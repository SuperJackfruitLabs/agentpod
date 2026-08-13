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
process.env.ENABLE_MODAL_PROVISIONING = "true";
// reprovisionRuntime runs without a request in hand — a rotation sweep has no
// origin to take a hub URL from — so it reads one from configuration. Unset,
// every re-create throws rather than handing a container a hub it cannot dial.
process.env.PROVISIONING_HUB_URL = "https://hub.test";

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { db, rawSql } from "../db/drizzle";
import { provisionedRuntimes, enrollmentTokens, nodes } from "../db/schema/nodes";
import { stations } from "../db/schema/stations";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { registerProvisioner, resetProvisioners } from "../services/provisioner/registry";
import type {
  RuntimeProvisioner,
  ProvisionSpec,
  RuntimeState,
} from "../services/provisioner/types";
import { runtimeRoutes } from "./runtimes";
import {
  sweepStalledRuntimeStarts,
  START_TIMEOUT_MS,
  sweepStalledRuntimeStops,
  STOP_TIMEOUT_MS,
  sweepExpiringRuntimes,
  ROTATION_MARGIN_MS,
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

// ─── A terminal-stop fake: the shape Modal forces ─────────────────────────────
//
// No start(), because there is nothing to start — terminate is irreversible and
// every restart is a new sandbox. What survives is the driver's ANCHOR, and a
// driver anchors by spec.runtimeId, so provisioning again with the same
// runtimeId re-attaches the same workspace. The external id below is shaped
// like the real Modal driver's (`<volume>#<sandbox>`) so a test can see which
// half changed.

const terminalCalls: {
  provision: ProvisionSpec[];
  stop: string[];
  /** Every id the hub asked the substrate about. Rotation must ask about none. */
  status: string[];
  /** Interleaved log, so "terminate BEFORE create" is checkable, not assumed. */
  order: string[];
} = { provision: [], stop: [], status: [], order: [] };

let terminalCounter = 0;
/** Makes the substrate refuse to terminate the instance being replaced. */
let terminalStopFails = false;
/** Makes the substrate refuse to create the replacement. */
let terminalProvisionFails = false;
/** What the substrate reports about a sandbox, when it is asked at all. */
let terminalState: RuntimeState = "running";
/**
 * Runs once, inside the next provision() call, then clears itself.
 *
 * The seam a test needs to act WHILE the hub is mid-flight — an operator
 * stopping one runtime while a sweep is busy re-creating another.
 */
let terminalDuringProvision: ((spec: ProvisionSpec) => Promise<void>) | null = null;

const fakeTerminalProvisioner: RuntimeProvisioner = {
  provider: "modal",
  manifest: {
    provider: "modal",
    workspaceStorage: "volume",
    stopSemantics: "terminal",
    maxLifetimeMs: 86_400_000,
    imageBinding: "per-instance",
    supportedTiers: ["small", "medium", "large"],
    idleBehaviour: "never",
    lifecycle: ["stop", "status"],
  },
  async provision(spec) {
    terminalCalls.provision.push(spec);
    terminalCalls.order.push(`provision:${spec.runtimeId}`);
    if (terminalDuringProvision) {
      const hook = terminalDuringProvision;
      terminalDuringProvision = null;
      await hook(spec);
    }
    if (terminalProvisionFails) throw new Error("modal: no capacity");
    return { externalId: `vol-${spec.runtimeId}#sb-${++terminalCounter}` };
  },
  async destroy() {},
  async stop(externalId) {
    terminalCalls.stop.push(externalId);
    terminalCalls.order.push(`stop:${externalId}`);
    if (terminalStopFails) throw new Error("modal: sandbox already terminated");
  },
  async status(externalId) {
    terminalCalls.status.push(externalId);
    return terminalState;
  },
  // Deliberately NO start(): conformance rule 3 forbids one on a terminal
  // driver, and this is the case startRuntime has to handle without it.
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
  registerFakeProvisioners();
});

/**
 * Register both fakes.
 *
 * A helper rather than two calls, because two tests below clear the registry on
 * purpose and have to put it back exactly as it was — restoring only docker
 * left every later modal test failing with "provider not registered", which
 * reads as a broken feature rather than a broken fixture.
 */
function registerFakeProvisioners() {
  registerProvisioner(fakeDockerProvisioner);
  registerProvisioner(fakeTerminalProvisioner);
}

