import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { SkillHubOperation } from "@agentpod/contract";
import { db, rawSql } from "../db/drizzle";
import { nodes } from "../db/schema/nodes";
import { stations } from "../db/schema/stations";
import { skillOperations } from "../db/schema/skills";
import { stationAudit } from "../db/schema/audit";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { connectionManager } from "../services/connection-manager";
import * as broker from "../services/broker";
import {
  createSkillManagementRoutes,
  skillArtifactDownloadRoutes,
  readSkillBody,
} from "./skill-management";
import { planFixture } from "../../../../packages/contract/src/fixtures/skill-install";
import { placementFixture } from "../../../../packages/contract/src/fixtures/skill-placement";
import { pluginPlanFixture } from "../../../../packages/contract/src/fixtures/plugin-operation";
import type { AuthUser } from "../auth/middleware";

const userId = `test-skill-management-${crypto.randomUUID()}`;
const otherUser = `test-skill-management-other-${crypto.randomUUID()}`;
const secret = "synthetic-node-secret";
const archive = readFileSync(
  new URL(
    "../../../node-agent/internal/skills/testdata/export-codex.tar.gz",
    import.meta.url,
  ),
);
const made: string[] = [];
let secretHash: string;
const app = new Hono()
  .route("/api", skillArtifactDownloadRoutes)
  .use("*", async (c, next) => {
    c.set("user", {
      id: c.req.header("X-Test-User") ?? userId,
      tenantId: c.req.header("X-Test-Tenant") ?? BOOTSTRAP_TENANT_ID,
      authType: "api_key",
    } satisfies AuthUser);
    await next();
  })
  .route("/api", createSkillManagementRoutes({ timeoutMs: 1000 }));
beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: userId });
  await createTestUser({ id: otherUser });
  secretHash = await Bun.password.hash(secret);
});
afterEach(async () => {
  for (const id of made.splice(0)) {
    connectionManager.unregister(id);
    broker.dropNode(id);
    await rawSql`DELETE FROM nodes WHERE id=${id}`;
  }
});
afterAll(async () => {
  await rawSql`DELETE FROM station_audit WHERE user_id=${userId}`;
  await rawSql`DELETE FROM "user" WHERE id IN (${userId},${otherUser})`;
});
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});
async function upload(headers: Record<string, string> = {}) {
  const res = await app.request(
    "/api/skills/artifacts?harness=codex&profile=fixture",
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", ...headers },
      body: archive,
    },
  );
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string; archiveSHA256: string }>;
}
async function setup(overrides: Partial<typeof stations.$inferInsert> = {}) {
  const nodeId = `node_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  made.push(nodeId);
  await db.insert(nodes).values({
    id: nodeId,
    userId,
    tenantId: BOOTSTRAP_TENANT_ID,
    name: "skill fixture",
    hostname: "fixture",
    os: "linux",
    arch: "arm64",
    secretHash,
  });
  const [station] = await db
    .insert(stations)
    .values({
      id: `station_${crypto.randomUUID()}`,
      userId,
      tenantId: BOOTSTRAP_TENANT_ID,
      nodeId,
      harness: "codex",
      stationKey: "codex:fixture",
      kind: "leaf",
      displayName: "Fixture",
      capabilities: ["skills.manage", "skills.native"],
      ...overrides,
    })
    .returning();
  let reachedPlan: () => void = () => {};
  const planReached = new Promise<void>((resolve) => {
    reachedPlan = resolve;
  });
  const requests: { verb: string; params: any }[] = [];
  const receipts = new Map<string, any>();
  const state = {
    dropApply: false,
    foreignReply: false,
    holdPlan: false,
    pluginRefusal: null as string | null,
    downloadStatus: 0,
    auditSeen: false,
  };
  connectionManager.register(nodeId, (msg) => {
    if (msg.type !== "req") return;
    const params = msg.params as any;
    requests.push({ verb: msg.verb, params });
    void (async () => {
      let data: unknown;
      if (msg.verb === "plugins.plan") {
        const refused = state.pluginRefusal;
        const plan = {
          ...structuredClone(pluginPlanFixture),
          operationId: params.operationId,
          action: params.action,
          binding: { ...pluginPlanFixture.binding, nodeId, stationKey: station!.stationKey, plugin: params.plugin },
          gate: params.action === "enable" ? pluginPlanFixture.gate : null,
          ...(refused ? { files: null, fileAction: null, fileNames: [], config: null, refusal: refused, restartRequired: false } : {}),
        };
        receipts.set(params.operationId, { plan, phase: refused ? "conflict" : "planned", updatedAt: plan.createdAt, completedAt: null, error: refused });
        data = plan;
      } else if (msg.verb === "plugins.apply") {
        const receipt = receipts.get(params.operationId);
        if (receipt.plan.planDigest !== params.expectedPlanDigest) throw new Error("digest");
        receipt.phase = "applied";
        receipt.completedAt = receipt.updatedAt;
        data = receipt;
      } else if (msg.verb === "skills.operation" || msg.verb === "skills.native.operation" || msg.verb === "plugins.operation")
        data = { receipt: receipts.get(params.operationId) ?? null };
      else if (msg.verb === "skills.maintenance.plan") {
        data = { nodeId, stationKey: station!.stationKey, harness: "codex", profile: params.profile, maintenance: { preview: { generations: [], operations: [], nativeOperations: [], nativeBackups: [] }, planDigest: "a".repeat(64), observedAt: "2026-09-21T15:00:00Z", limitation: "Read-only preview" } };
      }
      else if (msg.verb === "skills.native.plan") {
        const plan = {
          ...structuredClone(placementFixture),
          operationId: params.operationId,
          action: params.action,
          binding: {
            ...placementFixture.binding,
            nodeId,
            stationKey: station!.stationKey,
            profile: params.profile,
          },
          after: params.action === "deactivate" ? null : {
            ...placementFixture.after,
            generation: params.operationId,
          },
        };
        receipts.set(params.operationId, { plan, phase: "planned", updatedAt: plan.createdAt, completedAt: null, error: null });
        data = plan;
      } else if (msg.verb === "skills.native.apply") {
        const receipt = receipts.get(params.operationId);
        receipt.phase = "applied";
        receipt.completedAt = receipt.updatedAt;
        data = receipt;
      }
      else if (msg.verb === "skills.plan" || msg.verb === "skills.rollback") {
        reachedPlan();
        if (state.holdPlan) return;
        const audits = await db
          .select()
          .from(stationAudit)
          .where(eq(stationAudit.nodeId, nodeId));
        state.auditSeen = audits.some((a) => a.result === "pending");
        if (msg.verb === "skills.plan") {
          const download = await app.request(
            `/api/nodes/${nodeId}/stations/${station!.id}/skill-artifacts/${params.operationId}`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${nodeId}:${secret}`,
                "X-AgentPod-Station-Key": station!.stationKey,
              },
            },
          );
          state.downloadStatus = download.status;
          if (download.status === 200)
            expect(
              Buffer.from(await download.arrayBuffer()).equals(archive),
            ).toBe(true);
        }
        const plan = {
          ...structuredClone(planFixture),
          operationId: params.operationId,
          action: msg.verb === "skills.plan" ? "install" : "rollback",
          binding: {
            ...planFixture.binding,
            nodeId,
            stationKey: state.foreignReply
              ? "codex:other"
              : station!.stationKey,
            profile: params.profile,
          },
          after:
            msg.verb === "skills.plan"
              ? {
                  ...planFixture.after,
                  generation: params.operationId,
                  archiveSHA256: params.archiveSHA256,
                }
              : null,
          targetPath:
            msg.verb === "skills.plan" ? planFixture.targetPath : null,
        };
        receipts.set(params.operationId, {
          plan,
          phase: "planned",
          updatedAt: plan.createdAt,
          completedAt: null,
          error: null,
        });
        data = plan;
      } else if (msg.verb === "skills.apply") {
        const receipt = receipts.get(params.operationId);
        receipt.phase = "applied";
        receipt.completedAt = receipt.updatedAt;
        data = receipt;
        if (state.dropApply) return;
      }
      broker.handleNodeMessage(nodeId, {
        type: "res",
        id: msg.id,
        ok: true,
        data,
      });
    })().catch((error) =>
      broker.handleNodeMessage(nodeId, {
        type: "res",
        id: msg.id,
        ok: false,
        error: error.message,
      }),
    );
  });
  return { nodeId, station: station!, state, requests, receipts, planReached };
}

