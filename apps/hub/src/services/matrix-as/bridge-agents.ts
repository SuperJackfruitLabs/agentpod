/**
 * Which agents the bridge holds keys for.
 *
 * **Only bridge-mode ones, and the distinction is not a nicety.** A
 * harness-mode station runs its own Matrix client with its own crypto store;
 * the bridge never speaks for it and must never hold its keys.
 *
 * It did. Every `@agent_*` user appearing in an appservice transaction got a
 * machine, so the bridge created a device for all fourteen harness agents and
 * published a cross-signing identity for each. The effect only became visible
 * when one of those agents turned its own encryption on:
 *
 *     WARNING mau.crypto: Device @agent_analyst-echo/p2xjNCX7RV isn't cross-signed
 *
 * It cannot be. The identity belongs to the bridge, which holds the private
 * half, and the agent that actually reads the room is left with a device
 * nobody can verify — while a second device it does not use sits there signed.
 *
 * Cached because this is asked on every transaction and the answer changes
 * only when a station switches modes, which is a deliberate operator action.
 * The TTL is short enough that a mode change lands within a minute without
 * anybody restarting anything.
 */
import { eq } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";

const TTL_MS = 60_000;

let harnessMxids = new Set<string>();
let refreshedAt = 0;
let inFlight: Promise<void> | null = null;

async function refresh(): Promise<void> {
  const rows = await db
    .select({ mxid: stations.matrixId })
    .from(stations)
    .where(eq(stations.matrixIdentityMode, "harness"));
  harnessMxids = new Set(rows.map((r) => (r.mxid ?? "").trim()).filter(Boolean));
  refreshedAt = Date.now();
}

/**
 * Start the cache, and keep it warm.
 *
 * Failure here is deliberately not fatal: the previous answer stays, and on a
 * cold cache that means an empty harness set — the bridge would then hold keys
 * it should not, which is the state this replaces rather than a new hazard.
 */
export async function bridgeModeOnly(): Promise<(userId: string) => boolean> {
  await refresh().catch(() => {});
  return (userId: string) => {
    if (Date.now() - refreshedAt > TTL_MS && !inFlight) {
      inFlight = refresh()
        .catch(() => {})
        .finally(() => {
          inFlight = null;
        });
    }
    return !harnessMxids.has(userId);
  };
}

/** For tests: forget what was cached. */
export function resetBridgeModeCache(): void {
  harnessMxids = new Set();
  refreshedAt = 0;
}
