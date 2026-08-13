/**
 * Integration Test: hub fs write routes (capability-gated, audited) — P2 Task 8
 *
 * Verifies:
 *   1. POST /fs/write on a station WITH fs.write capability → 200, node received
 *      fs.write request, audit row exists with result "ok".
 *   2. POST /fs/write on a station WITHOUT fs.write capability → 403, node
 *      received NO request (capability gate fires before broker.request).
 *   3. POST /fs/write without authentication → 401.
 *   4. POST /fs/write when node is offline → 409.
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
import { and, eq } from "drizzle-orm";

// src/ imports — DB URL is already set above
import { db, rawSql } from "../db/drizzle";
import { stationAudit } from "../db/schema/audit";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { waitForNodeOnline } from "../../tests/helpers/wait";
import { mintEnrollmentToken, enrollNode } from "../services/enrollment";
import { gatewayRoutes } from "./gateway";
import { stationWriteRoutes } from "./station-writes";
import { stationRoutes } from "./stations";
import { websocket } from "../ws";
import type { AuthUser } from "../auth/middleware";
import type { StationRow } from "../services/station-registry";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER = "test-user-writes-001";

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
  .route("/api", stationWriteRoutes)
  .route("/api", stationRoutes);

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "writes-test@example.com",
    name: "Station Writes Test User",
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

/**
 * Connect a fake node to the gateway WS and wire handlers.
 *
 * @param serverPort       Port of the Bun test server.
 * @param nodeId           Enrolled node ID.
 * @param nodeSecret       Node secret from enrollment.
 * @param stationKey       Station key to report in detect response.
 * @param capabilities     Capability strings to advertise in detect response.
 * @param capturedMsgs     Optional array to record every raw message the node receives.
 */
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
                harness: "opencode",
                kind: "leaf",
                displayName: `Test Station (${stationKey})`,
                parentKey: null,
                workspacePath: `/workspace/${stationKey}`,
                capabilities,
              },
            ],
          })
        );
        break;

      case "fs.write":
        ws.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            data: { bytesWritten: 42, backupPath: null },
          })
        );
        break;

      case "fs.mkdir":
        ws.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            data: { ok: true },
          })
        );
        break;

      case "fs.move":
        ws.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            data: { ok: true },
          })
        );
        break;

      case "fs.delete":
        ws.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            data: { ok: true },
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

/** Adopt a station via the HTTP route and return the station row. */
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

/** Poll until condition() returns truthy or timeout expires. */
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
  "POST /fs/write on a capable station → 200, node received fs.write, audit row result=ok",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const STATION_KEY = "write-capable-001";
      const capturedMsgs: string[] = [];

      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "write-capable-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      const fakeNode = await connectFakeNode(
        server.port!,
        nodeId,
        nodeSecret,
        STATION_KEY,
        ["health", "fs.read", "fs.write"],
        capturedMsgs
      );

      const station = await adoptStation(baseUrl, nodeId, STATION_KEY);

      // POST fs/write
      const res = await fetch(
        `${baseUrl}/api/stations/${station.id}/fs/write`,
        {
          method: "POST",
          headers: {
            "X-Test-User-Id": TEST_USER,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path: "hello.txt",
            content: "Hello, world!",
            encoding: "utf8",
            backup: false,
          }),
        }
      );

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.bytesWritten).toBe(42);

      // Node must have received an fs.write request
      await pollUntil(() =>
        capturedMsgs.some((raw) => {
          try {
            const m = JSON.parse(raw);
            return m?.type === "req" && m?.verb === "fs.write";
          } catch {
            return false;
          }
        })
      );

      const writeReqs = capturedMsgs
        .map((raw) => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })
        .filter((m) => m?.type === "req" && m?.verb === "fs.write");

      expect(writeReqs.length).toBeGreaterThan(0);
      const req = writeReqs[0];
      expect(req.params.key).toBe(STATION_KEY);
      expect(req.params.path).toBe("hello.txt");
      expect(req.params.content).toBe("Hello, world!");

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
            eq(stationAudit.verb, "fs.write")
          )
        );

      expect(auditRows.length).toBeGreaterThan(0);
      // The row should be finalized as "ok"
      const okRows = auditRows.filter((r) => r.result === "ok");
      expect(okRows.length).toBeGreaterThan(0);

      // The params_summary must NOT contain "content"
      for (const row of auditRows) {
        expect(row.paramsSummary).not.toHaveProperty("content");
        expect(row.paramsSummary).toHaveProperty("path");
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
  "POST /fs/write on a station WITHOUT fs.write capability → 403, node receives NO request",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const STATION_KEY = "write-incapable-001";
      const capturedMsgs: string[] = [];

      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "write-incapable-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      // Capabilities do NOT include "fs.write"
      const fakeNode = await connectFakeNode(
        server.port!,
        nodeId,
        nodeSecret,
        STATION_KEY,
        ["health", "fs.read"],
        capturedMsgs
      );

      const station = await adoptStation(baseUrl, nodeId, STATION_KEY);

      const res = await fetch(
        `${baseUrl}/api/stations/${station.id}/fs/write`,
        {
          method: "POST",
          headers: {
            "X-Test-User-Id": TEST_USER,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path: "hello.txt",
            content: "Hello!",
            encoding: "utf8",
          }),
        }
      );

      expect(res.status).toBe(403);

      // Brief wait so any stray async work completes
      await new Promise((r) => setTimeout(r, 300));

      // The node must NOT have received any fs.write request
      const fsWriteReqs = capturedMsgs.filter((raw) => {
        try {
          const m = JSON.parse(raw);
          return m?.type === "req" && m?.verb === "fs.write";
        } catch {
          return false;
        }
      });
      expect(fsWriteReqs.length).toBe(0);

      fakeNode.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "POST /fs/write without authentication → 401",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      // Use a made-up station id — the auth check fires before any DB lookup
      const res = await fetch(
        `${baseUrl}/api/stations/station_fake_id/fs/write`,
        {
          method: "POST",
          headers: {
            // No X-Test-User-Id header → anonymous
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path: "hello.txt",
            content: "Hello!",
            encoding: "utf8",
          }),
        }
      );

      expect(res.status).toBe(401);
    } finally {
      server.stop(true);
    }
  },
  10_000
);

test(
  "POST /fs/write when node is offline → 409",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const STATION_KEY = "write-offline-001";

      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "write-offline-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      // Connect, adopt, then disconnect so the node goes offline
      const fakeNode = await connectFakeNode(
        server.port!,
        nodeId,
        nodeSecret,
        STATION_KEY,
        ["health", "fs.read", "fs.write"]
      );

      const station = await adoptStation(baseUrl, nodeId, STATION_KEY);

      // Disconnect the fake node
      fakeNode.close();
      await new Promise((r) => setTimeout(r, 200));

      // Now the node is offline — expect 409
      const res = await fetch(
        `${baseUrl}/api/stations/${station.id}/fs/write`,
        {
          method: "POST",
          headers: {
            "X-Test-User-Id": TEST_USER,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path: "hello.txt",
            content: "Hello!",
            encoding: "utf8",
          }),
        }
      );

      expect(res.status).toBe(409);
    } finally {
      server.stop(true);
    }
  },
  20_000
);
