/** Opening a session: the control pair, the readiness gates, the open phase, and resume. */

import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { AcpSessionMode, AcpSessionRow } from "@agentpod/contract";
import { db } from "../../db/drizzle";
import { acpEvents, acpSessions } from "../../db/schema/acp";
import { grantAllowsPrincipal } from "../../auth/org-plane/grants";
import { callerGrant, callerPrincipal } from "../../auth/caller-authority";
import { connectionManager } from "../broker";
import { ControlPairDenied, isControlPairEnforced } from "../control";
import {
  admitSalaamExecution,
  makeSalaamExecution,
  renewSalaamExecution,
  revokeSalaamExecution,
  salaamStationHolder,
} from "../salaam";
import { gateCapability, getStation } from "../stations";
import { finalizeEnd } from "./end";
import { persistEvent, setStatus } from "./events";
import { busyRefusal, interactiveWorkspaceAdmin, nodeHasCapability, stationReadiness } from "./gates";
import { connectAndHandshake, proxyOptions } from "./handshake";
import { log } from "./log";
import { handleWireClosed } from "./recovery";
import { toContract } from "./rows";
import { startSalaamAuthorityWatch } from "./salaam-authority";
import {
  ACTIVE_SESSION_MESSAGE,
  addLive,
  liveByStation,
  makeLive,
  otherLive,
  type CreateSessionInput,
  type LiveSession,
} from "./session-state";
import { boundedDb, withStationOpenLock } from "./timing";
import { openAcpWire } from "./transport";
import { turnErrorFromRejection } from "./turn-error";

export async function createSession(
  input: CreateSessionInput,
): Promise<AcpSessionRow> {
  const { stationId, userId, tenantId } = input;

  // ── The control pair, first half: may this principal dispatch this agent? ──
  //
  // Decision 4 of charter decisions/2026-08-13-ecosystem-identity.md, enforced
  // HERE because this is the one choke point both dispatch paths pass through:
  // the console/API route and the superpipeline bridge. A check in superpipeline alone
  // would cover board-driven work while provisioning straight at AgentPod — the
  // most common path today — went unguarded, and "a control with a hole that
  // shape is not a control".
  //
  // Unconfigured is off; configured is fail-closed. Before the readiness gates
  // on purpose: whether a caller is ALLOWED to reach a station does not depend
  // on whether that station happens to be online, and answering "node offline"
  // to someone who was never permitted leaks which stations exist.
  const station = await getStation({ tenantId }, stationId);
  if (station && isControlPairEnforced() && !interactiveWorkspaceAdmin(input)) {
    // The grant is keyed by principal id, not the session's `userId`. A caller
    // with no principal has no grant to hold. Under the org plane a caller's
    // token answers both (`auth/caller-authority.ts`).
    const caller = { id: userId, authority: input.authority };
    const principal = await callerPrincipal(caller);
    const allowed =
      principal !== null &&
      grantAllowsPrincipal(
        await callerGrant(caller, principal.id),
        station.principalId,
      );

    if (!allowed) {
      log.warn("dispatch refused by the control pair", {
        userId,
        principalId: principal?.id ?? null,
        stationKey: station.stationKey,
        stationId,
      });
      throw new ControlPairDenied(userId, station.stationKey);
    }
  }

  // Fail fast on the obvious gates before queueing (openSession re-checks them
  // under the lock, where the answers are current).
  const readiness = await stationReadiness({ tenantId }, stationId);
  if (!readiness.ready)
    throw readiness.holder
      ? await busyRefusal(readiness.holder, userId)
      : new Error(readiness.reason);

  return withStationOpenLock(stationId, () => openSession(input));
}

