/**
 * Integration Test: broker ↔ gateway round-trip
 *
 * Verifies that broker.request() round-trips through the real gateway WebSocket:
 *   1. broker sends {type:"req"} to the registered node via connectionManager.
 *   2. A fake node WS receives the req, replies with {type:"res"}.
 *   3. gateway.ts onMessage calls handleNodeMessage() → broker resolves the promise.
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

// src/ imports — DB URL is already set above
import { rawSql } from "../../src/db/drizzle";
import { createTestUser } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { waitForNodeOnline } from "../helpers/wait";
import {
  mintEnrollmentToken,
  enrollNode,
} from "../../src/services/enrollment";
import { gatewayRoutes } from "../../src/routes/gateway";
import { websocket } from "../../src/ws";
import * as broker from "../../src/services/broker";

// ─── Minimal test server ──────────────────────────────────────────────────────

const testApp = new Hono().route("/public/nodes", gatewayRoutes);

const TEST_USER_ID = "test-user-broker-gw-001";

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER_ID,
    email: "broker-gw-test@example.com",
    name: "Broker Gateway Integration Test User",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM nodes             WHERE user_id = ${TEST_USER_ID}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER_ID}`;
    await rawSql`DELETE FROM "user"            WHERE id      = ${TEST_USER_ID}`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "broker.request round-trips a detect verb through the gateway WebSocket",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });

    try {
      // Enroll a real node
      const { token } = await mintEnrollmentToken(TEST_USER_ID);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "broker-int-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      // Connect a fake node WS that acts as the node-agent
      const ws = new WebSocket(
        `ws://localhost:${server.port}/public/nodes/gateway`,
        {
          headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
        } as RequestInit & { headers: Record<string, string> }
      );

      await new Promise<void>((res, rej) => {
        ws.onopen = () => res();
        ws.onerror = () => rej(new Error("WebSocket connection error"));
      });

      // Fake node-agent: reply to detect req with a synthetic DetectedStation
      const fakeStation = {
        key: "test-station-key",
        harness: "opencode",
        kind: "leaf" as const,
        displayName: "Test Station",
        parentKey: null,
        workspacePath: "/workspace/test",
        capabilities: ["health" as const],
        adopted: false,
      };

      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === "req" && msg.verb === "detect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: msg.id,
              ok: true,
              data: [fakeStation],
            })
          );
        }
      };

      // onOpen → verifyNodeCredential (argon2id) → register outlasts any fixed
      // sleep under load; wait for the registration itself.
      await waitForNodeOnline(nodeId);

      // Call broker.request — should resolve with the station data
      const result = await broker.request(nodeId, "detect", {}, {
        timeoutMs: 3_000,
      });

      expect(result.ok).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      const stations = result.data as typeof fakeStation[];
      expect(stations).toHaveLength(1);
      expect(stations[0]).toEqual(fakeStation);

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  10_000 // generous timeout for DB + WS handshake
);

test(
  "broker.stream delivers chunks through the gateway to onChunk",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });

    try {
      const { token } = await mintEnrollmentToken(TEST_USER_ID);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "broker-stream-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 1,
      });

      const ws = new WebSocket(
        `ws://localhost:${server.port}/public/nodes/gateway`,
        {
          headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
        } as RequestInit & { headers: Record<string, string> }
      );

      await new Promise<void>((res, rej) => {
        ws.onopen = () => res();
        ws.onerror = () => rej(new Error("WebSocket connection error"));
      });

      // Fake node: reply with two stream chunks then eof
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === "req" && msg.verb === "logs.tail") {
          ws.send(
            JSON.stringify({ type: "stream", id: msg.id, seq: 0, chunk: "log line 1", eof: false })
          );
          ws.send(
            JSON.stringify({ type: "stream", id: msg.id, seq: 1, chunk: "log line 2", eof: false })
          );
          ws.send(
            JSON.stringify({ type: "stream", id: msg.id, seq: 2, chunk: null, eof: true })
          );
        }
      };

      await new Promise((r) => setTimeout(r, 150));

      const received: Array<{ seq: number; chunk: string | null; eof: boolean }> = [];
      const streamDone = new Promise<void>((res) => {
        broker.stream(
          nodeId,
          "logs.tail",
          { key: "test-station-key", follow: false },
          (seq, chunk, eof) => {
            received.push({ seq, chunk, eof });
            if (eof) res();
          }
        );
      });

      await streamDone;

      expect(received).toHaveLength(3);
      expect(received[0]).toEqual({ seq: 0, chunk: "log line 1", eof: false });
      expect(received[1]).toEqual({ seq: 1, chunk: "log line 2", eof: false });
      expect(received[2]).toEqual({ seq: 2, chunk: null, eof: true });

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  10_000
);
