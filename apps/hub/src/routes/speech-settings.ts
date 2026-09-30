/**
 * Spoken-reply settings, over HTTP.
 *
 *   GET  /api/admin/settings/speech              the hub default (admin)
 *   PUT  /api/admin/settings/speech
 *   POST /api/admin/settings/speech/test         speak one sentence; the clip
 *                                                comes back for the console to play
 *   GET  /api/stations/:stationId/speech         a station's voice / speak mode /
 *   PUT  /api/stations/:stationId/speech         service override (owner)
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
}

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
