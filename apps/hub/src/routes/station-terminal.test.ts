/**
 * Integration Test: console↔hub terminal WebSocket bridge (P2 Task 4)
 *
 * Verifies GET /api/stations/:id/terminal (WebSocket):
 *   1. Authenticated connect → hub sends term.open then term.attach to the node.
 *   2. Node stream{enc:"base64"} chunk → client receives {t:"data", data:chunk}.
 *   3. Client {t:"input"} → forwarded to node as an input frame with attach id.
 *   4. Unauthenticated upgrade → WS closed (code 1008), no term.open sent.
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
import { rawSql } from "../db/drizzle";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { waitForNodeOnline } from "../../tests/helpers/wait";
import { mintEnrollmentToken, enrollNode } from "../services/enrollment";
import { setGrant } from "../services/grants";
import { createPrincipal } from "../services/principals";
import { gatewayRoutes } from "./gateway";
import { stationTerminalRoutes } from "./station-terminal";
import { stationRoutes } from "./stations";
import { websocket } from "../ws";
import type { AuthUser } from "../auth/middleware";
import type { StationRow } from "../services/station-registry";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER = "test-user-sterm-001";
const STATION_KEY = "sterm-station";
const FAKE_SESSION_ID = "pty-session-abc123";

/**
 * The two principals the control-pair tests need.
 *
 * A grant is keyed by the CALLER's principal and its values are the principal
 * ids of the agents that caller may dispatch — `principal_grants.principal_id`
 * is a foreign key onto `principals.id`, so a grant keyed by a Better Auth id
 * is not a wide grant, it is a failed INSERT. And the scope half compares the
 * grant against the station's OCCUPANT, so a station with nobody in it is
 * dispatchable by nobody: `AGENT_PRINCIPAL` is put on the station after adoption,
 * which is the fixture standing in for an assignment nothing yet does.
 */
const USER_HANDLE = "sterm-it-user";
const AGENT_HANDLE = "sterm-it-agent";
let USER_PRINCIPAL: string;
let AGENT_PRINCIPAL: string;

// ─── Minimal test app ─────────────────────────────────────────────────────────

