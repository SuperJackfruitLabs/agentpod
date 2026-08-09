/**
 * Service Test: ACP transport adapter (broker ↔ SDK byte streams)
 *
 * Verifies openAcpWire() (src/services/acp-transport.ts):
 *   1. acp.open {key} → acp.attach {sessionId}; base64 chunks surface via
 *      `readable` in order as raw bytes.
 *   2. Bytes written to `writable` reach the node as input frames keyed by the
 *      ACP SESSION id (NOT the attach stream id — that's the terminal's convention).
 *   3. An in-band exit chunk {"event":"exit","reason":...} resolves `closed`
 *      with the reason and does NOT leak into `readable`.
 *   4. close() sends acp.close {sessionId} + a cancel for the attach stream;
 *      idempotent.
 *   5. acp.open failure → throws Error("Couldn't start the agent process — ...").
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
import { mintEnrollmentToken, enrollNode } from "../services/enrollment";
import { gatewayRoutes } from "../routes/gateway";
import { websocket } from "../ws";
import { openAcpWire } from "./acp-transport";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER = "test-user-acpwire-001";
const STATION_KEY = "acpwire-station";
const FAKE_SESSION_ID = "acp-session-xyz789";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

// ─── Minimal test app ─────────────────────────────────────────────────────────

// Service test: only the node gateway is needed (openAcpWire talks broker-side).
const testApp = new Hono().route("/public/nodes", gatewayRoutes);

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "acpwire-test@example.com",
    name: "ACP Wire Test User",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM nodes             WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM "user"            WHERE id = ${TEST_USER}`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Connect a fake node WS to the gateway and script the ACP verbs.
 *
 * - acp.open  → res {sessionId: FAKE_SESSION_ID} (or {ok:false} when failOpen)
 * - acp.attach → records the attach id, then emits opts.streamChunks (base64)
 *   followed by eof unless holdStream is set
 * - input frames → echoed back as stream chunks on the attach id
 * - acp.close → res {ok:true}
 */
async function connectFakeNode(
  serverPort: number,
  nodeId: string,
  nodeSecret: string,
  opts: {
    streamChunks?: string[];
    capturedNodeMsgs?: string[];
    attachIdRef?: [string | null];
    holdStream?: boolean;
    failOpen?: string; // respond to acp.open with ok:false and this error
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

  let echoSeq = 1000; // scripted chunks use low seqs; echoes use high ones

  ws.onmessage = (e) => {
    const raw = String(e.data);
    const msg = JSON.parse(raw);

    if (opts.capturedNodeMsgs) {
      opts.capturedNodeMsgs.push(raw);
    }

    // Echo input frames back as stream chunks on the attach stream.
    if (msg.type === "input" && opts.attachIdRef?.[0]) {
      ws.send(
        JSON.stringify({
          type: "stream",
          id: opts.attachIdRef[0],
          seq: echoSeq++,
          chunk: msg.data,
          eof: false,
          enc: "base64",
        })
      );
      return;
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
                  displayName: "ACP Wire Test",
                  parentKey: null,
                  workspacePath: "/workspace/acpwire",
                  capabilities: ["health", "acp"],
                },
              ],
            })
          );
          break;

        case "acp.open":
          if (opts.failOpen) {
            ws.send(
              JSON.stringify({
                type: "res",
                id: msg.id,
                ok: false,
                error: opts.failOpen,
              })
            );
          } else {
            ws.send(
              JSON.stringify({
                type: "res",
                id: msg.id,
                ok: true,
                data: { sessionId: FAKE_SESSION_ID },
              })
            );
          }
          break;

        case "acp.attach":
          if (opts.attachIdRef) {
            opts.attachIdRef[0] = msg.id;
          }
          if (!opts.holdStream) {
            const chunks = opts.streamChunks ?? [];
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

        case "acp.close":
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
    }
  };

  // Allow onOpen → connectionManager.register to settle
  await new Promise((r) => setTimeout(r, 150));
  return ws;
}

async function enrollTestNode(hostname: string) {
  const { token } = await mintEnrollmentToken(TEST_USER);
  return enrollNode(token, {
    hostname,
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });
}

/** Poll condition() every pollMs until truthy, or throw after timeoutMs. */
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

