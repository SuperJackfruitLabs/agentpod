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
import {
  sweepStalledRuntimeStarts,
  START_TIMEOUT_MS,
  sweepStalledRuntimeStops,
  STOP_TIMEOUT_MS,
} from "../services/runtimes";
import { enrollNode } from "../services/enrollment";
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
  // Declares what this fake actually implements: provision, destroy and start,
  // but deliberately no stop — hence `lifecycle: ["start"]`, which keeps the
  // declaration honest about the 400-unsupported path the tests below exercise.
  manifest: {
    provider: "docker",
    workspaceStorage: "rootfs",
    stopSemantics: "resumable",
    maxLifetimeMs: null,
    imageBinding: "per-instance",
    supportedTiers: ["small", "medium", "large"],
    idleBehaviour: "never",
    lifecycle: ["start"],
  },
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

test("POST /api/runtimes with a provider no driver registered → 400, and nothing is written", async () => {
  // The contract no longer carries an enum of provider names, so "fly" now
  // reaches the hub instead of being bounced by zod. That must not widen what
  // the hub accepts: the registry is the authority, and a name it does not know
  // is refused BEFORE a runtime row, an enrolment token or a driver call
  // exists. If this ever returns 201, or leaves a row behind, the validation
  // that used to live in the enum has been lost rather than moved.
  const res = await testApp.request("/api/runtimes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-User-Id": TEST_USER,
      "Host": "localhost:3001",
    },
    body: JSON.stringify({ provider: "fly", name: "fly-box" }),
  });
  expect(res.status).toBe(400);

  const rows = await db
    .select()
    .from(provisionedRuntimes)
    .where(eq(provisionedRuntimes.provider, "fly"));
  expect(rows).toHaveLength(0);
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
  const body = (await res.json()) as {
    providers: string[];
    manifests: { provider: string; supportedTiers: string[] }[];
  };
  expect(Array.isArray(body.providers)).toBe(true);
  expect(body.providers).toContain("docker");
  // `providers` and `manifests` are served together because the hub and the
  // console deploy separately: the deployed console still reads `providers`,
  // so removing it the moment the hub learned manifests would blank the New
  // Runtime dialog until the console caught up.
  const docker = body.manifests.find((m) => m.provider === "docker");
  expect(docker?.supportedTiers).toEqual(["small", "medium", "large"]);
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

// ─── container runtime round-trip ─────────────────────────────────────────────

test("the runtime a driver reports is stored and returned", async () => {
  // Proves the value survives the whole path: driver → column → DTO. Without
  // this the field can be plumbed everywhere and still arrive null.
  registerProvisioner({
    provider: "docker",
    async provision() {
      return { externalId: "rt_gvisor_ext", runtime: "runsc" };
    },
    async destroy() {},
  } as never);

  try {
    const res = await testApp.request("/api/runtimes", {
      method: "POST",
      headers: { "X-Test-User-Id": TEST_USER, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "docker", name: "gvisor-rt", resourceTier: "small" }),
    });

    expect(res.status).toBe(201);
    expect(((await res.json()) as Record<string, unknown>).runtime).toBe("runsc");
  } finally {
    registerProvisioner(fakeDockerProvisioner); // restore for later tests
  }
});

test("a driver that reports no runtime stores null", async () => {
  // Null means "not recorded", never a guessed default.
  const res = await testApp.request("/api/runtimes", {
    method: "POST",
    headers: { "X-Test-User-Id": TEST_USER, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "docker", name: "plain-rt", resourceTier: "small" }),
  });

  expect(res.status).toBe(201);
  expect(((await res.json()) as Record<string, unknown>).runtime).toBeNull();
});

// ─── "started but never came back" (issue #254) ───────────────────────────────
//
// `online` is a claim that a node for this runtime is connected. The start path
// cannot know that: it only knows the substrate accepted a start request. On
// 2026-08-12 a runtime read `online` while its container was crash-exiting in
// 892 ms, and the operator restarted it twice on the strength of the lie.

async function startVia(id: string, userId = TEST_USER) {
  return testApp.request(`/api/runtimes/${id}/start`, {
    method: "POST",
    headers: { "X-Test-User-Id": userId },
  });
}

async function rowOf(id: string) {
  const [row] = await db
    .select()
    .from(provisionedRuntimes)
    .where(eq(provisionedRuntimes.id, id));
  return row!;
}

test("a started runtime is not online until a node actually arrives", async () => {
  const createRes = await createRuntime(TEST_USER, "start-no-evidence");
  const { id } = (await createRes.json()) as { id: string };

  // The fake driver's start() resolves — the substrate accepted the request.
  const res = await startVia(id);
  expect(res.status).toBe(204);
  expect(fakeCalls.start).toHaveLength(1);

  // ...but no node has enrolled, so the hub must not claim it is online.
  const row = await rowOf(id);
  expect(row.status).not.toBe("online");
  expect(row.status).toBe("starting");
}, 30_000);

