/**
 * Integration Test: GET /api/stations/:id/activity (P2 Task 6)
 *
 * Verifies:
 *   1. Returns station_audit rows newest-first for the owning user.
 *   2. Unauthenticated request → 401.
 *   3. Another user's request → 404 (station not owned).
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
import { Hono } from "hono";

import { db, rawSql } from "../db/drizzle";
import { stationAudit } from "../db/schema/audit";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import {
  waitForNodeOnline,
  waitForNodeUnregistered,
} from "../../tests/helpers/wait";
import { mintEnrollmentToken, enrollNode } from "../services/enrollment";
import { gatewayRoutes } from "./gateway";
import { stationRoutes } from "./stations";
import { stationActivityRoutes } from "./station-activity";
import { websocket } from "../ws";
import type { AuthUser } from "../auth/middleware";
import type { StationRow } from "../services/station-registry";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER = "test-user-station-act-001";
const OTHER_USER = "test-user-station-act-002";
const STATION_KEY = "activity-test-station";

// ─── Minimal test app ─────────────────────────────────────────────────────────

const testApp = new Hono()
  .use("/api/*", async (c, next) => {
    const userId = c.req.header("X-Test-User-Id");
    if (userId && userId !== "anonymous") {
      c.set("user", { id: userId, authType: "api_key" } satisfies AuthUser);
    } else {
      c.set("user", { id: "anonymous", authType: "api_key" } satisfies AuthUser);
    }
    return next();
  })
  .route("/public/nodes", gatewayRoutes)
  .route("/api", stationRoutes)
  .route("/api", stationActivityRoutes);

// ─── State shared across tests ────────────────────────────────────────────────

let nodeId: string;
let nodeSecret: string;
let stationId: string;

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();

  await createTestUser({
    id: TEST_USER,
    email: "station-act-test@example.com",
    name: "Station Activity Test User",
  });
  await createTestUser({
    id: OTHER_USER,
    email: "station-act-other@example.com",
    name: "Station Activity Other User",
  });

  // Enroll a node under TEST_USER
  const { token } = await mintEnrollmentToken(TEST_USER);
  const enrolled = await enrollNode(token, {
    hostname: "station-act-host",
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });
  nodeId = enrolled.nodeId;
  nodeSecret = enrolled.nodeSecret;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM station_audit WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM stations          WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM nodes             WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM "user"            WHERE id      IN (${TEST_USER}, ${OTHER_USER})`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Start a minimal Bun server with a fake node gateway, adopt the station. */
async function setupServer() {
  // Every test in this file reconnects the SAME node id. The previous test's
  // socket must be out of the connection manager before this one dials, or the
  // "is it online yet" barrier below is satisfied by the dying connection and
  // its teardown can unregister the node out from under this test.
  await waitForNodeUnregistered(nodeId);

  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });

  const baseUrl = `http://localhost:${server.port}`;

  // Connect a fake node so adopt can get detected stations
  const fakeNode = new WebSocket(
    `ws://localhost:${server.port}/public/nodes/gateway`,
    {
      headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
    } as RequestInit & { headers: Record<string, string> }
  );

  await new Promise<void>((res, rej) => {
    fakeNode.onopen = () => res();
    fakeNode.onerror = () => rej(new Error("Fake node WS error"));
  });

  fakeNode.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.type === "req" && msg.verb === "detect") {
      fakeNode.send(
        JSON.stringify({
          type: "res",
          id: msg.id,
          ok: true,
          data: [
            {
              key: STATION_KEY,
              harness: "opencode",
              kind: "leaf",
              displayName: "Activity Test Station",
              parentKey: null,
              workspacePath: "/workspace/act",
              capabilities: [],
            },
          ],
        })
      );
    }
  };

  // onOpen → verifyNodeCredential (argon2id) → register outlasts any fixed
  // sleep under load; wait for the registration itself.
  await waitForNodeOnline(nodeId);

  // Adopt the station via the API
  const adoptRes = await fetch(`${baseUrl}/api/nodes/${nodeId}/stations/adopt`, {
    method: "POST",
    headers: {
      "X-Test-User-Id": TEST_USER,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ keys: [STATION_KEY] }),
  });
  const rows = (await adoptRes.json()) as StationRow[];
  stationId = rows[0]!.id;

  return { server, baseUrl, fakeNode };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "GET /activity returns station_audit rows newest-first",
  async () => {
    const { server, baseUrl, fakeNode } = await setupServer();

    try {
      // Insert two audit rows with known timestamps, older first
      const now = new Date();
      const older = new Date(now.getTime() - 60_000);

      await db.insert(stationAudit).values([
        {
          id: "audit_row_older",
          userId: TEST_USER,
          nodeId,
          stationKey: STATION_KEY,
          verb: "fs.list",
          paramsSummary: {},
          result: "ok",
          error: null,
          createdAt: older,
        },
        {
          id: "audit_row_newer",
          userId: TEST_USER,
          nodeId,
          stationKey: STATION_KEY,
          verb: "fs.read",
          paramsSummary: {},
          result: "ok",
          error: null,
          createdAt: now,
        },
      ]);

      const res = await fetch(`${baseUrl}/api/stations/${stationId}/activity`, {
        headers: { "X-Test-User-Id": TEST_USER },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ verb: string; result: string }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2);
      // Newest first: fs.read should appear before fs.list
      const verbs = body.map((r) => r.verb);
      expect(verbs.indexOf("fs.read")).toBeLessThan(verbs.indexOf("fs.list"));
    } finally {
      await rawSql`DELETE FROM station_audit WHERE id = ${"audit_row_older"} OR id = ${"audit_row_newer"}`;
      fakeNode.close();
      server.stop(true);
    }
  },
  20_000
);

test(
  "GET /activity returns 401 for unauthenticated request",
  async () => {
    const { server, baseUrl, fakeNode } = await setupServer();

    try {
      const res = await fetch(`${baseUrl}/api/stations/${stationId}/activity`);
      // No X-Test-User-Id header → anonymous → 401
      expect(res.status).toBe(401);
    } finally {
      fakeNode.close();
      server.stop(true);
    }
  },
  20_000
);

test(
  "GET /activity returns 404 for a different user's station",
  async () => {
    const { server, baseUrl, fakeNode } = await setupServer();

    try {
      const res = await fetch(`${baseUrl}/api/stations/${stationId}/activity`, {
        headers: { "X-Test-User-Id": OTHER_USER },
      });
      // OTHER_USER does not own this station → 404
      expect(res.status).toBe(404);
    } finally {
      fakeNode.close();
      server.stop(true);
    }
  },
  20_000
);
