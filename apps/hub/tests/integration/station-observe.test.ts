/**
 * Integration Test: Station read-capability routes (health, files, logs SSE)
 *
 * Tests the four new routes added in Task 11:
 *   GET /api/stations/:id/health      → StationHealth JSON
 *   GET /api/stations/:id/files?path= → FsEntry[] JSON
 *   GET /api/stations/:id/file?path=  → decoded file content
 *   GET /api/stations/:id/logs        → SSE stream of log chunks
 *
 * Uses a minimal Hono test server with a fake node WS that answers all verbs.
 * The station must be adopted first (mirrors Task 10 lifecycle).
 *
 * DATABASE_URL must point to the local Docker test-postgres on localhost:5434.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";

// src/ imports — DB URL is already set
import { rawSql } from "../../src/db/drizzle";
import { createTestUser } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { waitForNodeOnline } from "../helpers/wait";
import {
  mintEnrollmentToken,
  enrollNode,
} from "../../src/services/enrollment";
import { gatewayRoutes } from "../../src/routes/gateway";
import { stationRoutes } from "../../src/routes/stations";
import { websocket } from "../../src/ws";
import type { AuthUser } from "../../src/auth/middleware";
import type { StationRow } from "../../src/services/station-registry";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER = "test-user-observe-a";
const STATION_KEY = "observe-station";

// ─── Fake responses ───────────────────────────────────────────────────────────

const fakeDetected = [
  {
    key: STATION_KEY,
    harness: "opencode",
    kind: "leaf" as const,
    displayName: "Observe Station",
    parentKey: null,
    workspacePath: "/workspace/observe",
    capabilities: ["health" as const, "logs" as const, "fs.read" as const],
    adopted: false,
  },
];

const fakeHealth = {
  running: true,
  pid: 1234,
  cpuPct: 5.5,
  memBytes: 104857600,
  diskBytes: null,
  uptimeSec: 300,
  lastActivity: "2024-01-01T00:00:00Z",
  note: null,
};

const fakeFiles = [
  {
    name: "file.txt",
    path: "file.txt",
    type: "file" as const,
    size: 5,
    modified: "2024-01-01T00:00:00Z",
  },
  {
    name: "subdir",
    path: "subdir",
    type: "dir" as const,
    size: null,
    modified: null,
  },
];

const fakeFileContent = {
  content: "hello",
  encoding: "utf8" as const,
  truncated: false,
};

// ─── Minimal test app ─────────────────────────────────────────────────────────

const testApp = new Hono()
  .use("/api/*", async (c, next) => {
    const userId = c.req.header("X-Test-User-Id") ?? "anonymous";
    c.set("user", { id: userId, authType: "api_key" , tenantId: "fleet_00000000000000000000"} satisfies AuthUser);
    return next();
  })
  .route("/public/nodes", gatewayRoutes)
  .route("/api", stationRoutes);

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  // Apply Drizzle Postgres migrations so the suite is self-contained on a fresh DB.
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "observe-a@test.example.com",
    name: "Observe Test User A",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM stations          WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM nodes             WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM "user"            WHERE id = ${TEST_USER}`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Helper: connect a fake node WS that answers all observe verbs ────────────

async function connectFakeNode(
  serverPort: number,
  nodeId: string,
  nodeSecret: string,
  overrides?: { fsRead?: unknown }
): Promise<WebSocket> {
  const ws = new WebSocket(
    `ws://localhost:${serverPort}/public/nodes/gateway`,
    {
      headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
    } as RequestInit & { headers: Record<string, string> }
  );

  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("WebSocket connection error"));
  });

  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));

    if (msg.type === "req") {
      switch (msg.verb) {
        case "detect":
          ws.send(
            JSON.stringify({ type: "res", id: msg.id, ok: true, data: fakeDetected })
          );
          break;

        case "health":
          ws.send(
            JSON.stringify({ type: "res", id: msg.id, ok: true, data: fakeHealth })
          );
          break;

        case "fs.list":
          ws.send(
            JSON.stringify({ type: "res", id: msg.id, ok: true, data: fakeFiles })
          );
          break;

        case "fs.read":
          ws.send(
            JSON.stringify({
              type: "res",
              id: msg.id,
              ok: true,
              data: overrides?.fsRead ?? fakeFileContent,
            })
          );
          break;

        case "logs.tail":
          // Emit 2 stream chunks then eof
          setTimeout(() => {
            ws.send(
              JSON.stringify({ type: "stream", id: msg.id, seq: 0, chunk: "log line 1\n", eof: false })
            );
            ws.send(
              JSON.stringify({ type: "stream", id: msg.id, seq: 1, chunk: "log line 2\n", eof: false })
            );
            ws.send(
              JSON.stringify({ type: "stream", id: msg.id, seq: 2, chunk: null, eof: true })
            );
          }, 50);
          break;
      }
    }
  };

  // onOpen → verifyNodeCredential (argon2id) → register outlasts any fixed
  // sleep under load; wait for the registration itself.
  await waitForNodeOnline(nodeId);
  return ws;
}

// ─── Helper: adopt a station and return the row ───────────────────────────────

async function adoptStation(
  baseUrl: string,
  nodeId: string,
  userId: string
): Promise<StationRow> {
  const res = await fetch(`${baseUrl}/api/nodes/${nodeId}/stations/adopt`, {
    method: "POST",
    headers: {
      "X-Test-User-Id": userId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ keys: [STATION_KEY] }),
  });
  expect(res.status).toBe(200);
  const rows = (await res.json()) as StationRow[];
  expect(rows).toHaveLength(1);
  return rows[0];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "GET /api/stations/:id/health returns StationHealth JSON",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "observe-health-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      const ws = await connectFakeNode(server.port, nodeId, nodeSecret);
      const station = await adoptStation(baseUrl, nodeId, TEST_USER);

      const res = await fetch(`${baseUrl}/api/stations/${station.id}/health`, {
        headers: { "X-Test-User-Id": TEST_USER },
      });
      expect(res.status).toBe(200);

      const health = await res.json();
      expect(health).toMatchObject({
        running: true,
        pid: 1234,
        cpuPct: 5.5,
        memBytes: 104857600,
        uptimeSec: 300,
      });

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  15_000
);

test(
  "GET /api/stations/:id/files returns FsEntry[] JSON",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "observe-files-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      const ws = await connectFakeNode(server.port, nodeId, nodeSecret);
      const station = await adoptStation(baseUrl, nodeId, TEST_USER);

      const res = await fetch(
        `${baseUrl}/api/stations/${station.id}/files?path=.`,
        { headers: { "X-Test-User-Id": TEST_USER } }
      );
      expect(res.status).toBe(200);

      const entries = await res.json();
      expect(Array.isArray(entries)).toBe(true);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ name: "file.txt", type: "file" });
      expect(entries[1]).toMatchObject({ name: "subdir", type: "dir" });

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  15_000
);

test(
  "GET /api/stations/:id/file returns file content with X-Truncated header",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "observe-file-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      const ws = await connectFakeNode(server.port, nodeId, nodeSecret);
      const station = await adoptStation(baseUrl, nodeId, TEST_USER);

      const res = await fetch(
        `${baseUrl}/api/stations/${station.id}/file?path=file.txt`,
        { headers: { "X-Test-User-Id": TEST_USER } }
      );
      expect(res.status).toBe(200);

      const content = await res.text();
      expect(content).toBe("hello");
      // Not truncated → header should be "false" or absent
      const truncated = res.headers.get("X-Truncated");
      expect(truncated === "false" || truncated === null).toBe(true);

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  15_000
);

test(
  "GET /api/stations/:id/logs SSE yields 2 chunks then closes",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "observe-logs-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      const ws = await connectFakeNode(server.port, nodeId, nodeSecret);
      const station = await adoptStation(baseUrl, nodeId, TEST_USER);

      const res = await fetch(`${baseUrl}/api/stations/${station.id}/logs`, {
        headers: { "X-Test-User-Id": TEST_USER },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/event-stream");

      // Read the SSE body stream and collect data: lines
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let rawText = "";

      // Read until stream closes (eof frame causes SSE stream to close)
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawText += decoder.decode(value, { stream: true });
        // Break early once we have both expected lines
        if (rawText.includes("log line 2")) break;
      }
      reader.cancel();

      const dataLines = rawText
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice("data:".length).trim());

      expect(dataLines).toContain("log line 1");
      expect(dataLines).toContain("log line 2");

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  15_000
);

test(
  "GET /api/stations/:id/file returns decoded bytes for base64-encoded content",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "observe-file-b64-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      // binary\x00data → base64
      const binaryData = "binary\x00data";
      const base64Content = btoa(binaryData);
      const ws = await connectFakeNode(server.port, nodeId, nodeSecret, {
        fsRead: { content: base64Content, encoding: "base64", truncated: false },
      });
      const station = await adoptStation(baseUrl, nodeId, TEST_USER);

      const res = await fetch(
        `${baseUrl}/api/stations/${station.id}/file?path=binary.bin`,
        { headers: { "X-Test-User-Id": TEST_USER } }
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/octet-stream");

      const buf = await res.arrayBuffer();
      const decoded = new TextDecoder("latin1").decode(buf);
      expect(decoded).toBe(binaryData);

      const truncated = res.headers.get("X-Truncated");
      expect(truncated).toBe("false");

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  15_000
);

test(
  "GET /api/stations/:id/logs returns 502 when node is offline",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      // Enroll + connect a node, adopt a station, then disconnect the node.
      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "observe-logs-offline-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      const ws = await connectFakeNode(server.port, nodeId, nodeSecret);
      const station = await adoptStation(baseUrl, nodeId, TEST_USER);

      // Disconnect node and let the connection manager unregister it.
      ws.close();
      await new Promise((r) => setTimeout(r, 200));

      const res = await fetch(`${baseUrl}/api/stations/${station.id}/logs`, {
        headers: { "X-Test-User-Id": TEST_USER },
      });
      expect(res.status).toBe(502);

      const body = await res.json() as { error: string };
      expect(body.error).toBe("node offline");
    } finally {
      server.stop(true);
    }
  },
  15_000
);

test(
  "station read routes return 404 for unknown station",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const unknownId = "station_00000000-0000-0000-0000-000000000000";

      const healthRes = await fetch(`${baseUrl}/api/stations/${unknownId}/health`, {
        headers: { "X-Test-User-Id": TEST_USER },
      });
      expect(healthRes.status).toBe(404);

      const filesRes = await fetch(`${baseUrl}/api/stations/${unknownId}/files?path=.`, {
        headers: { "X-Test-User-Id": TEST_USER },
      });
      expect(filesRes.status).toBe(404);

      const fileRes = await fetch(`${baseUrl}/api/stations/${unknownId}/file?path=x`, {
        headers: { "X-Test-User-Id": TEST_USER },
      });
      expect(fileRes.status).toBe(404);

      const logsRes = await fetch(`${baseUrl}/api/stations/${unknownId}/logs`, {
        headers: { "X-Test-User-Id": TEST_USER },
      });
      expect(logsRes.status).toBe(404);
    } finally {
      server.stop(true);
    }
  },
  10_000
);
