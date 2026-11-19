/**
 * How often an unresolved checkpoint attempt is re-driven. It is checked at the base interval, then
 * twice that, up to a ceiling; a different attempt, or one that moved on, starts again from the base.
 * The claim cycle itself keeps its own poll: ordinary claims are never held by this.
 */
export const RECOVER_BASE_MS = 30_000;
export const RECOVER_MAX_MS = 15 * 60_000;

export interface AttemptBackoff {
  /** True when the attempt may be driven now. */
  due(key: string): boolean;
  /** The attempt was driven and is still unresolved: wait longer before the next try. */
  parked(key: string): void;
  /** The attempt resolved (or another one replaced it): forget it. */
  clear(): void;
}

export function createAttemptBackoff(opts: { now?: () => number; baseMs?: number; maxMs?: number } = {}): AttemptBackoff {
  const now = opts.now ?? Date.now;
  const base = opts.baseMs ?? RECOVER_BASE_MS;
  const max = opts.maxMs ?? RECOVER_MAX_MS;
  let state: { key: string; streak: number; nextAt: number } | undefined;
  return {
    due: (key) => !state || state.key !== key || now() >= state.nextAt,
    parked(key) {
      const streak = state?.key === key ? state.streak + 1 : 1;
      state = { key, streak, nextAt: now() + Math.min(base * 2 ** Math.min(streak - 1, 30), max) };
    },
    clear() { state = undefined; },
  };
}