// Mirrors station-observe.test.ts: fake auth middleware + real gateway + routes.
const testApp = new Hono()
  .use("/api/*", async (c, next) => {
    const userId = c.req.header("X-Test-User-Id");
    if (userId && userId !== "anonymous") {
      c.set("user", { id: userId, authType: "api_key" , tenantId: "fleet_00000000000000000000"} satisfies AuthUser);
    } else {
      // No header → anonymous; the terminal route rejects this with 1008.
      c.set("user", { id: "anonymous", authType: "api_key" , tenantId: "fleet_00000000000000000000"} satisfies AuthUser);
    }
    return next();
  })
  .route("/public/nodes", gatewayRoutes)
  .route("/api", stationTerminalRoutes)
  .route("/api", stationRoutes);

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "sterm-test@example.com",
    name: "Station Terminal Test User",
  });
  USER_PRINCIPAL = await createPrincipal({
    kind: "human",
    handle: USER_HANDLE,
    userId: TEST_USER,
  });
  AGENT_PRINCIPAL = await createPrincipal({ kind: "agent", handle: AGENT_HANDLE });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM stations          WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM nodes             WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM principals        WHERE handle IN (${USER_HANDLE}, ${AGENT_HANDLE})`;
    await rawSql`DELETE FROM "user"            WHERE id = ${TEST_USER}`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Connect a fake node WS to the gateway and wire up handlers.
 *
 * @param streamChunks  base64 chunks to emit after term.attach (default: ["aGVsbG8="])
 * @param capturedNodeMsgs  array to append raw messages received by the node
 * @param attachIdRef  single-element array; [0] is set to the attach req id once known
 */
async function connectFakeNode(
  serverPort: number,
  nodeId: string,
  nodeSecret: string,
  opts: {
    streamChunks?: string[];
    capturedNodeMsgs?: string[];
    attachIdRef?: [string | null];
    holdStream?: boolean; // if true, don't close the stream with eof
  } = {}
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
    const msg = JSON.parse(raw);

    // Capture everything the node receives (for assertion in unauthenticated test)
    if (opts.capturedNodeMsgs) {
      opts.capturedNodeMsgs.push(raw);
    }

    if (msg.type === "req") {
      switch (msg.verb) {
        case "detect":
          ws.send(
            JSON.stringify({
              type: "res",
              id: msg.id,
              ok: true,
              data: [
                {
                  key: STATION_KEY,
                  harness: "opencode",
                  kind: "leaf",
                  displayName: "Station Terminal Test",
                  parentKey: null,
                  workspacePath: "/workspace/sterm",
                  capabilities: ["health", "terminal"],
                },
              ],
            })
          );
          break;

        case "term.open":
          ws.send(
            JSON.stringify({
              type: "res",
              id: msg.id,
              ok: true,
              data: { sessionId: FAKE_SESSION_ID },
            })
          );
          break;

        case "term.attach":
          if (opts.attachIdRef) {
            opts.attachIdRef[0] = msg.id;
          }
          if (!opts.holdStream) {
            // Emit chunks then eof after a short delay.
            const chunks = opts.streamChunks ?? ["aGVsbG8="]; // base64("hello")
            setTimeout(() => {
              chunks.forEach((chunk, i) => {
                ws.send(
                  JSON.stringify({
                    type: "stream",
                    id: msg.id,
                    seq: i,
                    chunk,
                    eof: false,
                    enc: "base64",
                  })
                );
              });
              // eof frame
              ws.send(
                JSON.stringify({
                  type: "stream",
                  id: msg.id,
                  seq: chunks.length,
                  chunk: null,
                  eof: true,
                })
              );
            }, 50);
          }
          break;
      }
    }
  };

  // onOpen → verifyNodeCredential (argon2id) → register outlasts any fixed
  // sleep under load; wait for the registration itself.
  await waitForNodeOnline(nodeId);
  return ws;
}

/** Adopt the test station via the HTTP route. */
async function adoptStation(
  baseUrl: string,
  nodeId: string
): Promise<StationRow> {
  const res = await fetch(`${baseUrl}/api/nodes/${nodeId}/stations/adopt`, {
    method: "POST",
    headers: {
      "X-Test-User-Id": TEST_USER,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ keys: [STATION_KEY] }),
  });
  expect(res.status).toBe(200);
  const rows = (await res.json()) as StationRow[];
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** Put the test's agent in the station, so a grant naming it covers this one. */
async function occupy(stationId: string): Promise<void> {
  // Occupancy is exclusive as of the fix round on Task 5
  // (`stations_principal_id_idx`) — this file reuses ONE `AGENT_PRINCIPAL`
  // across many tests, each adopting its own fresh station, so it has to
  // vacate wherever that principal already sits (an earlier test's station)
  // before placing it here, exactly as the real assign endpoint now does.
  await rawSql`UPDATE stations SET principal_id = NULL WHERE principal_id = ${AGENT_PRINCIPAL}`;
  await rawSql`UPDATE stations SET principal_id = ${AGENT_PRINCIPAL} WHERE id = ${stationId}`;
}

// ─── Helpers (event-driven) ───────────────────────────────────────────────────

/**
 * Poll condition() every pollMs until it returns a truthy value, or throw
 * after timeoutMs.  Used in the new tests instead of arbitrary setTimeout
 * waits so the suite doesn't waste time waiting for already-arrived frames.
 */
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
  "authenticated WS → hub sends term.open + term.attach; stream chunk arrives as {t:'data'}",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "sterm-open-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      const fakeNode = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        streamChunks: ["aGVsbG8="], // base64("hello")
      });

      const station = await adoptStation(baseUrl, nodeId);

      // Connect an authenticated client WS and collect messages.
      const receivedData: string[] = [];
      const sessionDone = new Promise<void>((resolve) => {
        const clientWs = new WebSocket(
          `ws://localhost:${server.port}/api/stations/${station.id}/terminal`,
          {
            headers: { "X-Test-User-Id": TEST_USER },
          } as RequestInit & { headers: Record<string, string> }
        );
        clientWs.onmessage = (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.t === "data") receivedData.push(msg.data);
          if (msg.t === "exit") resolve();
        };
        clientWs.onclose = () => resolve();
        clientWs.onerror = () => resolve();
      });

      await sessionDone;

      // The chunk "aGVsbG8=" must have been forwarded from the node stream.
      expect(receivedData).toContain("aGVsbG8=");

      fakeNode.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "client {t:'input'} is forwarded to the node as an input frame with the attach id",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "sterm-input-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      const attachIdRef: [string | null] = [null];
      const capturedNodeMsgs: string[] = [];

      // Custom fake node: hold the attach stream open so we can send input.
      const fakeNode = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        holdStream: true,
        attachIdRef,
        capturedNodeMsgs,
      });

      const station = await adoptStation(baseUrl, nodeId);

      // Connect client
      let clientWs: WebSocket;
      await new Promise<void>((resolve, reject) => {
        clientWs = new WebSocket(
          `ws://localhost:${server.port}/api/stations/${station.id}/terminal`,
          {
            headers: { "X-Test-User-Id": TEST_USER },
          } as RequestInit & { headers: Record<string, string> }
        );
        clientWs.onopen = () => resolve();
        clientWs.onerror = () => reject(new Error("Client WS error"));
      });

      // Wait for the attach handshake to complete on the node side.
      await pollUntil(() => attachIdRef[0] !== null);
      expect(attachIdRef[0]).not.toBeNull(); // term.attach must have been sent

      // Send input from the client.
      clientWs!.send(JSON.stringify({ t: "input", data: "ls\n" }));
      await new Promise((r) => setTimeout(r, 200));

      // Find the input frame in the messages the node received.
      const inputFrames = capturedNodeMsgs
        .map((raw) => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })
        .filter((m) => m?.type === "input");

      expect(inputFrames.length).toBeGreaterThan(0);
      const frame = inputFrames[0];
      expect(frame.type).toBe("input");
      expect(frame.data).toBe("ls\n");
      // The id must match the attach stream id so the node routes it to the right PTY.
      expect(frame.id).toBe(attachIdRef[0]);

      clientWs!.close();
      fakeNode.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "client {t:'resize'} is forwarded to the node as a resize frame with the attach id",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "sterm-resize-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      const attachIdRef: [string | null] = [null];
      const capturedNodeMsgs: string[] = [];

      // Hold the stream open so we can send a resize message.
      const fakeNode = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        holdStream: true,
        attachIdRef,
        capturedNodeMsgs,
      });

      const station = await adoptStation(baseUrl, nodeId);

      // Connect authenticated client.
      let clientWs: WebSocket;
      await new Promise<void>((resolve, reject) => {
        clientWs = new WebSocket(
          `ws://localhost:${server.port}/api/stations/${station.id}/terminal`,
          {
            headers: { "X-Test-User-Id": TEST_USER },
          } as RequestInit & { headers: Record<string, string> }
        );
        clientWs.onopen = () => resolve();
        clientWs.onerror = () => reject(new Error("Client WS error"));
      });

      // Wait until the attach handshake completes on the node side.
      await pollUntil(() => attachIdRef[0]);

      // Send a resize event from the client.
      clientWs!.send(JSON.stringify({ t: "resize", cols: 120, rows: 40 }));

      // Poll until the node receives a resize frame.
      const resizeFrame = await pollUntil(() => {
        for (const raw of capturedNodeMsgs) {
          try {
            const m = JSON.parse(raw);
            if (m?.type === "resize") return m;
          } catch { /* skip */ }
        }
        return null;
      });

      expect(resizeFrame.type).toBe("resize");
      expect(resizeFrame.cols).toBe(120);
      expect(resizeFrame.rows).toBe(40);
      // Frame must carry the attach id so the node routes it to the right PTY.
      expect(resizeFrame.id).toBe(attachIdRef[0]);

      clientWs!.close();
      fakeNode.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "client disconnect sends cancel (detach) to the node and does NOT send term.close — PTY session survives",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "sterm-disconnect-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      const attachIdRef: [string | null] = [null];
      const capturedNodeMsgs: string[] = [];

      // Hold the stream open so the session is active when we disconnect.
      const fakeNode = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        holdStream: true,
        attachIdRef,
        capturedNodeMsgs,
      });

      const station = await adoptStation(baseUrl, nodeId);

      // Connect authenticated client.
      let clientWs: WebSocket;
      await new Promise<void>((resolve, reject) => {
        clientWs = new WebSocket(
          `ws://localhost:${server.port}/api/stations/${station.id}/terminal`,
          {
            headers: { "X-Test-User-Id": TEST_USER },
          } as RequestInit & { headers: Record<string, string> }
        );
        clientWs.onopen = () => resolve();
        clientWs.onerror = () => reject(new Error("Client WS error"));
      });

      // Wait for attach to be established before disconnecting.
      await pollUntil(() => attachIdRef[0]);

      // Disconnect the client — this should trigger a cancel (detach), not term.close.
      clientWs!.close();

      // Poll until the node sees a cancel frame.
      const cancelFrame = await pollUntil(() => {
        for (const raw of capturedNodeMsgs) {
          try {
            const m = JSON.parse(raw);
            if (m?.type === "cancel") return m;
          } catch { /* skip */ }
        }
        return null;
      });

      expect(cancelFrame.type).toBe("cancel");
      // The cancel must reference the attach stream id so the node detaches the
      // right PTY subscription — not blindly close it.
      expect(cancelFrame.id).toBe(attachIdRef[0]);

      // The node must NOT have received a term.close verb.  The PTY session is
      // kept alive on the node so a reconnecting client can re-attach.
      const termCloseReceived = capturedNodeMsgs.some((raw) => {
        try {
          const m = JSON.parse(raw);
          return m?.type === "req" && m?.verb === "term.close";
        } catch {
          return false;
        }
      });
      expect(termCloseReceived).toBe(false);

      fakeNode.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "unauthenticated upgrade is rejected — WS closes, no term.open sent to node",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "sterm-unauth-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      // Track everything the node receives.
      const nodeReceivedMsgs: string[] = [];
      const fakeNode = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        capturedNodeMsgs: nodeReceivedMsgs,
      });

      const station = await adoptStation(baseUrl, nodeId);

      // Connect WITHOUT X-Test-User-Id header → anonymous → should be rejected.
      const { closeCode } = await new Promise<{ closeCode: number }>((resolve) => {
        const clientWs = new WebSocket(
          `ws://localhost:${server.port}/api/stations/${station.id}/terminal`
          // no X-Test-User-Id header
        );
        clientWs.onclose = (e) => resolve({ closeCode: e.code });
        // Some Bun versions fire onerror without onclose for policy violations
        clientWs.onerror = () => resolve({ closeCode: 1006 });
      });

      // Server must have closed the connection (not left it hanging).
      // Acceptable codes: 1008 (policy violation), 1006 (abnormal), 1000 (normal),
      // or 1011 (internal error), depending on how Bun surfaces the close.
      expect([1008, 1006, 1000, 1011].includes(closeCode)).toBe(true);

      // Allow any pending async work to complete.
      await new Promise((r) => setTimeout(r, 200));

      // No term.open req should have been sent to the node.
      const termOpenSent = nodeReceivedMsgs.some((raw) => {
        try {
          const m = JSON.parse(raw);
          return m?.type === "req" && m?.verb === "term.open";
        } catch {
          return false;
        }
      });
      expect(termOpenSent).toBe(false);

      fakeNode.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

