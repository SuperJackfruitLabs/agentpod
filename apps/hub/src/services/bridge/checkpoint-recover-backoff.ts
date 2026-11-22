/**
 * How often an unresolved checkpoint attempt is re-driven. It is checked at the base interval, then
 * twice that, up to a ceiling; a different attempt, or one that moved on, starts again from the base.
 * The claim cycle itself keeps its own poll: ordinary claims are never held by this.
 */
export const RECOVER_BASE_MS = 30_000;
/**
 * SuperPipeline reclaims a run whose heartbeat is older than this (its `HEARTBEAT_TIMEOUT_MS`).
 * Every re-drive of a waiting attempt heartbeats its run, so the ceiling stays well under it.
 */
export const BOARD_HEARTBEAT_TIMEOUT_MS = 15 * 60_000;
/**
 * The ceiling. It was 15 minutes, the board's whole heartbeat window: an attempt waiting on a long
 * prepare or execute could lose its run between two re-drives while the node was still working.
 */
export const RECOVER_MAX_MS = 5 * 60_000;

export interface AttemptBackoff {
  /** True when the attempt may be driven now. */
  due(key: string): boolean;
  /**
   * The attempt was driven and is still unresolved: wait longer before the next try. With `recheckMs`
   * (its run is still going) wait exactly that, without growing the fault backoff.
   */
  parked(key: string, recheckMs?: number): void;
  /** While a still-running attempt waits: the ms until it is due. Undefined for a fault backoff. */
  recheckIn(key: string): number | undefined;
  /** The attempt resolved (or another one replaced it): forget it. */
  clear(): void;
}

export function createAttemptBackoff(opts: { now?: () => number; baseMs?: number; maxMs?: number } = {}): AttemptBackoff {
  const now = opts.now ?? Date.now;
  const base = opts.baseMs ?? RECOVER_BASE_MS;
  const max = opts.maxMs ?? RECOVER_MAX_MS;
  let state: { key: string; streak: number; nextAt: number; running: boolean } | undefined;
  return {
    due: (key) => !state || state.key !== key || now() >= state.nextAt,
    parked(key, recheckMs) {
      if (recheckMs !== undefined) {
        state = { key, streak: 0, nextAt: now() + recheckMs, running: true };
        return;
      }
      const streak = state?.key === key ? state.streak + 1 : 1;
      state = { key, streak, nextAt: now() + Math.min(base * 2 ** Math.min(streak - 1, 30), max), running: false };
    },
    recheckIn: (key) => (state?.key === key && state.running ? Math.max(0, state.nextAt - now()) : undefined),
    clear() { state = undefined; },
  };
}
