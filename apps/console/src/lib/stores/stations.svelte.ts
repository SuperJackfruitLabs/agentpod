import type { DetectedStation } from "@agentpod/contract";
import type { StationRow } from "$lib/api/client";
import * as api from "$lib/api/client";
import { ApiError } from "$lib/api/http-error";

let detected = $state<DetectedStation[]>([]);
let adopted = $state<StationRow[]>([]);
let isLoading = $state(false);
let error = $state<string | null>(null);
/**
 * The node itself could not answer detect: the hub reached us fine and said so (503/424, see
 * isStationFailure)
 * (node offline, timed out, or sent garbage). A node problem, never a hub-connection one, so it
 * is kept apart from `error` and the page words it about the node.
 */
let nodeUnreachable = $state(false);

export const stations = {
  get detected() { return detected; },
  get adopted() { return adopted; },
  get isLoading() { return isLoading; },
  get error() { return error; },
  get nodeUnreachable() { return nodeUnreachable; },
};

/**
 * The hub answered, and the node or station is what failed: 503 `station_unavailable` or 424
 * `node_failed` (spec 2026-10-23, C16), or a 502 from a hub older than that rule.
 */
export function isStationFailure(e: ApiError): boolean {
  if (e.status === 502) return true;
  return (e.status === 503 || e.status === 424) && (e.code === "station_unavailable" || e.code === "node_failed");
}

export async function loadDetected(nodeId: string, nodeOffline = false): Promise<void> {
  isLoading = true; error = null; nodeUnreachable = false;
  try { detected = await api.listDetected(nodeId); }
  catch (e) {
    // 502: the hub answered for a node it could not reach. An offline node with any other hub
    // answer is the same story. Only a request that never reached the hub (status null) is
    // a connection problem.
    if (e instanceof ApiError && (isStationFailure(e) || (nodeOffline && e.status !== null))) { detected = []; nodeUnreachable = true; }
    else error = e instanceof Error ? e.message : "Couldn’t load detected agents.";
  }
  finally { isLoading = false; }
}

export async function adopt(nodeId: string, keys: string[]): Promise<void> {
  isLoading = true; error = null;
  try {
    await api.adoptStations(nodeId, keys);
    adopted = await api.listStations(nodeId);
  }
  catch (e) { error = e instanceof Error ? e.message : "Couldn’t add the agents."; }
  finally { isLoading = false; }
}

export async function loadAdopted(nodeId: string): Promise<void> {
  isLoading = true; error = null;
  try { adopted = await api.listStations(nodeId); }
  catch (e) { error = e instanceof Error ? e.message : "Couldn’t load your agents."; }
  finally { isLoading = false; }
}
