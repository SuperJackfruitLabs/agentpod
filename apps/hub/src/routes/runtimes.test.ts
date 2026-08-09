/**
 * Integration Test: runtime provisioning routes (P4 Task 8)
 *
 * Verifies:
 *   1. POST /api/runtimes {provider:"docker",name:"box1"} → 201; row in DB;
 *      fake provision() called with runtimeId+hubUrl+enrollToken; externalId persisted;
 *      linked enrollment_token row created with provisionedRuntimeId.
 *   2. POST /api/runtimes with disabled provider → 400.
 *   3. GET  /api/runtimes → only the caller's runtimes (isolation by user).
 *   4. GET  /api/runtimes/providers → lists enabled providers.
 *   5. DELETE /api/runtimes/:id → fake destroy() called; row status "destroyed".
 *   6. DELETE /api/runtimes/:otherId (other user's) → 404.
 *   7. POST /api/runtimes/:id/stop on a driver with no stop → 400.
 *   8. Unauthenticated request → 401 (anonymous user in X-Test-User-Id middleware).
 *
 * Uses the local Docker test-postgres (localhost:5434).
 * DATABASE_URL must be set before any src/ modules are imported.
 */

// ─── Env vars BEFORE any src/ imports ─────────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";
process.env.ENABLE_DOCKER_PROVISIONING = "true";

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { db, rawSql } from "../db/drizzle";
import { provisionedRuntimes, enrollmentTokens, nodes } from "../db/schema/nodes";
import { stations } from "../db/schema/stations";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { registerProvisioner, resetProvisioners } from "../services/provisioner/registry";
import type { RuntimeProvisioner, ProvisionSpec } from "../services/provisioner/types";
import { runtimeRoutes } from "./runtimes";
import type { AuthUser } from "../auth/middleware";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER = "test-user-runtimes-001";
const OTHER_USER = "test-user-runtimes-002";

// ─── Fake provisioner ─────────────────────────────────────────────────────────

/** Captures all calls made to the fake so tests can assert on them. */
const fakeCalls: {
  provision: ProvisionSpec[];
  destroy: string[];
  start: string[];
} = { provision: [], destroy: [], start: [] };

const fakeDockerProvisioner: RuntimeProvisioner = {
  provider: "docker",
  async provision(spec) {
    fakeCalls.provision.push(spec);
    return { externalId: `fake-container-${spec.runtimeId}` };
  },
  async destroy(externalId) {
    fakeCalls.destroy.push(externalId);
  },
  async start(externalId) {
    fakeCalls.start.push(externalId);
  },
  // Note: no `stop` — deliberately omitted to test the 400 unsupported path.
};

// ─── Minimal test app ─────────────────────────────────────────────────────────
//
// The auth middleware in production reads Better Auth sessions / API keys.
// In tests we fake it via X-Test-User-Id. "anonymous" → no user → 401.

const testApp = new Hono()
  .use("/api/*", async (c, next) => {
    const userId = c.req.header("X-Test-User-Id");
    if (userId && userId !== "anonymous") {
      c.set("user", { id: userId, authType: "api_key" } satisfies AuthUser);
      return next();
    }
    return c.json({ error: "Unauthorized", message: "Valid session or API key required" }, 401);
  })
  .route("/api/runtimes", runtimeRoutes);

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "runtimes-test@example.com",
    name: "Runtimes Test User",
  });
  await createTestUser({
    id: OTHER_USER,
    email: "runtimes-other@example.com",
    name: "Runtimes Other User",
  });
  // Register the fake provisioner (ENABLE_DOCKER_PROVISIONING=true set above).
  registerProvisioner(fakeDockerProvisioner);
});

afterEach(() => {
  // Clear call history between tests (but keep the registration).
  fakeCalls.provision.length = 0;
  fakeCalls.destroy.length = 0;
  fakeCalls.start.length = 0;
});