/** Drain a ReadableStream<Uint8Array> to a UTF-8 string (until close). */
async function readAllText(
  readable: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function parsedNodeMsgs(raw: string[]): Record<string, unknown>[] {
  return raw
    .map((r) => {
      try {
        return JSON.parse(r);
      } catch {
        return null;
      }
    })
    .filter((m): m is Record<string, unknown> => m !== null);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "openAcpWire: acp.open {key} → acp.attach {sessionId}; chunks surface via readable in order; eof resolves closed with 'eof'",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });

    try {
      const { nodeId, nodeSecret } = await enrollTestNode("acpwire-read-host");

      const capturedNodeMsgs: string[] = [];
      const attachIdRef: [string | null] = [null];
      const line1 = '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n';
      const line2 = '{"jsonrpc":"2.0","method":"session/update","params":{}}\n';
      const fakeNode = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        streamChunks: [b64(line1), b64(line2)],
        capturedNodeMsgs,
        attachIdRef,
      });

      const wire = await openAcpWire(nodeId, STATION_KEY);
      expect(wire.nodeSessionId).toBe(FAKE_SESSION_ID);

      // acp.open carried the station key; acp.attach carried the session id.
      const openReq = await pollUntil(() => {
        return parsedNodeMsgs(capturedNodeMsgs).find(
          (m) => m.type === "req" && (m as { verb?: string }).verb === "acp.open"
        ) as { params: { key: string } } | undefined;
      });
      expect(openReq.params.key).toBe(STATION_KEY);
      const attachReq = await pollUntil(() => {
        return parsedNodeMsgs(capturedNodeMsgs).find(
          (m) =>
            m.type === "req" && (m as { verb?: string }).verb === "acp.attach"
        ) as { params: { sessionId: string } } | undefined;
      });
      expect(attachReq.params.sessionId).toBe(FAKE_SESSION_ID);

      // Chunks arrive base64-decoded, in order.
      const text = await readAllText(wire.readable);
      expect(text).toBe(line1 + line2);

      // eof without exit frame → closed resolves "eof".
      expect(await wire.closed).toBe("eof");

      await wire.close();
      fakeNode.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "writes to writable reach the node as input frames keyed by the SESSION id (not the attach id) and echo back via readable",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });

    try {
      const { nodeId, nodeSecret } = await enrollTestNode("acpwire-input-host");

      const capturedNodeMsgs: string[] = [];
      const attachIdRef: [string | null] = [null];
      const fakeNode = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        holdStream: true,
        capturedNodeMsgs,
        attachIdRef,
      });

      const wire = await openAcpWire(nodeId, STATION_KEY);
      await pollUntil(() => attachIdRef[0]);

      const outbound = '{"jsonrpc":"2.0","id":7,"method":"initialize"}\n';
      const writer = wire.writable.getWriter();
      await writer.write(new TextEncoder().encode(outbound));
      writer.releaseLock();

      // The node must receive an input frame keyed by the ACP SESSION id.
      const inputFrame = await pollUntil(() => {
        return parsedNodeMsgs(capturedNodeMsgs).find(
          (m) => m.type === "input"
        ) as { id: string; data: string } | undefined;
      });
      expect(inputFrame.id).toBe(FAKE_SESSION_ID);
      expect(inputFrame.id).not.toBe(attachIdRef[0]!);
      expect(Buffer.from(inputFrame.data, "base64").toString("utf-8")).toBe(
        outbound
      );

      // The echoed chunk comes back through readable.
      const reader = wire.readable.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe(outbound);
      reader.releaseLock();

      await wire.close();
      fakeNode.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "in-band exit frame resolves closed with the reason and does not leak into readable",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });

    try {
      const { nodeId, nodeSecret } = await enrollTestNode("acpwire-exit-host");

      const protocolLine = '{"jsonrpc":"2.0","id":2,"result":{}}\n';
      const exitFrame = JSON.stringify({
        event: "exit",
        reason: "agent process exited (code 1)",
      });
      const fakeNode = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        streamChunks: [b64(protocolLine), b64(exitFrame)],
      });

      const wire = await openAcpWire(nodeId, STATION_KEY);

      const text = await readAllText(wire.readable);
      // Protocol bytes surfaced; the exit frame did NOT leak into readable.
      expect(text).toBe(protocolLine);
      expect(text).not.toContain('"event"');

      expect(await wire.closed).toBe("agent process exited (code 1)");

      await wire.close();
      fakeNode.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "close() sends acp.close {sessionId} + cancel for the attach stream; idempotent",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });

    try {
      const { nodeId, nodeSecret } = await enrollTestNode("acpwire-close-host");

      const capturedNodeMsgs: string[] = [];
      const attachIdRef: [string | null] = [null];
      const fakeNode = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        holdStream: true,
        capturedNodeMsgs,
        attachIdRef,
      });

      const wire = await openAcpWire(nodeId, STATION_KEY);
      await pollUntil(() => attachIdRef[0]);

      await wire.close();

      // Node received a cancel for the attach stream id…
      const cancelFrame = await pollUntil(() => {
        return parsedNodeMsgs(capturedNodeMsgs).find(
          (m) => m.type === "cancel"
        ) as { id: string } | undefined;
      });
      expect(cancelFrame.id).toBe(attachIdRef[0]!);

      // …and a best-effort acp.close keyed by the session id.
      const closeReq = await pollUntil(() => {
        return parsedNodeMsgs(capturedNodeMsgs).find(
          (m) => m.type === "req" && (m as { verb?: string }).verb === "acp.close"
        ) as { params: { sessionId: string } } | undefined;
      });
      expect(closeReq.params.sessionId).toBe(FAKE_SESSION_ID);

      // readable terminates and closed settles.
      const text = await readAllText(wire.readable);
      expect(text).toBe("");
      await wire.closed;

      // Idempotent: a second close() neither throws nor re-sends acp.close.
      await wire.close();
      await new Promise((r) => setTimeout(r, 150));
      const closeReqs = parsedNodeMsgs(capturedNodeMsgs).filter(
        (m) => m.type === "req" && (m as { verb?: string }).verb === "acp.close"
      );
      expect(closeReqs).toHaveLength(1);

      fakeNode.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "acp.open failure and offline node → Error(\"Couldn't start the agent process — ...\")",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });

    try {
      const { nodeId, nodeSecret } = await enrollTestNode("acpwire-fail-host");

      const fakeNode = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        failOpen: "harness not found",
      });

      await expect(openAcpWire(nodeId, STATION_KEY)).rejects.toThrow(
        "Couldn't start the agent process — harness not found."
      );

      // Offline node (never connected) → broker resolves {ok:false, error:"node offline"}.
      await expect(
        openAcpWire("00000000-0000-0000-0000-000000000000", STATION_KEY)
      ).rejects.toThrow("Couldn't start the agent process — node offline.");

      fakeNode.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);
