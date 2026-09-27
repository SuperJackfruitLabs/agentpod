/**
 * Which speech-to-text service hears a station's voice notes.
 *
 * Four places can answer, most specific first:
 *
 *   1. the station's own setting — `custom` names a service, `off` says none;
 *   2. the hub-wide setting an admin saved in the console (`system_settings`,
 *      key `transcription`, one JSON row — see `dbTranscriptionStore`);
 *   3. the TRANSCRIBE_* environment the hub was started with — only when
 *      nothing is saved at (2), so a hub configured before the console could
 *      configure it keeps working with no migration step;
 *   4. nothing: voice notes are named to the agent, not heard.
 *
 * A saved hub setting that is disabled is an answer ("off"), not an absence —
 * it does not fall through to the environment.
 *
 * API keys are encrypted at rest (`utils/encryption.ts`) and write-only: every
 * view this module returns says `hasApiKey`, never the key or its ciphertext.
 *
 * `resolveTranscriptionFor` is what the Matrix bridge asks per voice note, and
 * what Phase B (pushing the setting to harness-mode stations) will import.
 * Answers are cached for 30 s in this process; every save clears the cache.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { systemSettings } from "../db/schema/admin";
import { stations } from "../db/schema/stations";
import { stationTranscription } from "../db/schema/transcription";
import { decrypt, encrypt } from "../utils/encryption";
import { createLogger } from "../utils/logger";
import {
  DEFAULT_TRANSCRIBE_MODEL,
  MAX_VOICE_SECONDS,
  openAiTranscriber,
  transcriptionFromEnv,
  type Transcriber,
  type TranscriptionEndpoint,
} from "./matrix-as/voice";

const log = createLogger("transcription-settings");

// =============================================================================
// Shapes
// =============================================================================

/** The bounds on a configurable voice-note length, in seconds. */
export const MIN_MAX_SECONDS = 10;
export const MAX_MAX_SECONDS = 600;

/** The `system_settings` key the hub-wide setting lives under. */
export const TRANSCRIPTION_SETTING_KEY = "transcription";

export const CACHE_TTL_MS = 30_000;

export type TranscriptionSource = "station" | "hub" | "env";

/** A service to send a station's voice notes to. Phase B imports this shape. */
export interface ResolvedTranscription {
  url: string;
  apiKey: string;
  model: string;
  maxSeconds: number;
  source: TranscriptionSource;
}

export type StationTranscriptionMode = "inherit" | "off" | "custom";

/** The hub-wide setting as stored. */
export interface HubTranscriptionRecord {
  enabled: boolean;
  url: string;
  model: string;
  maxSeconds: number;
  apiKeyEncrypted: string | null;
}

/** A station's setting as stored. */
export interface StationTranscriptionRecord {
  mode: StationTranscriptionMode;
  url: string | null;
  model: string | null;
  maxSeconds: number | null;
  apiKeyEncrypted: string | null;
}

export interface TranscriptionStore {
  getHub(): Promise<HubTranscriptionRecord | null>;
  setHub(record: HubTranscriptionRecord, updatedBy?: string): Promise<void>;
  getStation(stationId: string): Promise<StationTranscriptionRecord | null>;
  setStation(stationId: string, record: StationTranscriptionRecord, updatedBy?: string): Promise<void>;
}

export interface Cipher {
  encrypt(plain: string): Promise<string>;
  decrypt(cipher: string): Promise<string>;
}

/**
 * A key in a write: omitted keeps the saved one, `null` clears it, a string
 * replaces it. The console never holds the saved key, so "keep" has to be
 * expressible without sending it back.
 */
export type ApiKeyWrite = string | null | undefined;

export interface HubTranscriptionInput {
  enabled: boolean;
  url: string;
  model: string;
  maxSeconds: number;
  apiKey?: ApiKeyWrite;
}

export interface StationTranscriptionInput {
  mode: StationTranscriptionMode;
  url?: string | null;
  model?: string | null;
  maxSeconds?: number | null;
  apiKey?: ApiKeyWrite;
}