afterAll(async () => {
  resetProvisioners();
  try {
    await rawSql`DELETE FROM enrollment_tokens    WHERE user_id IN (${TEST_USER}, ${OTHER_USER})`;
    await rawSql`DELETE FROM provisioned_runtimes WHERE user_id IN (${TEST_USER}, ${OTHER_USER})`;
    await rawSql`DELETE FROM "user"               WHERE id IN (${TEST_USER}, ${OTHER_USER})`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createRuntime(userId: string, name = "box1") {
  const res = await testApp.request("/api/runtimes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-User-Id": userId,
      "Host": "localhost:3001",
    },
    body: JSON.stringify({ provider: "docker", name }),
  });
  return res;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "POST /api/runtimes → 201, DB row with externalId, fake provision called, enrollment token linked",
  async () => {
    const res = await createRuntime(TEST_USER);
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      id: string;
      ownerId: string;
      provider: string;
      externalId: string | null;
      status: string;
    };

    expect(body.ownerId).toBe(TEST_USER);
    expect(body.provider).toBe("docker");
    expect(body.status).toBe("provisioning");
    // externalId is set immediately after provision() resolves
    expect(typeof body.externalId).toBe("string");
    expect(body.externalId).toContain("fake-container-");

    // The fake provision() was called exactly once
    expect(fakeCalls.provision).toHaveLength(1);
    const spec = fakeCalls.provision[0]!;
    expect(spec.runtimeId).toBe(body.id);
    expect(typeof spec.hubUrl).toBe("string");
    expect(spec.hubUrl.length).toBeGreaterThan(0);
    expect(typeof spec.enrollToken).toBe("string");
    expect(spec.enrollToken.startsWith("enr_")).toBe(true);

    // A provisionedRuntimes DB row exists with the externalId
    const [row] = await db
      .select()
      .from(provisionedRuntimes)
      .where(eq(provisionedRuntimes.id, body.id));
    expect(row).toBeDefined();
    expect(row!.externalId).toBe(body.externalId);

    // An enrollment_tokens row linked to the runtimeId was created
    const tokenRows = await db
      .select()
      .from(enrollmentTokens)
      .where(eq(enrollmentTokens.provisionedRuntimeId, body.id));
    expect(tokenRows.length).toBeGreaterThanOrEqual(1);
    expect(tokenRows[0]!.provisionedRuntimeId).toBe(body.id);
  },
  30_000
);

test("POST /api/runtimes with disabled provider → 400", async () => {
  // "cloudflare" provider — ENABLE_CLOUDFLARE_SANDBOXES is not set → disabled
  const res = await testApp.request("/api/runtimes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-User-Id": TEST_USER,
      "Host": "localhost:3001",
    },
    body: JSON.stringify({ provider: "cloudflare", name: "cf-box" }),
  });
  expect(res.status).toBe(400);
});

test("GET /api/runtimes → only the caller's runtimes", async () => {
  // Create one runtime for TEST_USER and one for OTHER_USER
  await createRuntime(TEST_USER, "user1-box");
  await createRuntime(OTHER_USER, "user2-box");

  const res = await testApp.request("/api/runtimes", {
    headers: { "X-Test-User-Id": TEST_USER },
  });
  expect(res.status).toBe(200);

  const list = (await res.json()) as Array<{ ownerId: string }>;
  expect(Array.isArray(list)).toBe(true);
  // Every returned runtime must belong to TEST_USER
  for (const rt of list) {
    expect(rt.ownerId).toBe(TEST_USER);
  }
  // OTHER_USER's runtimes must NOT appear
  const otherUserRts = list.filter((r) => r.ownerId === OTHER_USER);
  expect(otherUserRts).toHaveLength(0);
}, 30_000);

test("GET /api/runtimes → destroyed runtimes are excluded (no immortal ghost rows)", async () => {
  // Regression: destroyed rows are kept in the DB for history, but the list
  // endpoint must not return them — the console can take no action on a
  // destroyed runtime, so returning it produces a permanent dead row.
  const createRes = await createRuntime(TEST_USER, "ghost-box");
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { id: string };

  const delRes = await testApp.request(`/api/runtimes/${created.id}`, {
    method: "DELETE",
    headers: { "X-Test-User-Id": TEST_USER },
  });
  expect(delRes.status).toBe(204);

  const res = await testApp.request("/api/runtimes", {
    headers: { "X-Test-User-Id": TEST_USER },
  });
  expect(res.status).toBe(200);
  const list = (await res.json()) as Array<{ id: string }>;
  expect(list.find((r) => r.id === created.id)).toBeUndefined();
}, 30_000);

