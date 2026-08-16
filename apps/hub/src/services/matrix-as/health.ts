/**
 * Is the bridge working, or merely running?
 *
 * Not an academic distinction. The homeserver's registration carried
 * `url: null` for months: a perfectly healthy Application Service that had never
 * been sent a single event, with nothing anywhere saying so. This exists so that
 * state has a name.
 */

/** When the homeserver last pushed us anything. Process-local, like the sweeper's. */
let lastTransactionAt: number | null = null;

export function recordTransaction(now = Date.now()): void {
  lastTransactionAt = now;
}

/** Test hook — the counter is module state, as the sweeper's is. */
export function _resetHealthForTest(): void {
  lastTransactionAt = null;
}

/**
 * How long a bridge may hear nothing before that is itself the news.
 *
 * Two hours: long enough that an idle night is not an alarm, short enough that
 * a disconnected bridge is noticed the same working day.
 */
export const SILENCE_MS = 2 * 60 * 60 * 1000;

export interface BridgeHealth {
  status: "ok" | "silent" | "disabled";
  reason?: string;
  lastTransactionAt: number | null;
}

export function bridgeHealth(opts: { enabled: boolean; now?: number }): BridgeHealth {
  const now = opts.now ?? Date.now();

  if (!opts.enabled) {
    return { status: "disabled", lastTransactionAt };
  }

  if (lastTransactionAt === null) {
    return {
      status: "silent",
      reason:
        "no transaction has ever arrived — the homeserver's registration may still " +
        "have no `url`, in which case this bridge is running and connected to nothing",
      lastTransactionAt: null,
    };
  }

  if (now - lastTransactionAt > SILENCE_MS) {
    return {
      status: "silent",
      reason: `no transaction for over ${Math.round(SILENCE_MS / 60000)} minutes`,
      lastTransactionAt,
    };
  }

  return { status: "ok", lastTransactionAt };
}
