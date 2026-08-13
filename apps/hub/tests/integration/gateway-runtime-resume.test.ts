/**
 * Integration Test: a resumed node completes its runtime's start (#281)
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `enrollment.ts` was the only writer of runtime status `online`, which is
 * correct for a substrate that re-enrols on every boot (Docker) and for one
 * whose stop is terminal so a start is really a re-provision (Modal). It is
 * wrong for a substrate that RESUMES an existing instance — Fly, and any
 * driver with a real `start()` whose agent keeps its credential on a volume.
 * Such an agent logs `already enrolled: node_…` and merely reconnects over the
 * gateway, so enrolment never runs and the runtime sat in `starting` until
 * `sweepStalledRuntimeStarts` wrote `error — no node enrolled within 2m`,
 * while the node itself was `online` and heartbeating.
 *
 * EVERY OTHER TEST IN THE SUITE DRIVES THE ENROLMENT PATH — the exact path a
 * resume does not take. That is why the bug shipped green. The tests here
 * connect a node that is ALREADY enrolled and never call `enrollNode` again,
 * which is what a resumed container actually does.
 *
 * The negative half matters just as much: a node reconnecting after an
 * ordinary network blip must NOT resurrect a `stopped`, `asleep`, `error` or
 * `destroyed` runtime. A stopped runtime silently reading `online` would
 * misreport a substrate that is still billing, or still down.
 */

// ─── Set env vars BEFORE any src/ imports (ESM evaluation order) ───────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";

import { rawSql } from "../../src/db/drizzle";
import { createTestUser } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { mintEnrollmentToken, enrollNode } from "../../src/services/enrollment";
import { gatewayRoutes } from "../../src/routes/gateway";
import { websocket } from "../../src/ws";
import { pollUntil } from "../helpers/wait";

const testApp = new Hono().route("/public/nodes", gatewayRoutes);

const TEST_USER_ID = "test-user-gateway-resume-001";