// ─── The reach half of the control pair (#345) ────────────────────────────────

test(
  "a principal who may dispatch but not change is refused — no shell opens, and it is recorded",
  async () => {
    // A terminal is the most complete way to change what an agent is; the route
    // itself calls it "the most powerful mutation". So it is the clearest case
    // for the second half of the pair: dispatch permission is not permission to
    // rewrite (charter Decision 4).
    //
    // Asserted on what is unambiguous — the shell never opened and the refusal
    // was recorded — rather than on the close code, which Bun surfaces
    // inconsistently for policy violations (see the unauthenticated test above).
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    process.env.ENFORCE_CONTROL_PAIR = "true";

    try {
      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "sterm-reach-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      const nodeReceivedMsgs: string[] = [];
      const fakeNode = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        capturedNodeMsgs: nodeReceivedMsgs,
      });
      const station = await adoptStation(baseUrl, nodeId);

      // Dispatch over this very agent, and no reach — so the only thing that
      // can refuse is the reach half.
      await occupy(station.id);
      await setGrant(USER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
      await rawSql`DELETE FROM station_audit WHERE user_id = ${TEST_USER} AND verb = 'terminal'`;

      await new Promise<void>((resolve) => {
        const clientWs = new WebSocket(
          `ws://localhost:${server.port}/api/stations/${station.id}/terminal`,
          { headers: { "X-Test-User-Id": TEST_USER } } as RequestInit & {
            headers: Record<string, string>;
          }
        );
        clientWs.onclose = () => resolve();
        clientWs.onerror = () => resolve();
      });

      await new Promise((r) => setTimeout(r, 200));

      const termOpenSent = nodeReceivedMsgs.some((raw) => {
        try {
          const m = JSON.parse(raw);
          return m?.type === "req" && m?.verb === "term.open";
        } catch {
          return false;
        }
      });
      expect(termOpenSent).toBe(false);

      // Refused and recorded. An attempt refused and recorded nowhere is
      // indistinguishable from an attempt nobody made.
      const rows = await rawSql`
        SELECT result FROM station_audit WHERE user_id = ${TEST_USER} AND verb = 'terminal'`;
      expect(rows.length).toBe(1);
      expect(rows[0]!.result).toBe("error");

      fakeNode.close();
    } finally {
      delete process.env.ENFORCE_CONTROL_PAIR;
      await rawSql`DELETE FROM principal_grants WHERE principal_id = ${USER_PRINCIPAL}`;
      server.stop(true);
    }
  },
  20000
);

