process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser } from "../../tests/helpers/database";
import { db, rawSql } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { principals } from "../db/schema/organization";
import { principalGrants } from "../db/schema/grants";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { createPrincipal } from "../services/principals";
import { mintEnrollmentToken, enrollNode } from "../services/enrollment";
import { adminMiddleware } from "../auth/admin-middleware";
import { agentsAdminRouter } from "./agents-admin";
import { onProvisionStation } from "../services/matrix-as/hooks";
const run = crypto.randomUUID().slice(0, 8);
const actor = `setup-admin-${run}`;
let nodeId: string;
let operatorId: string;
function app(userId = actor, tenantId = BOOTSTRAP_TENANT_ID) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", {
      id: userId,
      authType: "api_key",
      tenantId,
    });
    await next();
  });
  a.use("*", adminMiddleware);
  return a.route("/", agentsAdminRouter);
}
const request = (id: string, body: unknown, userId = actor) =>
  app(userId).request(`/stations/${id}/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
async function station() {
  const id = `setup-st-${crypto.randomUUID()}`;
  await db.insert(stations).values({
    id,
    userId: actor,
    tenantId: BOOTSTRAP_TENANT_ID,
    nodeId,
    harness: "codex",
    stationKey: id,
    kind: "leaf",
    displayName: "Test",
    capabilities: [],
  });
  return id;
}
const input = () => ({
  requestId: crypto.randomUUID(),
  agent: {
    kind: "new",
    handle: `setup-${run}-${crypto.randomUUID().slice(0, 8)}`,
    displayName: "Test agent",
  },
  dispatch: "me",
});
beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: actor, role: "admin" });
  await createTestUser({ id: `setup-user-${run}` });
  operatorId = await createPrincipal({
    kind: "human",
    handle: `setup-${run}-operator`,
    userId: actor,
  });
  await db.insert(principalGrants).values({
    principalId: operatorId,
    mayDispatch: '["prn_00000000000000000099"]',
    mayGrantReach: true,
  });
  const { token } = await mintEnrollmentToken(actor);
  ({ nodeId } = await enrollNode(token, {
    hostname: "setup-test",
    os: "linux",
    arch: "amd64",
    cpuCount: 1,
  }));
});
afterAll(async () => {
  onProvisionStation(null);
  await rawSql`DELETE FROM nodes WHERE id=${nodeId}`;
  await rawSql`DELETE FROM principals WHERE handle LIKE ${`setup-${run}-%`}`;
  await rawSql`DELETE FROM "user" WHERE id IN (${actor},${`setup-user-${run}`})`;
});
test("setup creates and assigns once; response-loss retry never regrants revoked access", async () => {
  const id = await station(),
    body = input();
  const first = await request(id, body);
  expect(first.status).toBe(200);
  const result = (await first.json()) as { principalId: string };
  expect(result.principalId).toMatch(/^prn_[a-f0-9]{20}$/);
  const [grant] = await db
    .select()
    .from(principalGrants)
    .where(eq(principalGrants.principalId, operatorId));
  expect(JSON.parse(grant!.mayDispatch)).toContain(result.principalId);
  expect(JSON.parse(grant!.mayDispatch)).toContain("prn_00000000000000000099");
  expect(grant!.mayGrantReach).toBe(true);
  await db
    .update(principalGrants)
    .set({ mayDispatch: "[]" })
    .where(eq(principalGrants.principalId, operatorId));
  const retry = await request(id, body);
  expect(retry.status).toBe(200);
  expect(((await retry.json()) as { principalId: string }).principalId).toBe(
    result.principalId,
  );
  const [after] = await db
    .select()
    .from(principalGrants)
    .where(eq(principalGrants.principalId, operatorId));
  expect(after!.mayDispatch).toBe("[]");
  expect((await request(id, { ...body, dispatch: "none" })).status).toBe(409);
});
test("occupied station refuses setup without minting a second identity", async () => {
  const id = await station();
  expect((await request(id, input())).status).toBe(200);
  const second = input();
  expect((await request(id, second)).status).toBe(409);
  expect(
    await db
      .select()
      .from(principals)
      .where(eq(principals.handle, second.agent.handle)),
  ).toHaveLength(0);
});
test("existing assigned agents cannot be moved by setup", async () => {
  const id = await station();
  const res = await request(id, input());
  const { principalId } = (await res.json()) as {
    principalId: string;
    matrix: { status: string };
  };
  const other = await station();
  expect(
    (
      await request(other, {
        requestId: crypto.randomUUID(),
        agent: { kind: "existing", principalId },
        dispatch: "none",
      })
    ).status,
  ).toBe(409);
});
test("setup is admin-only and owner-scoped", async () => {
  const id = await station();
  expect((await request(id, input(), `setup-user-${run}`)).status).toBe(403);
  expect((await request("missing", input())).status).toBe(404);
});
test("Matrix failure leaves assignment and exposes a retry without changing identity", async () => {
  onProvisionStation(async () => {
    throw new Error("homeserver unavailable");
  }, "matrix.example");
  const id = await station(),
    body = input();
  const res = await request(id, body);
  expect(res.status).toBe(200);
  const result = (await res.json()) as {
    principalId: string;
    matrix: { status: string };
  };
  expect(result.matrix.status).toBe("failed");
  onProvisionStation(async () => {}, "matrix.example");
  const retry = await app().request(`/stations/${id}/setup/matrix`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId: result.principalId }),
  });
  expect(retry.status).toBe(200);
  const [row] = await db.select().from(stations).where(eq(stations.id, id));
  expect(row!.principalId).toBe(result.principalId);
  onProvisionStation(null);
});

test("concurrent retries create exactly one identity", async () => {
  const id = await station(),
    body = { ...input(), dispatch: "none" };
  const responses = await Promise.all([request(id, body), request(id, body)]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  const results = await Promise.all(
    responses.map((r) => r.json() as Promise<{ principalId: string }>),
  );
  expect(results[0]!.principalId).toBe(results[1]!.principalId);
  expect(
    await db
      .select()
      .from(principals)
      .where(eq(principals.handle, body.agent.handle)),
  ).toHaveLength(1);
});
test("invalid handles and non-agent identities are refused", async () => {
  const id = await station();
  expect(
    (
      await request(id, {
        ...input(),
        agent: { kind: "new", handle: "Upper Case", displayName: "Bad" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(id, {
        ...input(),
        agent: { kind: "existing", principalId: operatorId },
      })
    ).status,
  ).toBe(404);
  const [row] = await db.select().from(stations).where(eq(stations.id, id));
  expect(row!.principalId).toBeNull();
});
test("existing unassigned identity does not gain dispatchers without consent", async () => {
  const existing = await createPrincipal({
    kind: "agent",
    handle: `setup-${run}-spare`,
  });
  const before = await db
    .select()
    .from(principalGrants)
    .where(eq(principalGrants.principalId, operatorId));
  expect(
    (
      await request(await station(), {
        requestId: crypto.randomUUID(),
        agent: { kind: "existing", principalId: existing },
        dispatch: "none",
      })
    ).status,
  ).toBe(200);
  expect(
    await db
      .select()
      .from(principalGrants)
      .where(eq(principalGrants.principalId, operatorId)),
  ).toEqual(before);
});
test("suspended agents are neither offered nor assigned", async () => {
  const existing = await createPrincipal({
    kind: "agent",
    handle: `setup-${run}-suspended`,
  });
  await db
    .update(principals)
    .set({ suspendedAt: new Date() })
    .where(eq(principals.id, existing));
  const options = (await (
    await app().request("/station-setup/options")
  ).json()) as { agents: { id: string }[] };
  expect(options.agents.some((a) => a.id === existing)).toBe(false);
  expect(
    (
      await request(await station(), {
        requestId: crypto.randomUUID(),
        agent: { kind: "existing", principalId: existing },
        dispatch: "none",
      })
    ).status,
  ).toBe(403);
});
test("Matrix failure survives reload; a no-op provisioner does not prove a room exists", async () => {
  onProvisionStation(async () => {
    throw new Error("offline");
  }, "matrix.example");
  const id = await station();
  const first = (await (await request(id, input())).json()) as {
    principalId: string;
  };
  const status = (await (
    await app().request(`/stations/${id}/setup`)
  ).json()) as { matrix: { status: string } };
  expect(status.matrix.status).toBe("failed");
  onProvisionStation(async () => {}, "matrix.example");
  const retry = await app().request(`/stations/${id}/setup/matrix`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId: first.principalId }),
  });
  expect(
    ((await retry.json()) as { matrix: { status: string } }).matrix.status,
  ).toBe("pending");
  onProvisionStation(null);
});

test("setup endpoints reject another owner and a mismatched tenant", async () => {
  const id = await station();
  const stranger = `setup-other-admin-${run}`;
  await createTestUser({ id: stranger, role: "admin" });
  try {
    for (const client of [app(stranger), app(actor, "fleet_99999999999999999999")]) {
      expect((await client.request(`/stations/${id}/setup`)).status).toBe(404);
      for (const [suffix, body] of [
        ["", input()],
        ["/matrix", { principalId: "prn_00000000000000000001" }],
      ] as const) {
        expect(
          (
            await client.request(`/stations/${id}/setup${suffix}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          ).status,
        ).toBe(404);
      }
    }
  } finally {
    await rawSql`DELETE FROM "user" WHERE id=${stranger}`;
  }
});
