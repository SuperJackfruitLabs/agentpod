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

/**
 * Provisioning ONE station, on demand, and waiting for the answer.
 *
 * The adoption hook above is fire-and-forget because adoption has already
 * succeeded by the time it runs and must not be undone by a homeserver.
 * This one is awaited, because its caller — `routes/agents-admin.ts`'s
 * assign endpoint — is the act that makes a station dispatchable, and
 * whether the agent actually got a room is part of the answer an operator
 * needs, not a detail to discover weeks later from a silent gate.
 *
 * The whole-branch review's Critical: assigning an agent wrote
 * `stations.principal_id`, conditionally bound an EXISTING unbound room,
 * and never provisioned. The console reaches no other provisioning trigger
 * — `onStationsAdopted` fires before there is an occupant, and
 * `provision.ts` returns early for a bridge-mode station with none — so a
 * console-created agent had no room, its gates resolved to `no-room`, and
 * `gate-sweep.ts` does not count that status. Silent, and permanent until
 * somebody restarted the hub.
 */
type Provisioner = (stationId: string) => Promise<void>;

let provisioner: Provisioner | null = null;

/** Register the one provisioner. Boot wiring, same as `onStationsAdopted`. */
export function onProvisionStation(fn: Provisioner | null): void {
  provisioner = fn;
}

/**
 * Whether a station ended up with a Matrix room, and if not, why not.
 *
 * `"no-bridge"` is a real answer rather than a failure: a hub with
 * `MATRIX_AS_*` unset has no homeserver, no rooms for anything, and an
 * assignment there is complete when the row is written. Distinguished from
 * `"failed"` so a caller never reports a configuration choice as a fault,
 * or a fault as a configuration choice.
 */
export type ProvisionOutcome =
  | { status: "provisioned" }
  | { status: "no-bridge" }
  | { status: "failed"; error: string };

export async function provisionStationNow(stationId: string): Promise<ProvisionOutcome> {
  if (!provisioner) return { status: "no-bridge" };
  try {
    await provisioner(stationId);
    return { status: "provisioned" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("could not provision a Matrix room for a station", { stationId, error });
    return { status: "failed", error };
  }
}