export interface HubTranscriptionView {
  enabled: boolean;
  url: string;
  model: string;
  maxSeconds: number;
  hasApiKey: boolean;
  source: "settings" | "env" | "none";
}

export interface EffectiveTranscription {
  enabled: boolean;
  url: string | null;
  model: string | null;
  maxSeconds: number | null;
  source: TranscriptionSource | "none";
}

export interface StationTranscriptionView {
  mode: StationTranscriptionMode;
  url?: string;
  model?: string;
  maxSeconds?: number;
  hasApiKey: boolean;
  effective: EffectiveTranscription;
}

// =============================================================================
// The service
// =============================================================================

export function createTranscriptionSettings(deps: {
  store: TranscriptionStore;
  cipher: Cipher;
  env: Record<string, string | undefined>;
  now?: () => number;
  ttlMs?: number;
}) {
  const { store, cipher, env } = deps;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? CACHE_TTL_MS;

  /** stationId → an answer, or the read producing one. */
  const cache = new Map<string, { at: number; value: Promise<ResolvedTranscription | null> }>();

  function invalidate(): void {
    cache.clear();
  }

  /**
   * A stored key, readable. A key that will not decrypt — ENCRYPTION_KEY
   * changed under it — is logged and sent as none, so the service's own 401
   * is what the room hears, which points at the key rather than at nothing.
   */
  async function reveal(encrypted: string | null): Promise<string> {
    if (!encrypted) return "";
    try {
      return await cipher.decrypt(encrypted);
    } catch {
      log.error("a stored transcription API key could not be decrypted; has ENCRYPTION_KEY changed?");
      return "";
    }
  }

  async function seal(write: ApiKeyWrite, previous: string | null): Promise<string | null> {
    if (write === undefined) return previous;
    if (write === null || write.trim() === "") return null;
    return cipher.encrypt(write.trim());
  }

  /** What stations that inherit get: saved hub settings, else the env, else none. */
  async function resolveHub(): Promise<ResolvedTranscription | null> {
    const hub = await store.getHub();
    if (hub) {
      if (!hub.enabled || !hub.url) return null;
      return {
        url: hub.url,
        apiKey: await reveal(hub.apiKeyEncrypted),
        model: hub.model || DEFAULT_TRANSCRIBE_MODEL,
        maxSeconds: hub.maxSeconds,
        source: "hub",
      };
    }
    const fromEnv = transcriptionFromEnv(env);
    return fromEnv ? { ...fromEnv, maxSeconds: MAX_VOICE_SECONDS, source: "env" } : null;
  }

  async function resolveUncached(stationId: string): Promise<ResolvedTranscription | null> {
    const station = await store.getStation(stationId);
    if (station?.mode === "off") return null;
    if (station?.mode === "custom" && station.url) {
      return {
        url: station.url,
        apiKey: await reveal(station.apiKeyEncrypted),
        model: station.model || DEFAULT_TRANSCRIBE_MODEL,
        maxSeconds: station.maxSeconds ?? MAX_VOICE_SECONDS,
        source: "station",
      };
    }
    return resolveHub();
  }

  function resolveFor(stationId: string): Promise<ResolvedTranscription | null> {
    const hit = cache.get(stationId);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = resolveUncached(stationId);
    const entry = { at: now(), value };
    cache.set(stationId, entry);
    // A failed read is not an answer worth keeping.
    value.catch(() => {
      if (cache.get(stationId) === entry) cache.delete(stationId);
    });
    return value;
  }

  async function getHubView(): Promise<HubTranscriptionView> {
    const hub = await store.getHub();
    if (hub) {
      return {
        enabled: hub.enabled,
        url: hub.url,
        model: hub.model,
        maxSeconds: hub.maxSeconds,
        hasApiKey: !!hub.apiKeyEncrypted,
        source: "settings",
      };
    }
    const fromEnv = transcriptionFromEnv(env);
    if (fromEnv) {
      return {
        enabled: true,
        url: fromEnv.url,
        model: fromEnv.model,
        maxSeconds: MAX_VOICE_SECONDS,
        hasApiKey: fromEnv.apiKey !== "",
        source: "env",
      };
    }
    return {
      enabled: false,
      url: "",
      model: DEFAULT_TRANSCRIBE_MODEL,
      maxSeconds: MAX_VOICE_SECONDS,
      hasApiKey: false,
      source: "none",
    };
  }

  async function putHub(input: HubTranscriptionInput, updatedBy?: string): Promise<HubTranscriptionView> {
    const url = input.url.trim();
    if (input.enabled && !url) throw new Error("a url is required to enable transcription");
    const previous = await store.getHub();
    await store.setHub(
      {
        enabled: input.enabled,
        url,
        model: input.model.trim() || DEFAULT_TRANSCRIBE_MODEL,
        maxSeconds: input.maxSeconds,
        apiKeyEncrypted: await seal(input.apiKey, previous?.apiKeyEncrypted ?? null),
      },
      updatedBy
    );
    invalidate();
    return getHubView();
  }

  async function getStationView(stationId: string): Promise<StationTranscriptionView> {
    const [station, effective] = await Promise.all([store.getStation(stationId), resolveUncached(stationId)]);
    const view: StationTranscriptionView = {
      mode: station?.mode ?? "inherit",
      hasApiKey: !!station?.apiKeyEncrypted,
      effective: effective
        ? {
            enabled: true,
            url: effective.url,
            model: effective.model,
            maxSeconds: effective.maxSeconds,
            source: effective.source,
          }
        : { enabled: false, url: null, model: null, maxSeconds: null, source: "none" },
    };
    if (station?.url) view.url = station.url;
    if (station?.model) view.model = station.model;
    if (station?.maxSeconds != null) view.maxSeconds = station.maxSeconds;
    return view;
  }

  async function putStation(
    stationId: string,
    input: StationTranscriptionInput,
    updatedBy?: string
  ): Promise<StationTranscriptionView> {
    const previous = await store.getStation(stationId);
    // Fields not sent keep what was saved: switching to `off` and back must
    // not mean typing the service in again.
    const url = input.url === undefined ? (previous?.url ?? null) : input.url?.trim() || null;
    if (input.mode === "custom" && !url) throw new Error("a url is required for a custom transcription service");
    const model = input.model === undefined ? (previous?.model ?? null) : input.model?.trim() || null;
    const maxSeconds = input.maxSeconds === undefined ? (previous?.maxSeconds ?? null) : input.maxSeconds;
    await store.setStation(
      stationId,
      {
        mode: input.mode,
        url,
        model: model ?? (input.mode === "custom" ? DEFAULT_TRANSCRIBE_MODEL : null),
        maxSeconds: maxSeconds ?? (input.mode === "custom" ? MAX_VOICE_SECONDS : null),
        apiKeyEncrypted: await seal(input.apiKey, previous?.apiKeyEncrypted ?? null),
      },
      updatedBy
    );
    invalidate();
    return getStationView(stationId);
  }

  /**
   * The endpoint a connection test should hit: what the caller typed, over
   * what is saved (or the env). An omitted key uses the saved one, so an admin
   * can test a new URL without re-entering a key they cannot see.
   */
  async function endpointForTest(overrides: {
    url?: string;
    model?: string;
    apiKey?: ApiKeyWrite;
  }): Promise<TranscriptionEndpoint | null> {
    const hub = await store.getHub();
    const fromEnv = hub ? null : transcriptionFromEnv(env);
    const saved: TranscriptionEndpoint | null = hub
      ? { url: hub.url, apiKey: await reveal(hub.apiKeyEncrypted), model: hub.model }
      : fromEnv;
    const url = overrides.url?.trim() || saved?.url || "";
    if (!url) return null;
    return {
      url,
      model: overrides.model?.trim() || saved?.model || DEFAULT_TRANSCRIBE_MODEL,
      apiKey: overrides.apiKey === undefined ? (saved?.apiKey ?? "") : (overrides.apiKey ?? ""),
    };
  }

  return { resolveFor, getHubView, putHub, getStationView, putStation, endpointForTest, invalidate };
}

