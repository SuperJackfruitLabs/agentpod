/**
 * Station Timeline routes (item 11a), read-only:
 *   GET /api/stations/:id/timeline                                     the station's strict runs
 *   GET /api/stations/:id/timeline/:sessionId/checkpoints              a run's checkpoints
 *   GET /api/stations/:id/timeline/:sessionId/checkpoints/:ckp/diff    what restoring one would do
 *
 * The station must be in the caller's workspace (404 otherwise), and the session must be one of
 * that station's strict runs (404 otherwise). Checkpoints come from Salaam, derived from the run's
 * own recorded writes. The diff carries file contents off the station, so it is audited; listing
 * is not. Nothing here changes a workspace: restore is a separate, approved operation.
 */
import { Hono, type Context } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/drizzle";
import { acpSessions } from "../db/schema/acp";
import * as broker from "../services/broker";
import { getStation } from "../services/station-registry";
import { recordAudit } from "../services/audit";
import type { AuthUser } from "../auth/middleware";

const brokerStatus = (error?: string) =>
  error === "node offline" || error === "node disconnected" ? 409 : 502;

async function stationOf(c: Context) {
  const user = c.get("user") as AuthUser | undefined;
  if (!user || user.id === "anonymous") return { error: c.json({ error: "Unauthorized" }, 401) };
  const station = await getStation(user, c.req.param("id")!);
  if (!station) return { error: c.json({ error: "Not Found" }, 404) };
  return { user, station };
}

async function runOf(stationId: string, sessionId: string) {
  const [row] = await db
    .select()
    .from(acpSessions)
    .where(
      and(
        eq(acpSessions.id, sessionId),
        eq(acpSessions.stationId, stationId),
        sql`${acpSessions.executionAuthority} #>> '{binding,run,source}' = 'superpipeline'`,
      ),
    );
  return row?.executionAuthority ? row : null;
}

export const stationTimelineRoutes = new Hono()
  .get("/stations/:id/timeline", async (c) => {
    const s = await stationOf(c);
    if ("error" in s) return s.error;
    const rows = await db
      .select()
      .from(acpSessions)
      .where(
        and(
          eq(acpSessions.stationId, s.station.id),
          sql`${acpSessions.executionAuthority} #>> '{binding,run,source}' = 'superpipeline'`,
        ),
      )
      .orderBy(desc(acpSessions.createdAt))
      .limit(20);
    return c.json({
      runs: rows.map((r) => ({
        sessionId: r.id,
        runId: r.executionAuthority!.binding.run.id,
        state: r.executionAuthority!.state,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  })
  .get("/stations/:id/timeline/:sessionId/checkpoints", async (c) => {
    const s = await stationOf(c);
    if ("error" in s) return s.error;
    const run = await runOf(s.station.id, c.req.param("sessionId"));
    if (!run) return c.json({ error: "Not Found" }, 404);
    const binding = run.executionAuthority!.binding;
    const result = await broker.request(binding.node_id, "salaam.work-checkpoints", { binding });
    if (!result.ok) return c.json({ error: result.error ?? "checkpoints unavailable" }, brokerStatus(result.error));
    return c.json(result.data);
  })
  .get("/stations/:id/timeline/:sessionId/checkpoints/:checkpointId/diff", async (c) => {
    const s = await stationOf(c);
    if ("error" in s) return s.error;
    const run = await runOf(s.station.id, c.req.param("sessionId"));
    const checkpoint = c.req.param("checkpointId");
    if (!run || checkpoint.length > 128) return c.json({ error: "Not Found" }, 404);
    const binding = run.executionAuthority!.binding;
    const audit = await recordAudit(db, {
      tenantId: s.station.tenantId,
      userId: s.user.id,
      nodeId: s.station.nodeId,
      stationKey: s.station.stationKey,
      verb: "salaam.work-checkpoint-diff",
      params: { actor: s.user.id },
    });
    const result = await broker.request(binding.node_id, "salaam.work-checkpoint-diff", {
      binding,
      checkpoint_id: checkpoint,
    });
    await audit.done(result.ok ? "ok" : "error", result.ok ? undefined : result.error);
    if (!result.ok) return c.json({ error: result.error ?? "diff unavailable" }, brokerStatus(result.error));
    return c.json(result.data);
  });
