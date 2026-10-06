/**
 * Integration Test: recordAudit service (P2 Task 6)
 *
 * Verifies:
 *   1. recordAudit inserts a row with result:"pending".
 *   2. done("ok") updates result to "ok".
 *   3. done("error","msg") sets result="error" and error="msg".
 *   4. The params sanitizer drops "content"/"data" but keeps "path".
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
import { db, rawSql } from "../db/drizzle";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser, deleteTestUser } from "../../tests/helpers/database";
import { recordAudit } from "./audit";

const TEST_USER = "test-user-audit-svc-001";

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "audit-svc-test@example.com",
    name: "Audit Service Test User",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM station_audit WHERE user_id = ${TEST_USER}`;
    await deleteTestUser(TEST_USER);
  } catch {
    // Ignore cleanup errors
  }
});

test("recordAudit inserts a row with result:'pending'", async () => {
  const handle = await recordAudit(db, {
    userId: TEST_USER,
    nodeId: "test-node-audit-1",
    stationKey: "test-station-audit",
    verb: "fs.mkdir",
    params: { path: "/workspace/newdir" },
  });

  expect(handle).toBeDefined();
  expect(typeof handle.done).toBe("function");

  const rows = await rawSql`
    SELECT result FROM station_audit
    WHERE user_id = ${TEST_USER} AND verb = ${"fs.mkdir"}
    ORDER BY created_at DESC LIMIT 1
  `;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.result).toBe("pending");
});

test("done('ok') updates result to 'ok'", async () => {
  const handle = await recordAudit(db, {
    userId: TEST_USER,
    nodeId: "test-node-audit-1",
    stationKey: "test-station-audit",
    verb: "lifecycle",
    params: { action: "restart" },
  });

  await handle.done("ok");

  const rows = await rawSql`
    SELECT result, error FROM station_audit
    WHERE user_id = ${TEST_USER} AND verb = ${"lifecycle"}
    ORDER BY created_at DESC LIMIT 1
  `;
  expect(rows[0]?.result).toBe("ok");
  expect(rows[0]?.error).toBeNull();
});

test("done('error','msg') sets result='error' and error='msg'", async () => {
  const handle = await recordAudit(db, {
    userId: TEST_USER,
    nodeId: "test-node-audit-1",
    stationKey: "test-station-audit",
    verb: "fs.delete",
    params: { path: "/workspace/old.txt", recursive: false },
  });

  await handle.done("error", "permission denied");

  const rows = await rawSql`
    SELECT result, error FROM station_audit
    WHERE user_id = ${TEST_USER} AND verb = ${"fs.delete"}
    ORDER BY created_at DESC LIMIT 1
  `;
  expect(rows[0]?.result).toBe("error");
  expect(rows[0]?.error).toBe("permission denied");
});

test("sanitizer drops 'content' and 'data' but keeps 'path'", async () => {
  const handle = await recordAudit(db, {
    userId: TEST_USER,
    nodeId: "test-node-audit-1",
    stationKey: "test-station-audit",
    verb: "fs.write",
    params: {
      path: "/workspace/config.json",
      content: "secret file content here",
      data: "terminal keystrokes",
      encoding: "utf8",
      backup: true,
    },
  });

  await handle.done("ok");

  const rows = await rawSql`
    SELECT params_summary FROM station_audit
    WHERE user_id = ${TEST_USER} AND verb = ${"fs.write"}
    ORDER BY created_at DESC LIMIT 1
  `;
  const summary = rows[0]?.params_summary as Record<string, unknown>;
  // Safe fields are kept
  expect(summary.path).toBe("/workspace/config.json");
  expect(summary.encoding).toBe("utf8");
  expect(summary.backup).toBe(true);
  // Sensitive fields are stripped
  expect(summary.content).toBeUndefined();
  expect(summary.data).toBeUndefined();
});
