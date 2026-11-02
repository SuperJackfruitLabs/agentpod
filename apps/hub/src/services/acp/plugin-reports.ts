/**
 * A harness plugin's account of a failed turn: waiting for it after a silent turn, and placing a
 * report the node forwards on the turn it belongs to.
 */

import type { TurnError, TurnErrorReport, TurnResolution } from "@agentpod/contract";
import { persistEvent } from "./events";
import { log } from "./log";
import { liveById, type LiveSession } from "./session-state";
import { turnErrorGraceMs } from "./timing";
import { turnErrorFromPlugin } from "./turn-error";

// A report for a turn that has already been given its error is still posted,
// as a follow-up, if it comes within this long. Later than that it cannot be
// told apart from a report about some other turn.
const LATE_TURN_ERROR_MS = 60_000;

/** Wait, up to the grace window, for a plugin to report this turn's error. */
export function awaitTurnError(
  live: LiveSession,
): Promise<TurnError | TurnResolution | null> {
  if (turnErrorGraceMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      live.awaitingTurnError = null;
      resolve(null);
    }, turnErrorGraceMs);
    timer.unref?.();
    live.awaitingTurnError = (error) => {
      clearTimeout(timer);
      live.awaitingTurnError = null;
      resolve(error);
    };
  });
}

export type TurnErrorReportOutcome =
  | "awaited"
  | "pending"
  | "merged"
  | "resolved"
  | "late"
  | "duplicate"
  | "unmatched";

/**
 * One turn's reports, as one error. The first report leads — it is about the
 * model the agent was asked to use, and the rest are its fallbacks failing in
 * turn — and every attempt is kept, in order.
 */
function mergeTurnErrors(first: TurnError, next: TurnError): TurnError {
  const attemptsOf = (e: TurnError) =>
    e.attempts ?? [
      {
        provider: e.provider ?? "unknown",
        model: e.model ?? "unknown",
        kind: e.kind,
        message: e.message,
        ...(e.providerErrorType
          ? { providerErrorType: e.providerErrorType }
          : {}),
      },
    ];
  return { ...first, attempts: [...attemptsOf(first), ...attemptsOf(next)] };
}

/**
 * A harness plugin's report of a failed turn, forwarded by the node it runs on.
 *
 * Only that node's sessions are candidates: anyone who can send a turn.error
 * can put words in a room, and a node speaks only for what it runs.
 */
export function reportTurnError(
  nodeId: string,
  report: TurnErrorReport,
): TurnErrorReportOutcome {
  const candidates = [...liveById.values()].filter(
    (live) =>
      !live.ended &&
      live.nodeId === nodeId &&
      (report.acpSessionId !== undefined
        ? live.id === report.acpSessionId
        : live.harnessSessionKey === report.harnessSessionKey),
  );
  // One harness session can be open from two places (a room and the console);
  // the report is about the one that is failing now.
  const live =
    candidates.find((c) => c.awaitingTurnError) ??
    candidates.find((c) => c.turnInFlight) ??
    candidates.sort((a, b) => b.lastTurnSettledAt - a.lastTurnSettledAt)[0];

  if (!live) {
    // Info, not warn: a plugin sees every channel its harness serves, and a
    // failed turn in a Telegram chat has no hub session to belong to.
    log.info("a turn error was reported for no live session on its node", {
      nodeId,
      acpSessionId: report.acpSessionId,
      harnessSessionKey: report.harnessSessionKey,
    });
    return "unmatched";
  }

  if (report.resolution) return applyResolution(live, nodeId, report.resolution);
  if (!report.error) return "unmatched";
  const error = turnErrorFromPlugin(report.error, live.harness);
  if (live.awaitingTurnError) {
    live.awaitingTurnError(error);
    return "awaited";
  }
  if (live.turnInFlight && !live.turnErrorRecorded) {
    // More than one report for a turn: merge, never replace. Replacing lost
    // Kimi's quota — the cause — behind the fallbacks' errors (2026-09-26).
    live.pendingTurnErrorAt = Date.now();
    if (live.pendingTurnError) {
      live.pendingTurnError = mergeTurnErrors(live.pendingTurnError, error);
      return "merged";
    }
    live.pendingTurnError = error;
    return "pending";
  }
  if (live.turnErrorSource === "plugin") {
    // The room already shows a plugin's account of this turn. Another would be
    // the same news twice, which is exactly what krishna's room showed.
    return "duplicate";
  }
  if (Date.now() - live.lastTurnSettledAt < LATE_TURN_ERROR_MS) {
    // The turn already has its error ("completed without a reply"). This one
    // says why, so it follows rather than being lost.
    live.turnErrorSource = error.source;
    persistEvent(live, "error", error);
    return "late";
  }
  log.warn("a turn error was reported too long after its turn to place", {
    nodeId,
    sessionId: live.id,
  });
  return "unmatched";
}

/**
 * The run this plugin reported (or is watching) ended well: whatever it
 * said failed was recovered. A pending report goes; a waiting turn wakes.
 */
function applyResolution(
  live: LiveSession,
  nodeId: string,
  resolution: TurnResolution,
): TurnErrorReportOutcome {
  live.pendingTurnError = null;
  live.pendingTurnErrorAt = 0;
  if (live.awaitingTurnError) {
    live.awaitingTurnError(resolution);
    return "resolved";
  }
  if (live.turnInFlight) {
    live.turnResolution = resolution;
    return "resolved";
  }
  // Too late to take back what the room was already told.
  log.info("a turn resolution arrived after its turn ended", {
    nodeId,
    sessionId: live.id,
    resolution,
  });
  return "late";
}
