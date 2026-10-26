/** Station Timeline (item 11a): a station's strict runs, their checkpoints and a checkpoint diff. */
process.env.NODE_ENV = "test";
import { beforeAll, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/drizzle";
import { tenants } from "../../src/db/schema/tenants";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { acpSessions } from "../../src/db/schema/acp";
import { stationAudit } from "../../src/db/schema/audit";
import type { AuthUser } from "../../src/auth/middleware";
import { stationTimelineRoutes } from "../../src/routes/station-timeline";
import * as broker from "../../src/services/broker";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 20);
const tenant = "fleet_" + hex(),
  other = "fleet_" + hex(),
  user = "prn_" + hex(),
  node = "node_" + hex(),
  station = "station_" + hex(),
  sibling = "station_" + hex(),
  session = "acps_" + hex(),
  siblingSession = "acps_" + hex();
const binding = (sid: string, st: string) => ({
  version: 1, organization_id: "org_" + "1".repeat(20), principal_id: "prn_" + "2".repeat(20),
  node_id: node, station_id: st, station_key: "salaam:" + "0".repeat(16), occupancy_epoch: 1,
  hub_session_id: sid, workspace: "/workspace", run: { source: "superpipeline", id: "run_" + hex(), epoch: 1 },
});
beforeAll(async () => {
  await ensurePgMigrations();
  await db.insert(tenants).values([{ id: tenant, name: "timeline" }, { id: other, name: "timeline other" }]);
  await db.insert(nodes).values({ id: node, tenantId: tenant, userId: user, name: "tl", hostname: "f", os: "t", arch: "t", secretHash: "x" });
  for (const id of [station, sibling])
    await db.insert(stations).values({
      id, tenantId: tenant, userId: user, nodeId: node, harness: "salaam", stationKey: "salaam:" + hex().slice(0, 16),
      kind: "leaf", displayName: id, workspacePath: "/workspace", capabilities: ["acp"],
    });
  for (const [id, st] of [[session, station], [siblingSession, sibling]] as const)
    await db.insert(acpSessions).values({
      id, tenantId: tenant, stationId: st, userId: user, mode: "ask", status: "ended",
      executionAuthority: { binding: binding(id, st), leaseSequence: 1, sessionId: crypto.randomUUID(), admissionId: crypto.randomUUID(), stopRequestId: "r", state: "revoked" } as any,
      createdAt: new Date(), lastEventAt: new Date(),
    });
});
function app(t = tenant) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: user, authType: "api_key", tenantId: t, workspaceRole: "member" } as AuthUser);
    await next();
  });
  a.route("/api", stationTimelineRoutes);
  return a;
}
const get = async (a: Hono, path: string) => {
  const res = await a.request("/api" + path);
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

test("a member lists the station's strict runs, only that station's", async () => {
  const r = await get(app(), `/stations/${station}/timeline`);
  expect(r.status).toBe(200);
  expect(r.json.runs.map((x: any) => x.sessionId)).toEqual([session]);
  expect((await get(app(other), `/stations/${station}/timeline`)).status).toBe(404);
});

test("checkpoints and a diff come from the run's own binding; another station's run is 404", async () => {
  const calls: [string, any][] = [];
  const mock = spyOn(broker, "request").mockImplementation(async (_n, verb, body: any) => {
    calls.push([String(verb), body]);
    return { ok: true, data: { version: 1, verb } } as never;
  });
  try {
    expect((await get(app(), `/stations/${station}/timeline/${session}/checkpoints`)).json).toEqual({ version: 1, verb: "salaam.work-checkpoints" });
    expect(calls[0]![1].binding.hub_session_id).toBe(session);
    const diff = await get(app(), `/stations/${station}/timeline/${session}/checkpoints/ckp-1/diff`);
    expect(diff.status).toBe(200);
    expect(calls[1]).toEqual(["salaam.work-checkpoint-diff", { binding: calls[0]![1].binding, checkpoint_id: "ckp-1" }]);
    expect((await get(app(), `/stations/${station}/timeline/${siblingSession}/checkpoints`)).status).toBe(404);
    expect((await get(app(), `/stations/${station}/timeline/${session}/checkpoints/${"a".repeat(129)}/diff`)).status).toBe(404);
    expect(calls).toHaveLength(2);
    const audits = await db.select().from(stationAudit).where(eq(stationAudit.tenantId, tenant));
    expect(audits.map((a) => a.verb)).toEqual(["salaam.work-checkpoint-diff"]);
  } finally {
    mock.mockRestore();
  }
});