test("a start whose node never arrives times out into error with the reason", async () => {
  // The state the old code could not represent: started, never came back.
  const createRes = await createRuntime(TEST_USER, "start-never-returns");
  const { id } = (await createRes.json()) as { id: string };
  await startVia(id);

  // Before the deadline it is still legitimately "starting".
  expect(await sweepStalledRuntimeStarts(Date.now())).not.toContain(id);
  expect((await rowOf(id)).status).toBe("starting");

  const swept = await sweepStalledRuntimeStarts(Date.now() + START_TIMEOUT_MS + 1_000);
  expect(swept).toContain(id);

  const row = await rowOf(id);
  expect(row.status).toBe("error");
  // The console must be able to say *why*, not just show a red light.
  expect(row.statusReason).toContain("no node enrolled");
}, 30_000);

test("a node enrolling is what makes a started runtime online", async () => {
  const createRes = await createRuntime(TEST_USER, "start-then-enrol");
  const { id } = (await createRes.json()) as { id: string };
  const enrollToken = fakeCalls.provision[0]!.enrollToken;

  await startVia(id);
  expect((await rowOf(id)).status).toBe("starting");

  await enrollNode(enrollToken, {
    hostname: "startbox",
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });

  const row = await rowOf(id);
  expect(row.status).toBe("online");
  expect(row.nodeId).toBeTruthy();
  // A stale failure reason must not linger next to a green badge.
  expect(row.statusReason).toBeNull();
}, 30_000);

test("an error reason from an earlier failure is cleared when the runtime is started again", async () => {
  const createRes = await createRuntime(TEST_USER, "start-clears-reason");
  const { id } = (await createRes.json()) as { id: string };
  await startVia(id);
  await sweepStalledRuntimeStarts(Date.now() + START_TIMEOUT_MS + 1_000);
  expect((await rowOf(id)).statusReason).toBeTruthy();

  await startVia(id);
  const row = await rowOf(id);
  expect(row.status).toBe("starting");
  expect(row.statusReason).toBeNull();
}, 30_000);