async function openSession(input: CreateSessionInput): Promise<AcpSessionRow> {
  const { stationId, userId, mode } = input;
  const station = await currentOpenTarget(input);
  const { nodeId, stationKey, workspacePath, harness } = station;
  // Asked only of a node that runs the proxy; read before the sibling check, so no await
  // separates that check from addLive.
  const mcpProxyRequested =
    input.mcpProxy === true && (await nodeHasCapability(nodeId, "mcp.proxy"));

  // ── Compatibility layer 1 (pre-open) ───────────────────────────────────────
  // A concurrent session is only safe when the node keys its agent processes on
  // (station key, instance). The one signal for that is a live sibling whose
  // acp.open echoed the instance back; anything else (an old node, or a sibling
  // that never got that far) means one shared process — refuse. Runs with no
  // await between it and addLive below, and under the station open lock, so no
  // second open can slip past it (see withStationOpenLock).
  for (const sibling of liveByStation.get(stationId) ?? []) {
    if (sibling.instanceEchoed !== true) {
      throw new Error(ACTIVE_SESSION_MESSAGE);
    }
  }

  const id = `acps_${crypto.randomUUID()}`;
  const now = new Date();
  // Resolved once, here, and carried on the live session: every event this
  // session ever writes inherits it, so a transcript cannot end up split across
  // tenants by a later re-resolution. It is the station's tenant: a session is
  // a child of the station it runs on (W5), never of the user opening it.
  const tenantId = station.tenantId;
  const execution = await prepareExecution(input, id, harness);
  const live = makeLive({
    id,
    tenantId,
    stationId,
    userId,
    nodeId,
    stationKey,
    harness,
    mode,
    workspacePath: workspacePath ?? null,
    mcpProxyRequested,
    mcpServers: input.mcpServers,
  });
  live.executionAuthority = execution;

  // Register before any await so siblings (and the layers above) can see this
  // session while it is starting. Every failure exit below MUST run
  // finalizeEnd, which removes these entries — a leaked entry would wedge the
  // station with 409s until restart.
  addLive(live);

  // A resume claims its predecessor once, atomically: two resumes of one conversation would fork
  // it into two branches. Released below if nothing was admitted, so the person can try again.
  let claimed = false;
  try {
    if (input.resumeFrom !== undefined) {
      await claimResumed(input.resumeFrom, userId, id);
      claimed = true;
    }
    return await openPhase(live, input, execution, now);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    persistEvent(live, "error", turnErrorFromRejection(err, live.harness));
    await finalizeEnd(live, reason);
    // Salaam never admitted the continuation, so the conversation was not carried anywhere:
    // give the claim back. Once admitted, the new session holds the history and is the one to
    // resume.
    if (claimed && !live.executionAuthority?.sessionId)
      await db
        .update(acpSessions)
        .set({ resumedAs: null })
        .where(and(eq(acpSessions.id, input.resumeFrom!), eq(acpSessions.resumedAs, id)))
        .catch(() => {});
    throw err;
  }
}

/**
 * Re-read the station and its node's presence: a queued open can start a
 * minute after createSession was called, by which time the station may have
 * been re-adopted onto another node, lost the capability, or gone offline.
 * The open must target CURRENT routing, never the snapshot from the queue.
 */
async function currentOpenTarget(input: CreateSessionInput) {
  const { stationId, userId } = input;
  const station = await getStation({ tenantId: input.tenantId }, stationId);
  if (!station) throw new Error("Station not found.");
  if (!gateCapability(station, "acp")) {
    throw new Error("This station does not support agent sessions.");
  }
  if (!connectionManager.isOnline(station.nodeId)) {
    throw new Error("Node is offline.");
  }
  if (station.harness === "salaam") {
    const holder = await salaamStationHolder(station.id);
    if (holder) throw await busyRefusal(holder, userId);
  }
  if (input.resumeFrom !== undefined && station.harness !== "salaam")
    throw new SessionNotResumable("Only an interactive Salaam session can be resumed.");
  return station;
}

