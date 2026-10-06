/**
 * Spoken-reply settings, over the hub API.
 *
 * The hub default is admin-only (`/api/admin/settings/speech`); a station's
 * voice, speak mode and service override are its owner's
 * (`/api/stations/:id/speech`). The voice list and previews come through the
 * hub (`/api/speech/voices`), so the console never holds the speech service's
 * token or needs to reach its network.
 *
 * Keys are write-only, exactly as for transcription: `hasApiKey`, and in a
 * write an omitted `apiKey` keeps, `null` clears, a string replaces.
 */

import { authFetch, http, hubUrl } from "./client";
import type { ApiKeyWrite } from "./transcription";

export type { ApiKeyWrite };

export type SpeakMode = "off" | "voice_in" | "always";
export type VoiceSource = "station" | "hub" | "assigned";

export interface HubSpeech {
  enabled: boolean;
  url: string;
  /** "" — every agent gets its own assigned voice. */
  defaultVoice: string;
  mode: SpeakMode;
  maxChars: number;
  hasApiKey: boolean;
  source: "settings" | "env" | "none";
}

export interface HubSpeechInput {
  enabled: boolean;
  url: string;
  defaultVoice: string;
  mode: SpeakMode;
  maxChars: number;
  apiKey?: ApiKeyWrite;
}

export interface SpeechTestResult {
  ok: boolean;
  status?: number;
  error?: string;
  elapsedMs: number;
  durationMs?: number;
  /** The test clip, base64 Ogg/Opus. */
  audio?: string;
}

export type StationSpeechMode = "inherit" | "off" | "custom";

export interface EffectiveSpeech {
  enabled: boolean;
  url: string | null;
  voice: string;
  voiceSource: VoiceSource;
  speakMode: SpeakMode;
  maxChars: number;
  source: "station" | "hub" | "env" | "none";
}

export interface StationSpeech {
  mode: StationSpeechMode;
  voice?: string;
  speakMode?: SpeakMode;
  url?: string;
  hasApiKey: boolean;
  /** The voice this station gets from its id when nobody chooses one. */
  assignedVoice: string;
  /** What it speaks in with no voice of its own: the hub default voice, else the assigned one. */
  inheritedVoice: string;
  inheritedVoiceSource: "hub" | "assigned";
  effective: EffectiveSpeech;
}

export interface StationSpeechInput {
  mode: StationSpeechMode;
  /** `null` goes back to the hub default / assigned voice. */
  voice?: string | null;
  /** `null` goes back to the hub's speak mode. */
  speakMode?: SpeakMode | null;
  url?: string | null;
  apiKey?: ApiKeyWrite;
}

export interface VoiceInfo {
  id: string;
  name: string;
  accent: string;
  gender: string;
  grade: string;
  preview_url: string;
}

export interface VoiceList {
  voices: VoiceInfo[];
  default: string | null;
  aliases: Record<string, string>;
  /** The voices an agent with no chosen voice is assigned from. */
  assignable: string[];
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const getHubSpeech = () => http<HubSpeech>("/api/admin/settings/speech");

export const saveHubSpeech = (input: HubSpeechInput) =>
  http<HubSpeech>("/api/admin/settings/speech", jsonInit("PUT", input));

/** Speak one sentence with the typed (or saved) service; the clip comes back. */
export const testHubSpeech = (input: { url?: string; apiKey?: ApiKeyWrite; voice?: string }) =>
  http<SpeechTestResult>("/api/admin/settings/speech/test", jsonInit("POST", input));

export const getStationSpeech = (stationId: string) =>
  http<StationSpeech>(`/api/stations/${encodeURIComponent(stationId)}/speech`);

export const saveStationSpeech = (stationId: string, input: StationSpeechInput) =>
  http<StationSpeech>(`/api/stations/${encodeURIComponent(stationId)}/speech`, jsonInit("PUT", input));

/** What a harness-mode station's node wrote into its profile. No url, no key. */
export interface SpeechApplyResult {
  applied: boolean;
  /** "on": the harness now speaks through the hub's speech service; "off": the station has none. */
  mode: "on" | "off";
  voice: string | null;
  /** What the hub asked for. */
  speakMode: SpeakMode | null;
  /** What the harness will do: true = it speaks every reply on its own (Hermes voice.auto_tts). */
  autoSpeak: boolean;
  /** False when the station may not be restarted from here (a profile sharing the root gateway). */
  restarted: boolean;
}

/**
 * Push the station's saved voice and speak mode into its harness profile
 * (harness-mode Hermes stations). No body: the node fetches the setting itself.
 */
export const applyStationSpeech = (stationId: string) =>
  http<SpeechApplyResult>(`/api/stations/${encodeURIComponent(stationId)}/speech/apply`, { method: "POST" });

export const listVoices = () => http<VoiceList>("/api/speech/voices");

/**
 * A voice's sample as a blob. Fetched with the console's credential (the session cookie, or the
 * plane's bearer token) rather than pointed at from an `<audio src>`, which would carry neither.
 */
export async function fetchVoicePreview(voiceId: string): Promise<Blob> {
  const res = await authFetch(`${hubUrl()}/api/speech/voices/${encodeURIComponent(voiceId)}/preview`);
  if (!res.ok) throw new Error(`The preview could not be loaded (HTTP ${res.status}).`);
  return res.blob();
}
