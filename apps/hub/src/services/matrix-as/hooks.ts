/**
 * Telling the bridge that stations have arrived.
 *
 * Provisioning runs at boot, which is enough for a fleet that only changes when
 * the hub restarts — and wrong for one that doesn't. A station adopted at noon
 * would have no Matrix identity and no room until somebody restarted the hub,
 * and the symptom is an agent that exists everywhere except the place you were
 * told to talk to it.
 *
 * A hook rather than a direct call, so `station-registry` keeps knowing nothing
 * about Matrix: adoption announces what happened, and whoever cares listens.
 * Nobody listens when the bridge is off.
 */

import { createLogger } from "../../utils/logger";

const log = createLogger("matrix-hooks");

type Listener = (stationIds: string[]) => Promise<void>;

let listener: Listener | null = null;

/** Register the one listener. Replaces any previous — this is boot wiring. */
export function onStationsAdopted(fn: Listener | null): void {
  listener = fn;
}

/**
 * Announce newly adopted stations.
 *
 * Never throws and never delays the caller: adoption succeeded, and a bridge
 * that could not give an agent a room must not make it look as though the
 * station was not adopted.
 */
export function notifyStationsAdopted(stationIds: string[]): void {
  if (!listener || stationIds.length === 0) return;
  void listener(stationIds).catch((err) => {
    log.error("could not provision Matrix identities for newly adopted stations", {
      count: stationIds.length,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
