/**
 * The ACP session service's deadlines and per-key locks: how long a handshake, an open-phase
 * database step, a node's absence or a plugin's turn report may take, and the queue that
 * serializes opens per station (and recovery, prompts and ends per session).
 */

import { log } from "./log";

// How long a session survives at `waiting` after its node goes offline before
// the hub gives up (no reattach in slice 2).
export let offlineGraceMs = 60_000;

/** Test hook: shrink the offline grace period. */
export function _setOfflineGraceMsForTest(ms: number): void {
  offlineGraceMs = ms;
}

// How long a turn that ended with nothing waits for a harness plugin to say
// why. OpenClaw's bridge resolves `end_turn` before the plugin's report
// arrives: the plugin waits 2.5 s of quiet after the last model attempt (see
// integrations/openclaw/agentpod-errors), and real attempts land ~1 s apart.
const TURN_ERROR_GRACE_DEFAULT_MS = 5_000;
export let turnErrorGraceMs = TURN_ERROR_GRACE_DEFAULT_MS;

/** Test hook: change the wait. Pass nothing to restore the default. */
export function _setTurnErrorGraceMsForTest(
  ms = TURN_ERROR_GRACE_DEFAULT_MS,
): void {
  turnErrorGraceMs = ms;
}

// Deadline for each ACP handshake request (initialize, session/new). An agent
// process that spawns but never speaks ACP (interactive-prompt/TTY wedge —
// the class Hermes hit in dogfooding) must not leave createSession pending
// forever: the live-map entry is registered before the handshake, so a hung
// await would 409-lock the station until hub restart.
export let handshakeTimeoutMs = 30_000;

/** Test hook: shrink the handshake deadline. */
export function _setHandshakeTimeoutMsForTest(ms: number): void {
  handshakeTimeoutMs = ms;
}

export const HANDSHAKE_TIMEOUT_MESSAGE =
  "Couldn't start the agent process — the agent didn't respond (handshake timed out).";

// Deadline for each DB step of the open phase. Postgres has no statement
// timeout here (and must not get one — boot migrations share the client), so a
// blocked query would otherwise hang openSession forever: its live-map entry is
// already registered, its catch never runs, and layer 1 would refuse every
// later create for that station until hub restart.
let openDbTimeoutMs = 10_000;

/** Test hook: shrink the per-step deadline for the open phase's DB writes. */
export function _setOpenDbTimeoutMsForTest(ms: number): void {
  openDbTimeoutMs = ms;
}

const OPEN_DB_TIMEOUT_MESSAGE =
  "Couldn't start the agent process — the database didn't respond (write timed out).";

/**
 * Bound one DB step of the open phase so a stall REJECTS into openSession's
 * catch (error event → finalizeEnd → live-map cleanup) instead of hanging.
 * `step` names the culprit in the log; the thrown copy stays stable.
 */
export function boundedDb<T>(promise: Promise<T>, step: string): Promise<T> {
  return withDeadline(promise, openDbTimeoutMs, OPEN_DB_TIMEOUT_MESSAGE).catch(
    (err: unknown) => {
      if (err instanceof Error && err.message === OPEN_DB_TIMEOUT_MESSAGE) {
        log.error("ACP open: database step timed out", { step });
      }
      throw err;
    },
  );
}

/**
 * Reject with `message` if `promise` doesn't settle within `ms`.
 *
 * On timeout the underlying promise is left to settle later (the SDK rejects
 * it when the connection closes) — its eventual rejection is swallowed so it
 * never becomes an unhandled rejection.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      promise.catch(() => {});
      reject(new Error(message));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Serializes the open phase per station — the other half of layer 1.
 *
 * Layer 1 refuses on `instanceEchoed !== true`, and a session's verdict is null
 * until ITS acp.open completes. So without this lock two simultaneous creates on
 * a perfectly modern station would race: the second would see the first's null
 * verdict and 409 a session that is entirely legal. Queueing the open phase
 * means the second create reads a settled verdict and only refuses for real.
 *
 * The strict check and this lock are a PAIR, and dismantling either re-opens
 * two-hub-sessions-on-one-agent-process for pre-instance nodes:
 *   - relax layer 1 to `=== false` and two concurrent opens on an old node both
 *     pass (neither has a verdict yet) and land on the same shared process,
 *   - drop the lock and layer 1 has to stay strict, which spuriously 409s
 *     legitimate concurrent creates.
 * Layer 2 (post-open) is the last resort if both are somehow bypassed.
 */
const openLocks = new Map<string, Promise<unknown>>();

/**
 * Backstop ceiling on one queued open, so a stalled open can never park every
 * later create for that station behind it. Every step INSIDE the open phase has
 * its own deadline (two handshake requests, four DB steps), and this ceiling is
 * their sum plus slack — so a single stalled step always trips its own,
 * attributable deadline first and this one only catches something unbounded
 * that slipped in.
 */
const OPEN_PHASE_SLACK_MS = 5_000;
const OPEN_PHASE_DB_STEPS = 4;
const OPEN_PHASE_TIMEOUT_MESSAGE =
  "Couldn't start the agent process — it didn't finish starting in time.";

function openPhaseTimeoutMs(): number {
  return (
    handshakeTimeoutMs * 2 +
    openDbTimeoutMs * OPEN_PHASE_DB_STEPS +
    OPEN_PHASE_SLACK_MS
  );
}

export function withStationOpenLock<T>(
  stationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = openLocks.get(stationId);
  const run = (async () => {
    if (prev) await prev.catch(() => {});
    return withDeadline(fn(), openPhaseTimeoutMs(), OPEN_PHASE_TIMEOUT_MESSAGE);
  })();
  openLocks.set(stationId, run);
  void run
    .then(
      () => {},
      () => {},
    )
    .then(() => {
      if (openLocks.get(stationId) === run) openLocks.delete(stationId);
    });
  return run;
}

/**
 * Restoring a row and ending it after a hub restart are serialised per session (#773).
 * Recovery used to restore from a row read before a concurrent end committed: the end wrote
 * the ended state while the restored live session kept the station, wrote events at the
 * row's stale seq (duplicate key), and refused the next open.
 */
export const sessionLockKey = (id: string) => "session:" + id;
