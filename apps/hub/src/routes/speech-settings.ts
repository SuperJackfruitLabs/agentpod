/**
 * Spoken-reply settings, over HTTP.
 *
 *   GET  /api/admin/settings/speech              the hub default (admin)
 *   PUT  /api/admin/settings/speech
 *   POST /api/admin/settings/speech/test         speak one sentence; the clip
 *                                                comes back for the console to play
 *   GET  /api/stations/:stationId/speech         a station's voice / speak mode /
 *   PUT  /api/stations/:stationId/speech         service override (owner)
 *   POST /api/stations/:stationId/speech/apply   push it into a harness-mode
 *                                                Hermes profile (owner)
 *   GET  /api/speech/voices                      the service's voices (any signed-in user)
 *   GET  /api/speech/voices/:id/preview          one voice's sample, Ogg/Opus
 *
 * The admin router is mounted inside `adminRouter` (`routes/admin.ts`), behind
 * its auth + admin guard. Station routes are owner-scoped like transcription's:
 * someone else's station is a 404. The voices routes sit behind the hub's
 * `/api/*` auth and proxy the hub's own speech service, so the console never
 * holds the service's token and never needs to reach its network (Tailscale).
 *
 * Keys go in and never come out: every answer carries `hasApiKey`.
 */

import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import {
  CURATED_VOICES,
  MAX_MAX_CHARS,
  MIN_MAX_CHARS,
  SPEAK_MODES,
  speechSettings,
  type SpeechSettings,
} from "../services/speech-settings";
import { fetchPreview, fetchVoices, testSpeech } from "../services/speech-client";
import { VERB_RESULTS } from "@agentpod/contract";
import * as broker from "../services/broker";
import {
  applyTargetInDb,
  type BrokerRequest,
  type TranscriptionApplyTarget,
} from "./transcription-settings";
import { createLogger } from "../utils/logger";

const log = createLogger("speech-settings-routes");

// =============================================================================
// Validation
// =============================================================================

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine(isHttpUrl, { message: "url must be an http:// or https:// URL" });

const apiKeyWrite = z.string().max(4096).nullable().optional();

/**
 * A voice id (`af_heart`), an OpenAI name (`nova`), or a blend
 * (`af_heart:60+af_bella:40`) — at most 64 characters, the length the
 * `dev.agentpod.voice_reply` key carries. The service decides whether it
 * knows the voice; this only keeps the value to the characters one uses.
 */
export const voiceSpec = z
  .string()
  .trim()
  .max(64)
  .regex(/^[A-Za-z0-9_]+(:[0-9.]+)?(\+[A-Za-z0-9_]+(:[0-9.]+)?){0,3}$/, {
    message: "voice must be a voice id or a blend like af_heart:60+af_bella:40",
  });

const speakMode = z.enum(SPEAK_MODES);

const HubBody = z
  .object({
    enabled: z.boolean(),
    url: z.union([z.literal(""), httpUrl]),
    defaultVoice: z.union([z.literal(""), voiceSpec]),
    mode: speakMode,
    maxChars: z.number().int().min(MIN_MAX_CHARS).max(MAX_MAX_CHARS),
    apiKey: apiKeyWrite,
  })
  .refine((b) => !b.enabled || b.url !== "", {
    message: "a url is required to enable spoken replies",
    path: ["url"],
  });

const TestBody = z.object({
  url: z.union([z.literal(""), httpUrl]).optional(),
  apiKey: apiKeyWrite,
  voice: voiceSpec.optional(),
});

const StationBody = z.object({
  mode: z.enum(["inherit", "off", "custom"]),
  voice: z.union([z.literal(""), voiceSpec]).nullable().optional(),
  speakMode: speakMode.nullable().optional(),
  url: z.union([z.literal(""), httpUrl]).nullable().optional(),
  apiKey: apiKeyWrite,
});

// =============================================================================
// Admin: the hub default
// =============================================================================

export interface AdminSpeechDeps {
  settings?: SpeechSettings;
  fetch?: typeof fetch;
  audit?: (adminId: string, summary: string, c: Context) => Promise<void>;
}

async function auditToLog(adminId: string, summary: string, c: Context): Promise<void> {
  const { logSettingsUpdate } = await import("../models/admin-audit-log");
  const { getRequestContext } = await import("../auth/admin-middleware");
  const ctx = getRequestContext(c);
  await logSettingsUpdate(adminId, "speech", summary, ctx.ipAddress, ctx.userAgent);
}

