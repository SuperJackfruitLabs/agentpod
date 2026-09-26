/**
 * Voice-note transcription settings, over HTTP.
 *
 *   GET  /api/admin/settings/transcription        the hub default (admin)
 *   PUT  /api/admin/settings/transcription
 *   POST /api/admin/settings/transcription/test   one second of silence, sent
 *   GET  /api/stations/:stationId/transcription   a station's override (owner)
 *   PUT  /api/stations/:stationId/transcription
 *   POST /api/stations/:stationId/transcription/apply
 *                                                 push it into a harness-mode
 *                                                 Hermes profile (owner)
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
import { VERB_RESULTS } from "@agentpod/contract";
import * as broker from "../services/broker";
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

/** What the apply route needs to know about a station the caller owns. */
export interface TranscriptionApplyTarget {
  id: string;
  nodeId: string;
  stationKey: string;
  harness: string;
  matrixIdentityMode: string;
}

type BrokerRequest = (
  nodeId: string,
  verb: string,
  params: unknown,
  opts?: { timeoutMs?: number }
) => Promise<{ ok: boolean; data?: unknown; error?: string }>;

/** A node gets this long to fetch, write and restart — matrix.adopt's budget. */
export const TRANSCRIPTION_APPLY_TIMEOUT_MS = 120_000;

/**
 * Harnesses whose node-agent can write a transcription setting — the hub's
 * copy of `transcriptionHarnesses` in the node-agent's transcriptionapply.go.
 */
const HARNESSES_WITH_STT_WRITER: ReadonlySet<string> = new Set(["hermes"]);

export interface StationTranscriptionDeps {
  settings?: TranscriptionSettings;
  ownsStation?: (userId: string, stationId: string) => Promise<boolean>;
  /** The station, if the caller owns it. Defaults to the stations table. */
  applyTarget?: (userId: string, stationId: string) => Promise<TranscriptionApplyTarget | null>;
  /** Injected by tests; defaults to the broker. */
  brokerRequest?: BrokerRequest;
}

async function applyTargetInDb(userId: string, stationId: string): Promise<TranscriptionApplyTarget | null> {
  const [row] = await db
    .select({
      id: stations.id,
      nodeId: stations.nodeId,
      stationKey: stations.stationKey,
      harness: stations.harness,
      matrixIdentityMode: stations.matrixIdentityMode,
    })
    .from(stations)
    .where(and(eq(stations.id, stationId), eq(stations.userId, userId)))
    .limit(1);
  return row ?? null;
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
  const applyTarget = deps.applyTarget ?? applyTargetInDb;
  const request: BrokerRequest = deps.brokerRequest ?? broker.request;

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
    })
    /**
     * A harness-mode station runs its own Matrix client and transcribes voice
     * notes itself, so the saved setting reaches it only when its node writes
     * it into the harness profile. This asks the node to (`transcription.apply`).
     * The frame carries the station key and id only; the node fetches the
     * setting, key included, from its own authenticated endpoint
     * (routes/station-transcription-node.ts).
     */
    .post("/stations/:stationId/transcription/apply", async (c) => {
      const userId = c.get("user").id;
      const stationId = c.req.param("stationId");
      const station = await applyTarget(userId, stationId);
      if (!station) return c.json({ error: "Not Found" }, 404);

      if (station.matrixIdentityMode !== "harness") {
        return c.json(
          {
            error:
              "This station is bridge-mode: the hub transcribes its voice notes, so the saved " +
              "setting already applies. Only a harness-mode station needs it pushed.",
          },
          400
        );
      }
      if (!HARNESSES_WITH_STT_WRITER.has(station.harness)) {
        return c.json(
          {
            error:
              `Pushing the voice-note setting to a ${station.harness} harness is not supported; ` +
              "only Hermes stations can take it.",
          },
          400
        );
      }

      const result = await request(
        station.nodeId,
        "transcription.apply",
        { key: station.stationKey, stationId: station.id },
        { timeoutMs: TRANSCRIPTION_APPLY_TIMEOUT_MS }
      );
      if (!result.ok) {
        log.warn("a node could not apply a station's transcription setting", {
          stationId: station.id,
          nodeId: station.nodeId,
          error: result.error,
        });
        return c.json({ error: result.error ?? "the node could not apply the setting" }, 502);
      }
      const parsed = VERB_RESULTS["transcription.apply"].safeParse(result.data);
      if (!parsed.success) {
        return c.json(
          {
            error:
              "The node answered in a shape this hub does not understand — its node-agent may " +
              "predate transcription.apply.",
          },
          502
        );
      }
      log.info("applied a station's transcription setting to its harness", {
        stationId: station.id,
        nodeId: station.nodeId,
        mode: parsed.data.mode,
        restarted: parsed.data.restarted,
      });
      return c.json(parsed.data);
    });
}
