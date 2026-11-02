/**
 * Getting a session back onto a live agent: the wire closing underneath it, re-attaching after a
 * lost transport, and restoring or reconnecting a Salaam session after a hub restart or a node
 * reconnect.
 */

import { and, eq, sql } from "drizzle-orm";
import type { AcpSessionMode } from "@agentpod/contract";
import { db } from "../../db/drizzle";
import { acpEvents, acpPromptRequests, acpSessions } from "../../db/schema/acp";
import * as broker from "../broker";
import { connectionManager } from "../broker";
import { renewSalaamExecution, revokeSalaamExecution, validateSalaamAuthority } from "../salaam";
import { finalizeEnd, rejectPendingPermissions } from "./end";
import { appendEndedState, setStatus } from "./events";
import { connectAndHandshake, proxyOptions } from "./handshake";
import { log } from "./log";
import { projectRecoveredSalaamTurn, startSalaamAuthorityWatch } from "./salaam-authority";
import { addLive, liveById, makeLive, type LiveSession } from "./session-state";
import { offlineGraceMs, sessionLockKey, withStationOpenLock } from "./timing";
import { openAcpWire, type AcpWire } from "./transport";
import { gatewayUnreachable } from "./turn-error";
import { dispatchPrompt, type TurnDeps } from "./turn";

/**
 * How many times a lost transport is re-attached, and how long between tries.
 *
 * Bounded, and short. A gateway that is coming back does so in seconds — it is a
 * service restart — so a long tail buys nothing. A gateway that is NOT coming back
 * must not turn into a process-spawn loop that runs for as long as the session row
 * exists, asking the node to start an agent every few seconds forever.
 */
const REATTACH_BACKOFF_MS = [1_000, 2_000, 4_000];

/**
 * Put the session back on a live agent process after its transport went away.
 *
 * Runs in the BACKGROUND, after the failure has already been reported. Making
 * somebody wait out a retry budget to be told what went wrong would be a worse
 * answer delivered later; they get the explanation at once, and the session quietly
 * becomes usable again behind it.
 *
 * It re-opens with the SAME instance — `live.id`, stable by construction — so the
 * node spawns the bridge against the same harness session key and the conversation
 * resumes rather than restarting. That is the whole reason the transcript survives a
 * gateway restart.
 *
 * Deliberately does NOT re-send the interrupted prompt. That turn was running inside
 * the thing that went away and may already have had effects; repeating it is the
 * person's decision to make, not this function's.
 */