test("an asleep runtime is never swept into error", async () => {
  // A sleeping runtime's node is legitimately offline and it wakes on demand.
  // Reporting a routine state as a fault is the failure shape this codebase
  // keeps hitting — the sweeper must not reintroduce it.
  const id = `rt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await rawSql`
    INSERT INTO provisioned_runtimes
      (id, user_id, provider, external_id, status, name, resource_tier, harness, created_at, updated_at)
    VALUES (${id}, ${TEST_USER}, 'cloudflare', 'ext-asleep', 'asleep', 'sleeper', 'small', 'none',
            now() - interval '1 day', now() - interval '1 day')
  `;

  const swept = await sweepStalledRuntimeStarts(Date.now() + START_TIMEOUT_MS + 1_000);
  expect(swept).not.toContain(id);
  expect((await rowOf(id)).status).toBe("asleep");
}, 30_000);

test("a created runtime whose node never arrives times out too", async () => {
  // createRuntime has the same shape as startRuntime: it asks a substrate and
  // then waits. A create that never enrols used to read "provisioning" forever.
  const createRes = await createRuntime(TEST_USER, "create-never-returns");
  const { id } = (await createRes.json()) as { id: string };
  expect((await rowOf(id)).status).toBe("provisioning");

  const swept = await sweepStalledRuntimeStarts(Date.now() + START_TIMEOUT_MS + 1_000);
  expect(swept).toContain(id);

  const row = await rowOf(id);
  expect(row.status).toBe("error");
  expect(row.statusReason).toContain("no node enrolled");
}, 30_000);

// ─── "stopped without evidence" (sibling of #254) ─────────────────────────────
//
// `stopped` is a claim that a container is no longer running — which is what an
// operator reads as "it has stopped costing me money". The stop path could not
// know that: it only knew the substrate's stop call returned. A stop that did
// not take left the console saying `stopped` while a 4 GiB station kept billing.
//
// The absence of a node is NOT evidence of a stop: nodes go offline for network
// reasons while their container runs perfectly well. Only the substrate can say.

/**
 * A driver whose stop() always succeeds and whose status() answers whatever the
 * test tells it to — the substrate's answer is the only thing under test here.
 */
function fakeStoppableProvisioner(
  answers: () => "running" | "stopped" | "unknown",
  opts: { withStatus?: boolean; statusThrows?: boolean } = {}
) {
  const calls = { stop: [] as string[], status: [] as string[] };
  const driver: Record<string, unknown> = {
    provider: "docker",
    async provision(spec: ProvisionSpec) {
      fakeCalls.provision.push(spec);
      return { externalId: `fake-container-${spec.runtimeId}` };
    },
    async destroy() {},
    async start() {},
    async stop(externalId: string) {
      calls.stop.push(externalId);
    },
  };
  if (opts.withStatus !== false) {
    driver.status = async (externalId: string) => {
      calls.status.push(externalId);
      if (opts.statusThrows) throw new Error("substrate unreachable");
      return answers();
    };
  }
  return { driver: driver as unknown as RuntimeProvisioner, calls };
}

async function stopVia(id: string, userId = TEST_USER) {
  return testApp.request(`/api/runtimes/${id}/stop`, {
    method: "POST",
    headers: { "X-Test-User-Id": userId },
  });
}

/** Run a body with a temporary provisioner registered, always restoring. */
async function withProvisioner(
  driver: RuntimeProvisioner,
  body: () => Promise<void>
) {
  registerProvisioner(driver);
  try {
    await body();
  } finally {
    registerProvisioner(fakeDockerProvisioner);
  }
}

test("a runtime the substrate still reports running is not written stopped", async () => {
  // The bug: stopRuntime wrote `stopped` because the stop CALL returned, not
  // because the container went away. The operator then believes billing ended.
  const { driver, calls } = fakeStoppableProvisioner(() => "running");
  await withProvisioner(driver, async () => {
    const { id } = (await (await createRuntime(TEST_USER, "stop-no-evidence")).json()) as {
      id: string;
    };

    const res = await stopVia(id);
    expect(res.status).toBe(204);
    expect(calls.stop).toHaveLength(1);

    const row = await rowOf(id);
    expect(row.status).not.toBe("stopped");
    expect(row.status).toBe("stopping");
  });
}, 30_000);

test("a stop the substrate confirms lands on stopped", async () => {
  // The evidence path: the substrate says the container is down, so the hub may
  // say so too — and nothing about the ordinary stop UX changes.
  const { driver } = fakeStoppableProvisioner(() => "stopped");
  await withProvisioner(driver, async () => {
    const { id } = (await (await createRuntime(TEST_USER, "stop-confirmed")).json()) as {
      id: string;
    };

    expect((await stopVia(id)).status).toBe(204);

    const row = await rowOf(id);
    expect(row.status).toBe("stopped");
    expect(row.statusReason).toBeNull();
  });
}, 30_000);

test("a stop confirmed only later is reconciled to stopped by the sweeper", async () => {
  // Cloudflare's stop returns as soon as the container is signalled; the exit
  // lands seconds later. `stopping` is the honest state in between.
  let state: "running" | "stopped" = "running";
  const { driver } = fakeStoppableProvisioner(() => state);
  await withProvisioner(driver, async () => {
    const { id } = (await (await createRuntime(TEST_USER, "stop-late-confirm")).json()) as {
      id: string;
    };
    await stopVia(id);
    expect((await rowOf(id)).status).toBe("stopping");

    state = "stopped";
    // No timeout needed: confirmation is welcome the moment it exists.
    const swept = await sweepStalledRuntimeStops(Date.now());
    expect(swept.stopped).toContain(id);

    const row = await rowOf(id);
    expect(row.status).toBe("stopped");
    expect(row.statusReason).toBeNull();
  });
}, 30_000);

test("a stop that never takes becomes an error saying so, not a silent stopped", async () => {
  // The expensive case: the container is still up, still billing, and the
  // console must not be the thing that tells the operator otherwise.
  const { driver } = fakeStoppableProvisioner(() => "running");
  await withProvisioner(driver, async () => {
    const { id } = (await (await createRuntime(TEST_USER, "stop-never-takes")).json()) as {
      id: string;
    };
    await stopVia(id);

    // Before the deadline it is still legitimately "stopping".
    expect((await sweepStalledRuntimeStops(Date.now())).failed).not.toContain(id);
    expect((await rowOf(id)).status).toBe("stopping");

    const swept = await sweepStalledRuntimeStops(Date.now() + STOP_TIMEOUT_MS + 1_000);
    expect(swept.failed).toContain(id);

    const row = await rowOf(id);
    expect(row.status).toBe("error");
    expect(row.statusReason).toContain("not confirmed");
    // The operator's actual question is about money: say the quiet part.
    expect(row.statusReason).toContain("still reports it running");
    expect(row.statusReason).toContain("billing");
  });
}, 30_000);

test("a substrate that will not answer ends in error, never in an unevidenced stopped", async () => {
  // The undeployed-worker case: GET /sandbox/:id answers, but with no state in
  // it. The hub has a channel and it is not giving an answer — that is an
  // anomaly for a human, not something to paper over with a green "stopped".
  const { driver } = fakeStoppableProvisioner(() => "unknown");
  await withProvisioner(driver, async () => {
    const { id } = (await (await createRuntime(TEST_USER, "stop-unknown")).json()) as {
      id: string;
    };
    await stopVia(id);
    expect((await rowOf(id)).status).toBe("stopping");

    // A transient no-answer must not fail early — it may resolve next tick.
    await sweepStalledRuntimeStops(Date.now());
    expect((await rowOf(id)).status).toBe("stopping");

    const swept = await sweepStalledRuntimeStops(Date.now() + STOP_TIMEOUT_MS + 1_000);
    expect(swept.failed).toContain(id);

    const row = await rowOf(id);
    expect(row.status).toBe("error");
    expect(row.statusReason).toContain("not confirmed");
  });
}, 30_000);

test("a status() that throws does not fail the stop, it leaves it unconfirmed", async () => {
  // A broken probe must never turn a working stop into a 502 — but it also must
  // not be read as confirmation.
  const { driver } = fakeStoppableProvisioner(() => "stopped", { statusThrows: true });
  await withProvisioner(driver, async () => {
    const { id } = (await (await createRuntime(TEST_USER, "stop-probe-throws")).json()) as {
      id: string;
    };

    expect((await stopVia(id)).status).toBe(204);
    expect((await rowOf(id)).status).toBe("stopping");
  });
}, 30_000);

test("a driver that cannot report state says stopped is unverified rather than pretending", async () => {
  // No status() at all: the hub structurally cannot confirm, and stranding
  // every such runtime in `stopping` forever would be its own lie. So it writes
  // `stopped` — with the caveat attached, in the console, next to the badge.
  const { driver } = fakeStoppableProvisioner(() => "stopped", { withStatus: false });
  await withProvisioner(driver, async () => {
    const { id } = (await (await createRuntime(TEST_USER, "stop-unverifiable")).json()) as {
      id: string;
    };

    expect((await stopVia(id)).status).toBe(204);

    const row = await rowOf(id);
    expect(row.status).toBe("stopped");
    expect(row.statusReason).toContain("unverified");
    expect(row.statusReason).toContain("docker");
  });
}, 30_000);

test("an asleep runtime is never swept by the stop sweeper", async () => {
  // A sleeping Cloudflare runtime is not a failed stop. Same rule as #254.
  const id = `rt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await rawSql`
    INSERT INTO provisioned_runtimes
      (id, user_id, provider, external_id, status, name, resource_tier, harness, created_at, updated_at)
    VALUES (${id}, ${TEST_USER}, 'cloudflare', 'ext-asleep-stop', 'asleep', 'sleeper2', 'small', 'none',
            now() - interval '1 day', now() - interval '1 day')
  `;

  const swept = await sweepStalledRuntimeStops(Date.now() + STOP_TIMEOUT_MS + 1_000);
  expect(swept.stopped).not.toContain(id);
  expect(swept.failed).not.toContain(id);
  expect((await rowOf(id)).status).toBe("asleep");
}, 30_000);

