/**
 * The single state vocabulary for the fleet.
 *
 * Every station/node/runtime/session status string the hub returns is
 * narrowed here to one of six StateIds before it ever reaches markup.
 * That's the enforcement point for "colour means state": nothing downstream
 * picks a colour on its own, it looks up a StateInfo and uses its token.
 */

export type StateId = "running" | "starting" | "unknown" | "error" | "sleeping" | "stopped";

export interface StateInfo {
  id: StateId;
  /** Sentence-case, for the word that always accompanies the dot. */
  label: string;
  /** Tailwind colour token suffix: use as bg-status-{token} / text-status-{token}. */
  token: StateId;
}

export const STATE: Record<StateId, StateInfo> = {
  running: { id: "running", label: "Running", token: "running" },
  starting: { id: "starting", label: "Starting", token: "starting" },
  unknown: { id: "unknown", label: "Unknown", token: "unknown" },
  error: { id: "error", label: "Error", token: "error" },
  sleeping: { id: "sleeping", label: "Sleeping", token: "sleeping" },
  stopped: { id: "stopped", label: "Stopped", token: "stopped" },
};

/** Worst-first, for sorting and for grouping the roster by state. */
export const STATE_ORDER: StateId[] = ["error", "unknown", "starting", "running", "sleeping", "stopped"];

/** FleetAgent.status ("running" | "stopped" | "error" | "unknown") → StateInfo. */
export function stationState(status: string): StateInfo {
  switch (status) {
    case "running":
      return STATE.running;
    case "stopped":
      return STATE.stopped;
    case "error":
      return STATE.error;
    case "unknown":
      return STATE.unknown;
    default:
      return STATE.unknown;
  }
}

/** NodeSummary.status ("online" | "offline") → StateInfo. */
export function nodeState(status: string): StateInfo {
  switch (status) {
    case "online":
      return STATE.running;
    case "offline":
      return STATE.error;
    default:
      return STATE.unknown;
  }
}

/** ProvisionedRuntime.status (8 values) → StateInfo. */
export function runtimeState(status: string): StateInfo {
  switch (status) {
    case "provisioning":
    case "starting":
    case "stopping":
      return STATE.starting;
    case "online":
      return STATE.running;
    case "stopped":
    case "destroyed":
      return STATE.stopped;
    case "asleep":
      return STATE.sleeping;
    case "error":
      return STATE.error;
    default:
      return STATE.unknown;
  }
}

/** AcpSessionStatus ("starting"|"idle"|"working"|"waiting"|"ended") → StateInfo. */
export function sessionState(status: string): StateInfo {
  switch (status) {
    case "starting":
      return STATE.starting;
    case "idle":
      return STATE.stopped;
    case "working":
      return STATE.running;
    case "waiting":
      return STATE.unknown;
    case "ended":
      return STATE.stopped;
    default:
      return STATE.unknown;
  }
}
