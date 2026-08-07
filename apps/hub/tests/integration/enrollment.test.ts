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
});