test("the start sweeper does not touch a stopping runtime", async () => {
  // The two sweeps share a tick; they must not share a verdict.
  const { driver } = fakeStoppableProvisioner(() => "running");
  await withProvisioner(driver, async () => {
    const { id } = (await (await createRuntime(TEST_USER, "stop-not-a-start")).json()) as {
      id: string;
    };
    await stopVia(id);

    const swept = await sweepStalledRuntimeStarts(Date.now() + START_TIMEOUT_MS + 1_000);
    expect(swept).not.toContain(id);
    expect((await rowOf(id)).status).toBe("stopping");
  });
}, 30_000);

test("a runtime still being provisioned (no external id yet) is not swept", async () => {
  // Between the row insert and provision() resolving there is no container to
  // have failed — a slow image pull must not be reported as a failure.
  const id = `rt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await rawSql`
    INSERT INTO provisioned_runtimes
      (id, user_id, provider, external_id, status, name, resource_tier, harness, created_at, updated_at)
    VALUES (${id}, ${TEST_USER}, 'docker', NULL, 'provisioning', 'slow-pull', 'small', 'none',
            now() - interval '1 day', now() - interval '1 day')
  `;

  const swept = await sweepStalledRuntimeStarts(Date.now() + START_TIMEOUT_MS + 1_000);
  expect(swept).not.toContain(id);
  expect((await rowOf(id)).status).toBe("provisioning");
}, 30_000);