test("GET /api/runtimes/providers → lists enabled providers", async () => {
  const res = await testApp.request("/api/runtimes/providers", {
    headers: { "X-Test-User-Id": TEST_USER },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { providers: string[] };
  expect(Array.isArray(body.providers)).toBe(true);
  expect(body.providers).toContain("docker");
}, 15_000);

test("DELETE /api/runtimes/:id → fake destroy() called, status destroyed", async () => {
  // First create a runtime
  const createRes = await createRuntime(TEST_USER, "to-delete");
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { id: string; externalId: string };

  const externalId = created.externalId;
  const id = created.id;

  // Now delete it
  const delRes = await testApp.request(`/api/runtimes/${id}`, {
    method: "DELETE",
    headers: { "X-Test-User-Id": TEST_USER },
  });
  expect(delRes.status).toBe(204);

  // Fake destroy() was called with the externalId
  expect(fakeCalls.destroy).toContain(externalId);

  // DB row status is "destroyed"
  const [row] = await db
    .select()
    .from(provisionedRuntimes)
    .where(eq(provisionedRuntimes.id, id));
  expect(row!.status).toBe("destroyed");
}, 30_000);

test("DELETE /api/runtimes/:id removes the provisioned node + its stations (no ghost in the fleet)", async () => {
  const createRes = await createRuntime(TEST_USER, "ghost-check");
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { id: string };

  // Simulate the provisioned container having enrolled: insert a node + station,
  // link the runtime to it (as the gateway's enrollNode would).
  const nodeId = "node_ghost_test_001";
  await db.insert(nodes).values({
    id: nodeId, userId: TEST_USER, name: "ghost", hostname: "ghostbox",
    os: "linux", arch: "amd64", secretHash: "x",
  });
  await db.insert(stations).values({
    id: "st_ghost_001", userId: TEST_USER, nodeId, harness: "opencode",
    stationKey: "opencode:ws", kind: "workspace", displayName: "/workspace",
  });
  await db.update(provisionedRuntimes).set({ nodeId }).where(eq(provisionedRuntimes.id, created.id));

  const delRes = await testApp.request(`/api/runtimes/${created.id}`, {
    method: "DELETE",
    headers: { "X-Test-User-Id": TEST_USER },
  });
  expect(delRes.status).toBe(204);

  // The node is gone (no ghost in the fleet); its station cascade-deleted;
  // the runtime row is kept for history with a null node_id.
  expect((await db.select().from(nodes).where(eq(nodes.id, nodeId))).length).toBe(0);
  expect((await db.select().from(stations).where(eq(stations.nodeId, nodeId))).length).toBe(0);
  const [rt] = await db.select().from(provisionedRuntimes).where(eq(provisionedRuntimes.id, created.id));
  expect(rt!.status).toBe("destroyed");
  expect(rt!.nodeId).toBeNull();
}, 30_000);

test("DELETE /api/runtimes/:id with another user's id → 404", async () => {
  // Create a runtime for OTHER_USER
  const createRes = await createRuntime(OTHER_USER, "other-box");
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { id: string };

  // TEST_USER tries to delete OTHER_USER's runtime
  const delRes = await testApp.request(`/api/runtimes/${created.id}`, {
    method: "DELETE",
    headers: { "X-Test-User-Id": TEST_USER },
  });
  expect(delRes.status).toBe(404);
}, 30_000);

test("POST /api/runtimes/:id/stop on driver with no stop → 400", async () => {
  // Create a runtime (fake docker provisioner has no stop method)
  const createRes = await createRuntime(TEST_USER, "no-stop-box");
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { id: string };

  const stopRes = await testApp.request(`/api/runtimes/${created.id}/stop`, {
    method: "POST",
    headers: { "X-Test-User-Id": TEST_USER },
  });
  expect(stopRes.status).toBe(400);
}, 30_000);

test("unauthenticated request → 401", async () => {
  const res = await testApp.request("/api/runtimes", {
    headers: { "X-Test-User-Id": "anonymous" },
  });
  expect(res.status).toBe(401);
}, 15_000);

test("DELETE /api/runtimes/:id with provider flag OFF → still destroys row (no 500)", async () => {
  // Create the runtime while ENABLE_DOCKER_PROVISIONING is still "true"
  const createRes = await createRuntime(TEST_USER, "flag-off-box");
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { id: string; externalId: string };

  const { id, externalId } = created;

  // Disable the provider flag (provisioner is still registered in the map)
  const originalFlag = process.env.ENABLE_DOCKER_PROVISIONING;
  process.env.ENABLE_DOCKER_PROVISIONING = "false";

  try {
    const delRes = await testApp.request(`/api/runtimes/${id}`, {
      method: "DELETE",
      headers: { "X-Test-User-Id": TEST_USER },
    });
    // Must not be 500 — lifecycle op should succeed even though flag is off
    expect(delRes.status).toBe(204);

    // Fake destroy() was still called (provisioner still registered)
    expect(fakeCalls.destroy).toContain(externalId);

    // DB row must be marked destroyed
    const [row] = await db
      .select()
      .from(provisionedRuntimes)
      .where(eq(provisionedRuntimes.id, id));
    expect(row!.status).toBe("destroyed");
  } finally {
    // Always restore the flag so subsequent tests are not affected
    process.env.ENABLE_DOCKER_PROVISIONING = originalFlag;
  }
}, 30_000);

// ─── Task 3 (P4B): harness + image-by-harness ────────────────────────────────

test(
  "POST /api/runtimes with harness:'opencode' → persists harness, resolves opencode image, returns harness in body",
  async () => {
    const res = await testApp.request("/api/runtimes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-User-Id": TEST_USER,
        "Host": "localhost:3001",
      },
      body: JSON.stringify({ provider: "docker", name: "opencode-box", harness: "opencode" }),
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { id: string; harness: string };

    // Returned ProvisionedRuntime includes harness field
    expect(body.harness).toBe("opencode");

    // DB row persists harness
    const [row] = await db
      .select()
      .from(provisionedRuntimes)
      .where(eq(provisionedRuntimes.id, body.id));
    expect(row!.harness).toBe("opencode");

    // Provision spec image resolves to the opencode-specific image
    expect(fakeCalls.provision).toHaveLength(1);
    const spec = fakeCalls.provision[0]!;
    const expectedImage = process.env.NODE_AGENT_OPENCODE_IMAGE ?? "agentpod-node-opencode:local";
    expect((spec as typeof spec & { image: string }).image).toBe(expectedImage);
  },
  30_000
);

test(
  "POST /api/runtimes without harness → defaults to 'none', resolves generic image",
  async () => {
    const res = await testApp.request("/api/runtimes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-User-Id": TEST_USER,
        "Host": "localhost:3001",
      },
      body: JSON.stringify({ provider: "docker", name: "generic-box" }),
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { id: string; harness: string };
    expect(body.harness).toBe("none");

    const [row] = await db
      .select()
      .from(provisionedRuntimes)
      .where(eq(provisionedRuntimes.id, body.id));
    expect(row!.harness).toBe("none");

    expect(fakeCalls.provision).toHaveLength(1);
    const spec = fakeCalls.provision[0]!;
    const expectedImage = process.env.NODE_AGENT_IMAGE ?? "agentpod-node:local";
    expect((spec as typeof spec & { image: string }).image).toBe(expectedImage);
  },
  30_000
);

test("DELETE /api/runtimes/:id with unregistered provisioner → row still marked destroyed", async () => {
  // Create a runtime while the fake provisioner is registered
  const createRes = await createRuntime(TEST_USER, "unregistered-box");
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { id: string; externalId: string };

  const { id } = created;

  // Clear the registry entirely so no provisioner is found for "docker"
  resetProvisioners();

  try {
    const delRes = await testApp.request(`/api/runtimes/${id}`, {
      method: "DELETE",
      headers: { "X-Test-User-Id": TEST_USER },
    });
    // Driver is absent — but the row must still be cleaned up (no crash)
    expect(delRes.status).toBe(204);

    const [row] = await db
      .select()
      .from(provisionedRuntimes)
      .where(eq(provisionedRuntimes.id, id));
    expect(row!.status).toBe("destroyed");
  } finally {
    // Re-register the fake so later tests continue to work
    registerProvisioner(fakeDockerProvisioner);
  }
}, 30_000);