const WS_URL = (port: number) => `ws://localhost:${port}/public/nodes/gateway`;

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER_ID,
    email: "gateway-resume-test@example.com",
    name: "Gateway Resume Test User",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM provisioned_runtimes WHERE user_id = ${TEST_USER_ID}`;
    await rawSql`DELETE FROM nodes              WHERE user_id = ${TEST_USER_ID}`;
    await rawSql`DELETE FROM enrollment_tokens  WHERE user_id = ${TEST_USER_ID}`;
    await rawSql`DELETE FROM "user"             WHERE id      = ${TEST_USER_ID}`;
  } catch {
    // Ignore cleanup errors
  }
});

/**
 * Enrol a node ONCE, then hand back credentials the test reuses to dial the
 * gateway directly — the "already enrolled, just reconnecting" shape.
 */
async function enrolledNodeWithRuntime(
  hostname: string,
  status: string,
  statusReason: string | null = null
) {
  const { token } = await mintEnrollmentToken(TEST_USER_ID);
  const creds = await enrollNode(token, {
    hostname,
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });
  const runtimeId = `rt-${creds.nodeId}`;
  await rawSql`
    INSERT INTO provisioned_runtimes
      (id, user_id, provider, external_id, status, status_reason, node_id, name, harness)
    VALUES (${runtimeId}, ${TEST_USER_ID}, 'fly', ${`fly-${creds.nodeId}`},
            ${status}::runtime_status, ${statusReason}, ${creds.nodeId}, ${hostname}, 'opencode')
  `;
  return { ...creds, runtimeId };
}

async function runtimeRow(runtimeId: string) {
  const rows = (await rawSql`
    SELECT status, status_reason FROM provisioned_runtimes WHERE id = ${runtimeId}
  `) as Array<{ status: string; status_reason: string | null }>;
  return rows[0]!;
}

function connect(port: number, nodeId: string, nodeSecret: string): WebSocket {
  return new WebSocket(WS_URL(port), {
    headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
  } as RequestInit & { headers: Record<string, string> });
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("WebSocket connection error"));
  });
}

/**
 * Barrier for "this socket's onOpen finished".
 *
 * onMessage awaits `authReady`, which the gateway resolves at the END of
 * onOpen — after registration, after the node's online write, and after the
 * runtime-start completion this file is about. So an ack proves the gateway
 * has already had its chance to touch the runtime row. That is what lets the
 * negative tests assert "it did NOT change" without sleeping for a barrier.
 */
async function awaitOnOpenFinished(ws: WebSocket): Promise<void> {
  const ack = new Promise<void>((res) => {
    ws.onmessage = (e) => {
      if ((JSON.parse(String(e.data)) as { type: string }).type === "ack") res();
    };
  });
  ws.send(JSON.stringify({ type: "heartbeat", ts: Date.now() }));
  await ack;
  ws.onmessage = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The test that would have caught #281
// ─────────────────────────────────────────────────────────────────────────────

test("an ALREADY-ENROLLED node reconnecting while its runtime is `starting` ends `online`", async () => {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  try {
    // The stale reason is the one the sweeper writes; a node that just came
    // back must retire it, exactly as the enrolment path does.
    const { nodeId, nodeSecret, runtimeId } = await enrolledNodeWithRuntime(
      "resume-host",
      "starting",
      "no node enrolled within 2m of the start request"
    );

    // NOTE: no second enrollNode call. A resumed container finds its persisted
    // credential ("already enrolled: node_…") and dials the gateway straight
    // away — enrolment, the historical sole writer of `online`, never runs.
    const ws = connect(server.port, nodeId, nodeSecret);
    await opened(ws);

    const row = await pollUntil(async () => {
      const r = await runtimeRow(runtimeId);
      return r.status === "online" ? r : null;
    });
    expect(row.status).toBe("online");
    expect(row.status_reason).toBeNull();

    ws.close();
  } finally {
    server.stop(true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The dangerous edge: reconnection must resurrect nothing
// ─────────────────────────────────────────────────────────────────────────────

for (const status of ["stopped", "asleep", "error", "destroyed"] as const) {
  test(`a node reconnecting whose runtime is \`${status}\` leaves it \`${status}\``, async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    try {
      const { nodeId, nodeSecret, runtimeId } = await enrolledNodeWithRuntime(
        `blip-host-${status}`,
        status,
        "set by the test"
      );

      const ws = connect(server.port, nodeId, nodeSecret);
      await opened(ws);
      // Deterministic barrier — onOpen has fully run by the time the ack lands.
      await awaitOnOpenFinished(ws);

      const row = await runtimeRow(runtimeId);
      expect(row.status).toBe(status);
      expect(row.status_reason).toBe("set by the test");

      ws.close();
    } finally {
      server.stop(true);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// A start issued while the node's socket is already open
//
// `startRuntime` writes `starting` after the driver call returns, so a runtime
// can enter `starting` with its node already connected — no onOpen will ever
// fire for it. The heartbeat is the same evidence as a connect (the node is
// there, right now), so it completes the start within one beat instead of
// leaving the sweeper to call it an error two minutes later.
// ─────────────────────────────────────────────────────────────────────────────

test("a runtime that enters `starting` while its node is already connected is completed by a heartbeat", async () => {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  try {
    const { nodeId, nodeSecret, runtimeId } = await enrolledNodeWithRuntime(
      "already-connected-host",
      "online"
    );

    const ws = connect(server.port, nodeId, nodeSecret);
    await opened(ws);
    await awaitOnOpenFinished(ws);

    // The operator hits Start; the driver accepts and the row goes `starting`.
    await rawSql`
      UPDATE provisioned_runtimes SET status = 'starting' WHERE id = ${runtimeId}
    `;

    await awaitOnOpenFinished(ws); // one more heartbeat + ack
    const row = await pollUntil(async () => {
      const r = await runtimeRow(runtimeId);
      return r.status === "online" ? r : null;
    });
    expect(row.status).toBe("online");

    ws.close();
  } finally {
    server.stop(true);
  }
});
