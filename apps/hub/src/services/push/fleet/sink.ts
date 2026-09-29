/**
 * Where the Matrix path tells the fleet Live Activity what happened.
 *
 * A module-level sink, installed at boot only when the push gateway is on —
 * so `outbound.ts`, `permissions.ts` and `gates.ts` report into it without
 * knowing whether anything is listening, and a hub with no APNs does no
 * lookups and keeps no state for it at all.
 */

import type { FleetEvent } from "./state";

export interface FleetSink {
  note(reader: string, event: FleetEvent): void;
  clearDecision(key: string): void;
  reconcileGates(boardId: string, pendingGateIds: ReadonlySet<string>): void;
  knowsDecision(key: string): boolean;
}

let current: FleetSink | null = null;

export function setFleetSink(sink: FleetSink | null): void {
  current = sink;
}

export function fleetSink(): FleetSink | null {
  return current;
}

export function noteFleet(reader: string, event: FleetEvent): void {
  current?.note(reader, event);
}

export function clearFleetDecision(key: string): void {
  current?.clearDecision(key);
}

/** One permission per room at a time — the session parks until it is answered. */
export const permissionDecisionKey = (roomId: string) => `perm:${roomId}`;
export const gateDecisionKey = (gateId: string) => `gate:${gateId}`;
