/**
 * Voice-note transcription settings, over the hub API.
 *
 * The hub default is admin-only (`/api/admin/settings/transcription`); a
 * station's override is its owner's (`/api/stations/:id/transcription`).
 *
 * API keys are write-only: the hub answers `hasApiKey`, never the key. In a
 * write, an omitted `apiKey` keeps the saved one, `null` clears it, and a
 * string replaces it — see `ApiKeyWrite`.
 */

import { http } from "./client";

/** Omitted keeps the saved key; `null` clears it; a string replaces it. */
export type ApiKeyWrite = string | null | undefined;

export interface HubTranscription {
  enabled: boolean;
  url: string;
  model: string;
  maxSeconds: number;
  hasApiKey: boolean;
  /** Where the hub's answer comes from: saved here, the hub's env, or nowhere. */
  source: "settings" | "env" | "none";
}

export interface HubTranscriptionInput {
  enabled: boolean;
  url: string;
  model: string;
  maxSeconds: number;
  apiKey?: ApiKeyWrite;
}

export interface TranscriptionTestResult {
  ok: boolean;
  status?: number;
  error?: string;
  elapsedMs: number;
}

export type StationTranscriptionMode = "inherit" | "off" | "custom";

export interface EffectiveTranscription {
  enabled: boolean;
  url: string | null;
  model: string | null;
  maxSeconds: number | null;
  source: "station" | "hub" | "env" | "none";
}

export interface StationTranscription {
  mode: StationTranscriptionMode;
  url?: string;
  model?: string;
  maxSeconds?: number;
  hasApiKey: boolean;
  effective: EffectiveTranscription;
}

export interface StationTranscriptionInput {
  mode: StationTranscriptionMode;
  url?: string | null;
  model?: string | null;
  maxSeconds?: number | null;
  apiKey?: ApiKeyWrite;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  // `undefined` fields drop out of JSON — which is exactly "keep the saved key".
  body: JSON.stringify(body),
});

export const getHubTranscription = () => http<HubTranscription>("/api/admin/settings/transcription");

export const saveHubTranscription = (input: HubTranscriptionInput) =>
  http<HubTranscription>("/api/admin/settings/transcription", jsonInit("PUT", input));

/** Send one second of silence to the typed (or saved) service. */
export const testHubTranscription = (input: { url?: string; model?: string; apiKey?: ApiKeyWrite }) =>
  http<TranscriptionTestResult>("/api/admin/settings/transcription/test", jsonInit("POST", input));

export const getStationTranscription = (stationId: string) =>
  http<StationTranscription>(`/api/stations/${encodeURIComponent(stationId)}/transcription`);

export const saveStationTranscription = (stationId: string, input: StationTranscriptionInput) =>
  http<StationTranscription>(
    `/api/stations/${encodeURIComponent(stationId)}/transcription`,
    jsonInit("PUT", input)
  );

/** What a harness-mode station's node wrote into its profile. No url, no key. */
export interface TranscriptionApplyResult {
  applied: boolean;
  mode: "on" | "off";
  model: string | null;
  /** False when the station may not be restarted from here (a profile sharing the root gateway). */
  restarted: boolean;
}

/**
 * Push the station's saved setting into its harness profile (harness-mode
 * Hermes stations). No body: the node fetches the setting from the hub itself.
 */
export const applyStationTranscription = (stationId: string) =>
  http<TranscriptionApplyResult>(`/api/stations/${encodeURIComponent(stationId)}/transcription/apply`, {
    method: "POST",
  });