test(
  "a principal holding reach in scope opens the shell as before",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    process.env.ENFORCE_CONTROL_PAIR = "true";

    try {
      const { token } = await mintEnrollmentToken(TEST_USER);
      const { nodeId, nodeSecret } = await enrollNode(token, {
        hostname: "sterm-reach-ok-host",
        os: "linux",
        arch: "amd64",
        cpuCount: 2,
      });

      const nodeReceivedMsgs: string[] = [];
      const fakeNode = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        capturedNodeMsgs: nodeReceivedMsgs,
      });
      const station = await adoptStation(baseUrl, nodeId);

      await occupy(station.id);
      await setGrant(USER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });

      const clientWs = new WebSocket(
        `ws://localhost:${server.port}/api/stations/${station.id}/terminal`,
        { headers: { "X-Test-User-Id": TEST_USER } } as RequestInit & {
          headers: Record<string, string>;
        }
      );
      await new Promise<void>((resolve) => {
        clientWs.onopen = () => resolve();
        clientWs.onerror = () => resolve();
      });
      await new Promise((r) => setTimeout(r, 300));

      const termOpenSent = nodeReceivedMsgs.some((raw) => {
        try {
          const m = JSON.parse(raw);
          return m?.type === "req" && m?.verb === "term.open";
        } catch {
          return false;
        }
      });
      expect(termOpenSent).toBe(true);

      clientWs.close();
      fakeNode.close();
    } finally {
      delete process.env.ENFORCE_CONTROL_PAIR;
      await rawSql`DELETE FROM principal_grants WHERE principal_id = ${USER_PRINCIPAL}`;
      server.stop(true);
    }
  },
  20000
);
