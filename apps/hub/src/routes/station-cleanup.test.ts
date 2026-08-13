/**
 * Integration Test: hub cleanup routes (capability-gated, audited) — P2 Task 13
 *
 * Verifies:
 *   1. POST /cleanup/plan on a cleanup-capable station → 200 + {items,totalBytes},
 *      node received cleanup.plan request, audit row result=ok.
 *   2. POST /cleanup/apply with returned paths → 200 + {removedBytes},
 *      node received cleanup.apply, audit row result=ok.
 *   3. POST /cleanup/plan on a station WITHOUT cleanup capability → 403,
 *      node receives NO request.
 *   4. POST /cleanup/plan without authentication → 401.
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
import { stationCleanupRoutes } from "./station-cleanup";
import { stationRoutes } from "./stations";
import { websocket } from "../ws";
import type { AuthUser } from "../auth/middleware";
import type { StationRow } from "../services/station-registry";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER = "test-user-cleanup-001";

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
  .route("/api", stationCleanupRoutes)
  .route("/api", stationRoutes);

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "cleanup-test@example.com",
    name: "Station Cleanup Test User",
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
    // ignore
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

      case "cleanup.plan":
        ws.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            data: {
              items: [
                { path: "logs", size: 1024, kind: "logs" },
                { path: "tmp", size: 512, kind: "tmp" },
              ],
              totalBytes: 1536,
            },
          })
        );
        break;

      case "cleanup.apply":
        ws.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            data: { removedBytes: 1024 },
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
  "POST /cleanup/plan on cleanup-capable station → 200 + items, node received cleanup.plan, audit ok",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const STATION_KEY = "cleanup-capable-001";
      const capturedMsgs: string[] = [];

      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "cleanup-capable-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      const fakeNode = await connectFakeNode(
        server.port!,
        nodeId,
        nodeSecret,
        STATION_KEY,
        ["health", "logs", "fs.read", "lifecycle", "cleanup"],
        capturedMsgs
      );

      const station = await adoptStation(baseUrl, nodeId, STATION_KEY);

      const res = await fetch(
        `${baseUrl}/api/stations/${station.id}/cleanup/plan`,
        {
          method: "POST",
          headers: {
            "X-Test-User-Id": TEST_USER,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        }
      );

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty("items");
      expect(body).toHaveProperty("totalBytes");
      expect(Array.isArray(body.items)).toBe(true);

      // Node must have received cleanup.plan
      await pollUntil(() =>
        capturedMsgs.some((raw) => {
          try {
            const m = JSON.parse(raw);
            return m?.type === "req" && m?.verb === "cleanup.plan";
          } catch {
            return false;
          }
        })
      );

      // Allow audit finalisation
      await new Promise((r) => setTimeout(r, 200));

      const auditRows = await db
        .select()
        .from(stationAudit)
        .where(
          and(
            eq(stationAudit.userId, TEST_USER),
            eq(stationAudit.nodeId, nodeId),
            eq(stationAudit.stationKey, STATION_KEY),
            eq(stationAudit.verb, "cleanup.plan")
          )
        );
      expect(auditRows.length).toBeGreaterThan(0);
      expect(auditRows.filter((r) => r.result === "ok").length).toBeGreaterThan(0);

      fakeNode.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "POST /cleanup/apply with paths → 200 + removedBytes, node received cleanup.apply, audit ok",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const STATION_KEY = "cleanup-apply-001";
      const capturedMsgs: string[] = [];

      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "cleanup-apply-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      const fakeNode = await connectFakeNode(
        server.port!,
        nodeId,
        nodeSecret,
        STATION_KEY,
        ["health", "logs", "fs.read", "cleanup"],
        capturedMsgs
      );

      const station = await adoptStation(baseUrl, nodeId, STATION_KEY);

      const res = await fetch(
        `${baseUrl}/api/stations/${station.id}/cleanup/apply`,
        {
          method: "POST",
          headers: {
            "X-Test-User-Id": TEST_USER,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ paths: ["logs"] }),
        }
      );

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty("removedBytes");

      // Node must have received cleanup.apply
      await pollUntil(() =>
        capturedMsgs.some((raw) => {
          try {
            const m = JSON.parse(raw);
            return m?.type === "req" && m?.verb === "cleanup.apply";
          } catch {
            return false;
          }
        })
      );

      const applyReqs = capturedMsgs
        .map((raw) => { try { return JSON.parse(raw); } catch { return null; } })
        .filter((m) => m?.type === "req" && m?.verb === "cleanup.apply");
      expect(applyReqs.length).toBeGreaterThan(0);
      expect(applyReqs[0].params.key).toBe(STATION_KEY);
      expect(Array.isArray(applyReqs[0].params.paths)).toBe(true);

      // Allow audit finalisation
      await new Promise((r) => setTimeout(r, 200));

      const auditRows = await db
        .select()
        .from(stationAudit)
        .where(
          and(
            eq(stationAudit.userId, TEST_USER),
            eq(stationAudit.nodeId, nodeId),
            eq(stationAudit.stationKey, STATION_KEY),
            eq(stationAudit.verb, "cleanup.apply")
          )
        );
      expect(auditRows.length).toBeGreaterThan(0);
      expect(auditRows.filter((r) => r.result === "ok").length).toBeGreaterThan(0);

      fakeNode.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "POST /cleanup/plan on station WITHOUT cleanup capability → 403, no node call",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const STATION_KEY = "cleanup-incapable-001";
      const capturedMsgs: string[] = [];

      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "cleanup-incapable-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      // Capabilities do NOT include "cleanup"
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
        `${baseUrl}/api/stations/${station.id}/cleanup/plan`,
        {
          method: "POST",
          headers: {
            "X-Test-User-Id": TEST_USER,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        }
      );

      expect(res.status).toBe(403);

      await new Promise((r) => setTimeout(r, 300));

      // Node must NOT have received any cleanup request
      const cleanupReqs = capturedMsgs.filter((raw) => {
        try {
          const m = JSON.parse(raw);
          return m?.type === "req" && (m?.verb === "cleanup.plan" || m?.verb === "cleanup.apply");
        } catch {
          return false;
        }
      });
      expect(cleanupReqs.length).toBe(0);

      fakeNode.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "POST /cleanup/plan without authentication → 401",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const res = await fetch(
        `${baseUrl}/api/stations/station_fake_id/cleanup/plan`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      expect(res.status).toBe(401);
    } finally {
      server.stop(true);
    }
  },
  10_000
);
