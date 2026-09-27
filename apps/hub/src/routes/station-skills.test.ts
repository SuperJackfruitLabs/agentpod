// Exercises the real ownership query and broker using an in-process node
// transport. Gateway credential authentication has its own integration suite.
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { SkillInventory } from "@agentpod/contract";
import { Hono } from "hono";
import { db, rawSql } from "../db/drizzle";
import { nodes } from "../db/schema/nodes";
import { stations } from "../db/schema/stations";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { connectionManager } from "../services/connection-manager";
import * as broker from "../services/broker";
import { stationSkillsRoutes } from "./station-skills";
import { inventoryFixture } from "../../../../packages/contract/src/fixtures/skill-inventory";
import type { AuthUser } from "../auth/middleware";

const userId = `test-skills-${crypto.randomUUID()}`;
const made: string[] = [];
const app = new Hono()
  .use("*", async (c, next) => {
    c.set("user", {
      id: c.req.header("X-Test-User") ?? userId,
      tenantId: c.req.header("X-Test-Tenant") ?? BOOTSTRAP_TENANT_ID,
      authType: "api_key",
    } satisfies AuthUser);
    await next();
  })
  .route("/api", stationSkillsRoutes);
beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: userId });
});
afterEach(async () => {
  for (const id of made.splice(0)) {
    connectionManager.unregister(id);
    broker.dropNode(id);
    await rawSql`DELETE FROM nodes WHERE id = ${id}`;
  }
});
afterAll(async () => {
  await rawSql`DELETE FROM "user" WHERE id = ${userId}`;
});

async function setup(
  capabilities = ["skills.inventory"],
  reply: unknown = inventoryFixture,
  error?: string,
) {
  const nodeId = `node_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const id = `station_${crypto.randomUUID()}`;
  await db
    .insert(nodes)
    .values({
      id: nodeId,
      tenantId: BOOTSTRAP_TENANT_ID,
      userId,
      name: nodeId,
      hostname: nodeId,
      os: "linux",
      arch: "arm64",
      secretHash: "test-transport",
    });
  made.push(nodeId);
  await db
    .insert(stations)
    .values({
      id,
      nodeId,
      userId,
      tenantId: BOOTSTRAP_TENANT_ID,
      harness: "codex",
      stationKey: "codex:fixture",
      kind: "leaf",
      displayName: "fixture",
      capabilities,
      adoptedAt: new Date(),
    });
  const requests: unknown[] = [];
  connectionManager.register(nodeId, (msg) => {
    if (msg.type !== "req") return;
    requests.push(msg);
    queueMicrotask(() =>
      broker.handleNodeMessage(nodeId, {
        type: "res",
        id: msg.id,
        ok: !error,
        ...(error ? { error } : { data: reply }),
      }),
    );
  });
  const post = (body: unknown = {}, headers: Record<string, string> = {}) =>
    app.request(`/api/stations/${id}/skills/inventory`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { post, requests, nodeId };
}

test("owned capable station returns independently unknown observations", async () => {
  const c = await setup();
  const res = await c.post();
  expect(res.status).toBe(200);
  const body = SkillInventory.parse(await res.json());
  expect(body.skills[0]!.evidence.loaded.value).toBeNull();
  expect(body.coverage.complete).toBe(false);
  expect(c.requests).toHaveLength(1);
  expect(c.requests[0]).toMatchObject({
    verb: "skills.inventory",
    params: { key: "codex:fixture" },
  });
});
test("anonymous, other owner and other tenant never reach the node", async () => {
  const c = await setup();
  expect((await c.post({}, { "X-Test-User": "anonymous" })).status).toBe(401);
  expect((await c.post({}, { "X-Test-User": "other-user" })).status).toBe(404);
  expect(
    (await c.post({}, { "X-Test-Tenant": "fleet_11111111111111111111" }))
      .status,
  ).toBe(404);
  expect(c.requests).toHaveLength(0);
});
test("missing capability and caller-controlled paths are rejected before broker", async () => {
  const old = await setup(["health"]);
  expect((await old.post()).status).toBe(403);
  expect(old.requests).toHaveLength(0);
  const c = await setup();
  expect((await c.post({ path: "/other-profile" })).status).toBe(400);
  expect((await c.post({ key: "codex:other" })).status).toBe(400);
  expect(c.requests).toHaveLength(0);
});
test("invalid or cross-station replies cannot become an empty success", async () => {
  for (const reply of [
    {},
    { ...inventoryFixture, stationKey: "codex:other" },
    { ...inventoryFixture, harness: "hermes" },
    {
      ...inventoryFixture,
      skills: [
        {
          ...inventoryFixture.skills[0],
          evidence: { present: { value: true } },
        },
      ],
    },
  ]) {
    const c = await setup(["skills.inventory"], reply);
    expect((await c.post()).status).toBe(502);
  }
});
test("offline and failed inventory remain errors", async () => {
  const c = await setup();
  connectionManager.unregister(c.nodeId);
  expect((await c.post()).status).toBe(409);
  const bad = await setup(["skills.inventory"], undefined, "scan failed");
  expect((await bad.post()).status).toBe(502);
});