afterEach(() => {
  // Clear call history between tests (but keep the registration).
  fakeCalls.provision.length = 0;
  fakeCalls.destroy.length = 0;
  fakeCalls.start.length = 0;
  terminalCalls.provision.length = 0;
  terminalCalls.stop.length = 0;
  terminalCalls.status.length = 0;
  terminalCalls.order.length = 0;
  terminalStopFails = false;
  terminalProvisionFails = false;
  terminalState = "running";
  terminalDuringProvision = null;
});

afterAll(async () => {
  resetProvisioners();
  // These two are set on `process.env` above and `bun test` runs every file in
  // ONE process, so leaving them set would silently enable a modal provider —
  // and pin a hub URL — for every file that runs after this one.
  delete process.env.ENABLE_MODAL_PROVISIONING;
  delete process.env.PROVISIONING_HUB_URL;
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
    // Re-register the fakes so later tests continue to work
    registerFakeProvisioners();
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
    registerFakeProvisioners();
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

// ─── external_started_at: the age of the CURRENT instance ─────────────────────
//
// A substrate with a lifetime ceiling — Modal destroys a sandbox at 24h, with no
// warning callback and no way back — forces the hub to know how old the
// *instance* is. `created_at` cannot answer that: once a runtime has been
// re-created against its durable anchor, the row is older than the thing
// running. These tests pin the only three answers the column may give: "when
// the substrate accepted this instance", "null, because provisioning failed and
// there is no instance", and "null, because nobody wrote one".

test("provisioning records when the instance started, not only when the row was made", async () => {
  const before = Date.now();
  const { id } = (await (await createRuntime(TEST_USER, "instance-clock")).json()) as {
    id: string;
  };

  const row = await rowOf(id);
  expect(row.externalStartedAt).toBeInstanceOf(Date);
  // Bounded on both sides. The rotation sweeper subtracts this from now(), so a
  // constant, a far-off default or a zero is worse than useless: it would date
  // an instance that is not the one running.
  expect(row.externalStartedAt!.getTime()).toBeGreaterThanOrEqual(before);
  expect(row.externalStartedAt!.getTime()).toBeLessThanOrEqual(Date.now());
  // It is written with the externalId because the two describe the same
  // instance: one names it, the other dates it, and they must not disagree.
  expect(row.externalId).toBe(`fake-container-${id}`);
}, 30_000);

test("a runtime whose provision failed has NO instance start time", async () => {
  // The guard that keeps this column from decaying into a second created_at.
  // Nothing was started here, so there is no age to report — and a DEFAULT
  // now(), or a write at insert time, would hand sweepExpiringRuntimes the age
  // of an instance that does not exist. Its answer to an old instance is to
  // terminate and re-create, so a fabricated timestamp buys a billed sandbox
  // for a runtime that failed.
  const refusing: RuntimeProvisioner = {
    ...fakeDockerProvisioner,
    async provision(spec) {
      fakeCalls.provision.push(spec);
      throw new Error("substrate refused");
    },
  };

  await withProvisioner(refusing, async () => {
    const res = await createRuntime(TEST_USER, "never-started");
    expect(res.status).toBe(502);

    const [row] = await db
      .select()
      .from(provisionedRuntimes)
      .where(eq(provisionedRuntimes.name, "never-started"));
    expect(row!.status).toBe("error");
    expect(row!.externalId).toBeNull();
    expect(row!.externalStartedAt).toBeNull();
  });
}, 30_000);

test("a row written without an instance start time keeps NULL — the column is additive", async () => {
  // Every provisioned_runtimes row on the live hub predates this column, and a
  // driver with no ceiling (docker, cloudflare) never writes it. So the
  // migration has to be additive in the strict sense: an INSERT naming only the
  // pre-existing columns must still succeed (no NOT NULL), and must leave the
  // new column NULL rather than dating an instance the hub never started (no
  // DEFAULT). Both halves are what makes this deployable against live rows.
  const id = `rt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await rawSql`
    INSERT INTO provisioned_runtimes
      (id, user_id, provider, external_id, status, name, resource_tier, harness, created_at, updated_at)
    VALUES (${id}, ${TEST_USER}, 'docker', 'ext-legacy-row', 'online', 'legacy', 'small', 'none',
            now() - interval '30 days', now() - interval '30 days')
  `;

  expect((await rowOf(id)).externalStartedAt).toBeNull();
}, 30_000);

// ─── Start means CREATE, on a substrate whose stop is terminal ────────────────
//
// Modal has no start verb: terminate cannot be undone, and every restart is a
// new sandbox with a new id and a fresh rootfs. The honest answer is not a 400
// forever — it is that a restart on such a substrate IS a create, against the
// anchor that carries the workspace. The tests below pin the three things that
// make that safe rather than merely convenient: the SAME runtime id (so the
// Volume is re-attached instead of orphaned), a FRESH enrolment token (the hub
// stores only a hash and cannot re-present the old one), and a NEW instance
// clock (the 24h ceiling restarts with the sandbox).

async function createModalRuntime(name: string) {
  const res = await testApp.request("/api/runtimes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-User-Id": TEST_USER,
      "Host": "localhost:3001",
    },
    body: JSON.stringify({ provider: "modal", name, resourceTier: "small" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; externalId: string };
}

/**
 * Age the current instance by two hours.
 *
 * Not cosmetic: without it, "did the re-create rewrite external_started_at?"
 * would be asked of two timestamps milliseconds apart, and a `>=` assertion
 * passes just as happily when nothing was rewritten at all. Backdating makes
 * the question answerable with a strict comparison.
 */
async function ageInstanceByTwoHours(id: string) {
  await rawSql`
    UPDATE provisioned_runtimes
       SET external_started_at = now() - interval '2 hours'
     WHERE id = ${id}
  `;
}

test("starting a terminal-stop runtime creates a NEW instance against the SAME anchor", async () => {
  const { id } = await createModalRuntime("rolling");
  await ageInstanceByTwoHours(id);
  const before = await rowOf(id);

  const res = await startVia(id);
  expect(res.status).toBe(204);

  const after = await rowOf(id);
  // A new sandbox...
  expect(after.externalId).not.toBe(before.externalId);
  // ...on the SAME runtime id, which is what the driver anchors its Volume by.
  // A fresh id here would silently orphan the old Volume — still billed, and
  // holding the only copy of the station's work — and hand the new sandbox an
  // empty workspace, with nothing anywhere saying so.
  expect(terminalCalls.provision.at(-1)!.runtimeId).toBe(id);
  expect(after.externalId!.startsWith(`vol-${id}#`)).toBe(true);
  // The rest of the spec is the runtime's, not a default: a re-create that
  // quietly resized or renamed the station is a different station.
  expect(terminalCalls.provision.at(-1)!.name).toBe("rolling");
  expect(terminalCalls.provision.at(-1)!.resourceTier).toBe("small");
  // No request to take an origin from, so the hub URL comes from config.
  expect(terminalCalls.provision.at(-1)!.hubUrl).toBe("https://hub.test");

  // `starting`, never `online`: the substrate accepting a create is not a node
  // existing. Only enrolment writes online (issue #254).
  expect(after.status).toBe("starting");

  // The new sandbox has a new 24h ceiling, so it needs a new clock. Left at the
  // old value, the rotation sweep would find a freshly created sandbox already
  // "expired" and re-create it again on the very next tick, for ever.
  expect(after.externalStartedAt!.getTime()).toBeGreaterThan(
    before.externalStartedAt!.getTime() + 60 * 60_000
  );
  expect(after.externalStartedAt!.getTime()).toBeLessThanOrEqual(Date.now());
}, 30_000);

test("re-creating terminates the instance it replaces, BEFORE creating its successor", async () => {
  // Leaving the old sandbox behind is one nobody is watching and everybody is
  // paying for. Ordering matters too: two live sandboxes writing to one Volume
  // is the corruption case, so the terminate is not merely eventual.
  const { id, externalId } = await createModalRuntime("no-leak");

  await startVia(id);

  expect(terminalCalls.stop).toEqual([externalId]);
  expect(terminalCalls.order).toEqual([
    `provision:${id}`, // the original create
    `stop:${externalId}`, // the sandbox being replaced, terminated first
    `provision:${id}`, // its successor, on the same anchor
  ]);
}, 30_000);

test("a terminate that fails does not block the re-create, and is not swallowed either", async () => {
  // Best effort by design: the old instance is very often already gone (that is
  // the 24h ceiling doing its thing), and refusing to create a replacement
  // because the corpse would not die again helps nobody. But "best effort" must
  // not mean "unrecorded" — the one case where it matters is a sandbox that is
  // still up, still billing, and now unreferenced by any row.
  const { id, externalId } = await createModalRuntime("stubborn");
  terminalStopFails = true;

  const res = await startVia(id);
  expect(res.status).toBe(204);

  const after = await rowOf(id);
  expect(after.status).toBe("starting");
  expect(after.externalId).not.toBe(externalId);
  // The operator has to be able to see which sandbox was left behind, in the
  // place the console already shows (statusReason renders under the badge).
  expect(after.statusReason).toContain(externalId);
  expect(after.statusReason).toContain("already terminated");
}, 30_000);

test("re-creating mints a fresh enrolment token, because the old one is not in the hub", async () => {
  // The hub stores only a hash, so it cannot re-inject the token it minted. It
  // mints another bound to the same runtime; enrollNode resumes the same node
  // with a rotated secret (PR #252). Nothing is kept in the Volume — the
  // node-agent's config lives on the disposable rootfs on purpose.
  const { id } = await createModalRuntime("tokens");
  const firstToken = terminalCalls.provision.at(-1)!.enrollToken;

  await startVia(id);

  const secondToken = terminalCalls.provision.at(-1)!.enrollToken;
  expect(secondToken).not.toBe(firstToken);
  expect(secondToken.startsWith("enr_")).toBe(true);

  const tokenRows = await db
    .select()
    .from(enrollmentTokens)
    .where(eq(enrollmentTokens.provisionedRuntimeId, id));
  expect(tokenRows.length).toBe(2);
}, 30_000);

test("a re-create the substrate refuses leaves the runtime in error, saying so", async () => {
  // A create can fail, and this one is a create. Leaving the row `starting`
  // after the substrate said no would hand the operator a spinner for something
  // that already failed, and the stalled-start sweeper would eventually report
  // the wrong reason ("no node enrolled") for it.
  const { id } = await createModalRuntime("no-capacity");
  terminalProvisionFails = true;

  const res = await startVia(id);
  expect(res.status).toBe(502);

  const after = await rowOf(id);
  expect(after.status).toBe("error");
  expect(after.statusReason).toContain("no capacity");
}, 30_000);

test("a resumable driver's start is unchanged — it starts the instance it already has", async () => {
  // The terminal branch is additive. Docker and Cloudflare keep the instance
  // across a stop, so their start is still start(): no new instance, no new
  // token, and no new instance clock.
  const createRes = await createRuntime(TEST_USER, "resumable-start");
  const { id } = (await createRes.json()) as { id: string };
  const before = await rowOf(id);

  const res = await startVia(id);
  expect(res.status).toBe(204);

  expect(fakeCalls.start).toEqual([before.externalId!]);
  // Exactly one provision: the create. A second would mean the terminal branch
  // fired for a substrate that never needed it.
  expect(fakeCalls.provision).toHaveLength(1);

  const after = await rowOf(id);
  expect(after.externalId).toBe(before.externalId);
  expect(after.status).toBe("starting");
  expect(after.statusReason).toBeNull();
  // Same instance, so the same instance clock. Rewriting it here would make
  // every start reset the age of a sandbox that never restarted.
  expect(after.externalStartedAt!.getTime()).toBe(
    before.externalStartedAt!.getTime()
  );
}, 30_000);

test("a resumable driver with no start() still refuses — re-creating is not a substitute", async () => {
  // The branch is gated on the MANIFEST, not on the missing method. A resumable
  // substrate keeps the instance, and its disk, across a stop; destroying it and
  // building a new one to satisfy a button would throw the workspace away —
  // exactly the loss stopSemantics exists to prevent. The honest answer for a
  // driver that declares resumable and cannot start is the 400 (and conformance
  // now refuses to let such a driver ship at all).
  const noStart: RuntimeProvisioner = { ...fakeDockerProvisioner };
  delete (noStart as { start?: unknown }).start;

  await withProvisioner(noStart, async () => {
    const createRes = await createRuntime(TEST_USER, "resumable-no-start");
    const { id } = (await createRes.json()) as { id: string };
    const before = await rowOf(id);

    const res = await startVia(id);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(
      "does not support start"
    );

    // Nothing was re-created behind the refusal.
    expect(fakeCalls.provision).toHaveLength(1);
    const after = await rowOf(id);
    expect(after.externalId).toBe(before.externalId);
  });
}, 30_000);

// ─── Rotation: the substrate is about to kill a healthy runtime ───────────────
//
// Modal destroys a sandbox at 24 hours however well it is working, with no
// warning callback, no way to extend it and no way back afterwards. Nothing in
// the API rotates for you, so the hub replaces the instance ahead of the
// deadline — early enough that the replacement has enrolled before the platform
// takes the original, and against the same anchor, so the workspace carries
// over.
//
// The tests below are as much about what must NOT be rotated as what must. On a
// substrate that bills wall-clock for as long as an instance exists, a sweeper
// that re-creates the wrong runtime is not a bug that shows up in a dashboard,
// it is a bill that arrives at the end of the month.

/** The ceiling the terminal fake declares — read from it, never re-typed. */
const CEILING_MS = fakeTerminalProvisioner.manifest.maxLifetimeMs!;

/** Backdate the CURRENT instance's clock, leaving the row's own dates alone. */
async function ageInstanceBy(id: string, ms: number) {
  await db
    .update(provisionedRuntimes)
    .set({ externalStartedAt: new Date(Date.now() - ms) })
    .where(eq(provisionedRuntimes.id, id));
}

async function setRuntimeStatus(
  id: string,
  status: (typeof provisionedRuntimes.$inferSelect)["status"]
) {
  await db
    .update(provisionedRuntimes)
    .set({ status })
    .where(eq(provisionedRuntimes.id, id));
}

/** An instance one second past the point where rotation is due. */
const PAST_DUE_MS = CEILING_MS - ROTATION_MARGIN_MS + 1_000;

/**
 * Forget the calls a test's own setup made.
 *
 * Every createModalRuntime is itself a provision, so counting from zero after
 * setup is what makes "the sweep touched the substrate N times" readable — and
 * for the tests that must see NO substrate call, it is the assertion.
 */
function forgetSubstrateCalls() {
  terminalCalls.provision.length = 0;
  terminalCalls.stop.length = 0;
  terminalCalls.status.length = 0;
  terminalCalls.order.length = 0;
}

/**
 * The instances this sweep created FOR ONE RUNTIME.
 *
 * The sweep is global — it has to be, it runs on a timer with no request — so
 * rows other tests left behind are swept too, and a bare count would make these
 * assertions depend on what ran before them.
 */
const provisionsFor = (id: string) =>
  terminalCalls.provision.filter((p) => p.runtimeId === id);

test("rotates a runtime before the substrate's ceiling destroys it", async () => {
  const { id, externalId } = await createModalRuntime("ages");
  await setRuntimeStatus(id, "online");
  await ageInstanceBy(id, PAST_DUE_MS);
  const before = await rowOf(id);

  const rotated = await sweepExpiringRuntimes();
  expect(rotated).toContain(id);

  const after = await rowOf(id);
  // A different sandbox...
  expect(after.externalId).not.toBe(externalId);
  // ...on the SAME anchor: the volume half of the external id is derived from
  // the runtime id, so the workspace follows. A rotation that produced a new
  // anchor would hand the station an empty disk and orphan a paid volume
  // holding the only copy of its work.
  expect(after.externalId!.startsWith(`vol-${id}#`)).toBe(true);
  expect(terminalCalls.provision.at(-1)!.runtimeId).toBe(id);

  // `starting`, never `online`: a substrate accepting a create is not a node
  // existing. Only enrolment writes online.
  expect(after.status).toBe("starting");
  // The operator has to be able to tell this apart from a failure they caused —
  // the console renders statusReason under the badge.
  expect(after.statusReason).toMatch(/24|ceiling|lifetime/i);

  // The replacement gets its own clock. Left at the old value it would be found
  // "expired" on the very next tick and re-created again, for ever.
  expect(after.externalStartedAt!.getTime()).toBeGreaterThan(
    before.externalStartedAt!.getTime()
  );
  expect(Date.now() - after.externalStartedAt!.getTime()).toBeLessThan(60_000);

  // The old sandbox is terminated rather than left running beside its
  // replacement — two live sandboxes on one volume is the corruption case, and
  // the abandoned one bills until somebody notices.
  expect(terminalCalls.stop).toEqual([externalId]);

  // A fresh enrolment token, because the hub stores only a hash of the first.
  const tokenRows = await db
    .select()
    .from(enrollmentTokens)
    .where(eq(enrollmentTokens.provisionedRuntimeId, id));
  expect(tokenRows.length).toBe(2);
}, 30_000);

test("does not rotate one minute before rotation is due", async () => {
  // The margin is not decoration: it is the time the replacement needs to be
  // created and enrolled before the platform takes the original. But firing
  // early is its own cost — every rotation is a re-enrolment and a fresh
  // rootfs — so the boundary is pinned from both sides (with the test above).
  const { id, externalId } = await createModalRuntime("nearly-due");
  await setRuntimeStatus(id, "online");
  await ageInstanceBy(id, CEILING_MS - ROTATION_MARGIN_MS - 60_000);
  forgetSubstrateCalls();

  expect(await sweepExpiringRuntimes()).not.toContain(id);
  expect((await rowOf(id)).externalId).toBe(externalId);
  expect(provisionsFor(id)).toHaveLength(0);
}, 30_000);

test("does not rotate a young sandbox", async () => {
  const { id, externalId } = await createModalRuntime("young");
  await setRuntimeStatus(id, "online");
  forgetSubstrateCalls();

  expect(await sweepExpiringRuntimes()).not.toContain(id);
  const after = await rowOf(id);
  expect(after.externalId).toBe(externalId);
  expect(after.status).toBe("online");
  expect(provisionsFor(id)).toHaveLength(0);
}, 30_000);

test("NEVER rotates a runtime that was deliberately stopped", async () => {
  // The most expensive mistake available on this substrate. A stopped runtime
  // costs nothing; re-creating one starts a sandbox nobody asked for that bills
  // wall-clock until a human notices — and age alone would say it is due,
  // because a stopped runtime only gets older.
  const { id, externalId } = await createModalRuntime("stopped-for-a-reason");
  await setRuntimeStatus(id, "stopped");
  await ageInstanceBy(id, CEILING_MS + 60 * 60_000);
  forgetSubstrateCalls();

  expect(await sweepExpiringRuntimes()).not.toContain(id);

  const after = await rowOf(id);
  expect(after.status).toBe("stopped");
  expect(after.externalId).toBe(externalId);
  // Not "no new row" — no substrate call at all. A provision here is the bill.
  expect(provisionsFor(id)).toHaveLength(0);
  expect(terminalCalls.stop).not.toContain(externalId);
}, 30_000);

test("NEVER rotates asleep, error, destroyed or stopping runtimes either", async () => {
  // Same reasoning as `stopped`, one step wider. `asleep` is a healthy un-billed
  // state; `stopping` is an operator mid-stop, and re-creating under them is the
  // stop silently undone; `error` and `destroyed` both need a human, and neither
  // is made better by a sandbox appearing on the meter.
  const states = ["asleep", "error", "destroyed", "stopping"] as const;
  const ids: string[] = [];
  for (const state of states) {
    const { id } = await createModalRuntime(`state-${state}`);
    await setRuntimeStatus(id, state);
    await ageInstanceBy(id, CEILING_MS + 60 * 60_000);
    ids.push(id);
  }
  forgetSubstrateCalls();

  const rotated = await sweepExpiringRuntimes();
  for (const id of ids) {
    expect(rotated).not.toContain(id);
    expect(provisionsFor(id)).toHaveLength(0);
  }

  for (let i = 0; i < ids.length; i++) {
    expect((await rowOf(ids[i]!)).status).toBe(states[i]!);
  }
}, 30_000);

test("rotates a runtime still in `starting`, not only an online one", async () => {
  // A runtime whose node has not enrolled yet still has a sandbox on the
  // substrate's kill clock, and that sandbox is just as billed and just as
  // doomed. Excluding `starting` would leave a runtime that is briefly slow to
  // enrol to be destroyed by the platform with nothing replacing it.
  const { id, externalId } = await createModalRuntime("still-starting");
  await ageInstanceBy(id, PAST_DUE_MS);
  expect((await rowOf(id)).status).toBe("provisioning");
  await setRuntimeStatus(id, "starting");

  expect(await sweepExpiringRuntimes()).toContain(id);
  expect((await rowOf(id)).externalId).not.toBe(externalId);
}, 30_000);

test("ignores a substrate that declares no ceiling, however old the instance", async () => {
  // Docker and Cloudflare declare maxLifetimeMs: null — nothing destroys their
  // container for age. Rotating one would throw away a live workspace to solve
  // a problem that substrate does not have. The rule is the MANIFEST, so a
  // driver added tomorrow is covered without touching this sweeper.
  const createRes = await createRuntime(TEST_USER, "eternal");
  const { id } = (await createRes.json()) as { id: string };
  await setRuntimeStatus(id, "online");
  await ageInstanceBy(id, 10 * 86_400_000);
  const before = await rowOf(id);

  expect(await sweepExpiringRuntimes()).not.toContain(id);

  const after = await rowOf(id);
  expect(after.status).toBe("online");
  expect(after.externalId).toBe(before.externalId);
  // Exactly the create — no re-create hiding behind it.
  expect(fakeCalls.provision).toHaveLength(1);
}, 30_000);

test("judges the age of the INSTANCE, not the age of the row", async () => {
  // After the first rotation these are different numbers, and created_at is the
  // wrong one: it only grows, so a runtime that has been rotated once would be
  // found expired on every tick from then on — a fresh sandbox destroyed and
  // rebuilt every fifteen seconds, each one billed, for ever. updated_at is no
  // better: any status write refreshes it.
  const { id, externalId } = await createModalRuntime("old-row-new-sandbox");
  await setRuntimeStatus(id, "online");
  await rawSql`
    UPDATE provisioned_runtimes
       SET created_at = now() - interval '10 days',
           updated_at = now() - interval '10 days'
     WHERE id = ${id}
  `;
  forgetSubstrateCalls();

  expect(await sweepExpiringRuntimes()).not.toContain(id);
  expect((await rowOf(id)).externalId).toBe(externalId);
  expect(provisionsFor(id)).toHaveLength(0);
  // ...and the converse is the headline test above: a row created seconds ago
  // whose INSTANCE clock is old does rotate.
}, 30_000);

test("skips a row with no instance clock instead of guessing its age", async () => {
  // Every provisioned_runtimes row on the live hub predates external_started_at.
  // There is no age to judge here, and the two ways of "handling" that are both
  // wrong: falling back to created_at rotates a 30-day-old row immediately, and
  // treating null as zero rotates it immediately too. It is skipped — the next
  // provision writes a clock, and until then nothing is claimed.
  const id = `rt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await rawSql`
    INSERT INTO provisioned_runtimes
      (id, user_id, provider, external_id, status, name, resource_tier, harness, created_at, updated_at)
    VALUES (${id}, ${TEST_USER}, 'modal', 'vol-legacy#sb-legacy', 'online', 'legacy-modal', 'small', 'none',
            now() - interval '30 days', now() - interval '30 days')
  `;

  expect(await sweepExpiringRuntimes()).not.toContain(id);
  const after = await rowOf(id);
  expect(after.status).toBe("online");
  expect(after.externalId).toBe("vol-legacy#sb-legacy");
  expect(provisionsFor(id)).toHaveLength(0);
}, 30_000);

test("rotates on AGE alone — never because the substrate says the sandbox is dead", async () => {
  // The rule that keeps a crash from becoming a paid crash-loop. A sandbox that
  // died in its first minute will die again the same way, and a sweeper that
  // re-created it would rebuild it every fifteen seconds with nobody watching,
  // billing for each attempt. The node going offline already surfaces this, and
  // Start is one click for the human who looks.
  const { id, externalId } = await createModalRuntime("died-early");
  await setRuntimeStatus(id, "online");
  terminalState = "stopped";
  forgetSubstrateCalls();

  expect(await sweepExpiringRuntimes()).not.toContain(id);
  expect((await rowOf(id)).externalId).toBe(externalId);
  expect(provisionsFor(id)).toHaveLength(0);
  // Not even asked. Rotation is a clock, not a health check — the moment it
  // consults substrate state it acquires the power to resurrect things.
  expect(terminalCalls.status).toHaveLength(0);
}, 30_000);

test("an operator's stop landing mid-sweep wins — the claim is compare-and-set", async () => {
  // The window this closes: the sweep reads a batch of due runtimes, and while
  // it is busy re-creating the first one an operator stops the second. The row
  // in hand still says `online`, because it was read before the stop. Claiming
  // on the id alone would then resurrect a runtime somebody just switched off —
  // a sandbox nobody asked for, billing wall-clock until a human notices, which
  // is the single most expensive mistake available on this substrate.
  //
  // Two due runtimes make the window wide and deterministic: the loop's second
  // claim happens after the first has been fully re-created, and the stop lands
  // inside that first re-create.
  const first = await createModalRuntime("swept-a");
  const second = await createModalRuntime("swept-b");
  for (const { id } of [first, second]) {
    await setRuntimeStatus(id, "online");
    await ageInstanceBy(id, PAST_DUE_MS);
  }
  forgetSubstrateCalls();

  // Whichever the sweep reaches first, the operator stops the other one.
  terminalDuringProvision = async (spec) => {
    const other = spec.runtimeId === first.id ? second.id : first.id;
    await setRuntimeStatus(other, "stopped");
  };

  const rotated = await sweepExpiringRuntimes();

  const stopped = rotated.includes(first.id) ? second : first;
  expect(rotated).toEqual([rotated.includes(first.id) ? first.id : second.id]);
  const after = await rowOf(stopped.id);
  expect(after.status).toBe("stopped");
  expect(after.externalId).toBe(stopped.externalId);
  expect(provisionsFor(stopped.id)).toHaveLength(0);
}, 30_000);

test("two ticks over the same due runtime rotate it once, not twice", async () => {
  // The sweeps run on a 15s interval that does not wait for the previous pass.
  // Whether two passes truly interleave is up to the scheduler — the test above
  // is the one that pins the claim — but overlapping them must never produce two
  // instances on one anchor, which is both the corruption case and a sandbox
  // referenced by no row, billing quietly until the month ends.
  const { id } = await createModalRuntime("raced");
  await setRuntimeStatus(id, "online");
  await ageInstanceBy(id, PAST_DUE_MS);
  forgetSubstrateCalls();

  const [a, b] = await Promise.all([
    sweepExpiringRuntimes(),
    sweepExpiringRuntimes(),
  ]);

  expect([...a, ...b].filter((x) => x === id)).toEqual([id]);
  expect(provisionsFor(id)).toHaveLength(1);
  expect((await rowOf(id)).status).toBe("starting");
}, 30_000);

test("a ceiling shorter than the margin rotates at its midpoint, not on every tick", async () => {
  // The Modal driver takes a lifetime override whose stated purpose is verifying
  // rotation in ten minutes instead of a day. Subtract a flat 30-minute margin
  // from a 10-minute ceiling and the threshold is NEGATIVE: every instance is
  // born past due, and the sweeper re-creates it on every 15s tick, billing each
  // one, for as long as the runtime exists. The margin is capped at half the
  // ceiling so a short-lived substrate keeps the same promise at a smaller
  // scale: replaced with time to spare, not replaced constantly.
  const shortCeiling: RuntimeProvisioner = {
    ...fakeTerminalProvisioner,
    manifest: { ...fakeTerminalProvisioner.manifest, maxLifetimeMs: 10 * 60_000 },
  };

  await withProvisioner(shortCeiling, async () => {
    const { id, externalId } = await createModalRuntime("short-ceiling");
    await setRuntimeStatus(id, "online");
    forgetSubstrateCalls();

    // Brand new, and therefore nowhere near due.
    expect(await sweepExpiringRuntimes()).not.toContain(id);
    expect((await rowOf(id)).externalId).toBe(externalId);
    expect(provisionsFor(id)).toHaveLength(0);

    // ...but still rotated before the substrate takes it.
    await ageInstanceBy(id, 6 * 60_000);
    expect(await sweepExpiringRuntimes()).toContain(id);
    expect((await rowOf(id)).externalId).not.toBe(externalId);
  });
}, 30_000);

test("a rotation the substrate refuses leaves the runtime in error, naming the ceiling", async () => {
  // The runtime is going to be destroyed by the platform within the margin and
  // the hub could not replace it. Leaving it `online` would be the console
  // asserting health right up to the moment it vanishes; leaving it `starting`
  // would blame the wrong thing two minutes later ("no node enrolled").
  const { id } = await createModalRuntime("rotation-refused");
  await setRuntimeStatus(id, "online");
  await ageInstanceBy(id, PAST_DUE_MS);
  terminalProvisionFails = true;

  expect(await sweepExpiringRuntimes()).not.toContain(id);

  const after = await rowOf(id);
  expect(after.status).toBe("error");
  expect(after.statusReason).toContain("no capacity");
  expect(after.statusReason).toMatch(/24|ceiling|lifetime/i);
}, 30_000);
