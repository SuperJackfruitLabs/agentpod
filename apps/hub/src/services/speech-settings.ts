/**
 * Which text-to-speech service speaks a station's replies, in which voice,
 * and when.
 *
 * The service, most specific first — transcription's precedence, copied
 * (`transcription-settings.ts`):
 *
 *   1. the station's own setting — `custom` names a service, `off` says none;
 *   2. the hub-wide setting an admin saved in the console (`system_settings`,
 *      key `speech`, one JSON row);
 *   3. the SPEECH_* environment — only while nothing is saved at (2);
 *   4. nothing: replies stay text.
 *
 * A saved hub setting that is disabled is an answer ("off"), not an absence.
 *
 * Two things override on their own, with the service left inherited:
 *
 *   - **voice**: the station's, else the hub default voice, else one assigned
 *     from the station's id (`assignedVoiceFor`) — so a fleet of agents does
 *     not all sound the same unless an admin says so;
 *   - **speakMode**: `off` | `voice_in` (answer a voice note with a voice
 *     note) | `always`; the station's, else the hub's.
 *
 * API keys are encrypted at rest and write-only (`hasApiKey`). Answers are
 * cached for 30 s in this process; every save clears the cache.
 *
 * `resolveSpeechFor` is what the Matrix bridge asks when a turn ends, and what
 * a node reads (routes/station-speech-node.ts) to write a harness-mode
 * station's profile (`speech.apply`).
 */

import { eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { systemSettings } from "../db/schema/admin";
import { stations } from "../db/schema/stations";
import { stationSpeech } from "../db/schema/speech";
import { decrypt, encrypt } from "../utils/encryption";
import { createLogger } from "../utils/logger";

const log = createLogger("speech-settings");

// =============================================================================
// Shapes
// =============================================================================

export const SPEECH_SETTING_KEY = "speech";
export const CACHE_TTL_MS = 30_000;

export const SPEAK_MODES = ["off", "voice_in", "always"] as const;
export type SpeakMode = (typeof SPEAK_MODES)[number];
export const DEFAULT_SPEAK_MODE: SpeakMode = "voice_in";

/** The longest reply spoken, in characters; the speech service takes 4096. */
export const DEFAULT_MAX_CHARS = 1500;
export const MIN_MAX_CHARS = 100;
export const MAX_MAX_CHARS = 4096;

/**
 * The voices an agent is assigned from when nobody chose one: the best-graded
 * of the speech service's 28 (deploy/speech), US and UK, female and male.
 * **Order is load-bearing**: `assignedVoiceFor` indexes into it, so reordering
 * or inserting changes every unassigned agent's voice. Append only.
 */
export const CURATED_VOICES = [
  "af_heart",
  "af_bella",
  "bf_emma",
  "af_nicole",
  "am_michael",
  "am_fenrir",
  "am_puck",
  "af_aoede",
  "af_kore",
  "af_sarah",
  "bf_isabella",
  "bm_george",
  "bm_fable",
  "af_nova",
  "af_alloy",
] as const;

/**
 * A station's own voice when nobody chose one: FNV-1a (32-bit) of its id,
 * modulo the curated list. Pure and stable across restarts and hubs — no
 * state, no randomness — so an agent keeps its voice for its whole life.
 */
export function assignedVoiceFor(stationId: string): string {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(stationId)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return CURATED_VOICES[h % CURATED_VOICES.length]!;
}

export function isSpeakMode(value: unknown): value is SpeakMode {
  return typeof value === "string" && (SPEAK_MODES as readonly string[]).includes(value);
}

export type SpeechSource = "station" | "hub" | "env";
export type VoiceSource = "station" | "hub" | "assigned";

/** What a turn's end needs to speak a reply. */
export interface ResolvedSpeech {
  url: string;
  apiKey: string;
  voice: string;
  voiceSource: VoiceSource;
  speakMode: SpeakMode;
  maxChars: number;
  source: SpeechSource;
}

export type StationSpeechMode = "inherit" | "off" | "custom";

export interface HubSpeechRecord {
  enabled: boolean;
  url: string;
  /** "" = every agent gets its assigned voice. */
  defaultVoice: string;
  mode: SpeakMode;
  maxChars: number;
  apiKeyEncrypted: string | null;
}

export interface StationSpeechRecord {
  mode: StationSpeechMode;
  voice: string | null;
  speakMode: SpeakMode | null;
  url: string | null;
  apiKeyEncrypted: string | null;
}

export interface SpeechStore {
  getHub(): Promise<HubSpeechRecord | null>;
  setHub(record: HubSpeechRecord, updatedBy?: string): Promise<void>;
  getStation(stationId: string): Promise<StationSpeechRecord | null>;
  setStation(stationId: string, record: StationSpeechRecord, updatedBy?: string): Promise<void>;
}

export interface Cipher {
  encrypt(plain: string): Promise<string>;
  decrypt(cipher: string): Promise<string>;
}

/** Omitted keeps the saved key, `null` clears it, a string replaces it. */
export type ApiKeyWrite = string | null | undefined;

export interface HubSpeechInput {
  enabled: boolean;
  url: string;
  defaultVoice: string;
  mode: SpeakMode;
  maxChars: number;
  apiKey?: ApiKeyWrite;
}

/** Omitted fields keep what was saved; `null` clears voice/speakMode back to inherited. */
export interface StationSpeechInput {
  mode: StationSpeechMode;
  voice?: string | null;
  speakMode?: SpeakMode | null;
  url?: string | null;
  apiKey?: ApiKeyWrite;
}

export interface HubSpeechView {
  enabled: boolean;
  url: string;
  defaultVoice: string;
  mode: SpeakMode;
  maxChars: number;
  hasApiKey: boolean;
  source: "settings" | "env" | "none";
}

export interface EffectiveSpeech {
  /** Whether a service is in effect for this station. */
  enabled: boolean;
  url: string | null;
  /** The voice it speaks in — set even with no service, for stage 3. */
  voice: string;
  voiceSource: VoiceSource;
  speakMode: SpeakMode;
  maxChars: number;
  source: SpeechSource | "none";
}

export interface StationSpeechView {
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

/** Where a speech service is and how to ask it. */
export interface SpeechEndpoint {
  url: string;
  apiKey: string;
}

/** The hub default the environment describes, or null when SPEECH_URL is unset. */
export function speechFromEnv(env: Record<string, string | undefined>): {
  url: string;
  apiKey: string;
  defaultVoice: string;
  mode: SpeakMode;
  maxChars: number;
} | null {
  const url = env.SPEECH_URL?.trim();
  if (!url) return null;
  const mode = env.SPEECH_MODE?.trim();
  const maxChars = Number(env.SPEECH_MAX_CHARS);
  return {
    url,
    apiKey: env.SPEECH_API_KEY?.trim() ?? "",
    defaultVoice: env.SPEECH_VOICE?.trim() ?? "",
    mode: isSpeakMode(mode) ? mode : DEFAULT_SPEAK_MODE,
    maxChars:
      Number.isInteger(maxChars) && maxChars >= MIN_MAX_CHARS && maxChars <= MAX_MAX_CHARS
        ? maxChars
        : DEFAULT_MAX_CHARS,
  };
}

// =============================================================================
// The service
// =============================================================================

export function createSpeechSettings(deps: {
  store: SpeechStore;
  cipher: Cipher;
  env: Record<string, string | undefined>;
  now?: () => number;
  ttlMs?: number;
}) {
  const { store, cipher, env } = deps;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? CACHE_TTL_MS;
  const cache = new Map<string, { at: number; value: Promise<ResolvedSpeech | null> }>();

  function invalidate(): void {
    cache.clear();
  }

  async function reveal(encrypted: string | null): Promise<string> {
    if (!encrypted) return "";
    try {
      return await cipher.decrypt(encrypted);
    } catch {
      log.error("a stored speech API key could not be decrypted; has ENCRYPTION_KEY changed?");
      return "";
    }
  }

  async function seal(write: ApiKeyWrite, previous: string | null): Promise<string | null> {
    if (write === undefined) return previous;
    if (write === null || write.trim() === "") return null;
    return cipher.encrypt(write.trim());
  }

  /** The hub default: saved, else env, else none — with its key readable. */
  async function hubDefaults(): Promise<{
    /** In effect: switched on and with a url. */
    enabled: boolean;
    /** The switch as saved (true for env). */
    switchedOn: boolean;
    url: string;
    apiKey: string;
    hasApiKey: boolean;
    defaultVoice: string;
    mode: SpeakMode;
    maxChars: number;
    source: "settings" | "env" | "none";
  }> {
    const hub = await store.getHub();
    if (hub) {
      return {
        enabled: hub.enabled && hub.url !== "",
        switchedOn: hub.enabled,
        url: hub.url,
        apiKey: await reveal(hub.apiKeyEncrypted),
        hasApiKey: !!hub.apiKeyEncrypted,
        defaultVoice: hub.defaultVoice,
        mode: hub.mode,
        maxChars: hub.maxChars,
        source: "settings",
      };
    }
    const fromEnv = speechFromEnv(env);
    if (fromEnv) return { ...fromEnv, enabled: true, switchedOn: true, hasApiKey: fromEnv.apiKey !== "", source: "env" };
    return {
      enabled: false,
      switchedOn: false,
      url: "",
      apiKey: "",
      hasApiKey: false,
      defaultVoice: "",
      mode: DEFAULT_SPEAK_MODE,
      maxChars: DEFAULT_MAX_CHARS,
      source: "none",
    };
  }

  /** Everything about a station's speech, service or not. */
  async function effectiveFor(stationId: string): Promise<{
    service: (SpeechEndpoint & { source: SpeechSource }) | null;
    voice: string;
    voiceSource: VoiceSource;
    inherited: { voice: string; voiceSource: "hub" | "assigned" };
    speakMode: SpeakMode;
    maxChars: number;
  }> {
    const [station, hub] = await Promise.all([store.getStation(stationId), hubDefaults()]);
    let service: (SpeechEndpoint & { source: SpeechSource }) | null = null;
    if (station?.mode === "custom" && station.url) {
      service = { url: station.url, apiKey: await reveal(station.apiKeyEncrypted), source: "station" };
    } else if (station?.mode !== "off" && hub.enabled) {
      service = { url: hub.url, apiKey: hub.apiKey, source: hub.source === "env" ? "env" : "hub" };
    }
    const inherited: { voice: string; voiceSource: "hub" | "assigned" } = hub.defaultVoice
      ? { voice: hub.defaultVoice, voiceSource: "hub" }
      : { voice: assignedVoiceFor(stationId), voiceSource: "assigned" };
    const voice: { voice: string; voiceSource: VoiceSource } = station?.voice
      ? { voice: station.voice, voiceSource: "station" }
      : inherited;
    return {
      service,
      ...voice,
      inherited,
      speakMode: station?.speakMode ?? hub.mode,
      maxChars: hub.maxChars,
    };
  }

  async function resolveUncached(stationId: string): Promise<ResolvedSpeech | null> {
    const e = await effectiveFor(stationId);
    if (!e.service) return null;
    return {
      url: e.service.url,
      apiKey: e.service.apiKey,
      voice: e.voice,
      voiceSource: e.voiceSource,
      speakMode: e.speakMode,
      maxChars: e.maxChars,
      source: e.service.source,
    };
  }

  function resolveFor(stationId: string): Promise<ResolvedSpeech | null> {
    const hit = cache.get(stationId);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = resolveUncached(stationId);
    const entry = { at: now(), value };
    cache.set(stationId, entry);
    value.catch(() => {
      if (cache.get(stationId) === entry) cache.delete(stationId);
    });
    return value;
  }

  async function getHubView(): Promise<HubSpeechView> {
    const hub = await hubDefaults();
    return {
      enabled: hub.switchedOn,
      url: hub.url,
      defaultVoice: hub.defaultVoice,
      mode: hub.mode,
      maxChars: hub.maxChars,
      hasApiKey: hub.hasApiKey,
      source: hub.source,
    };
  }

  async function putHub(input: HubSpeechInput, updatedBy?: string): Promise<HubSpeechView> {
    const url = input.url.trim();
    if (input.enabled && !url) throw new Error("a url is required to enable spoken replies");
    const previous = await store.getHub();
    await store.setHub(
      {
        enabled: input.enabled,
        url,
        defaultVoice: input.defaultVoice.trim(),
        mode: input.mode,
        maxChars: input.maxChars,
        apiKeyEncrypted: await seal(input.apiKey, previous?.apiKeyEncrypted ?? null),
      },
      updatedBy
    );
    invalidate();
    return getHubView();
  }

  async function getStationView(stationId: string): Promise<StationSpeechView> {
    const [station, e] = await Promise.all([store.getStation(stationId), effectiveFor(stationId)]);
    const view: StationSpeechView = {
      mode: station?.mode ?? "inherit",
      hasApiKey: !!station?.apiKeyEncrypted,
      assignedVoice: assignedVoiceFor(stationId),
      inheritedVoice: e.inherited.voice,
      inheritedVoiceSource: e.inherited.voiceSource,
      effective: {
        enabled: e.service !== null,
        url: e.service?.url ?? null,
        voice: e.voice,
        voiceSource: e.voiceSource,
        speakMode: e.speakMode,
        maxChars: e.maxChars,
        source: e.service?.source ?? "none",
      },
    };
    if (station?.voice) view.voice = station.voice;
    if (station?.speakMode) view.speakMode = station.speakMode;
    if (station?.url) view.url = station.url;
    return view;
  }

  async function putStation(
    stationId: string,
    input: StationSpeechInput,
    updatedBy?: string
  ): Promise<StationSpeechView> {
    const previous = await store.getStation(stationId);
    const keep = <T,>(sent: T | null | undefined, saved: T | null | undefined): T | null =>
      sent === undefined ? (saved ?? null) : sent;
    const url = input.url === undefined ? (previous?.url ?? null) : input.url?.trim() || null;
    if (input.mode === "custom" && !url) throw new Error("a url is required for a custom speech service");
    const voice = input.voice === undefined ? (previous?.voice ?? null) : input.voice?.trim() || null;
    await store.setStation(
      stationId,
      {
        mode: input.mode,
        voice,
        speakMode: keep(input.speakMode, previous?.speakMode),
        url,
        apiKeyEncrypted: await seal(input.apiKey, previous?.apiKeyEncrypted ?? null),
      },
      updatedBy
    );
    invalidate();
    return getStationView(stationId);
  }

  /**
   * The hub's own service, whether or not it is enabled for replies: what the
   * console's voice list and previews are fetched from. Saved, else env.
   */
  async function hubEndpoint(): Promise<SpeechEndpoint | null> {
    const hub = await hubDefaults();
    return hub.url ? { url: hub.url, apiKey: hub.apiKey } : null;
  }

  /** What a connection test hits: typed values over the saved (or env) ones. */
  async function endpointForTest(overrides: { url?: string; apiKey?: ApiKeyWrite }): Promise<SpeechEndpoint | null> {
    const saved = await hubEndpoint();
    const url = overrides.url?.trim() || saved?.url || "";
    if (!url) return null;
    return {
      url,
      apiKey: overrides.apiKey === undefined ? (saved?.apiKey ?? "") : (overrides.apiKey ?? ""),
    };
  }

  return { resolveFor, getHubView, putHub, getStationView, putStation, hubEndpoint, endpointForTest, invalidate };
}

export type SpeechSettings = ReturnType<typeof createSpeechSettings>;

// =============================================================================
// Postgres
// =============================================================================

/** One `system_settings` row of JSON, like `transcription`: one atomic save. */
export const dbSpeechStore: SpeechStore = {
  async getHub() {
    const [row] = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, SPEECH_SETTING_KEY))
      .limit(1);
    if (!row) return null;
    try {
      const v = JSON.parse(row.value) as Partial<HubSpeechRecord>;
      return {
        enabled: v.enabled === true,
        url: typeof v.url === "string" ? v.url : "",
        defaultVoice: typeof v.defaultVoice === "string" ? v.defaultVoice : "",
        mode: isSpeakMode(v.mode) ? v.mode : DEFAULT_SPEAK_MODE,
        maxChars: typeof v.maxChars === "number" ? v.maxChars : DEFAULT_MAX_CHARS,
        apiKeyEncrypted: typeof v.apiKeyEncrypted === "string" ? v.apiKeyEncrypted : null,
      };
    } catch {
      log.error("the saved hub speech setting is not valid JSON; treating it as disabled");
      return {
        enabled: false,
        url: "",
        defaultVoice: "",
        mode: DEFAULT_SPEAK_MODE,
        maxChars: DEFAULT_MAX_CHARS,
        apiKeyEncrypted: null,
      };
    }
  },

  async setHub(record, updatedBy) {
    const value = JSON.stringify(record);
    await db
      .insert(systemSettings)
      .values({
        key: SPEECH_SETTING_KEY,
        value,
        description: "Spoken replies: text-to-speech service (hub default)",
        updatedBy,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedBy, updatedAt: new Date() } });
    log.info("hub speech setting saved", { enabled: record.enabled, url: record.url, mode: record.mode, updatedBy });
  },

  async getStation(stationId) {
    const [row] = await db.select().from(stationSpeech).where(eq(stationSpeech.stationId, stationId)).limit(1);
    if (!row) return null;
    return {
      mode: row.mode === "off" || row.mode === "custom" ? row.mode : "inherit",
      voice: row.voice,
      speakMode: isSpeakMode(row.speakMode) ? row.speakMode : null,
      url: row.url,
      apiKeyEncrypted: row.apiKeyEncrypted,
    };
  },

  async setStation(stationId, record, updatedBy) {
    const [station] = await db
      .select({ tenantId: stations.tenantId })
      .from(stations)
      .where(eq(stations.id, stationId))
      .limit(1);
    if (!station) throw new Error(`no station ${stationId}`);
    const values = { ...record, tenantId: station.tenantId, updatedBy: updatedBy ?? null, updatedAt: new Date() };
    await db
      .insert(stationSpeech)
      .values({ stationId, ...values })
      .onConflictDoUpdate({ target: stationSpeech.stationId, set: values });
    log.info("station speech setting saved", {
      stationId,
      mode: record.mode,
      voice: record.voice,
      speakMode: record.speakMode,
      url: record.url,
      updatedBy,
    });
  },
};

export const speechSettings = createSpeechSettings({
  store: dbSpeechStore,
  cipher: { encrypt, decrypt },
  env: process.env,
});

/**
 * The service, voice and speak mode for a station's replies, or null when no
 * service is in effect. Cached for 30 s.
 */
export function resolveSpeechFor(stationId: string): Promise<ResolvedSpeech | null> {
  return speechSettings.resolveFor(stationId);
}
