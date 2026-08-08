import type { DetectedStation } from "@agentpod/contract";
import type { StationRow } from "$lib/api/client";
import * as api from "$lib/api/client";

let detected = $state<DetectedStation[]>([]);
let adopted = $state<StationRow[]>([]);
let isLoading = $state(false);
let error = $state<string | null>(null);

export const stations = {
  get detected() { return detected; },
  get adopted() { return adopted; },
  get isLoading() { return isLoading; },
  get error() { return error; },
};

export async function loadDetected(nodeId: string): Promise<void> {
  isLoading = true; error = null;
  try { detected = await api.listDetected(nodeId); }
  catch (e) { error = e instanceof Error ? e.message : "Couldn’t load detected agents."; }
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
