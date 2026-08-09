/**
 * acp.test.ts
 *
 * Unit tests for the ACP session API client — REST helpers plus the thin
 * WebSocket wrapper over the hub's ACP session bridge.  Uses a mocked
 * globalThis.WebSocket (and a fetch spy) so no real network is touched.
 * Run: cd apps/console && pnpm test src/lib/api/acp.test.ts
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import type { AcpServerMsg, AcpSessionRow } from "@agentpod/contract";

// ─── Minimal WebSocket stub ───────────────────────────────────────────────────

class MockWebSocket {
  static instance: MockWebSocket | null = null;

  url: string;
  readyState: number = 0; // CONNECTING

  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  /** Payloads passed to ws.send(), as raw strings. */
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instance = this;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.onclose?.(new CloseEvent("close"));
  }

  /** Test helper: simulate the server opening the connection. */
  open() {
    this.readyState = 1; // OPEN
    this.onopen?.(new Event("open"));
  }

  /** Test helper: simulate a JSON message from the server. */
  fireMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  /** Test helper: simulate a raw (possibly non-JSON) frame from the server. */
  fireRaw(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  /** Test helper: simulate a socket-level error (no accompanying close). */
  fireError() {
    this.onerror?.(new Event("error"));
  }
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  MockWebSocket.instance = null;
  // Seed localStorage so hubUrl() returns a deterministic host
  localStorage.setItem("agentpod.apiUrl", "http://hub.test:3001");
  // Install the stub
  (globalThis as unknown as Record<string, unknown>).WebSocket = MockWebSocket;
});

afterEach(() => {
  MockWebSocket.instance = null;
  localStorage.clear();
  vi.unstubAllGlobals();
});

// ─── Import under test ────────────────────────────────────────────────────────
// Imported after stubs so the module can read globalThis.WebSocket at call time
// (it doesn't capture it at import time).
import { createAcpSocket, createAcpSession, listAcpSessions, endAcpSession } from "./acp";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const sessionRow: AcpSessionRow = {
  id: "s1",
  stationId: "st1",
  userId: "u1",
  mode: "ask",
  status: "idle",
  endedReason: null,
  createdAt: "2026-08-09T00:00:00.000Z",
  lastEventAt: "2026-08-09T00:00:00.000Z",
};

// ─── WebSocket: URL derivation ───────────────────────────────────────────────

test("createAcpSocket opens ws:// URL derived from hubUrl()", () => {
  createAcpSocket("s1");

  expect(MockWebSocket.instance).toBeTruthy();
  expect(MockWebSocket.instance!.url).toBe("ws://hub.test:3001/api/acp/sessions/s1/ws");
});

test("https:// → wss:// in the ACP WebSocket URL", () => {
  localStorage.setItem("agentpod.apiUrl", "https://hub.prod:443");
  createAcpSocket("s2");

  expect(MockWebSocket.instance!.url).toBe("wss://hub.prod:443/api/acp/sessions/s2/ws");
});

// ─── WebSocket: send ─────────────────────────────────────────────────────────

test("send(msg) after open sends the JSON-encoded client message", () => {
  const socket = createAcpSocket("s1");
  MockWebSocket.instance!.open();
  socket.send({ t: "prompt", text: "hello" });

  expect(MockWebSocket.instance!.sent).toHaveLength(1);
  expect(JSON.parse(MockWebSocket.instance!.sent[0])).toEqual({ t: "prompt", text: "hello" });
});

test("send(msg) before open is buffered and flushed in order on open", () => {
  const socket = createAcpSocket("s1");
  socket.send({ t: "subscribe", sinceSeq: 0 });
  socket.send({ t: "prompt", text: "hi" });

  expect(MockWebSocket.instance!.sent).toHaveLength(0); // not yet sent

  MockWebSocket.instance!.open();

  expect(MockWebSocket.instance!.sent).toHaveLength(2);
  expect(JSON.parse(MockWebSocket.instance!.sent[0])).toEqual({ t: "subscribe", sinceSeq: 0 });
  expect(JSON.parse(MockWebSocket.instance!.sent[1])).toEqual({ t: "prompt", text: "hi" });
});

