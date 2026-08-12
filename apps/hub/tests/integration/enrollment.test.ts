/**
 * Integration Tests for Node Enrollment Service
 * Tests the full mint-token → enroll → verify → list round-trip
 * against a real PostgreSQL test database.
 */

// IMPORTANT: Import setup first to set environment variables
import "../setup";

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from "bun:test";
import { Hono } from "hono";
import { rawSql } from "../../src/db/drizzle";
import { createTestUser } from "../helpers/database";
import {
  mintEnrollmentToken,
  enrollNode,
  verifyNodeCredential,
} from "../../src/services/enrollment";
import { listNodes } from "../../src/services/node-registry";
import { adoptStations } from "../../src/services/station-registry";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { nodeEnrollRoutes } from "../../src/routes/nodes";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal test server (mirrors gateway.test.ts's pattern)
// ─────────────────────────────────────────────────────────────────────────────

const testApp = new Hono().route("/public/nodes", nodeEnrollRoutes);

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const TEST_USER_ID = "test-user-enrollment-001";

const HOST_INFO = { hostname: "identity-test", os: "linux", arch: "amd64", cpuCount: 2 };

/**
 * Insert a provisioned_runtimes row and return its id.
 *
 * Written directly rather than through createRuntime() so these tests need no
 * provisioner registration — the identity behaviour under test is independent
 * of which driver created the runtime.
 */
async function seedRuntime(userId: string): Promise<string> {
  const id = `rt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await rawSql`
    INSERT INTO provisioned_runtimes (id, user_id, provider, status, name, resource_tier, harness, created_at, updated_at)
    VALUES (${id}, ${userId}, 'docker', 'provisioning', 'identity-test', 'small', 'none', now(), now())
  `;
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup & Teardown
// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  // Ensure a real user row exists so FK on nodes/enrollment_tokens holds
  await createTestUser({
    id: TEST_USER_ID,
    email: "enrollment-test@example.com",
    name: "Enrollment Test User",
  });
});

afterAll(async () => {
  // Clean up in FK order: nodes → enrollment_tokens → user
  try {
    await rawSql`DELETE FROM stations             WHERE user_id = ${TEST_USER_ID}`;
    await rawSql`DELETE FROM provisioned_runtimes WHERE user_id = ${TEST_USER_ID}`;
    await rawSql`DELETE FROM nodes           WHERE user_id = ${TEST_USER_ID}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER_ID}`;
    await rawSql`DELETE FROM "user"           WHERE id      = ${TEST_USER_ID}`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Enrollment service", () => {
  test("mint → enroll → verify → list", async () => {
    // 1. Mint an enrollment token
    const { token } = await mintEnrollmentToken(TEST_USER_ID);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);

    // 2. Enroll a node using that token
    const { nodeId, nodeSecret } = await enrollNode(token, {
      hostname: "vps1",
      os: "linux",
      arch: "amd64",
      cpuCount: 4,
    });
    expect(typeof nodeId).toBe("string");
    expect(typeof nodeSecret).toBe("string");

    // 3. Verify credential — correct secret passes, wrong secret fails
    expect(await verifyNodeCredential(nodeId, nodeSecret)).toBe(true);
    expect(await verifyNodeCredential(nodeId, "wrong-secret")).toBe(false);

    // 4. Node appears in list
    const list = await listNodes(TEST_USER_ID);
    const registered = list.find((n) => n.id === nodeId);
    expect(registered?.hostname).toBe("vps1");
    expect(registered?.os).toBe("linux");
    expect(registered?.arch).toBe("amd64");
    expect(registered?.cpuCount).toBe(4);
  });

  test("a token cannot be reused", async () => {
    const { token } = await mintEnrollmentToken(TEST_USER_ID);

    // First enrollment succeeds
    await enrollNode(token, {
      hostname: "node-a",
      os: "linux",
      arch: "amd64",
      cpuCount: 1,
    });

    // Second enrollment with the same token must throw
    await expect(
      enrollNode(token, {
        hostname: "node-b",
        os: "linux",
        arch: "amd64",
        cpuCount: 1,
      })
    ).rejects.toThrow();
  });

  test("concurrent enrollments with the same token — exactly one succeeds", async () => {
    // Mint a single-use token
    const { token } = await mintEnrollmentToken(TEST_USER_ID);

    // Fire two concurrent enrollNode calls with the same token
    const results = await Promise.allSettled([
      enrollNode(token, {
        hostname: "concurrent-node-a",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      }),
      enrollNode(token, {
        hostname: "concurrent-node-b",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one must succeed; the other must be rejected (token already consumed)
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  test("credential-check returns 200 for a valid node credential", async () => {
    const { token } = await mintEnrollmentToken(TEST_USER_ID);
    const { nodeId, nodeSecret } = await enrollNode(token, {
      hostname: "credcheck-host", os: "linux", arch: "amd64", cpuCount: 1,
    });
    const res = await testApp.request("/public/nodes/credential-check", {
      headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true });
  });

  test("credential-check returns 401 for a wrong secret and for a missing header", async () => {
    const { token } = await mintEnrollmentToken(TEST_USER_ID);
    const { nodeId } = await enrollNode(token, {
      hostname: "credcheck-bad-host", os: "linux", arch: "amd64", cpuCount: 1,
    });
    const bad = await testApp.request("/public/nodes/credential-check", {
      headers: { Authorization: `Bearer ${nodeId}:wrong-secret` },
    });
    expect(bad.status).toBe(401);
    const missing = await testApp.request("/public/nodes/credential-check");
    expect(missing.status).toBe(401);
  });

  // ─── runtime-bound token lifetime ──────────────────────────────────────────

  test("a runtime-bound token is minted durable, an unbound one is not", async () => {
    // A runtime-bound token has to survive as long as its runtime — it is
    // re-presented on every container restart, which may be months later. An
    // unbound token is pasted into a shell by a human within the hour.
    const runtimeId = await seedRuntime(TEST_USER_ID);

    const bound = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
    });
    const unbound = await mintEnrollmentToken(TEST_USER_ID);

    const oneDay = 24 * 60 * 60 * 1000;
    expect(bound.expiresAt.getTime() - Date.now()).toBeGreaterThan(oneDay);
    expect(unbound.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000 + 5_000);
  });

  test("an explicit ttlMs still wins for a runtime-bound token", async () => {
    // The durable default must not take away a caller's ability to say
    // otherwise — tests and future callers may want a short-lived bound token.
    const runtimeId = await seedRuntime(TEST_USER_ID);
    const t = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
      ttlMs: 60_000,
    });
    expect(t.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(65_000);
  });

  // ─── runtime-bound re-enrolment ───────────────────────────────────────────

  test("re-enrolling a runtime-bound token returns the SAME node", async () => {
    // The headline behaviour. On an ephemeral-disk substrate the container
    // re-enrols on every restart; today that mints a new node and orphans the
    // old one, so the runtime loses its stations, capabilities and history.
    const runtimeId = await seedRuntime(TEST_USER_ID);
    const { token } = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
    });

    const first = await enrollNode(token, HOST_INFO);
    const second = await enrollNode(token, HOST_INFO);

    expect(second.nodeId).toBe(first.nodeId);
  });

  test("re-enrolment rotates the secret and invalidates the old one", async () => {
    // The container never stores a secret durably, so a fresh one each restart
    // costs nothing — and a secret that leaked from a previous incarnation
    // stops working.
    const runtimeId = await seedRuntime(TEST_USER_ID);
    const { token } = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
    });

    const first = await enrollNode(token, HOST_INFO);
    const second = await enrollNode(token, HOST_INFO);

    expect(second.nodeSecret).not.toBe(first.nodeSecret);
    expect(await verifyNodeCredential(second.nodeId, second.nodeSecret)).toBe(true);
    expect(await verifyNodeCredential(first.nodeId, first.nodeSecret)).toBe(false);
  });

  test("re-enrolment does not create a second node", async () => {
    // Guards the orphaning directly: counting rows catches a bug that returning
    // the right id from the wrong code path would hide.
    const runtimeId = await seedRuntime(TEST_USER_ID);
    const { token } = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
    });

    await enrollNode(token, HOST_INFO);
    await enrollNode(token, HOST_INFO);
    await enrollNode(token, HOST_INFO);

    const rows = (await rawSql`
      SELECT node_id FROM provisioned_runtimes WHERE id = ${runtimeId}
    `) as Array<{ node_id: string }>;
    const nodeId = rows[0]!.node_id;

    const nodeRows = (await rawSql`
      SELECT count(*)::int AS n FROM nodes WHERE id = ${nodeId}
    `) as Array<{ n: number }>;
    expect(nodeRows[0]!.n).toBe(1);
  });

  test("an unbound token is still strictly one-time", async () => {
    // The security property this change must not erode. A reusable token is a
    // durable credential; only runtime-bound ones earn that, because they
    // resolve to exactly one runtime and are revoked by destroying it.
    const { token } = await mintEnrollmentToken(TEST_USER_ID);
    await enrollNode(token, HOST_INFO);
    await expect(enrollNode(token, HOST_INFO)).rejects.toThrow(
      /invalid or expired enrollment token/
    );
  });

  test("a runtime-bound token whose runtime is gone is rejected", async () => {
    // provisionedRuntimeId is ON DELETE SET NULL, so a destroyed runtime leaves
    // a token pointing at nothing. It must not silently degrade into "mint me
    // anything" — the identity it referred to is gone on purpose.
    const runtimeId = await seedRuntime(TEST_USER_ID);
    const { token } = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
    });
    await enrollNode(token, HOST_INFO);

    await rawSql`DELETE FROM provisioned_runtimes WHERE id = ${runtimeId}`;

    await expect(enrollNode(token, HOST_INFO)).rejects.toThrow();
  });

  test("first boot on a runtime-bound token still mints and links", async () => {
    // The existing provisioning path must be untouched.
    const runtimeId = await seedRuntime(TEST_USER_ID);
    const { token } = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
    });

    const { nodeId } = await enrollNode(token, HOST_INFO);

    const rows = (await rawSql`
      SELECT node_id, status FROM provisioned_runtimes WHERE id = ${runtimeId}
    `) as Array<{ node_id: string; status: string }>;
    expect(rows[0]!.node_id).toBe(nodeId);
    expect(rows[0]!.status).toBe("online");
  });

  test("concurrent re-enrolment converges on one node", async () => {
    // Runtime-bound re-enrolment cannot gate on usedAt, so it loses the atomic
    // consume that protects the unbound path. Two containers starting at once
    // must still not produce two nodes.
    const runtimeId = await seedRuntime(TEST_USER_ID);
    const { token } = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
    });
    const { nodeId } = await enrollNode(token, HOST_INFO);

    const results = await Promise.allSettled([
      enrollNode(token, HOST_INFO),
      enrollNode(token, HOST_INFO),
    ]);
    for (const r of results) {
      if (r.status === "fulfilled") expect(r.value.nodeId).toBe(nodeId);
    }

    const nodeRows = (await rawSql`
      SELECT count(*)::int AS n FROM nodes WHERE id = ${nodeId}
    `) as Array<{ n: number }>;
    expect(nodeRows[0]!.n).toBe(1);
  });

  test("adopted stations survive a re-enrolment", async () => {
    // Identity is only worth persisting if what hangs off it persists too.
    // Stations key on nodeId, so keeping the id keeps the fleet's view intact —
    // this is the difference between "the runtime came back" and "the runtime
    // came back as itself".
    const runtimeId = await seedRuntime(TEST_USER_ID);
    const { token } = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
    });
    const { nodeId } = await enrollNode(token, HOST_INFO);

    await adoptStations(TEST_USER_ID, nodeId, ["opencode:workspace"], [
      {
        key: "opencode:workspace", harness: "opencode", kind: "leaf",
        displayName: "workspace", parentKey: null, workspacePath: "/workspace",
        capabilities: ["health", "acp"], adopted: false,
      },
    ]);

    await enrollNode(token, HOST_INFO);

    const rows = (await rawSql`
      SELECT station_key FROM stations WHERE node_id = ${nodeId}
    `) as Array<{ station_key: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.station_key).toBe("opencode:workspace");
  });
});