/** A Salaam station's execution authority for this session (null for any other harness). */
async function prepareExecution(input: CreateSessionInput, id: string, harness: string) {
  const { stationId, userId } = input;
  const execution =
    harness === "salaam"
      ? await makeSalaamExecution(stationId, userId, id, input.executionRun, {
          workspaceAdmin: interactiveWorkspaceAdmin(input),
          ...(input.resumeFrom !== undefined ? { continueFrom: input.resumeFrom } : {}),
        })
      : null;
  if (execution && input.mcpServers?.length)
    throw Error("Salaam managed MCP is not enabled yet");
  if (execution?.binding.run.source === "superpipeline") {
    if (!input.validateExecutionRun)
      throw Error("Salaam board admission requires a fresh run-owner check");
    await input.validateExecutionRun();
  }
  return execution;
}

/** Claim the resumed session for this one, once: a second resume of it is refused. */
async function claimResumed(resumeFrom: string, userId: string, id: string): Promise<void> {
  const [won] = await boundedDb(
    db
      .update(acpSessions)
      .set({ resumedAs: id })
      .where(
        and(
          eq(acpSessions.id, resumeFrom),
          eq(acpSessions.userId, userId),
          isNull(acpSessions.resumedAs),
        ),
      )
      .returning({ id: acpSessions.id }),
    "claim resumed session",
  );
  if (!won) throw new SessionNotResumable("This session was already resumed.");
}

/**
 * The open phase proper: the row, the carried transcript, Salaam's admission, the wire, the
 * handshake, and the session at idle. Every DB step is bounded (boundedDb): a stalled query must
 * reject into openSession's catch so the live-map entry is cleaned up, never hang holding it.
 */
async function openPhase(
  live: LiveSession,
  input: CreateSessionInput,
  execution: LiveSession["executionAuthority"],
  now: Date,
): Promise<AcpSessionRow> {
  const { id, stationId, userId, nodeId, stationKey, mcpProxyRequested } = live;
  const { mode } = input;
  await boundedDb(
    db.insert(acpSessions).values({
      id,
      tenantId: live.tenantId,
      stationId,
      userId,
      mode,
      status: "starting",
      endedReason: null,
      nodeSessionId: null,
      executionAuthority: execution,
      mcpProxyRequested,
      resumedFrom: input.resumeFrom ?? null,
      createdAt: now,
      lastEventAt: now,
    }),
    "insert session row",
  );
  if (input.resumeFrom !== undefined) await carryTranscript(live, input.resumeFrom);

  // The hub session id doubles as the ACP instance: stable by construction
  // across a re-open of this session, and it correlates node-side processes
  // back to this row in logs.
  if (execution) {
    await admitSalaamExecution(id, userId);
    live.executionAuthority = await renewSalaamExecution(id, userId);
  }
  const wire = await openAcpWire(nodeId, stationKey, id, proxyOptions(live));
  live.wire = wire;
  live.nodeSessionId = wire.nodeSessionId;
  live.instanceEchoed = wire.instanceEchoed;
  live.mcpProxied = wire.mcpProxy;

  // ── Compatibility layer 2 (post-open) ────────────────────────────────────
  // The node did not echo the instance, so this wire may well be the SAME
  // agent process a sibling is already talking to — two conversations on one
  // process and one input-frame key. Refuse rather than risk the bleed; the
  // catch below tears this wire down (error event + finalizeEnd + node close).
  // Layer 1 normally catches this first; this is the belt to its braces for
  // the case where no live sibling had recorded an echo verdict yet.
  if (!wire.instanceEchoed && otherLive(stationId, live).length > 0) {
    throw new Error(ACTIVE_SESSION_MESSAGE);
  }

  await connectAndHandshake(live, wire, handleWireClosed);

  await boundedDb(
    db
      .update(acpSessions)
      .set({ nodeSessionId: wire.nodeSessionId })
      .where(eq(acpSessions.id, id)),
    "record node session id",
  );
  await boundedDb(
    setStatus(
      live,
      "idle",
      input.resumeFrom !== undefined ? { extra: { resumedFrom: input.resumeFrom } } : {},
    ).done,
    "idle state event",
  );
  startSalaamAuthorityWatch(live);

  const rows = await boundedDb(
    db.select().from(acpSessions).where(eq(acpSessions.id, id)),
    "read back session row",
  );
  return toContract(rows[0]!);
}

