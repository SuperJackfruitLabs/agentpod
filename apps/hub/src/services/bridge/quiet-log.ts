/**
 * A log line per distinct key, then again at most once per `relogMs` with the count it suppressed.
 * For outcomes that repeat every cycle: each must be said, and none may be said every cycle.
 */

/** The interval a repeated quiet line stays unlogged: the same as a checkpoint refusal's. */
export const QUIET_RELOG_MS = 15 * 60_000;

export type QuietLog = (key: string, message: string, meta?: Record<string, unknown>) => void;

export function createQuietLog(
  log: (message: string, meta?: Record<string, unknown>) => void,
  opts: { now?: () => number; relogMs?: number } = {},
): QuietLog {
  const now = opts.now ?? Date.now;
  const relogMs = opts.relogMs ?? QUIET_RELOG_MS;
  const seen = new Map<string, { at: number; suppressed: number }>();
  return (key, message, meta = {}) => {
    const at = now();
    const last = seen.get(key);
    if (last && at - last.at < relogMs) {
      last.suppressed++;
      return;
    }
    seen.set(key, { at, suppressed: 0 });
    log(message, { ...meta, ...(last ? { suppressed: last.suppressed } : {}) });
  };
}
