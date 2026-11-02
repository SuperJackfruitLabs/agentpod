/**
 * A Salaam session's execution authority while it is live: renewal, the 15-second watch, the
 * idle end, the projection of a recovered turn, and re-sending a pending cancellation.
 */

import type { AcpSessionStatus } from "@agentpod/contract";
import { SalaamRunAuthority } from "@agentpod/contract";
import { connectionManager } from "../broker";
import { inspectSalaamExecution, renewSalaamExecution, validateSalaamAuthority } from "../salaam";
import { finalizeEnd } from "./end";
import { setStatus } from "./events";
import { log } from "./log";
import { liveById, requireLive, type LiveSession } from "./session-state";

// ─── Salaam idle end ──────────────────────────────────────────────────────────

/** Default minutes of no activity after which the hub ends an interactive Salaam session. */
export const SALAAM_IDLE_END_DEFAULT_MINUTES = 15;

/**
 * How long an interactive Salaam session may sit with no activity before the hub ends it
 * (`SALAAM_IDLE_END_MINUTES`, default 15). A Salaam station runs one execution at a time, so an
 * idle session left open holds the station against everyone else; ending it goes through the
 * normal end and confirmed revocation, and the session stays resumable. Fractions are allowed
 * (a short timeout for a live check); anything not a positive number is the default.
 */
export function salaamIdleEndMs(env: Record<string, string | undefined> = process.env): number {
  const minutes = Number(env.SALAAM_IDLE_END_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : SALAAM_IDLE_END_DEFAULT_MINUTES) * 60_000;
}

/** What the idle decision reads from a live session. */
export interface IdleCandidate {
  ended: boolean;
  status: AcpSessionStatus;
  turnInFlight: boolean;
  pendingPermissions: number;
  interactive: boolean;
  lastActivityAt: number;
}

/**
 * Is this session due to be ended for inactivity? Never mid-turn, never while a permission
 * prompt waits for its answer, never board work (its run owns its lifecycle), and only once the
 * last activity is at least `idleMs` old.
 */
export function idleEndDue(s: IdleCandidate, now: number, idleMs: number): boolean {
  return (
    !s.ended &&
    s.interactive &&
    s.status === "idle" &&
    !s.turnInFlight &&
    s.pendingPermissions === 0 &&
    now - s.lastActivityAt >= idleMs
  );
}

/** The reason the row records for an idle end. */
export function idleEndReason(idleMs: number): string {
  const minutes = idleMs / 60_000;
  const amount = Number.isInteger(minutes)
    ? `${minutes} minute${minutes === 1 ? "" : "s"}`
    : `${Math.round(idleMs / 1000)} seconds`;
  return `Ended after ${amount} without activity. Resume it to carry on.`;
}

export async function renewExecution(
  userId: string,
  sessionId: string,
  run?: SalaamRunAuthority,
): Promise<void> {
  const live = requireLive(userId, sessionId);
  if (!live.executionAuthority) return;
  const expected = live.executionAuthority.binding.run;
  if (
    expected.source === "superpipeline" &&
    (!SalaamRunAuthority.safeParse(run).success ||
      JSON.stringify(SalaamRunAuthority.parse(expected)) !==
        JSON.stringify(SalaamRunAuthority.parse(run)))
  )
    throw Error("The board work owner must renew this Salaam run");
  try {
    live.executionAuthority = await renewSalaamExecution(sessionId, userId);
  } catch (error) {
    await finalizeEnd(
      live,
      "Salaam execution authority could not be revalidated",
    );
    throw error;
  }
}

function idleCandidate(live: LiveSession): IdleCandidate {
  return {
    ended: live.ended,
    status: live.status,
    turnInFlight: live.turnInFlight,
    pendingPermissions: live.pending.size,
    interactive: live.executionAuthority?.binding.run.source === "agentpod",
    lastActivityAt: live.lastActivityAt,
  };
}

/**
 * End every interactive Salaam session idle for `idleMs` (spec: session lifecycle, 2026-10-23).
 * Each goes through `finalizeEnd`, the same end and confirmed revocation as a person's own end, and
 * its row records `endedCause: "idle"`. Runs on each session's authority tick; exported so a test
 * can drive it with its own clock. Returns the ids it ended.
 */
export async function endIdleSalaamSessions(
  now: number = Date.now(),
  idleMs: number = salaamIdleEndMs(),
): Promise<string[]> {
  const due = [...liveById.values()].filter(
    (live) => live.executionAuthority && idleEndDue(idleCandidate(live), now, idleMs),
  );
  await Promise.all(
    due.map((live) => {
      log.info("Ending idle Salaam session", { sessionId: live.id, stationId: live.stationId });
      return finalizeEnd(live, idleEndReason(idleMs), "idle");
    }),
  );
  return due.map((live) => live.id);
}

export function startSalaamAuthorityWatch(live: LiveSession): void {
  if (!live.executionAuthority || live.authorityTimer) return;
  live.authorityTimer = setInterval(() => {
    const idleMs = salaamIdleEndMs();
    if (idleEndDue(idleCandidate(live), Date.now(), idleMs)) {
      void finalizeEnd(live, idleEndReason(idleMs), "idle");
      return;
    }
    if (
      live.ended ||
      live.authorityRenewing ||
      !connectionManager.isOnline(live.nodeId)
    )
      return;
    live.authorityRenewing = true;
    void (async () => {
      try {
        if (live.executionAuthority!.binding.run.source === "agentpod")
          live.executionAuthority = await renewSalaamExecution(
            live.id,
            live.userId,
          );
        else
          await validateSalaamAuthority(
            live.executionAuthority!.binding,
            live.userId,
          );
        if (live.recoveredTurn) await projectRecoveredSalaamTurn(live);
      } catch {
        await finalizeEnd(
          live,
          "Salaam execution authority could not be revalidated",
        );
      } finally {
        live.authorityRenewing = false;
      }
    })();
  }, 15_000);
  live.authorityTimer.unref?.();
}

export async function projectRecoveredSalaamTurn(live: LiveSession): Promise<void> {
  const status = await inspectSalaamExecution(live.executionAuthority!);
  if (status.revoked) {
    await finalizeEnd(live, "Salaam execution authority was revoked");
    return;
  }
  if (
    live.pendingCancellation &&
    live.pendingCancellation.state !== "confirmed"
  ) {
    await resendSalaamCancellation(live);
    await setStatus(live, "waiting", {
      extra: { cancellation: live.pendingCancellation },
      force: true,
    }).done;
    return;
  }
  if (status.interrupted_attempts.length) {
    await setStatus(live, "waiting", {
      extra: {
        reason:
          "Salaam attempt was interrupted; inspect and explicitly continue it",
      },
    }).done;
    return;
  }
  if (status.active_attempts.length) {
    await setStatus(live, "working").done;
    return;
  }
  live.recoveredTurn = false;
  await setStatus(live, "idle").done;
}

export async function resendSalaamCancellation(live: LiveSession): Promise<void> {
  const intent = live.pendingCancellation;
  if (!intent || intent.state === "confirmed" || !live.agent) return;
  await live.agent
    .notify("session/cancel", {
      sessionId: live.acpSessionId,
      _meta: {
        "salaam.dev/cancellationId": intent.requestId,
        "salaam.dev/targetRequestId": intent.targetRequestId,
      },
    })
    .catch(() => {});
}