export function adminSpeechRoutes(deps: AdminSpeechDeps = {}) {
  const settings = deps.settings ?? speechSettings;
  const audit = deps.audit ?? auditToLog;

  return new Hono()
    .get("/", async (c) => c.json(await settings.getHubView()))
    .put("/", zValidator("json", HubBody), async (c) => {
      const body = c.req.valid("json");
      const adminId = c.get("user").id;
      const view = await settings.putHub(body, adminId);
      const keyChange =
        body.apiKey === undefined ? "kept" : body.apiKey === null || body.apiKey === "" ? "cleared" : "replaced";
      const summary = JSON.stringify({
        enabled: view.enabled,
        url: view.url,
        defaultVoice: view.defaultVoice,
        mode: view.mode,
        maxChars: view.maxChars,
        apiKey: keyChange,
      });
      try {
        await audit(adminId, summary, c);
      } catch (err) {
        log.warn("could not write the audit entry for a speech save", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return c.json(view);
    })
    .post("/test", zValidator("json", TestBody), async (c) => {
      const body = c.req.valid("json");
      const endpoint = await settings.endpointForTest(body);
      if (!endpoint) return c.json({ error: "no speech service url to test" }, 400);
      const hub = await settings.getHubView();
      const result = await testSpeech(endpoint, { fetch: deps.fetch, voice: body.voice || hub.defaultVoice || undefined });
      log.info("speech connection tested", {
        url: endpoint.url,
        ok: result.ok,
        status: result.status,
        elapsedMs: result.elapsedMs,
        durationMs: result.durationMs,
      });
      return c.json(result);
    });
}

// =============================================================================
// Owner: one station's voice and override
// =============================================================================

export interface StationSpeechDeps {
  settings?: SpeechSettings;
  ownsStation?: (userId: string, stationId: string) => Promise<boolean>;
  /** The station, if the caller owns it. Defaults to the stations table. */
  applyTarget?: (userId: string, stationId: string) => Promise<TranscriptionApplyTarget | null>;
  /** Injected by tests; defaults to the broker. */
  brokerRequest?: BrokerRequest;
}

/** A node gets this long to fetch, write and restart — transcription.apply's budget. */
export const SPEECH_APPLY_TIMEOUT_MS = 120_000;

/**
 * Harnesses whose node-agent can write a speech setting — the hub's copy of
 * `speechHarnesses` in the node-agent's speechapply.go. OpenClaw is not here:
 * its stations are bridge-mode, where the hub speaks for them.
 */
const HARNESSES_WITH_TTS_WRITER: ReadonlySet<string> = new Set(["hermes"]);

/** How a node that predates `speech.apply` answers it (descriptor/handler.go). */
const UNKNOWN_VERB = /unknown verb "speech\.apply"/;

async function ownsStationInDb(userId: string, stationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: stations.id })
    .from(stations)
    .where(and(eq(stations.id, stationId), eq(stations.userId, userId)))
    .limit(1);
  return !!row;
}

export function stationSpeechRoutes(deps: StationSpeechDeps = {}) {
  const settings = deps.settings ?? speechSettings;
  const ownsStation = deps.ownsStation ?? ownsStationInDb;
  const applyTarget = deps.applyTarget ?? applyTargetInDb;
  const request: BrokerRequest = deps.brokerRequest ?? broker.request;

  return new Hono()
    .get("/stations/:stationId/speech", async (c) => {
      const stationId = c.req.param("stationId");
      if (!(await ownsStation(c.get("user").id, stationId))) return c.json({ error: "Not Found" }, 404);
      return c.json(await settings.getStationView(stationId));
    })
    .put("/stations/:stationId/speech", zValidator("json", StationBody), async (c) => {
      const userId = c.get("user").id;
      const stationId = c.req.param("stationId");
      if (!(await ownsStation(userId, stationId))) return c.json({ error: "Not Found" }, 404);
      const body = c.req.valid("json");
      try {
        return c.json(
          await settings.putStation(
            stationId,
            { ...body, voice: body.voice === "" ? null : body.voice },
            userId
          )
        );
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "invalid speech setting" }, 400);
      }
    })
    /**
     * A harness-mode station is its own Matrix client and speaks for itself,
     * so the saved voice and speak mode reach it only when its node writes
     * them into the harness profile. This asks the node to (`speech.apply`).
     * The frame carries the station key and id only; the node fetches the
     * setting, key included, from its own authenticated endpoint
     * (routes/station-speech-node.ts).
     */
    .post("/stations/:stationId/speech/apply", async (c) => {
      const userId = c.get("user").id;
      const stationId = c.req.param("stationId");
      const station = await applyTarget(userId, stationId);
      if (!station) return c.json({ error: "Not Found" }, 404);

      if (station.matrixIdentityMode !== "harness") {
        return c.json(
          {
            error:
              "This station is bridge-mode: the hub speaks its replies, so the saved voice " +
              "already applies. Only a harness-mode station needs it pushed.",
          },
          400
        );
      }
      if (!HARNESSES_WITH_TTS_WRITER.has(station.harness)) {
        return c.json(
          {
            error:
              `Pushing voice replies to a harness-mode ${station.harness} station is not supported ` +
              "yet; only Hermes stations can take it. Its voice is saved and applies if it " +
              "moves to bridge mode.",
          },
          400
        );
      }

      const result = await request(
        station.nodeId,
        "speech.apply",
        { key: station.stationKey, stationId: station.id },
        { timeoutMs: SPEECH_APPLY_TIMEOUT_MS }
      );
      if (!result.ok) {
        log.warn("a node could not apply a station's speech setting", {
          stationId: station.id,
          nodeId: station.nodeId,
          error: result.error,
        });
        if (result.error && UNKNOWN_VERB.test(result.error)) {
          return c.json(
            {
              error:
                "This station's node-agent predates voice replies for harness stations. Update " +
                "its node from the console (or run `apn update` on the host) and apply again.",
            },
            502
          );
        }
        return c.json({ error: result.error ?? "the node could not apply the setting" }, 502);
      }
      const parsed = VERB_RESULTS["speech.apply"].safeParse(result.data);
      if (!parsed.success) {
        return c.json(
          {
            error:
              "The node answered in a shape this hub does not understand — its node-agent may " +
              "predate speech.apply.",
          },
          502
        );
      }
      log.info("applied a station's speech setting to its harness", {
        stationId: station.id,
        nodeId: station.nodeId,
        mode: parsed.data.mode,
        speakMode: parsed.data.speakMode,
        autoSpeak: parsed.data.autoSpeak,
        restarted: parsed.data.restarted,
      });
      return c.json(parsed.data);
    });
}

