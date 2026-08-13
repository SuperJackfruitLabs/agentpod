/**
 * Integration Test: Node Gateway WebSocket
 *
 * Tests that a node-agent can connect to the gateway, is marked online,
 * and is marked offline when it disconnects.
 *
 * Uses the local Docker test-postgres (agentpod-test-postgres on localhost:5434).
 * DATABASE_URL MUST be set before any src/ modules are imported — the import
 * of this setup module is hoisted first so drizzle picks up the right URL.
 */

// ─── Set env vars BEFORE any src/ imports (ESM evaluation order) ───────────
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
import {
  mintEnrollmentToken,
  enrollNode,
} from "../../src/services/enrollment";
import { listNodes } from "../../src/services/node-registry";
import { gatewayRoutes } from "../../src/routes/gateway";
import { websocket } from "../../src/ws";
import { connectionManager } from "../../src/services/connection-manager";
import {
  pollUntil,
  waitForNodeOnline,
  waitForNodeUnregistered,
} from "../helpers/wait";

/**
 * Barrier for "this socket's onOpen finished registering it".
 *
 * The gateway resolves `authReady` only after `connectionManager.register`,
 * and onMessage awaits `authReady` — so an ack proves the registration
 * already happened. Needed where `waitForNodeOnline` cannot tell the sockets
 * apart because an earlier socket already has the node marked online.
 */
async function awaitSocketRegistered(ws: WebSocket): Promise<void> {
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
// Minimal test server (avoids importing full index.ts which has many side effects)
// ─────────────────────────────────────────────────────────────────────────────

const testApp = new Hono().route("/public/nodes", gatewayRoutes);

const TEST_USER_ID = "test-user-gateway-001";

// ─────────────────────────────────────────────────────────────────────────────
// Setup & Teardown
// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER_ID,
    email: "gateway-test@example.com",
    name: "Gateway Test User",
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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test("a node that connects to the gateway shows online via listNodes", async () => {
  // Start the minimal test app on a random port to avoid conflicts
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });

  try {
    // Enroll a node so we have valid credentials
    const { token } = await mintEnrollmentToken(TEST_USER_ID);
    const { nodeId, nodeSecret } = await enrollNode(token, {
      hostname: "ws-host",
      os: "linux",
      arch: "amd64",
      cpuCount: 2,
    });

    // Connect the node to the gateway
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

    // Wait for onOpen's setNodeStatus rather than guessing how long the
    // argon2id credential verify plus two DB round trips will take.
    const node = await pollUntil(async () =>
      (await listNodes(TEST_USER_ID)).find((n) => n.id === nodeId && n.status === "online")
    );
    expect(node?.status).toBe("online");

    // Close the connection — node should go offline
    ws.close();
    const nodeAfterClose = await pollUntil(async () =>
      (await listNodes(TEST_USER_ID)).find((n) => n.id === nodeId && n.status === "offline")
    );
    expect(nodeAfterClose?.status).toBe("offline");
  } finally {
    server.stop(true);
  }
});

test("a node with invalid credentials is rejected", async () => {
  // Enroll a real node so auth machinery is exercised, then connect with a
  // deliberately WRONG secret — this proves the rejection is credential-based,
  // not a missing-node-id shortcut.
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });

  try {
    const { token } = await mintEnrollmentToken(TEST_USER_ID);
    const { nodeId } = await enrollNode(token, {
      hostname: "bad-creds-host",
      os: "linux",
      arch: "amd64",
      cpuCount: 1,
    });

    const ws = new WebSocket(
      `ws://localhost:${server.port}/public/nodes/gateway`,
      {
        // Valid nodeId, deliberately wrong secret
        headers: { Authorization: `Bearer ${nodeId}:totally-wrong-secret` },
      } as RequestInit & { headers: Record<string, string> }
    );

    let closeCode: number | null = null;
    await new Promise<void>((res, rej) => {
      ws.onclose = (e) => {
        closeCode = e.code;
        res();
      };
      ws.onopen = () => {
        ws.close();
        rej(new Error("connection should have been rejected but was accepted"));
      };
    });

    // Server calls ws.close(1008, "unauthorized"); Bun's WS client normalises
    // the server-sent 1008 to 1000 on the receiving end (a Bun quirk), so we
    // accept either.  The unconditional assertion still proves the connection
    // was terminated — the hardened onopen handler above is what proves no
    // successful open ever happened.
    expect([1000, 1008]).toContain(closeCode);
  } finally {
    server.stop(true);
  }
});

