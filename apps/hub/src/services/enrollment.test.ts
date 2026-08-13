/**
 * Integration Test: enrollment service (P4 Task 3 — enrollment linking)
 *
 * Verifies:
 *   1. mintEnrollmentToken with no opts → enrollNode succeeds; no runtime is
 *      touched (back-compat path, provisionedRuntimeId null on the token).
 *   2. mintEnrollmentToken({ provisionedRuntimeId }) → enrollNode sets the
 *      runtime status to "online" and writes the nodeId back to the row.
 *
 * Uses the local Docker test-postgres (localhost:5434).
 * DATABASE_URL must be set before any src/ modules are imported.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { eq } from "drizzle-orm";
import { db, rawSql } from "../db/drizzle";
import { provisionedRuntimes } from "../db/schema/nodes";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser } from "../../tests/helpers/database";
import { mintEnrollmentToken, enrollNode } from "./enrollment";

const TEST_USER = "test-user-enrollment-svc-001";

const SAMPLE_HOST_INFO = {
  hostname: "enrollment-test-host",
  os: "linux",
  arch: "amd64",
  cpuCount: 4,
};

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "enrollment-svc-test@example.com",
    name: "Enrollment Service Test User",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM nodes               WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens   WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM provisioned_runtimes WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM "user"              WHERE id      = ${TEST_USER}`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Back-compat path ─────────────────────────────────────────────────────────

test("back-compat: mintEnrollmentToken(userId) — no opts — enrollNode succeeds, no runtime touched", async () => {
  // Mint with no opts (matches existing caller signature)
  const { token, expiresAt } = await mintEnrollmentToken(TEST_USER);
  expect(typeof token).toBe("string");
  expect(token.startsWith("enr_")).toBe(true);
  expect(expiresAt).toBeInstanceOf(Date);

  // Enroll should succeed and return credentials
  const { nodeId, nodeSecret } = await enrollNode(token, SAMPLE_HOST_INFO);
  expect(typeof nodeId).toBe("string");
  expect(nodeId.startsWith("node_")).toBe(true);
  expect(typeof nodeSecret).toBe("string");
  expect(nodeSecret.length).toBeGreaterThan(0);

  // No provisioned_runtimes row should have been modified for this user
  // (there are none, so just assert the count is 0 for back-compat sanity)
  const rows = await db
    .select()
    .from(provisionedRuntimes)
    .where(eq(provisionedRuntimes.userId, TEST_USER));

  // Runtimes created in the linked-path test haven't run yet, so 0 here.
  // The key invariant: enrollNode did NOT throw, which would happen only if
  // it somehow tried to update a non-existent runtime.
  expect(rows.length).toBe(0);
});

// ─── Linked path ──────────────────────────────────────────────────────────────

test("linked path: mintEnrollmentToken({ provisionedRuntimeId }) → enrollNode sets runtime nodeId + status=online", async () => {
  // Insert a provisioning runtime row (no nodeId yet)
  const runtimeId = `rt_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(provisionedRuntimes).values({
    tenantId: BOOTSTRAP_TENANT_ID,
    id: runtimeId,
    userId: TEST_USER,
    provider: "docker",
    externalId: "container-abc123",
    status: "provisioning",
    nodeId: null,
    name: "test-runtime",
    resourceTier: "small",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Mint a token linked to this runtime
  const { token } = await mintEnrollmentToken(TEST_USER, { provisionedRuntimeId: runtimeId });
  expect(typeof token).toBe("string");

  // Enroll the node
  const { nodeId, nodeSecret } = await enrollNode(token, SAMPLE_HOST_INFO);
  expect(typeof nodeId).toBe("string");
  expect(typeof nodeSecret).toBe("string");

  // The runtime row must now have nodeId set and status==="online"
  const [rtRow] = await db
    .select()
    .from(provisionedRuntimes)
    .where(eq(provisionedRuntimes.id, runtimeId));

  expect(rtRow).toBeDefined();
  expect(rtRow!.nodeId).toBe(nodeId);
  expect(rtRow!.status).toBe("online");
});

// ─── opts.ttlMs preserved ─────────────────────────────────────────────────────

test("opts.ttlMs overrides the default TTL", async () => {
  const ttlMs = 5 * 60 * 1000; // 5 minutes
  const before = Date.now();
  const { token, expiresAt } = await mintEnrollmentToken(TEST_USER, { ttlMs });
  const after = Date.now();

  expect(typeof token).toBe("string");
  const expiresMs = expiresAt.getTime();
  expect(expiresMs).toBeGreaterThanOrEqual(before + ttlMs);
  expect(expiresMs).toBeLessThanOrEqual(after + ttlMs + 100);
});