/**
 * Copy the resumed session's transcript into the new one, so the console (and any reader of this
 * session's events) sees one conversation. State events stay behind: an `ended` among them would
 * read as this session ending. Seqs are renumbered from 1; the live counter continues after them.
 */
async function carryTranscript(live: LiveSession, from: string): Promise<void> {
  const rows = await boundedDb(
    db
      .select()
      .from(acpEvents)
      .where(and(eq(acpEvents.sessionId, from), ne(acpEvents.type, "state")))
      .orderBy(asc(acpEvents.seq)),
    "read resumed transcript",
  );
  const [prior] = await boundedDb(
    db.select({ title: acpSessions.title }).from(acpSessions).where(eq(acpSessions.id, from)),
    "read resumed title",
  );
  if (rows.length) {
    await boundedDb(
      db.insert(acpEvents).values(
        rows.map((r, i) => ({
          sessionId: live.id,
          tenantId: live.tenantId,
          seq: i + 1,
          type: r.type,
          payload: r.payload as object,
          createdAt: r.createdAt,
        })),
      ),
      "carry resumed transcript",
    );
  }
  live.seq = rows.length;
  await boundedDb(
    db
      .update(acpSessions)
      .set({ lastSeq: rows.length, title: prior?.title ?? null })
      .where(eq(acpSessions.id, live.id)),
    "record carried transcript",
  );
}

/** A resume that cannot happen: not ended, not Salaam, already resumed, or stop unconfirmed. */
export class SessionNotResumable extends Error {
  override name = "SessionNotResumable";
}
export function isSessionNotResumable(e: unknown): e is SessionNotResumable {
  return e instanceof SessionNotResumable || (e as { name?: string })?.name === "SessionNotResumable";
}

/**
 * Resume an ended interactive Salaam session: the same conversation (Salaam carries its history
 * into a new admission, the hub carries the transcript), under a FRESH execution authority for
 * the person resuming. They pass every check a new session does (the control pair or decision 3,
 * the one-live-execution rule), because it IS a new session.
 *
 * Owner only. An admin can see and end another person's session, but resuming it would carry
 * that person's conversation, and whatever they told the agent, into the admin's own authority.
 * Restricting resume to the owner keeps one conversation on one person's authority from start to
 * end. Someone else's session is "not found", as on every other per-session door.
 */
export async function resumeSession(
  input: Omit<CreateSessionInput, "stationId" | "mode" | "resumeFrom" | "executionRun" | "validateExecutionRun"> & {
    sessionId: string;
    mode?: AcpSessionMode;
  },
): Promise<AcpSessionRow> {
  const [prior] = await db
    .select()
    .from(acpSessions)
    .where(and(eq(acpSessions.id, input.sessionId), eq(acpSessions.tenantId, input.tenantId)));
  if (!prior || prior.userId !== input.userId) throw new Error("Session not found.");
  if (prior.status !== "ended") throw new SessionNotResumable("This session is still running.");
  const saved = prior.executionAuthority;
  if (!saved || saved.binding.run.source !== "agentpod")
    throw new SessionNotResumable("Only an interactive Salaam session can be resumed.");
  if (prior.resumedAs) throw new SessionNotResumable("This session was already resumed.");
  if (saved.state !== "revoked") {
    const status = await revokeSalaamExecution(prior.id, "Reconcile before resume");
    if (status?.state !== "revoked")
      throw new SessionNotResumable(
        "This session's last execution has not been confirmed stopped yet. Try again in a moment.",
      );
  }
  const { sessionId, mode, ...rest } = input;
  return createSession({
    ...rest,
    stationId: prior.stationId,
    mode: mode ?? (prior.mode as AcpSessionMode),
    resumeFrom: sessionId,
  });
}