export type TranscriptionSettings = ReturnType<typeof createTranscriptionSettings>;

// =============================================================================
// Postgres
// =============================================================================

/**
 * The hub-wide setting is ONE `system_settings` row holding JSON, not a key
 * per field: a save is then a single atomic upsert, so the bridge can never
 * read a URL from one save and a key from another. It needs no migration, and
 * `system_settings` is already where hub-wide configuration lives.
 */
export const dbTranscriptionStore: TranscriptionStore = {
  async getHub() {
    const [row] = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, TRANSCRIPTION_SETTING_KEY))
      .limit(1);
    if (!row) return null;
    try {
      const v = JSON.parse(row.value) as Partial<HubTranscriptionRecord>;
      return {
        enabled: v.enabled === true,
        url: typeof v.url === "string" ? v.url : "",
        model: typeof v.model === "string" ? v.model : DEFAULT_TRANSCRIBE_MODEL,
        maxSeconds: typeof v.maxSeconds === "number" ? v.maxSeconds : MAX_VOICE_SECONDS,
        apiKeyEncrypted: typeof v.apiKeyEncrypted === "string" ? v.apiKeyEncrypted : null,
      };
    } catch {
      log.error("the saved hub transcription setting is not valid JSON; treating it as disabled");
      return { enabled: false, url: "", model: DEFAULT_TRANSCRIBE_MODEL, maxSeconds: MAX_VOICE_SECONDS, apiKeyEncrypted: null };
    }
  },

  async setHub(record, updatedBy) {
    const value = JSON.stringify(record);
    await db
      .insert(systemSettings)
      .values({
        key: TRANSCRIPTION_SETTING_KEY,
        value,
        description: "Voice-note transcription service (hub default)",
        updatedBy,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedBy, updatedAt: new Date() },
      });
    // Deliberately not `setSetting`, which logs the value it writes.
    log.info("hub transcription setting saved", { enabled: record.enabled, url: record.url, updatedBy });
  },

  async getStation(stationId) {
    const [row] = await db
      .select()
      .from(stationTranscription)
      .where(eq(stationTranscription.stationId, stationId))
      .limit(1);
    if (!row) return null;
    const mode: StationTranscriptionMode =
      row.mode === "off" || row.mode === "custom" ? row.mode : "inherit";
    return {
      mode,
      url: row.url,
      model: row.model,
      maxSeconds: row.maxSeconds,
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
      .insert(stationTranscription)
      .values({ stationId, ...values })
      .onConflictDoUpdate({ target: stationTranscription.stationId, set: values });
    log.info("station transcription setting saved", { stationId, mode: record.mode, url: record.url, updatedBy });
  },
};

export const transcriptionSettings = createTranscriptionSettings({
  store: dbTranscriptionStore,
  cipher: { encrypt, decrypt },
  env: process.env,
});

/**
 * The service a station's voice notes go to, or null when there is none —
 * disabled, unset, or the station turned it off. Cached for 30 s.
 */
export function resolveTranscriptionFor(stationId: string): Promise<ResolvedTranscription | null> {
  return transcriptionSettings.resolveFor(stationId);
}

/** What the Matrix bridge asks per voice note: a client and its length limit. */
export async function transcriberFor(
  stationId: string,
  resolve: (stationId: string) => Promise<ResolvedTranscription | null> = resolveTranscriptionFor
): Promise<{ transcriber: Transcriber; maxSeconds: number } | null> {
  const resolved = await resolve(stationId);
  if (!resolved) return null;
  return {
    transcriber: openAiTranscriber({ baseUrl: resolved.url, apiKey: resolved.apiKey, model: resolved.model }),
    maxSeconds: resolved.maxSeconds,
  };
}