// ─── WebSocket: onMessage ────────────────────────────────────────────────────

test("onMessage delivers parsed AcpServerMsg frames", () => {
  const socket = createAcpSocket("s1");
  const received: AcpServerMsg[] = [];
  socket.onMessage((msg) => received.push(msg));

  MockWebSocket.instance!.open();
  MockWebSocket.instance!.fireMessage({ t: "replay-done", lastSeq: 5 });
  MockWebSocket.instance!.fireMessage({ t: "session", session: sessionRow });

  expect(received).toEqual([
    { t: "replay-done", lastSeq: 5 },
    { t: "session", session: sessionRow },
  ]);
});

test("garbage frames (non-JSON, unknown variants) are dropped silently", () => {
  const socket = createAcpSocket("s1");
  const received: AcpServerMsg[] = [];
  socket.onMessage((msg) => received.push(msg));

  MockWebSocket.instance!.open();
  MockWebSocket.instance!.fireRaw("not json {");
  MockWebSocket.instance!.fireMessage({ t: "future-variant", stuff: true });
  MockWebSocket.instance!.fireMessage({ nonsense: 1 });
  MockWebSocket.instance!.fireMessage({ t: "replay-done", lastSeq: 3 });

  expect(received).toEqual([{ t: "replay-done", lastSeq: 3 }]);
});

// ─── WebSocket: onClose ──────────────────────────────────────────────────────

test("an unprompted clean close fires onClose('closed')", () => {
  const socket = createAcpSocket("s1");
  const reasons: string[] = [];
  socket.onClose((reason) => reasons.push(reason));

  MockWebSocket.instance!.open();
  // Server/network drops the socket without the client having called close().
  MockWebSocket.instance!.onclose?.(new CloseEvent("close"));

  expect(reasons).toEqual(["closed"]);
});

test("socket error fires onClose('error') exactly once", () => {
  const socket = createAcpSocket("s1");
  const reasons: string[] = [];
  socket.onClose((reason) => reasons.push(reason));

  MockWebSocket.instance!.open();
  MockWebSocket.instance!.fireError();
  // Errors are typically followed by a close event — must not double-fire.
  MockWebSocket.instance!.onclose?.(new CloseEvent("close"));

  expect(reasons).toEqual(["error"]);
});

test("close() then the resulting socket close does not fire onClose", () => {
  const socket = createAcpSocket("s1");
  const reasons: string[] = [];
  socket.onClose((reason) => reasons.push(reason));

  MockWebSocket.instance!.open();
  socket.close(); // mock synchronously invokes ws.onclose, as a real close would (async)

  expect(reasons).toEqual([]);
  expect(MockWebSocket.instance!.readyState).toBe(3); // CLOSED
});

// ─── REST helpers ────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("createAcpSession POSTs {mode} to /api/stations/:id/acp/sessions", async () => {
  const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(sessionRow, 201));
  vi.stubGlobal("fetch", fetchSpy);

  const row = await createAcpSession("st1", "ask");

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0];
  expect(url).toBe("http://hub.test:3001/api/stations/st1/acp/sessions");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ mode: "ask" });
  expect(row).toEqual(sessionRow);
});

test("listAcpSessions GETs /api/stations/:id/acp/sessions", async () => {
  const fetchSpy = vi.fn().mockResolvedValue(jsonResponse([sessionRow]));
  vi.stubGlobal("fetch", fetchSpy);

  const rows = await listAcpSessions("st1");

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0];
  expect(url).toBe("http://hub.test:3001/api/stations/st1/acp/sessions");
  expect(init?.method ?? "GET").toBe("GET");
  expect(rows).toEqual([sessionRow]);
});

test("endAcpSession DELETEs /api/acp/sessions/:sessionId and resolves on 204", async () => {
  const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchSpy);

  await expect(endAcpSession("s9")).resolves.toBeUndefined();

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0];
  expect(url).toBe("http://hub.test:3001/api/acp/sessions/s9");
  expect(init.method).toBe("DELETE");
});