// =============================================================================
// Any signed-in user: the voices, through the hub
// =============================================================================

export const VOICES_CACHE_MS = 5 * 60_000;
const VOICE_ID = /^[a-z]{2}_[a-z]{2,32}$/;

export interface SpeechVoicesDeps {
  settings?: SpeechSettings;
  fetch?: typeof fetch;
  now?: () => number;
}

export function speechVoicesRoutes(deps: SpeechVoicesDeps = {}) {
  const settings = deps.settings ?? speechSettings;
  const now = deps.now ?? Date.now;
  let cached: { at: number; url: string; body: unknown } | null = null;

  return new Hono()
    .get("/speech/voices", async (c) => {
      const endpoint = await settings.hubEndpoint();
      if (!endpoint) return c.json({ error: "no speech service is configured on this hub" }, 503);
      if (cached && cached.url === endpoint.url && now() - cached.at < VOICES_CACHE_MS) return c.json(cached.body);
      let upstream: { voices?: Array<Record<string, unknown>>; default?: unknown; aliases?: unknown };
      try {
        upstream = (await fetchVoices(endpoint, { fetch: deps.fetch })) as typeof upstream;
      } catch (err) {
        log.warn("could not list the speech service's voices", {
          url: endpoint.url,
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: "the speech service did not answer" }, 502);
      }
      const body = {
        voices: (upstream.voices ?? []).map((v) => ({
          ...v,
          // The hub's own route: the console never sees the service's address.
          preview_url: `/api/speech/voices/${encodeURIComponent(String(v.id))}/preview`,
        })),
        default: upstream.default ?? null,
        aliases: upstream.aliases ?? {},
        /** What an agent with no chosen voice is assigned from. */
        assignable: CURATED_VOICES,
      };
      cached = { at: now(), url: endpoint.url, body };
      return c.json(body);
    })
    .get("/speech/voices/:voiceId/preview", async (c) => {
      const voiceId = c.req.param("voiceId");
      if (!VOICE_ID.test(voiceId)) return c.json({ error: "not a voice id" }, 400);
      const endpoint = await settings.hubEndpoint();
      if (!endpoint) return c.json({ error: "no speech service is configured on this hub" }, 503);
      let res: Response;
      try {
        res = await fetchPreview(endpoint, voiceId, { fetch: deps.fetch });
      } catch (err) {
        log.warn("could not fetch a voice preview", {
          voiceId,
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: "the speech service did not answer" }, 502);
      }
      if (!res.ok || !res.body) {
        return c.json({ error: `the speech service answered ${res.status}` }, res.status === 404 ? 404 : 502);
      }
      return new Response(res.body, {
        status: 200,
        headers: {
          "Content-Type": "audio/ogg",
          // A preview never changes for a voice; the browser may keep it a day.
          "Cache-Control": "private, max-age=86400",
        },
      });
    });
}