test("heartbeat keeps node online and receives ack", async () => {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });

  try {
    const { token } = await mintEnrollmentToken(TEST_USER_ID);
    const { nodeId, nodeSecret } = await enrollNode(token, {
      hostname: "hb-host",
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

    await waitForNodeOnline(nodeId);

    // Send a heartbeat and await the ack
    const ackPromise = new Promise<unknown>((res) => {
      ws.onmessage = (e) => res(JSON.parse(String(e.data)));
    });
    ws.send(JSON.stringify({ type: "heartbeat", ts: Date.now() }));
    const ack = await ackPromise;
    expect((ack as { type: string }).type).toBe("ack");

    ws.close();
  } finally {
    server.stop(true);
  }
});

test("a late close from a replaced socket does not mark the reconnected node offline", async () => {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  try {
    const { token } = await mintEnrollmentToken(TEST_USER_ID);
    const { nodeId, nodeSecret } = await enrollNode(token, {
      hostname: "race-host", os: "linux", arch: "amd64", cpuCount: 1,
    });
    const headers = { Authorization: `Bearer ${nodeId}:${nodeSecret}` };
    const url = `ws://localhost:${server.port}/public/nodes/gateway`;

    const wsOld = new WebSocket(url, { headers } as RequestInit & { headers: Record<string, string> });
    await new Promise<void>((res, rej) => { wsOld.onopen = () => res(); wsOld.onerror = () => rej(new Error("old socket failed")); });
    await waitForNodeOnline(nodeId);

    // Node reconnects on a new socket while the old one is still open.
    const wsNew = new WebSocket(url, { headers } as RequestInit & { headers: Record<string, string> });
    await new Promise<void>((res, rej) => { wsNew.onopen = () => res(); wsNew.onerror = () => rej(new Error("new socket failed")); });
    // The node is already online from wsOld, so isOnline cannot tell the two
    // sockets apart — use the ack barrier to know wsNew's onOpen registered.
    await awaitSocketRegistered(wsNew);

    // The OLD socket closes late.
    const closed = new Promise<void>((res) => { wsOld.onclose = () => res(); });
    wsOld.close();
    await closed;
    // onClose's teardown is async after the close event; give the epoch guard
    // a chance to run the (wrong) teardown if it is going to.
    await new Promise((r) => setTimeout(r, 200));

    // Node must still be online, and the NEW socket must still be routable.
    const list = await listNodes(TEST_USER_ID);
    expect(list.find((n) => n.id === nodeId)?.status).toBe("online");
    const ackPromise = new Promise<unknown>((res) => { wsNew.onmessage = (e) => res(JSON.parse(String(e.data))); });
    wsNew.send(JSON.stringify({ type: "heartbeat", ts: Date.now() }));
    expect(((await ackPromise) as { type: string }).type).toBe("ack");

    wsNew.close();
  } finally {
    server.stop(true);
  }
});

test("a heartbeat from a socket with no registry entry re-registers it", async () => {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  try {
    const { token } = await mintEnrollmentToken(TEST_USER_ID);
    const { nodeId, nodeSecret } = await enrollNode(token, {
      hostname: "rereg-host", os: "linux", arch: "amd64", cpuCount: 1,
    });
    const ws = new WebSocket(`ws://localhost:${server.port}/public/nodes/gateway`, {
      headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
    } as RequestInit & { headers: Record<string, string> });
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("connect failed")); });
    await waitForNodeOnline(nodeId);

    // Simulate a sweep: the registry entry is gone but the socket is alive.
    connectionManager.unregister(nodeId);
    expect(connectionManager.isOnline(nodeId)).toBe(false);

    const ackPromise = new Promise<unknown>((res) => { ws.onmessage = (e) => res(JSON.parse(String(e.data))); });
    ws.send(JSON.stringify({ type: "heartbeat", ts: Date.now() }));
    expect(((await ackPromise) as { type: string }).type).toBe("ack");
    // Server→node routing is restored, not just DB status.
    expect(connectionManager.isOnline(nodeId)).toBe(true);

    ws.close();
  } finally {
    server.stop(true);
  }
});

