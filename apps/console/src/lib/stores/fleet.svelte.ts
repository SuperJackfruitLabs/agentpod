/**
 * One shared fleet poll.
 *
 * `NodesOverview` and `/agents` used to each run their own 30s poll of
 * overlapping endpoints. The shell, the roster rail, the attention lane and
 * the muster all need the same three calls (getFleet + listNodes +
 * listRuntimes) — this module makes that a single ref-counted poll instead
 * of one per consumer.
 */
import type { FleetAgent, FleetStats, NodeSummary, ProvisionedRuntime } from "@agentpod/contract";
import { getFleet, listNodes, listRuntimes } from "$lib/api/client";
import { startPolling } from "$lib/utils/poll";

export interface FleetSnapshot {
  agents: FleetAgent[];
  stats: FleetStats | null;
  nodes: NodeSummary[];
  runtimes: ProvisionedRuntime[];
  loadedAt: number | null;
}

let agents = $state<FleetAgent[]>([]);
let stats = $state<FleetStats | null>(null);
let nodes = $state<NodeSummary[]>([]);
let runtimes = $state<ProvisionedRuntime[]>([]);
let isLoading = $state(false);
let error = $state<string | null>(null);
let loadedAt = $state<number | null>(null);

export const fleet = {
  get agents() { return agents; },
  get stats() { return stats; },
  get nodes() { return nodes; },
  get runtimes() { return runtimes; },
  get isLoading() { return isLoading; },
  get error() { return error; },
  get loadedAt() { return loadedAt; },
};

/**
 * Refreshes the shared snapshot. Per-result failure tolerance, exactly as
 * NodesOverview.loadData does: one dead endpoint must not blank the shell —
 * the last good value for that slice stays on screen and no global error is
 * set for it. `quiet` skips the isLoading flip, for background poll ticks
 * that shouldn't flash a loading state over data already on screen.
 */
export async function refreshFleet(quiet = false): Promise<void> {
  if (!quiet) {
    isLoading = true;
    error = null;
  }
  try {
    const [fleetResult, nodesResult, runtimesResult] = await Promise.allSettled([
      getFleet(),
      listNodes(),
      listRuntimes(),
    ]);
    if (fleetResult.status === "fulfilled") {
      agents = fleetResult.value.agents;
      stats = fleetResult.value.stats;
    } else if (!quiet) {
      error = fleetResult.reason instanceof Error ? fleetResult.reason.message : "Couldn't load the fleet.";
    }
    if (nodesResult.status === "fulfilled") {
      nodes = nodesResult.value;
    }
    // nodes/runtimes failing is non-fatal — keep the previous value, same as NodesOverview
    if (runtimesResult.status === "fulfilled") {
      runtimes = runtimesResult.value;
    }
    loadedAt = Date.now();
  } finally {
    if (!quiet) isLoading = false;
  }
}

// Ref-counted: several consumers (shell, roster, lane, muster) each call
// startFleetPoll on mount and stop() on unmount. Only the last stop() should
// actually tear the interval down — an earlier unmount must not cut off a
// still-mounted consumer.
let refCount = 0;
let stopInterval: (() => void) | null = null;

/** Idempotent. Returns a stop function. Ref-counted: the last caller to stop ends the poll. */
export function startFleetPoll(): () => void {
  refCount += 1;
  if (refCount === 1) {
    void refreshFleet();
    stopInterval = startPolling(() => void refreshFleet(true), 30_000);
  }

  let stopped = false;
  return () => {
    if (stopped) return; // calling the returned stop function twice is a no-op
    stopped = true;
    refCount -= 1;
    if (refCount === 0 && stopInterval) {
      stopInterval();
      stopInterval = null;
    }
  };
}
