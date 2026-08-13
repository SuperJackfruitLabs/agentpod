/**
 * Integration Test: Station detect / adopt / list / unadopt
 *
 * Verifies the full lifecycle of station management:
 *   1. GET /api/nodes/:nodeId/detected  → lists all detected stations (adopted=false)
 *   2. POST /api/nodes/:nodeId/stations/adopt {keys}
 *      → adopts selected stations, resolves parentStationId
 *   3. GET /api/nodes/:nodeId/stations  → returns adopted rows (flat)
 *   4. DELETE /api/stations/:stationId  → unadopts a station
 *   5. Ownership enforcement: user B cannot access user A's node
 *
 * Uses a minimal Hono test server (avoids importing index.ts side-effects).
 * The "fake node" WebSocket replies to every detect req with 3 stations
 * (parent composite + child leaf + standalone leaf) to exercise parentStationId
 * resolution.
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
// Import type to activate ContextVariableMap augmentation for c.set("user", ...)
import type { AuthUser } from "../../src/auth/middleware";
import type { StationRow } from "../../src/services/station-registry";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER_A = "test-user-stations-a";
const TEST_USER_B = "test-user-stations-b";

// ─── Fake detected stations ───────────────────────────────────────────────────
// Three stations: one composite (root), one child of the root, one standalone leaf.

const PARENT_KEY = "parent-station";
const CHILD_KEY = "child-station";
const LEAF_KEY = "leaf-station";

const fakeDetected = [
  {
    key: PARENT_KEY,
    harness: "opencode",
    kind: "composite" as const,
    displayName: "Parent Station",
    parentKey: null,
    workspacePath: "/workspace/parent",
    capabilities: ["health" as const],
    adopted: false,
  },
  {
    key: CHILD_KEY,
    harness: "opencode",
    kind: "leaf" as const,
    displayName: "Child Station",
    parentKey: PARENT_KEY,
    workspacePath: "/workspace/child",
    capabilities: ["logs" as const, "fs.read" as const],
    adopted: false,
  },
  {
    key: LEAF_KEY,
    harness: "opencode",
    kind: "leaf" as const,
    displayName: "Leaf Station",
    parentKey: null,
    workspacePath: null,
    capabilities: [] as never[],
    adopted: false,
  },
];

// ─── Minimal test app ─────────────────────────────────────────────────────────
// Custom auth middleware reads X-Test-User-Id header instead of a real session.
// This lets us test multiple users without setting up Better Auth sessions.

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
    id: TEST_USER_A,
    email: "stations-a@test.example.com",
    name: "Stations Test User A",
  });
  await createTestUser({
    id: TEST_USER_B,
    email: "stations-b@test.example.com",
    name: "Stations Test User B",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM stations          WHERE user_id = ${TEST_USER_A}`;
    await rawSql`DELETE FROM stations          WHERE user_id = ${TEST_USER_B}`;
    await rawSql`DELETE FROM nodes             WHERE user_id = ${TEST_USER_A}`;
    await rawSql`DELETE FROM nodes             WHERE user_id = ${TEST_USER_B}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER_A}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER_B}`;
    await rawSql`DELETE FROM "user"            WHERE id = ${TEST_USER_A}`;
    await rawSql`DELETE FROM "user"            WHERE id = ${TEST_USER_B}`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Helper: connect a fake node WS that answers detect ──────────────────────

async function connectFakeNode(
  serverPort: number,
  nodeId: string,
  nodeSecret: string
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
    if (msg.type === "req" && msg.verb === "detect") {
      ws.send(
        JSON.stringify({
          type: "res",
          id: msg.id,
          ok: true,
          data: fakeDetected,
        })
      );
    }
  };

  // onOpen → verifyNodeCredential (argon2id) → register outlasts any fixed
  // sleep under load; wait for the registration itself.
  await waitForNodeOnline(nodeId);
  return ws;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "full lifecycle: detected → adopt → list → parentStationId → unadopt",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      // ── Enroll node A ──────────────────────────────────────────────────────
      const { token } = await mintEnrollmentToken(TEST_USER_A);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "station-lifecycle-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      const ws = await connectFakeNode(server.port, nodeId, nodeSecret);

      // ── 1. GET detected → 3 stations, all adopted=false ────────────────────
      const detRes = await fetch(`${baseUrl}/api/nodes/${nodeId}/detected`, {
        headers: { "X-Test-User-Id": TEST_USER_A },
      });
      expect(detRes.status).toBe(200);

      const detected = (await detRes.json()) as Array<
        (typeof fakeDetected)[0]
      >;
      expect(detected).toHaveLength(3);
      expect(detected.every((s) => !s.adopted)).toBe(true);
      expect(detected.map((s) => s.key).sort()).toEqual(
        [PARENT_KEY, CHILD_KEY, LEAF_KEY].sort()
      );

      // ── 2. POST adopt parent + child ───────────────────────────────────────
      const adoptRes = await fetch(
        `${baseUrl}/api/nodes/${nodeId}/stations/adopt`,
        {
          method: "POST",
          headers: {
            "X-Test-User-Id": TEST_USER_A,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ keys: [PARENT_KEY, CHILD_KEY] }),
        }
      );
      expect(adoptRes.status).toBe(200);

      const adoptedRows = (await adoptRes.json()) as StationRow[];
      expect(adoptedRows).toHaveLength(2);

      // ── 3. GET stations → flat list of 2 adopted rows ──────────────────────
      const listRes = await fetch(
        `${baseUrl}/api/nodes/${nodeId}/stations`,
        { headers: { "X-Test-User-Id": TEST_USER_A } }
      );
      expect(listRes.status).toBe(200);

      const stationList = (await listRes.json()) as StationRow[];
      expect(stationList).toHaveLength(2);

      // ── 4. parentStationId is resolved correctly ───────────────────────────
      const parent = stationList.find((s) => s.stationKey === PARENT_KEY);
      const child = stationList.find((s) => s.stationKey === CHILD_KEY);
      expect(parent).toBeDefined();
      expect(child).toBeDefined();
      expect(parent!.parentStationId).toBeNull(); // root has no parent
      expect(child!.parentStationId).toBe(parent!.id); // child points to parent

      // ── 5. detected now reflects adopted status ────────────────────────────
      const det2Res = await fetch(
        `${baseUrl}/api/nodes/${nodeId}/detected`,
        { headers: { "X-Test-User-Id": TEST_USER_A } }
      );
      const detected2 = (await det2Res.json()) as Array<
        (typeof fakeDetected)[0]
      >;
      expect(detected2.find((s) => s.key === PARENT_KEY)!.adopted).toBe(true);
      expect(detected2.find((s) => s.key === CHILD_KEY)!.adopted).toBe(true);
      expect(detected2.find((s) => s.key === LEAF_KEY)!.adopted).toBe(false);

      // ── 6. DELETE parent station ───────────────────────────────────────────
      const delRes = await fetch(
        `${baseUrl}/api/stations/${parent!.id}`,
        {
          method: "DELETE",
          headers: { "X-Test-User-Id": TEST_USER_A },
        }
      );
      expect(delRes.status).toBe(204);

      // ── 7. Verify station is gone from list ───────────────────────────────
      const listAfterDel = await fetch(
        `${baseUrl}/api/nodes/${nodeId}/stations`,
        { headers: { "X-Test-User-Id": TEST_USER_A } }
      );
      const stationsAfterDel = (await listAfterDel.json()) as StationRow[];
      expect(stationsAfterDel.find((s) => s.stationKey === PARENT_KEY)).toBeUndefined();

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "user B cannot access or adopt user A's node",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      // Enroll a node for user A
      const { token } = await mintEnrollmentToken(TEST_USER_A);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "station-ownership-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 1,
      });

      // Connect fake WS so the node appears online
      const ws = await connectFakeNode(server.port, nodeId, nodeSecret);

      // User B: GET detected → 404
      const detRes = await fetch(`${baseUrl}/api/nodes/${nodeId}/detected`, {
        headers: { "X-Test-User-Id": TEST_USER_B },
      });
      expect(detRes.status).toBe(404);

      // User B: POST adopt → 404
      const adoptRes = await fetch(
        `${baseUrl}/api/nodes/${nodeId}/stations/adopt`,
        {
          method: "POST",
          headers: {
            "X-Test-User-Id": TEST_USER_B,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ keys: [PARENT_KEY] }),
        }
      );
      expect(adoptRes.status).toBe(404);

      // User B: GET stations → 404
      const listRes = await fetch(
        `${baseUrl}/api/nodes/${nodeId}/stations`,
        { headers: { "X-Test-User-Id": TEST_USER_B } }
      );
      expect(listRes.status).toBe(404);

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  15_000
);

test(
  "DELETE /api/stations/:stationId is ownership-checked",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      // Enroll node A, adopt a station as user A
      const { token } = await mintEnrollmentToken(TEST_USER_A);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "station-delete-auth-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 1,
      });

      const ws = await connectFakeNode(server.port, nodeId, nodeSecret);

      // Adopt the leaf station as user A
      const adoptRes = await fetch(
        `${baseUrl}/api/nodes/${nodeId}/stations/adopt`,
        {
          method: "POST",
          headers: {
            "X-Test-User-Id": TEST_USER_A,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ keys: [LEAF_KEY] }),
        }
      );
      expect(adoptRes.status).toBe(200);
      const [leafRow] = (await adoptRes.json()) as StationRow[];
      expect(leafRow.stationKey).toBe(LEAF_KEY);

      // User B tries to delete user A's station → 404
      const delByB = await fetch(`${baseUrl}/api/stations/${leafRow.id}`, {
        method: "DELETE",
        headers: { "X-Test-User-Id": TEST_USER_B },
      });
      expect(delByB.status).toBe(404);

      // User A deletes their own station → 204
      const delByA = await fetch(`${baseUrl}/api/stations/${leafRow.id}`, {
        method: "DELETE",
        headers: { "X-Test-User-Id": TEST_USER_A },
      });
      expect(delByA.status).toBe(204);

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  15_000
);

test(
  "GET /api/nodes/:nodeId/detected returns 502 when node is offline",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      // Enroll a node but do NOT connect it
      const { token } = await mintEnrollmentToken(TEST_USER_A);
      const { nodeId } = await enrollNode(token, {
        hostname: "station-offline-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 1,
      });

      const res = await fetch(`${baseUrl}/api/nodes/${nodeId}/detected`, {
        headers: { "X-Test-User-Id": TEST_USER_A },
      });
      // broker resolves {ok:false, error:"node offline"} → route returns 502
      expect(res.status).toBe(502);
    } finally {
      server.stop(true);
    }
  },
  10_000
);