async function reattachAfterTransportLoss(live: LiveSession): Promise<void> {
  if (live.reattaching || live.ended) return;
  live.reattaching = true;
  try {
    for (const wait of REATTACH_BACKOFF_MS) {
      await new Promise((r) => setTimeout(r, wait));
      // Every reason to stop, re-checked each pass: the session ended, somebody
      // started a new turn (which owns the wire now), or the node went away and the
      // offline path has it.
      if (live.ended || live.turnInFlight) return;
      if (!connectionManager.isOnline(live.nodeId)) continue;

      // Ask before spawning. Re-opening into a gateway that is still down costs the
      // node a process that will fail the same way, and tells the reader nothing.
      const probe = await broker.request(live.nodeId, "acp.transport", {
        key: live.stationKey,
      });
      if (probe.ok && gatewayUnreachable(probe.data)) continue;

      try {
        // The old wire is holding a dead socket; let it go before taking another.
        try {
          await live.wire?.close();
        } catch {
          // Already gone — which is the case this exists for.
        }
        const wire = await openAcpWire(
          live.nodeId,
          live.stationKey,
          live.id,
          proxyOptions(live),
        );
        if (live.ended) {
          await wire.close();
          return;
        }
        live.wire = wire;
        live.nodeSessionId = wire.nodeSessionId;
        live.instanceEchoed = wire.instanceEchoed;
        if (
          live.mcpProxyRequested &&
          wire.mcpProxy.join() !== live.mcpProxied.join()
        ) {
          // The prompt already named (or did not name) the tools; say so if the re-open differs.
          log.warn("ACP re-attach: the node's MCP proxy answer changed", {
            sessionId: live.id,
            before: live.mcpProxied,
            after: wire.mcpProxy,
          });
        }
        live.mcpProxied = wire.mcpProxy;
        await connectAndHandshake(live, wire, handleWireClosed);
        await db
          .update(acpSessions)
          .set({ nodeSessionId: wire.nodeSessionId })
          .where(eq(acpSessions.id, live.id));
        await setStatus(live, "idle").done;
        log.info("ACP session re-attached after its transport came back", {
          sessionId: live.id,
          stationId: live.stationId,
        });
        return;
      } catch (err) {
        log.warn("ACP re-attach attempt failed", {
          sessionId: live.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log.info(
      "ACP session not re-attached; its transport did not come back in time",
      {
        sessionId: live.id,
        stationId: live.stationId,
      },
    );
  } finally {
    live.reattaching = false;
  }
}

/**
 * Wire ended underneath us. An in-band exit reason means the agent process
 * died → end the session with it. A bare "eof" means the node went offline
 * (or the stream was torn down) → park at `waiting` and start the grace timer.
 */
export async function handleWireClosed(
  live: LiveSession,
  reason: string,
  closedWire: AcpWire,
): Promise<void> {
  if (live.ended || live.wire !== closedWire) return;
  if (live.executionAuthority && !live.ended) live.transportLost = true;
  try {
    // Contract note: always close() after `closed` settles (idempotent).
    await closedWire.close();
  } catch {
    // Already closed — fine.
  }
  if (live.ended || live.wire !== closedWire) return;
  if (live.executionAuthority) {
    live.transportLost = true;
    rejectPendingPermissions(live);
    await setStatus(live, "waiting", {
      extra: {
        reason:
          "Salaam transport detached; admitted daemon work retains its identity",
      },
      force: true,
    }).done;
    if (connectionManager.isOnline(live.nodeId)) void reconnectSalaam(live);
    if (!live.graceTimer) {
      live.graceTimer = setTimeout(
        () =>
          void finalizeEnd(
            live,
            "Salaam transport did not recover within its authority window",
          ),
        offlineGraceMs,
      );
      live.graceTimer.unref?.();
    }
    return;
  }
  if (reason === "eof") {
    rejectPendingPermissions(live);
    const { done } = setStatus(live, "waiting", {
      extra: { reason: "node offline" },
      force: true,
    });
    live.graceTimer = setTimeout(() => {
      void finalizeEnd(live, "Couldn't reach the node.");
    }, offlineGraceMs);
    live.graceTimer.unref?.();
    await done;
  } else {
    await finalizeEnd(live, reason);
  }
}

export async function reconnectSalaam(live: LiveSession): Promise<void> {
  if (
    live.reattaching ||
    live.ended ||
    !live.executionAuthority ||
    !connectionManager.isOnline(live.nodeId)
  )
    return;
  live.reattaching = true;
  try {
    if (live.executionAuthority.binding.run.source === "agentpod")
      live.executionAuthority = await renewSalaamExecution(
        live.id,
        live.userId,
      );
    else
      await validateSalaamAuthority(
        live.executionAuthority.binding,
        live.userId,
      );
    try {
      live.connection?.close();
      await live.wire?.close();
    } catch {
      // The old wire is being replaced; a failure to close it changes nothing below.
    }
    const wire = await openAcpWire(
      live.nodeId,
      live.stationKey,
      live.id,
      proxyOptions(live),
    );
    if (live.ended) {
      await wire.close();
      return;
    }
    live.wire = wire;
    live.nodeSessionId = wire.nodeSessionId;
    live.instanceEchoed = wire.instanceEchoed;
    await connectAndHandshake(live, wire, handleWireClosed);
    if (live.graceTimer) {
      clearTimeout(live.graceTimer);
      live.graceTimer = null;
    }
    live.transportLost = false;
    live.recoveredTurn = true;
    await db
      .update(acpSessions)
      .set({ nodeSessionId: wire.nodeSessionId })
      .where(eq(acpSessions.id, live.id));
    await projectRecoveredSalaamTurn(live);
    startSalaamAuthorityWatch(live);
    await live.chain;
    await redispatchPreparedPrompt(live);
  } catch {
    await finalizeEnd(
      live,
      "Salaam transport recovery could not revalidate its saved authority",
    );
  } finally {
    live.reattaching = false;
  }
}

/**
 * Prepared means the dispatch marker never committed. Unknown/dispatched work is inspected, never
 * automatically sent again.
 */
async function redispatchPreparedPrompt(live: LiveSession): Promise<void> {
  if (
    live.status === "idle" &&
    live.executionAuthority?.binding.run.source === "agentpod"
  ) {
    const [prepared] = await db
      .select()
      .from(acpPromptRequests)
      .where(
        and(
          eq(acpPromptRequests.sessionId, live.id),
          eq(acpPromptRequests.state, "prepared"),
        ),
      );
    if (prepared)
      await dispatchPrompt(
        turnDeps,
        live.userId,
        live.id,
        prepared.inputText,
        [],
        undefined,
        prepared.requestId,
      );
  }
}

/** What a turn needs from recovery: the re-attach a gateway that went away triggers. */
export const turnDeps: TurnDeps = { reattachAfterTransportLoss };

let salaamRestoreBeforeLockForTest: (() => Promise<void>) | undefined;
/** Test seam: runs after recovery read a row and before it takes the session lock (#773). */
export function _setSalaamRestoreBeforeLockForTest(hook: (() => Promise<void>) | undefined): void {
  salaamRestoreBeforeLockForTest = hook;
}

export async function restoreSalaamRow(
  staleRow: typeof acpSessions.$inferSelect,
): Promise<void> {
  if (!staleRow.executionAuthority || liveById.has(staleRow.id)) return;
  await salaamRestoreBeforeLockForTest?.();
  const restored = await withStationOpenLock(sessionLockKey(staleRow.id), () =>
    restoreSalaamRowLocked(staleRow),
  );
  if (restored) await reconnectSalaam(restored);
}
async function restoreSalaamRowLocked(
  staleRow: typeof acpSessions.$inferSelect,
): Promise<LiveSession | null> {
  const [row] = await db.select().from(acpSessions).where(eq(acpSessions.id, staleRow.id));
  if (!row || !row.executionAuthority || row.status === "ended" || liveById.has(row.id))
    return null;
  const saved = row.executionAuthority;
  // A board run's session is restored like any other: its owner (the bridge) renews it and Salaam
  // carries the durable task itself, so a hub restart must not strand it (run_b2bfa162, run_687cded4).
  if (saved.state !== "active") {
    await revokeSalaamExecution(
      row.id,
      "Hub restart found an execution that was not active; recover explicitly",
    );
    if (row.status !== "ended")
      await appendEndedState(
        row.id,
        "Hub restart interrupted an inactive execution; no prompt was replayed",
      );
    return null;
  }
  if (!connectionManager.isOnline(saved.binding.node_id)) {
    await db
      .update(acpSessions)
      .set({ status: "waiting" })
      .where(eq(acpSessions.id, row.id));
    return null;
  }
  // The transcript's own high-water mark: row.lastSeq can trail an end appended without it.
  const [agg] = await db
    .select({ maxSeq: sql<number | string>`COALESCE(MAX(${acpEvents.seq}), 0)` })
    .from(acpEvents)
    .where(eq(acpEvents.sessionId, row.id));
  const b = saved.binding;
  const live = makeLive({
    id: row.id,
    tenantId: row.tenantId,
    stationId: row.stationId,
    userId: row.userId,
    nodeId: b.node_id,
    stationKey: b.station_key,
    harness: "salaam",
    mode: row.mode as AcpSessionMode,
    workspacePath: b.workspace,
    mcpProxyRequested: row.mcpProxyRequested,
  });
  live.seq = Math.max(row.lastSeq, Number(agg?.maxSeq ?? 0));
  // Idle time keeps counting across a hub restart: a session idle for 14 minutes before it is
  // not given a fresh 15.
  live.lastActivityAt = row.lastEventAt.getTime();
  live.executionAuthority = saved;
  live.acpSessionId = saved.sessionId ?? "";
  live.transportLost = true;
  if (liveById.has(row.id)) return null;
  addLive(live);
  return live;
}

/**
 * A strict run's owner (the bridge) asks for its session before driving it: restored if a hub
 * restart left it un-held, "waiting" while its node is not connected, "gone" if it ended, is not
 * active, or is not this user's. Nothing is replayed; Salaam carries the durable task itself.
 */
export async function ensureSalaamLive(
  userId: string,
  sessionId: string,
): Promise<"live" | "waiting" | "gone"> {
  const held = liveById.get(sessionId);
  if (held) {
    if (held.userId !== userId || held.ended) return "gone";
    if (held.transportLost) {
      if (!connectionManager.isOnline(held.nodeId)) return "waiting";
      await reconnectSalaam(held);
    }
    return "live";
  }
  const [row] = await db.select().from(acpSessions).where(eq(acpSessions.id, sessionId));
  if (
    !row ||
    row.userId !== userId ||
    !row.executionAuthority ||
    row.executionAuthority.state !== "active"
  )
    return "gone";
  if (!connectionManager.isOnline(row.executionAuthority.binding.node_id)) return "waiting";
  await restoreSalaamRow(row);
  return liveById.has(sessionId) ? "live" : "gone";
}

export async function recoverSalaamForNode(nodeId: string): Promise<void> {
  const rows = await db
    .select()
    .from(acpSessions)
    .where(sql`${acpSessions.executionAuthority} IS NOT NULL`);
  for (const row of rows)
    if (row.executionAuthority!.binding.node_id === nodeId) {
      if (row.executionAuthority!.state === "revocation_pending")
        await revokeSalaamExecution(
          row.id,
          "Reconcile pending revocation after node reconnect",
        );
      else if (row.status !== "ended") {
        const live = liveById.get(row.id);
        if (live?.transportLost) await reconnectSalaam(live);
        else if (!live) await restoreSalaamRow(row);
      }
    }
}
