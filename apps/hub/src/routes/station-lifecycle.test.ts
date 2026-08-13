/**
 * Integration Test: hub lifecycle route (capability-gated, audited) — P2 Task 11
 *
 * Verifies:
 *   1. POST /lifecycle {action:"stop"} on a lifecycle-capable station → 200,
 *      node received lifecycle request, audit row result=ok.
 *   2. POST /lifecycle on a station WITHOUT lifecycle capability → 403, node
 *      receives NO request.
 *   3. POST /lifecycle without authentication → 401.
 *
 * Uses the local Docker test-postgres (localhost:5434).
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";

import { db, rawSql } from "../db/drizzle";
import { stationAudit } from "../db/schema/audit";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { waitForNodeOnline } from "../../tests/helpers/wait";
import { mintEnrollmentToken, enrollNode } from "../services/enrollment";
import { gatewayRoutes } from "./gateway";
import { stationLifecycleRoutes } from "./station-lifecycle";
import { stationRoutes } from "./stations";
import { websocket } from "../ws";
import type { AuthUser } from "../auth/middleware";
import type { StationRow } from "../services/station-registry";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER = "test-user-lifecycle-001";

// ─── Minimal test app ─────────────────────────────────────────────────────────

const testApp = new Hono()
  .use("/api/*", async (c, next) => {
    const userId = c.req.header("X-Test-User-Id");
    if (userId && userId !== "anonymous") {
      c.set("user", { id: userId, authType: "api_key" , tenantId: "fleet_00000000000000000000"} satisfies AuthUser);
    } else {
      c.set("user", { id: "anonymous", authType: "api_key" , tenantId: "fleet_00000000000000000000"} satisfies AuthUser);
    }
    return next();
  })
  .route("/public/nodes", gatewayRoutes)
  .route("/api", stationLifecycleRoutes)
  .route("/api", stationRoutes);

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "lifecycle-test@example.com",
    name: "Station Lifecycle Test User",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM station_audit       WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM stations             WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM nodes               WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens   WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM "user"              WHERE id = ${TEST_USER}`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function connectFakeNode(
  serverPort: number,
  nodeId: string,
  nodeSecret: string,
  stationKey: string,
  capabilities: string[],
  capturedMsgs?: string[]
): Promise<WebSocket> {
  const ws = new WebSocket(
    `ws://localhost:${serverPort}/public/nodes/gateway`,
    {
      headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
    } as RequestInit & { headers: Record<string, string> }
  );

  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("Node WS connection error"));
  });

  ws.onmessage = (e) => {
    const raw = String(e.data);
    if (capturedMsgs) capturedMsgs.push(raw);

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type !== "req") return;

    switch (msg.verb) {
      case "detect":
        ws.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            data: [
              {
                key: stationKey,
                harness: "hermes",
                kind: "composite",
                displayName: `Test Station (${stationKey})`,
                parentKey: null,
                workspacePath: `/workspace/${stationKey}`,
                capabilities,
              },
            ],
          })
        );
        break;

      case "lifecycle":
        ws.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            data: {
              running: false,
              pid: null,
              cpuPct: null,
              memBytes: null,
              diskBytes: null,
              uptimeSec: null,
              lastActivity: null,
              note: "stopped by lifecycle action",
            },
          })
        );
        break;
    }
  };

  // onOpen → verifyNodeCredential (argon2id) → register outlasts any fixed
  // sleep under load; wait for the registration itself.
  await waitForNodeOnline(nodeId);
  return ws;
}

async function adoptStation(
  baseUrl: string,
  nodeId: string,
  stationKey: string
): Promise<StationRow> {
  const res = await fetch(`${baseUrl}/api/nodes/${nodeId}/stations/adopt`, {
    method: "POST",
    headers: {
      "X-Test-User-Id": TEST_USER,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ keys: [stationKey] }),
  });
  expect(res.status).toBe(200);
  const rows = (await res.json()) as StationRow[];
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function pollUntil<T>(
  condition: () => T | undefined | null | false,
  timeoutMs = 4000,
  pollMs = 30
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = condition();
    if (result) return result as T;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs} ms`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "POST /lifecycle on a lifecycle-capable station → 200, node received lifecycle, audit row result=ok",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const STATION_KEY = "lifecycle-capable-001";
      const capturedMsgs: string[] = [];

      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "lifecycle-capable-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      const fakeNode = await connectFakeNode(
        server.port!,
        nodeId,
        nodeSecret,
        STATION_KEY,
        ["health", "logs", "fs.read", "lifecycle"],
        capturedMsgs
      );

      const station = await adoptStation(baseUrl, nodeId, STATION_KEY);

      const res = await fetch(
        `${baseUrl}/api/stations/${station.id}/lifecycle`,
        {
          method: "POST",
          headers: {
            "X-Test-User-Id": TEST_USER,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action: "stop" }),
        }
      );

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty("running");

      // Node must have received a lifecycle request
      await pollUntil(() =>
        capturedMsgs.some((raw) => {
          try {
            const m = JSON.parse(raw);
            return m?.type === "req" && m?.verb === "lifecycle";
          } catch {
            return false;
          }
        })
      );

      const lifecycleReqs = capturedMsgs
        .map((raw) => {
          try { return JSON.parse(raw); } catch { return null; }
        })
        .filter((m) => m?.type === "req" && m?.verb === "lifecycle");

      expect(lifecycleReqs.length).toBeGreaterThan(0);
      const req = lifecycleReqs[0];
      expect(req.params.key).toBe(STATION_KEY);
      expect(req.params.action).toBe("stop");

      // Allow audit finalisation to settle
      await new Promise((r) => setTimeout(r, 200));

      // Audit row must exist with result "ok"
      const auditRows = await db
        .select()
        .from(stationAudit)
        .where(
          and(
            eq(stationAudit.userId, TEST_USER),
            eq(stationAudit.nodeId, nodeId),
            eq(stationAudit.stationKey, STATION_KEY),
            eq(stationAudit.verb, "lifecycle")
          )
        );

      expect(auditRows.length).toBeGreaterThan(0);
      const okRows = auditRows.filter((r) => r.result === "ok");
      expect(okRows.length).toBeGreaterThan(0);

      // paramsSummary must contain action but nothing sensitive
      for (const row of auditRows) {
        expect(row.paramsSummary).toHaveProperty("action");
      }

      fakeNode.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "POST /lifecycle on a station WITHOUT lifecycle capability → 403, node receives NO request",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const STATION_KEY = "lifecycle-incapable-001";
      const capturedMsgs: string[] = [];

      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "lifecycle-incapable-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      // Capabilities do NOT include "lifecycle"
      const fakeNode = await connectFakeNode(
        server.port!,
        nodeId,
        nodeSecret,
        STATION_KEY,
        ["health", "logs", "fs.read"],
        capturedMsgs
      );

      const station = await adoptStation(baseUrl, nodeId, STATION_KEY);

      const res = await fetch(
        `${baseUrl}/api/stations/${station.id}/lifecycle`,
        {
          method: "POST",
          headers: {
            "X-Test-User-Id": TEST_USER,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action: "stop" }),
        }
      );

      expect(res.status).toBe(403);

      await new Promise((r) => setTimeout(r, 300));

      // Node must NOT have received any lifecycle request
      const lcReqs = capturedMsgs.filter((raw) => {
        try {
          const m = JSON.parse(raw);
          return m?.type === "req" && m?.verb === "lifecycle";
        } catch {
          return false;
        }
      });
      expect(lcReqs.length).toBe(0);

      fakeNode.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "POST /lifecycle without authentication → 401",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const res = await fetch(
        `${baseUrl}/api/stations/station_fake_id/lifecycle`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // No X-Test-User-Id → anonymous
          },
          body: JSON.stringify({ action: "stop" }),
        }
      );

      expect(res.status).toBe(401);
    } finally {
      server.stop(true);
    }
  },
  10_000
);
