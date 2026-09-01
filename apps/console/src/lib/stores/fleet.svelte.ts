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
import { getFleet, listNodes, listRuntimes, listStations, type StationRow } from "$lib/api/client";
import { listPrincipals, type PrincipalSummary } from "$lib/api/grants";
import { auth } from "$lib/stores/auth.svelte";
import { startPolling } from "$lib/utils/poll";

export interface FleetSnapshot {
  agents: FleetAgent[];
  stats: FleetStats | null;
  nodes: NodeSummary[];
  runtimes: ProvisionedRuntime[];
  /** The DB rows behind the agents — the only place `principalId` lives. */
  stations: StationRow[];
  /** Empty for a non-admin; the directory is admin-only. */
  principals: PrincipalSummary[];
  loadedAt: number | null;
}

let agents = $state<FleetAgent[]>([]);
let stats = $state<FleetStats | null>(null);
let nodes = $state<NodeSummary[]>([]);
let runtimes = $state<ProvisionedRuntime[]>([]);
let stations = $state<StationRow[]>([]);
let principals = $state<PrincipalSummary[]>([]);
let isLoading = $state(false);
let error = $state<string | null>(null);
let loadedAt = $state<number | null>(null);

export const fleet = {
  get agents() { return agents; },
  get stats() { return stats; },
  get nodes() { return nodes; },
  get runtimes() { return runtimes; },
  get stations() { return stations; },
  get principals() { return principals; },
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
    // Second phase, not part of the allSettled above because both calls need
    // the node list this one just produced. Together they answer "can
    // anything dispatch this station" — a fact no fleet-wide endpoint
    // carries, and the lane's worst non-error warning.
    await Promise.all([refreshStations(), refreshPrincipals()]);
    loadedAt = Date.now();
  } finally {
    if (!quiet) isLoading = false;
  }
}

/**
 * The station rows for every ONLINE node.
 *
 * `listStations` is per node, so this is a call per node — kept to the online
 * ones because a station on an offline node is already reported by its node,
 * and nothing downstream may say anything else about it.
 */
async function refreshStations(): Promise<void> {
  const onlineNodeIds = nodes.filter((n) => n.status === "online").map((n) => n.id);
  const results = await Promise.allSettled(onlineNodeIds.map((id) => listStations(id)));
  const next: StationRow[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      next.push(...result.value);
    } else {
      // Per-node failure tolerance, the same shape as the per-slice tolerance
      // above: one unreachable node must not blank the rest of the fleet's
      // stations, and this node's last good rows stay until it answers again.
      const nodeId = onlineNodeIds[i];
      next.push(...stations.filter((s) => s.nodeId === nodeId));
    }
  });
  stations = next;
}

/**
 * The principal directory, for `suspendedAt`.
 *
 * Admin-only (`GET /api/admin/principals`). A non-admin asking would 403 on
 * every 30s tick — noise in the hub's log and in the browser's console — so
 * it doesn't ask. What that costs is exactly one case: an empty directory
 * still reports a station with a NULL principal as dispatchable by nobody,
 * but cannot tell that a named principal is suspended.
 */
async function refreshPrincipals(): Promise<void> {
  if (auth.user?.role !== "admin") {
    principals = [];
    return;
  }
  try {
    principals = await listPrincipals();
  } catch {
    // Keep the last good directory rather than emptying it — an empty list
    // reads as "no principal is suspended", which is a claim, not a gap.
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
