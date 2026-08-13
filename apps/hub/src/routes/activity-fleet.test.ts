/**
 * Integration Test: GET /api/activity (fleet-wide audit, LR Task 2)
 *
 * Verifies:
 *   1. Returns station_audit rows for the authenticated user, newest-first,
 *      bounded at 30. Rows from other users are excluded.
 *   2. User B sees only their own rows.
 *   3. Unauthenticated / anonymous → 401.
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
import { Hono } from "hono";

import { db, rawSql } from "../db/drizzle";
import { stationAudit } from "../db/schema/audit";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { fleetActivityRoutes } from "./activity-fleet";
import type { AuthUser } from "../auth/middleware";

// ─── Constants ────────────────────────────────────────────────────────────────

const USER_A = "test-fleet-act-user-a";
const USER_B = "test-fleet-act-user-b";

// ─── Minimal test app ─────────────────────────────────────────────────────────

const testApp = new Hono()
  .use("/api/*", async (c, next) => {
    const userId = c.req.header("X-Test-User-Id");
    if (userId && userId !== "anonymous") {
      c.set("user", { id: userId, authType: "api_key" , tenantId: "fleet_00000000000000000000"} satisfies AuthUser);
    } else {
      c.set("user", {
        id: "anonymous",
        authType: "api_key",
        tenantId: "fleet_00000000000000000000",
      } satisfies AuthUser);
    }
    return next();
  })
  .route("/api", fleetActivityRoutes);

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();

  await createTestUser({
    id: USER_A,
    email: "fleet-act-a@example.com",
    name: "Fleet Activity User A",
  });
  await createTestUser({
    id: USER_B,
    email: "fleet-act-b@example.com",
    name: "Fleet Activity User B",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM station_audit WHERE user_id IN (${USER_A}, ${USER_B})`;
    await rawSql`DELETE FROM "user"          WHERE id      IN (${USER_A}, ${USER_B})`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "GET /api/activity returns only the caller's rows, newest-first",
  async () => {
    const now = new Date();
    const older = new Date(now.getTime() - 60_000);

    await db.insert(stationAudit).values([
      {
        tenantId: BOOTSTRAP_TENANT_ID,
        id: "fleet-audit-a-older",
        userId: USER_A,
        nodeId: "node-a-test",
        stationKey: "station-a-test",
        verb: "fs.list",
        paramsSummary: {
        tenantId: BOOTSTRAP_TENANT_ID,},
        result: "ok",
        error: null,
        createdAt: older,
      },
      {
        tenantId: BOOTSTRAP_TENANT_ID,
        id: "fleet-audit-a-newer",
        userId: USER_A,
        nodeId: "node-a-test",
        stationKey: "station-a-test",
        verb: "fs.read",
        paramsSummary: {
        tenantId: BOOTSTRAP_TENANT_ID,},
        result: "ok",
        error: null,
        createdAt: now,
      },
      {
        tenantId: BOOTSTRAP_TENANT_ID,
        id: "fleet-audit-b-1",
        userId: USER_B,
        nodeId: "node-b-test",
        stationKey: "station-b-test",
        verb: "terminal.start",
        paramsSummary: {
        tenantId: BOOTSTRAP_TENANT_ID,},
        result: "ok",
        error: null,
        createdAt: now,
      },
    ]);

    try {
      const res = await testApp.request("/api/activity", {
        headers: { "X-Test-User-Id": USER_A },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{
        userId: string;
        verb: string;
      }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2);
      expect(body.length).toBeLessThanOrEqual(30);
      // All rows belong to USER_A
      expect(body.every((r) => r.userId === USER_A)).toBe(true);
      // No USER_B rows
      expect(body.some((r) => r.userId === USER_B)).toBe(false);
      // Newest-first: fs.read should appear before fs.list
      const verbs = body.map((r) => r.verb);
      const readIdx = verbs.indexOf("fs.read");
      const listIdx = verbs.indexOf("fs.list");
      expect(readIdx).toBeGreaterThanOrEqual(0);
      expect(listIdx).toBeGreaterThanOrEqual(0);
      expect(readIdx).toBeLessThan(listIdx);
    } finally {
      await rawSql`DELETE FROM station_audit WHERE id IN (${"fleet-audit-a-older"}, ${"fleet-audit-a-newer"}, ${"fleet-audit-b-1"})`;
    }
  },
  20_000
);

test("GET /api/activity returns 401 for unauthenticated request", async () => {
  // No X-Test-User-Id header → anonymous → 401
  const res = await testApp.request("/api/activity");
  expect(res.status).toBe(401);
});

test(
  "GET /api/activity as user B returns only B's rows (not A's)",
  async () => {
    const now = new Date();

    await db.insert(stationAudit).values([
      {
        tenantId: BOOTSTRAP_TENANT_ID,
        id: "fleet-audit-sep-a",
        userId: USER_A,
        nodeId: "node-a",
        stationKey: "key-a",
        verb: "fs.write",
        paramsSummary: {
        tenantId: BOOTSTRAP_TENANT_ID,},
        result: "ok",
        error: null,
        createdAt: now,
      },
      {
        tenantId: BOOTSTRAP_TENANT_ID,
        id: "fleet-audit-sep-b",
        userId: USER_B,
        nodeId: "node-b",
        stationKey: "key-b",
        verb: "terminal.start",
        paramsSummary: {
        tenantId: BOOTSTRAP_TENANT_ID,},
        result: "ok",
        error: null,
        createdAt: now,
      },
    ]);

    try {
      const res = await testApp.request("/api/activity", {
        headers: { "X-Test-User-Id": USER_B },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ userId: string }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      // All rows belong to USER_B
      expect(body.every((r) => r.userId === USER_B)).toBe(true);
      // No USER_A rows
      expect(body.some((r) => r.userId === USER_A)).toBe(false);
    } finally {
      await rawSql`DELETE FROM station_audit WHERE id IN (${"fleet-audit-sep-a"}, ${"fleet-audit-sep-b"})`;
    }
  },
  20_000
);