test("hello frame version is persisted to agentVersion on the node row", async () => {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });

  try {
    const { token } = await mintEnrollmentToken(TEST_USER_ID);
    const { nodeId, nodeSecret } = await enrollNode(token, {
      hostname: "version-host",
      os: "linux",
      arch: "amd64",
      cpuCount: 2,
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

    // Send hello IMMEDIATELY on open (as the real agent does) — it races with
    // the server's async verifyNodeCredential. The hub must still ingest the
    // one-shot hello (it carries the version); regression test for the
    // dropped-hello race that left agent_version null in production.
    ws.send(JSON.stringify({ type: "hello", hostInfo: { hostname: "version-host", os: "linux", arch: "amd64", cpuCount: 2 }, version: "v0.1.1" }));

    // Verify agentVersion was persisted — poll rather than guess how long the
    // auth-then-hello path takes; a hello that is never ingested still fails.
    const node = await pollUntil(async () =>
      (await listNodes(TEST_USER_ID)).find(
        (n) => n.id === nodeId && n.agentVersion === "v0.1.1"
      )
    );
    expect(node?.agentVersion).toBe("v0.1.1");

    ws.close();
  } finally {
    server.stop(true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Deferred work scheduled by onOpen must not outlive the connection (#267)
//
// onOpen schedules auto-adopt attempts (first at 1.5 s) and a capability
// refresh (2 s) on timers. Both reach the node the same way — through
// `broker.request(nodeId, "detect")` — so a `detect` req handed to whatever
// send fn the connection manager holds for the node is the observable that
// the deferred work ran.
//
// The two tests are a pair and must stay one. The first proves those timers
// really do fire and really do reach the node under this harness; without it
// the second test's "no detect ever arrived" would pass just as well against
// a gateway that never scheduled anything at all.
// ─────────────────────────────────────────────────────────────────────────────

/** Watch window: comfortably past both the 1.5 s and 2 s deadlines. */
const DEFERRED_WINDOW_MS = 3_000;

/**
 * Enroll a node that auto-adopt will actually do work for. It returns early
 * unless the node has a provisioned runtime with a real harness, so without
 * this row the deferred work would never reach the broker and neither test
 * below would observe anything.
 */
async function enrollProvisionedNode(hostname: string) {
  const { token } = await mintEnrollmentToken(TEST_USER_ID);
  const creds = await enrollNode(token, {
    hostname, os: "linux", arch: "amd64", cpuCount: 1,
  });
  await rawSql`
    INSERT INTO provisioned_runtimes (tenant_id, id, user_id, provider, status, node_id, name, harness)
    VALUES ('fleet_00000000000000000000', ${`rt-${creds.nodeId}`}, ${TEST_USER_ID}, 'docker', 'online',
            ${creds.nodeId}, ${hostname}, 'opencode')
  `;
  return creds;
}

test("onOpen's deferred work reaches a node whose socket stays open", async () => {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  try {
    const { nodeId, nodeSecret } = await enrollProvisionedNode("deferred-live-host");
    const ws = new WebSocket(`ws://localhost:${server.port}/public/nodes/gateway`, {
      headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
    } as RequestInit & { headers: Record<string, string> });
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("WebSocket connection error"));
    });

    const detects: string[] = [];
    const gotDetect = new Promise<void>((res) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type !== "req" || msg.verb !== "detect") return;
        detects.push(msg.id);
        // Answer with a failure: nothing is adopted, and the broker request
        // does not sit pending for its full 10 s timeout after the test ends.
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: false, error: "test" }));
        res();
      };
    });

    await waitForNodeOnline(nodeId);
    await Promise.race([
      gotDetect,
      new Promise((r) => setTimeout(r, DEFERRED_WINDOW_MS)),
    ]);
    expect(detects.length).toBeGreaterThan(0);

    ws.close();
  } finally {
    server.stop(true);
  }
}, 15_000);

test("a socket that closes before its deferred work fires cancels it", async () => {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  try {
    const { nodeId, nodeSecret } = await enrollProvisionedNode("deferred-closed-host");
    const ws = new WebSocket(`ws://localhost:${server.port}/public/nodes/gateway`, {
      headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
    } as RequestInit & { headers: Record<string, string> });
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("WebSocket connection error"));
    });
    await waitForNodeOnline(nodeId);

    // Close well inside the 1.5 s deadline for the first auto-adopt attempt.
    ws.close();
    // unregister happens after the cancellation in onClose, so this is the
    // barrier for "onClose has run" — no sleeping to guess at it.
    await waitForNodeUnregistered(nodeId);

    // Stand in for the node having reconnected on a fresh socket, which is
    // what makes the leak observable: give the connection manager a send fn
    // that records what the hub pushes at the node. The closed socket's
    // timers are now the only thing that could put anything here.
    const pushed: Array<{ type: string; verb?: string }> = [];
    connectionManager.register(nodeId, (m) => {
      pushed.push(m as { type: string; verb?: string });
    });

    try {
      // Sleeping is legitimate here and only here: proving something does NOT
      // happen needs a deadline, and this one is double the 1.5 s it waits out.
      await new Promise((r) => setTimeout(r, DEFERRED_WINDOW_MS));
      const verbs = pushed
        .filter((m) => m.type === "req")
        .map((m) => m.verb);
      expect(verbs).toEqual([]);
    } finally {
      connectionManager.unregister(nodeId);
    }
  } finally {
    server.stop(true);
  }
}, 15_000);
