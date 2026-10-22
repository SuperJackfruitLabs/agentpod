/**
 * Integration Test: GET /api/activity (fleet-wide audit, LR Task 2)
 *
 * Verifies:
 *   1. Returns the workspace's station_audit rows, newest-first, bounded at 30:
 *      every member's, because the fleet is the workspace's (workspace authority, W4).
 *   2. Another workspace's rows are never included.
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
import { createTestUser, deleteTestUsers } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { fleetActivityRoutes } from "./activity-fleet";
import { tenantForOrg } from "../auth/org-plane/tenant";
import type { AuthUser } from "../auth/middleware";

// ─── Constants ────────────────────────────────────────────────────────────────

const USER_A = "test-fleet-act-user-a";
const USER_B = "test-fleet-act-user-b";
// Two workspaces of their own, so the 30-row page holds only this file's rows.
let TENANT_A = "";
let TENANT_B = "";

// ─── Minimal test app ─────────────────────────────────────────────────────────

const testApp = new Hono()
  .use("/api/*", async (c, next) => {
    const userId = c.req.header("X-Test-User-Id");
    if (userId && userId !== "anonymous") {
      const tenantId = c.req.header("X-Test-Tenant") ?? TENANT_A;
      c.set("user", { id: userId, authType: "api_key", tenantId, workspaceRole: "admin" } satisfies AuthUser);
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
  await createTestUser({ id: USER_A, email: "fleet-act-a@example.com", name: "Fleet Activity User A" });
  await createTestUser({ id: USER_B, email: "fleet-act-b@example.com", name: "Fleet Activity User B" });
  const a = await tenantForOrg({ org: "org_66666666666666666666", ent: ["agentpod"] });
  const b = await tenantForOrg({ org: "org_77777777777777777777", ent: ["agentpod"] });
  if (!a.ok || !b.ok) throw new Error("tenant resolution refused");
  TENANT_A = a.tenantId;
  TENANT_B = b.tenantId;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM station_audit WHERE user_id IN (${USER_A}, ${USER_B})`;
    await deleteTestUsers([USER_A, USER_B]);
  } catch {
    // Ignore cleanup errors
  }
});

function row(id: string, tenantId: string, userId: string, verb: string, createdAt: Date) {
  return { tenantId, id, userId, nodeId: "node-fa", stationKey: "station-fa", verb, paramsSummary: {}, result: "ok" as const, error: null, createdAt };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "GET /api/activity returns every member's rows in the workspace, newest-first",
  async () => {
    const now = new Date();
    const older = new Date(now.getTime() - 60_000);
    await db.insert(stationAudit).values([
      row("fleet-audit-a-older", TENANT_A, USER_A, "fs.list", older),
      row("fleet-audit-a-newer", TENANT_A, USER_A, "fs.read", now),
      row("fleet-audit-b-in-a", TENANT_A, USER_B, "terminal.start", new Date(now.getTime() - 30_000)),
    ]);
    try {
      const res = await testApp.request("/api/activity", { headers: { "X-Test-User-Id": USER_A } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ id: string; verb: string }>;
      expect(body.map((r) => r.id)).toEqual(["fleet-audit-a-newer", "fleet-audit-b-in-a", "fleet-audit-a-older"]);
    } finally {
      await rawSql`DELETE FROM station_audit WHERE id IN (${"fleet-audit-a-older"}, ${"fleet-audit-a-newer"}, ${"fleet-audit-b-in-a"})`;
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
  "GET /api/activity never includes another workspace's rows",
  async () => {
    const now = new Date();
    await db.insert(stationAudit).values([
      row("fleet-audit-sep-a", TENANT_A, USER_A, "fs.write", now),
      row("fleet-audit-sep-b", TENANT_B, USER_B, "terminal.start", now),
    ]);
    try {
      const res = await testApp.request("/api/activity", {
        headers: { "X-Test-User-Id": USER_B, "X-Test-Tenant": TENANT_B },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ id: string }>;
      expect(body.map((r) => r.id)).toEqual(["fleet-audit-sep-b"]);
    } finally {
      await rawSql`DELETE FROM station_audit WHERE id IN (${"fleet-audit-sep-a"}, ${"fleet-audit-sep-b"})`;
    }
  },
  20_000
);