test("maintenance preview is authenticated, station-bound, and read-only", async () => {
  const c = await setup();
  const res = await app.request(`/api/stations/${c.station.id}/skills/maintenance/plan`, json({ profile: "fixture" }));
  expect(res.status).toBe(200);
  const data = await res.json() as any;
  expect(data.nodeId).toBe(c.nodeId);
  expect(data.stationKey).toBe(c.station.stationKey);
  expect(data.maintenance.planDigest).toBe("a".repeat(64));
  expect(c.requests.at(-1)).toEqual({ verb: "skills.maintenance.plan", params: { key: c.station.stationKey, profile: "fixture" } });
});

test("upload, authorized plan/download, reviewed apply and inspect form a durable operation", async () => {
  const c = await setup();
  const artifact = await upload();
  const request = { requestId: crypto.randomUUID(), artifactId: artifact.id };
  let res = await app.request(
    `/api/stations/${c.station.id}/skills/plan`,
    json(request),
  );
  expect(res.status).toBe(200);
  const planned = SkillHubOperation.parse(await res.json());
  expect(planned.state).toBe("planned");
  expect(planned.plan && "activation" in planned.plan ? planned.plan.activation : undefined).toBe("pending");
  expect(c.state.downloadStatus).toBe(200);
  expect(c.state.auditSeen).toBe(true);
  res = await app.request(
    `/api/stations/${c.station.id}/skills/operations/${planned.id}/apply`,
    json({ planDigest: "0".repeat(64) }),
  );
  expect(res.status).toBe(409);
  res = await app.request(
    `/api/stations/${c.station.id}/skills/operations/${planned.id}/apply`,
    json({ planDigest: planned.plan!.planDigest }),
  );
  expect(res.status).toBe(200);
  expect(SkillHubOperation.parse(await res.json()).state).toBe("applied");
  const before = c.requests.filter((r) => r.verb === "skills.apply").length;
  res = await app.request(
    `/api/stations/${c.station.id}/skills/operations/${planned.id}/apply`,
    json({ planDigest: planned.plan!.planDigest }),
  );
  expect(res.status).toBe(200);
  expect(c.requests.filter((r) => r.verb === "skills.apply")).toHaveLength(
    before,
  );
  expect(
    (
      await app.request(
        `/api/stations/${c.station.id}/skills/operations/${planned.id}`,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(`/api/skills/artifacts/${artifact.id}`, {
        method: "DELETE",
      })
    ).status,
  ).toBe(409);
  const audit = await db
    .select()
    .from(stationAudit)
    .where(eq(stationAudit.nodeId, c.nodeId));
  expect(JSON.stringify(audit)).not.toContain(secret);
  expect(JSON.stringify(audit)).not.toContain(archive.toString("base64"));
});

test("native activation uses a separate capability, operation namespace and node verbs", async () => {
  const c = await setup();
  let res = await app.request(
    `/api/stations/${c.station.id}/skills/native/plan`,
    json({ requestId: crypto.randomUUID(), profile: "fixture", action: "activate" }),
  );
  expect(res.status).toBe(200);
  const planned = SkillHubOperation.parse(await res.json());
  expect(planned.kind).toBe("native");
  expect(planned.action).toBe("activate");
  expect(planned.plan && "activation" in planned.plan ? planned.plan.activation : undefined).toBe("quiescent-project; loading-unverified");
  expect(c.requests.some((request) => request.verb === "skills.native.plan")).toBe(true);
  expect((await app.request(`/api/stations/${c.station.id}/skills/operations/${planned.id}`)).status).toBe(404);
  res = await app.request(
    `/api/stations/${c.station.id}/skills/native/operations/${planned.id}/apply`,
    json({ planDigest: planned.plan!.planDigest }),
  );
  expect(res.status).toBe(200);
  expect(SkillHubOperation.parse(await res.json()).state).toBe("applied");
  expect(c.requests.some((request) => request.verb === "skills.native.apply")).toBe(true);
});

const hermes = { harness: "hermes", stationKey: "hermes:fixture", capabilities: ["plugins.manage"] };

test("plugin management plans, reviews and applies through its own capability and verbs", async () => {
  const c = await setup(hermes);
  let res = await app.request(`/api/stations/${c.station.id}/plugins/plan`, json({ requestId: crypto.randomUUID(), action: "enable" }));
  expect(res.status).toBe(200);
  const planned = SkillHubOperation.parse(await res.json());
  expect(planned).toMatchObject({ kind: "plugin", action: "enable", profile: "agentpod-live", state: "planned" });
  const plan = c.requests.find((request) => request.verb === "plugins.plan");
  // The node is told only the station key, the plugin and the operation.
  expect(Object.keys(plan!.params).sort()).toEqual(["action", "key", "operationId", "plugin"]);
  expect(plan!.params).toMatchObject({ key: "hermes:fixture", plugin: "agentpod-live" });
  // Plugin operations are their own namespace.
  expect((await app.request(`/api/stations/${c.station.id}/skills/native/operations/${planned.id}`)).status).toBe(403);
  expect((await app.request(`/api/stations/${c.station.id}/plugins/operations/${planned.id}`)).status).toBe(200);
  res = await app.request(`/api/stations/${c.station.id}/plugins/operations/${planned.id}/apply`, json({ planDigest: "0".repeat(64) }));
  expect(res.status).toBe(409);
  res = await app.request(`/api/stations/${c.station.id}/plugins/operations/${planned.id}/apply`, json({ planDigest: planned.plan!.planDigest }));
  expect(res.status).toBe(200);
  expect(SkillHubOperation.parse(await res.json()).state).toBe("applied");
  const apply = c.requests.find((request) => request.verb === "plugins.apply");
  expect(Object.keys(apply!.params).sort()).toEqual(["expectedPlanDigest", "key", "operationId", "plugin"]);
  const history = (await (await app.request(`/api/stations/${c.station.id}/plugins/operations`)).json()) as { id: string }[];
  expect(history.map((operation) => operation.id)).toEqual([planned.id]);
  const audit = await db.select().from(stationAudit).where(eq(stationAudit.nodeId, c.nodeId));
  expect(audit.map((row) => `${row.verb}:${row.result}`).sort()).toEqual(["plugins.apply:ok", "plugins.plan:ok"]);
});

test("a node's refusal of a plugin plan is a conflict carrying its reason", async () => {
  const c = await setup(hermes);
  c.state.pluginRefusal = "hermes-live: The Hermes version could not be determined";
  const res = await app.request(`/api/stations/${c.station.id}/plugins/plan`, json({ requestId: crypto.randomUUID(), action: "enable" }));
  expect(res.status).toBe(200);
  const refused = SkillHubOperation.parse(await res.json());
  expect(refused.state).toBe("conflict");
  expect(refused.error).toContain("could not be determined");
  const inspected = await app.request(`/api/stations/${c.station.id}/plugins/operations/${refused.id}/inspect`, json({}));
  expect(SkillHubOperation.parse(await inspected.json()).state).toBe("conflict");
  const apply = await app.request(`/api/stations/${c.station.id}/plugins/operations/${refused.id}/apply`, json({ planDigest: refused.plan!.planDigest }));
  expect(SkillHubOperation.parse(await apply.json()).state).toBe("conflict");
  expect(c.requests.some((request) => request.verb === "plugins.apply")).toBe(false);
});

test("plugin routes need the station's capability and refuse other plugins or actions", async () => {
  const c = await setup({ ...hermes, capabilities: ["skills.manage"] });
  expect((await app.request(`/api/stations/${c.station.id}/plugins/plan`, json({ requestId: crypto.randomUUID(), action: "enable" }))).status).toBe(403);
  await db.update(stations).set({ capabilities: ["plugins.manage"] }).where(eq(stations.id, c.station.id));
  for (const body of [
    { requestId: crypto.randomUUID(), action: "activate" },
    { requestId: crypto.randomUUID(), action: "enable", plugin: "other" },
    { requestId: crypto.randomUUID(), action: "enable", path: "/etc" },
  ])
    expect((await app.request(`/api/stations/${c.station.id}/plugins/plan`, json(body))).status).toBe(400);
  expect((await app.request(`/api/stations/${c.station.id}/plugins/plan`, json({ requestId: crypto.randomUUID(), action: "enable" }, { "X-Test-User": otherUser }))).status).toBe(404);
  expect(c.requests).toHaveLength(0);
});

test("ownership, tenancy, capability and explicit reach gate dispatch", async () => {
  const c = await setup();
  const artifact = await upload();
  const body = { requestId: crypto.randomUUID(), artifactId: artifact.id };
  const path = `/api/stations/${c.station.id}/skills/plan`;
  expect(
    (await app.request(path, json(body, { "X-Test-User": "anonymous" })))
      .status,
  ).toBe(401);
  expect(
    (await app.request(path, json(body, { "X-Test-User": otherUser }))).status,
  ).toBe(404);
  expect(
    (
      await app.request(
        path,
        json(body, { "X-Test-Tenant": "fleet_11111111111111111111" }),
      )
    ).status,
  ).toBe(404);
  const otherArtifact = await upload({ "X-Test-User": otherUser });
  expect(
    (await app.request(path, json({ ...body, artifactId: otherArtifact.id })))
      .status,
  ).toBe(404);
  const previous = process.env.ENFORCE_CONTROL_PAIR;
  process.env.ENFORCE_CONTROL_PAIR = "true";
  try {
    expect((await app.request(path, json(body))).status).toBe(403);
  } finally {
    if (previous === undefined) delete process.env.ENFORCE_CONTROL_PAIR;
    else process.env.ENFORCE_CONTROL_PAIR = previous;
  }
  await db
    .update(stations)
    .set({ capabilities: ["health"] })
    .where(eq(stations.id, c.station.id));
  expect((await app.request(path, json(body))).status).toBe(403);
  expect(c.requests).toHaveLength(0);
});

test("lost apply replies remain unknown and reconcile from the node receipt", async () => {
  const c = await setup();
  const artifact = await upload();
  let res = await app.request(
    `/api/stations/${c.station.id}/skills/plan`,
    json({ requestId: crypto.randomUUID(), artifactId: artifact.id }),
  );
  const plan = SkillHubOperation.parse(await res.json());
  c.state.dropApply = true;
  res = await app.request(
    `/api/stations/${c.station.id}/skills/operations/${plan.id}/apply`,
    json({ planDigest: plan.plan!.planDigest }),
  );
  expect(res.status).toBe(202);
  expect(SkillHubOperation.parse(await res.json()).state).toBe("unknown");
  res = await app.request(
    `/api/stations/${c.station.id}/skills/operations/${plan.id}/inspect`,
    json({}),
  );
  expect(res.status).toBe(200);
  expect(SkillHubOperation.parse(await res.json()).state).toBe("applied");
});

test("cross-station node replies cannot become a valid plan", async () => {
  const c = await setup();
  c.state.foreignReply = true;
  const artifact = await upload();
  const res = await app.request(
    `/api/stations/${c.station.id}/skills/plan`,
    json({ requestId: crypto.randomUUID(), artifactId: artifact.id }),
  );
  expect(res.status).toBe(202);
  const op = SkillHubOperation.parse(await res.json());
  expect(op.state).toBe("unknown");
  expect(op.plan).toBeNull();
});

test("download needs the node secret and a live matching station operation", async () => {
  const c = await setup();
  const artifact = await upload();
  c.state.holdPlan = true;
  const planning = app.request(
    `/api/stations/${c.station.id}/skills/plan`,
    json({ requestId: crypto.randomUUID(), artifactId: artifact.id }),
  );
  // Wait for a specific broker dispatch, not an elapsed-time barrier.
  await c.planReached;
  const operationId = c.requests.find((r) => r.verb === "skills.plan")!.params
    .operationId;
  const path = `/api/nodes/${c.nodeId}/stations/${c.station.id}/skill-artifacts/${operationId}`;
  expect((await app.request(path, { method: "POST" })).status).toBe(401);
  expect(
    (
      await app.request(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.nodeId}:wrong` },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await app.request(path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.nodeId}:${secret}`,
          "X-AgentPod-Station-Key": "codex:other",
        },
      })
    ).status,
  ).toBe(403);
  await planning;
  expect(
    (
      await app.request(path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.nodeId}:${secret}`,
          "X-AgentPod-Station-Key": "codex:fixture",
        },
      })
    ).status,
  ).toBe(403);
  const [op] = await db
    .select()
    .from(skillOperations)
    .where(eq(skillOperations.id, operationId));
  expect(op?.state).toBe("unknown");
});

test("overlapping retries share one dispatch and preserve the operation ID", async () => {
  const c = await setup();
  const artifact = await upload();
  const request = { requestId: crypto.randomUUID(), artifactId: artifact.id };
  const path = `/api/stations/${c.station.id}/skills/plan`;
  c.state.holdPlan = true;
  const first = app.request(path, json(request));
  await c.planReached;
  const second = await app.request(path, json(request));
  expect(second.status).toBe(202);
  const busy = SkillHubOperation.parse(await second.json());
  expect(busy.inFlight).toBe(true);
  expect(c.requests.filter((r) => r.verb === "skills.plan")).toHaveLength(1);
  await first;
  c.state.holdPlan = false;
  const retried = await app.request(path, json(request));
  expect(retried.status).toBe(200);
  const planned = SkillHubOperation.parse(await retried.json());
  expect(planned.id).toBe(busy.id);
  expect(planned.state).toBe("planned");
  expect(
    (
      await app.request(
        `/api/stations/${c.station.id}/skills/rollback`,
        json({ requestId: request.requestId, profile: "fixture" }),
      )
    ).status,
  ).toBe(409);
  await db
    .update(skillOperations)
    .set({
      leaseToken: "crashed-worker",
      leaseExpiresAt: new Date(0),
      state: "applying",
    })
    .where(eq(skillOperations.id, planned.id));
  const afterCrash = await app.request(
    `/api/stations/${c.station.id}/skills/operations/${planned.id}`,
  );
  expect(SkillHubOperation.parse(await afterCrash.json()).state).toBe(
    "unknown",
  );
  const inspected = await app.request(
    `/api/stations/${c.station.id}/skills/operations/${planned.id}/inspect`,
    json({}),
  );
  expect(SkillHubOperation.parse(await inspected.json()).state).toBe("planned");
});

test("rollback is reviewed separately and cross-owner artifact references fail at the database", async () => {
  const c = await setup();
  let res = await app.request(
    `/api/stations/${c.station.id}/skills/rollback`,
    json({ requestId: crypto.randomUUID(), profile: "fixture" }),
  );
  const rollback = SkillHubOperation.parse(await res.json());
  expect(rollback.plan?.action).toBe("rollback");
  res = await app.request(
    `/api/stations/${c.station.id}/skills/operations/${rollback.id}/apply`,
    json({ planDigest: rollback.plan!.planDigest }),
  );
  expect(SkillHubOperation.parse(await res.json()).state).toBe("applied");
  const foreign = await upload({ "X-Test-User": otherUser });
  await expect(
    Promise.resolve(
      db.insert(skillOperations).values({
        id: crypto.randomUUID().replaceAll("-", ""),
        tenantId: BOOTSTRAP_TENANT_ID,
        userId,
        stationId: c.station.id,
        nodeId: c.nodeId,
        stationKey: c.station.stationKey,
        harness: "codex",
        profile: "fixture",
        action: "install",
        artifactId: foreign.id,
      }),
    ),
  ).rejects.toThrow();
});

test("caller-selected paths and malformed bodies never dispatch", async () => {
  const c = await setup();
  const artifact = await upload();
  const path = `/api/stations/${c.station.id}/skills/plan`;
  for (const extra of [
    { workspacePath: "/other" },
    { url: "https://example.org" },
    { key: "codex:other" },
  ])
    expect(
      (
        await app.request(
          path,
          json({
            requestId: crypto.randomUUID(),
            artifactId: artifact.id,
            ...extra,
          }),
        )
      ).status,
    ).toBe(400);
  expect(
    (
      await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "[",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(8193),
      })
    ).status,
  ).toBe(413);
  expect(c.requests).toHaveLength(0);
});

test("streamed uploads enforce byte and time limits without Content-Length", async () => {
  const chunks = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(5));
      controller.enqueue(new Uint8Array(5));
      controller.close();
    },
  });
  await expect(
    readSkillBody(
      new Request("http://fixture", { method: "POST", body: chunks }),
      8,
    ),
  ).rejects.toThrow("exceeds limit");
  let cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    readSkillBody(
      new Request("http://fixture", { method: "POST", body: stalled }),
      8,
      10,
    ),
  ).rejects.toThrow("interrupted");
  expect(cancelled).toBe(true);
});

test("skill route guards do not intercept unrelated mounted APIs", async () => {
  const unrelated = new Hono()
    .route("/api", createSkillManagementRoutes())
    .get("/api/unrelated", (c) => c.json({ ok: true }));
  expect((await unrelated.request("/api/unrelated")).status).toBe(200);
});
