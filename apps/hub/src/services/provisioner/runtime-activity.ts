/**
 * Runtime activity signal.
 *
 * Some substrates sleep an idle runtime to stop billing. Cloudflare's idle timer
 * is fed only by INCOMING requests, and a node-agent dials OUT — so from the
 * substrate's point of view a station is idle no matter how busy it is, and it
 * sleeps 15 minutes after start. On 2026-08-12 that took a live station away
 * mid-session.
 *
 * The hub is the only component that knows a station is being used, so it says
 * so. Debounced, because one trivial Hermes prompt was measured at 1,051 ACP
 * events and every one of them routes through the broker.
 *
 * Best-effort by construction: a renewal that fails must never fail the user's
 * verb, or this would cause the outage it exists to prevent.
 */

export interface ActivityDeps {
  /** The provisioned runtime backing a node, or null for an ordinary host. */
  lookup(nodeId: string): Promise<{ provider: string; externalId: string } | null>;
  /** Tell the substrate this runtime is in use. */
  touch(externalId: string): Promise<void>;
  now(): number;
}

/** Substrates whose runtimes idle out and therefore need this signal. */
const SLEEPS_WHEN_IDLE = new Set(["cloudflare"]);

export interface ActivityToucher {
  touch(nodeId: string): Promise<void>;
}

export function createActivityToucher(
  deps: ActivityDeps,
  intervalMs = 60_000
): ActivityToucher {
  const lastTouched = new Map<string, number>();

  return {
    async touch(nodeId: string): Promise<void> {
      try {
        const last = lastTouched.get(nodeId);
        const now = deps.now();
        if (last !== undefined && now - last < intervalMs) return;

        const runtime = await deps.lookup(nodeId);
        if (!runtime || !SLEEPS_WHEN_IDLE.has(runtime.provider)) return;

        // Recorded before the call, not after: a slow or failing worker must not
        // let a burst of verbs queue up a burst of renewals behind it.
        lastTouched.set(nodeId, now);
        await deps.touch(runtime.externalId);
      } catch {
        // Deliberately swallowed — see the module comment.
      }
    },
  };
}
