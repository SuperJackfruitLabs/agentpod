/**
 * Voice-note transcription settings, over HTTP.
 *
 *   GET  /api/admin/settings/transcription        the hub default (admin)
 *   PUT  /api/admin/settings/transcription
 *   POST /api/admin/settings/transcription/test   one second of silence, sent
 *   GET  /api/stations/:stationId/transcription   a station's override (owner)
 *   PUT  /api/stations/:stationId/transcription
 *
 * The admin router has no guard of its own: it is mounted inside `adminRouter`
 * (`routes/admin.ts`), behind the same auth + admin middleware as every other
 * admin route. The station routes are owner-scoped the way `purpose.ts` is —
 * someone else's station is a 404, not a 403, so its existence is not leaked.
 *
 * API keys go in and never come out: every answer carries `hasApiKey`. A key
 * omitted from a PUT keeps the saved one; `null` clears it.
 */

import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import {
  MAX_MAX_SECONDS,
  MIN_MAX_SECONDS,
  transcriptionSettings,
  type TranscriptionSettings,
} from "../services/transcription-settings";
import { testTranscription } from "../services/matrix-as/voice";
import { createLogger } from "../utils/logger";

const log = createLogger("transcription-settings-routes");

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

/** Omitted keeps the saved key, null clears it, a string replaces it. */
const apiKeyWrite = z.string().max(4096).nullable().optional();

const maxSeconds = z.number().int().min(MIN_MAX_SECONDS).max(MAX_MAX_SECONDS);

const model = z.string().trim().max(200);

const HubBody = z
  .object({
    enabled: z.boolean(),
    url: z.union([z.literal(""), httpUrl]),
    model,
    maxSeconds,
    apiKey: apiKeyWrite,
  })
  .refine((b) => !b.enabled || b.url !== "", {
    message: "a url is required to enable transcription",
    path: ["url"],
  });

const TestBody = z.object({
  url: z.union([z.literal(""), httpUrl]).optional(),
  model: model.optional(),
  apiKey: apiKeyWrite,
});

const StationBody = z.object({
  mode: z.enum(["inherit", "off", "custom"]),
  url: z.union([z.literal(""), httpUrl]).nullable().optional(),
  model: model.nullable().optional(),
  maxSeconds: maxSeconds.nullable().optional(),
  apiKey: apiKeyWrite,
});

// =============================================================================
// Admin: the hub default
// =============================================================================

export interface AdminTranscriptionDeps {
  settings?: TranscriptionSettings;
  /** The fetch the connection test uses. Injected by tests. */
  fetch?: typeof fetch;
  /** Records a save in the admin audit log. Never passed the key. */
  audit?: (adminId: string, summary: string, c: Context) => Promise<void>;
}

async function auditToLog(adminId: string, summary: string, c: Context): Promise<void> {
  const { logSettingsUpdate } = await import("../models/admin-audit-log");
  const { getRequestContext } = await import("../auth/admin-middleware");
  const ctx = getRequestContext(c);
  await logSettingsUpdate(adminId, "transcription", summary, ctx.ipAddress, ctx.userAgent);
}

export function adminTranscriptionRoutes(deps: AdminTranscriptionDeps = {}) {
  const settings = deps.settings ?? transcriptionSettings;
  const audit = deps.audit ?? auditToLog;

  return new Hono()
    .get("/", async (c) => c.json(await settings.getHubView()))
    .put("/", zValidator("json", HubBody), async (c) => {
      const body = c.req.valid("json");
      const adminId = c.get("user").id;
      const view = await settings.putHub(body, adminId);
      const keyChange = body.apiKey === undefined ? "kept" : body.apiKey === null || body.apiKey === "" ? "cleared" : "replaced";
      // What changed, and never the key: a summary an operator can read.
      const summary = JSON.stringify({
        enabled: view.enabled,
        url: view.url,
        model: view.model,
        maxSeconds: view.maxSeconds,
        apiKey: keyChange,
      });
      try {
        await audit(adminId, summary, c);
      } catch (err) {
        log.warn("could not write the audit entry for a transcription save", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return c.json(view);
    })
    .post("/test", zValidator("json", TestBody), async (c) => {
      const body = c.req.valid("json");
      const endpoint = await settings.endpointForTest(body);
      if (!endpoint) return c.json({ error: "no transcription service url to test" }, 400);
      const result = await testTranscription(endpoint, { fetch: deps.fetch });
      log.info("transcription connection tested", {
        url: endpoint.url,
        ok: result.ok,
        status: result.status,
        elapsedMs: result.elapsedMs,
      });
      return c.json(result);
    });
}

// =============================================================================
// Owner: one station's override
// =============================================================================

export interface StationTranscriptionDeps {
  settings?: TranscriptionSettings;
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

export function stationTranscriptionRoutes(deps: StationTranscriptionDeps = {}) {
  const settings = deps.settings ?? transcriptionSettings;
  const ownsStation = deps.ownsStation ?? ownsStationInDb;

  return new Hono()
    .get("/stations/:stationId/transcription", async (c) => {
      const stationId = c.req.param("stationId");
      if (!(await ownsStation(c.get("user").id, stationId))) return c.json({ error: "Not Found" }, 404);
      return c.json(await settings.getStationView(stationId));
    })
    .put("/stations/:stationId/transcription", zValidator("json", StationBody), async (c) => {
      const userId = c.get("user").id;
      const stationId = c.req.param("stationId");
      if (!(await ownsStation(userId, stationId))) return c.json({ error: "Not Found" }, 404);
      try {
        return c.json(await settings.putStation(stationId, c.req.valid("json"), userId));
      } catch (err) {
        // The one rule zod cannot see: `custom` with no url sent AND none saved.
        return c.json({ error: err instanceof Error ? err.message : "invalid transcription setting" }, 400);
      }
    });
}
