/**
 * terminal.test.ts
 *
 * Unit tests for createTerminalClient — the thin WebSocket wrapper over the
 * hub terminal bridge.  Uses a mocked globalThis.WebSocket so no real socket
 * is opened.  Run: cd apps/console && pnpm test src/lib/api/terminal.test.ts
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Minimal WebSocket stub ───────────────────────────────────────────────────

type SendHandler = (data: string) => void;

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

  /** Test helper: simulate a message from the server. */
  fireMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  /** Test helper: simulate a socket-level error (no accompanying close). */
  fireError() {
    this.onerror?.(new Event("error"));
  }
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
  MockWebSocket.instance = null;
  // Seed localStorage so hubUrl() returns a deterministic host
  localStorage.setItem("agentpod.apiUrl", "http://hub.test:3001");
  // Install the stub
  (globalThis as unknown as Record<string, unknown>).WebSocket = MockWebSocket;
});

afterEach(() => {
  MockWebSocket.instance = null;
  localStorage.clear();
});

// ─── Import under test ────────────────────────────────────────────────────────
// Imported after stubs so the module can read globalThis.WebSocket at call time
// (it doesn't capture it at import time).
import { createTerminalClient } from "./terminal";
import { socketToken } from "./client";
import { beginSignIn, completeSignIn, signOutLocal } from "$lib/auth/org-plane";
import { clearAuthSession, setPlane } from "$lib/stores/auth.svelte";

// ─── Tests ───────────────────────────────────────────────────────────────────

test("createTerminalClient opens ws:// URL derived from hubUrl()", () => {
  createTerminalClient("s1");

  expect(MockWebSocket.instance).toBeTruthy();
  expect(MockWebSocket.instance!.url).toBe("ws://hub.test:3001/api/stations/s1/terminal");
});

test("https:// → wss:// in the terminal WebSocket URL", () => {
  localStorage.setItem("agentpod.apiUrl", "https://hub.prod:443");
  createTerminalClient("s2");

  expect(MockWebSocket.instance!.url).toBe("wss://hub.prod:443/api/stations/s2/terminal");
});

test("server {t:'data', data:base64} → onData fires with decoded string", () => {
  const client = createTerminalClient("s1");
  const received: string[] = [];
  client.onData((text) => received.push(text));

  MockWebSocket.instance!.open();
  // btoa("hi") = "aGk="
  MockWebSocket.instance!.fireMessage({ t: "data", data: btoa("hi") });

  expect(received).toEqual(["hi"]);
});

test("onData receives multi-byte UTF-8 decoded correctly", () => {
  const client = createTerminalClient("s1");
  const received: string[] = [];
  client.onData((text) => received.push(text));

  MockWebSocket.instance!.open();
  // Encode "héllo" via TextEncoder → base64
  const bytes = new TextEncoder().encode("héllo");
  const b64 = btoa(String.fromCharCode(...bytes));
  MockWebSocket.instance!.fireMessage({ t: "data", data: b64 });

  expect(received).toEqual(["héllo"]);
});

test("send(text) emits {t:'input', data:base64} after socket open", () => {
  const client = createTerminalClient("s1");
  MockWebSocket.instance!.open();
  client.send("x");

  expect(MockWebSocket.instance!.sent).toHaveLength(1);
  const msg = JSON.parse(MockWebSocket.instance!.sent[0]);
  expect(msg).toEqual({ t: "input", data: btoa("x") });
});

test("send(text) before open is buffered and flushed on open", () => {
  const client = createTerminalClient("s1");
  // send before the socket is opened
  client.send("a");
  client.send("b");

  expect(MockWebSocket.instance!.sent).toHaveLength(0); // not yet sent

  MockWebSocket.instance!.open();

  expect(MockWebSocket.instance!.sent).toHaveLength(2);
  expect(JSON.parse(MockWebSocket.instance!.sent[0])).toEqual({ t: "input", data: btoa("a") });
  expect(JSON.parse(MockWebSocket.instance!.sent[1])).toEqual({ t: "input", data: btoa("b") });
});

test("resize(cols, rows) emits {t:'resize', cols, rows}", () => {
  const client = createTerminalClient("s1");
  MockWebSocket.instance!.open();
  client.resize(80, 24);

  expect(MockWebSocket.instance!.sent).toHaveLength(1);
  const msg = JSON.parse(MockWebSocket.instance!.sent[0]);
  expect(msg).toEqual({ t: "resize", cols: 80, rows: 24 });
});

test("server {t:'exit'} causes the socket to close", () => {
  const client = createTerminalClient("s1");
  MockWebSocket.instance!.open();
  MockWebSocket.instance!.fireMessage({ t: "exit" });

  expect(MockWebSocket.instance!.readyState).toBe(3); // CLOSED
});

test("close() closes the underlying socket", () => {
  const client = createTerminalClient("s1");
  MockWebSocket.instance!.open();
  client.close();

  expect(MockWebSocket.instance!.readyState).toBe(3); // CLOSED
});

// ─── onClose ─────────────────────────────────────────────────────────────────

test("server {t:'exit'} fires onClose('exit')", () => {
  const client = createTerminalClient("s1");
  const reasons: string[] = [];
  client.onClose((reason) => reasons.push(reason));

  MockWebSocket.instance!.open();
  MockWebSocket.instance!.fireMessage({ t: "exit" });

  expect(reasons).toEqual(["exit"]);
});

test("socket error fires onClose('error')", () => {
  const client = createTerminalClient("s1");
  const reasons: string[] = [];
  client.onClose((reason) => reasons.push(reason));

  MockWebSocket.instance!.open();
  MockWebSocket.instance!.fireError();

  expect(reasons).toEqual(["error"]);
});

test("an unprompted clean close fires onClose('closed')", () => {
  const client = createTerminalClient("s1");
  const reasons: string[] = [];
  client.onClose((reason) => reasons.push(reason));

  MockWebSocket.instance!.open();
  // Server/network drops the socket without a {t:"exit"} message and without
  // the client having called close() itself.
  MockWebSocket.instance!.onclose?.(new CloseEvent("close"));

  expect(reasons).toEqual(["closed"]);
});

test("close() then the resulting socket close does not double-fire onClose", () => {
  const client = createTerminalClient("s1");
  const reasons: string[] = [];
  client.onClose((reason) => reasons.push(reason));

  MockWebSocket.instance!.open();
  client.close(); // mock synchronously invokes ws.onclose, as a real close would (async)

  expect(reasons).toEqual([]);
});

test("{t:'exit'} then the resulting ws.close() does not double-fire onClose", () => {
  const client = createTerminalClient("s1");
  const reasons: string[] = [];
  client.onClose((reason) => reasons.push(reason));

  MockWebSocket.instance!.open();
  MockWebSocket.instance!.fireMessage({ t: "exit" }); // client reacts by closing the socket

  expect(reasons).toEqual(["exit"]);
});

// ─── Under the organization plane (P3 Task 15) ───────────────────────────────

test("a token rides the socket URL as ?token= (WebSocket cannot send headers)", () => {
  createTerminalClient("st_1", "at1");
  expect(MockWebSocket.instance!.url).toMatch(/\/api\/stations\/st_1\/terminal\?token=at1$/);
});

test("with a pending token, nothing is dialled until it arrives; early input is not lost", async () => {
  let resolve!: (t: string | null) => void;
  const pending = new Promise<string | null>((r) => (resolve = r));
  const c = createTerminalClient("st_1", pending);
  c.send("ls\n");
  c.resize(80, 24);
  expect(MockWebSocket.instance).toBeNull();
  resolve("at1");
  await pending;
  await Promise.resolve();
  const ws = MockWebSocket.instance!;
  expect(ws.url).toMatch(/\?token=at1$/);
  ws.open();
  expect(ws.sent.map((m) => JSON.parse(m).t)).toEqual(["input", "resize"]);
});

test("closed before its token arrives, it never dials and never reports a close", async () => {
  let resolve!: (t: string | null) => void;
  const pending = new Promise<string | null>((r) => (resolve = r));
  const c = createTerminalClient("st_1", pending);
  const onClose = vi.fn();
  c.onClose(onClose);
  c.close();
  resolve("at1");
  await pending;
  await Promise.resolve();
  expect(MockWebSocket.instance).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

/**
 * Review Focus 5: a console tab left open until its 5-minute token is nearly (or fully) spent,
 * then a terminal opened. The console must refresh first, so the socket carries a token that
 * outlives the upgrade — not one that dies on the wire.
 */
test("opens the terminal socket with a token fresh enough to last", async () => {
  const PLANE = { issuer: "https://accounts.test", url: "https://accounts.test", audience: "https://hub.test" };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(1_000_000);
    clearAuthSession();
    setPlane(PLANE);
    let went = "";
    await beginSignIn(PLANE, { returnTo: "/", origin: "https://console.test", navigate: (u) => (went = u) });
    const state = new URL(went).searchParams.get("state")!;
    await completeSignIn(new URLSearchParams({ code: "c", state }), PLANE, {
      origin: "https://console.test",
      fetchFn: (async () => json({ access_token: "at-stale", expires_in: 300, refresh_token: "rt1" })) as never,
    });

    // 250 s later: 50 s of life left. Enough for an ordinary fetch (30 s floor), not for a socket.
    vi.setSystemTime(1_000_000 + 250_000);
    const refresh = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ access_token: "at-fresh", expires_in: 300, refresh_token: "rt2" }));
    createTerminalClient("st_1", socketToken());
    await vi.waitFor(() => expect(MockWebSocket.instance).toBeTruthy());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instance!.url).toBe("ws://hub.test:3001/api/stations/st_1/terminal?token=at-fresh");

    // Left open past the token's whole life: refreshed again, never the dead one.
    MockWebSocket.instance = null;
    vi.setSystemTime(1_000_000 + 250_000 + 400_000);
    refresh.mockResolvedValue(json({ access_token: "at-fresher", expires_in: 300, refresh_token: "rt3" }));
    createTerminalClient("st_1", socketToken());
    await vi.waitFor(() => expect(MockWebSocket.instance).toBeTruthy());
    expect(MockWebSocket.instance!.url).toMatch(/\?token=at-fresher$/);
  } finally {
    vi.useRealTimers();
    signOutLocal();
    clearAuthSession();
  }
});

test("legacy mode: the socket URL carries no token", () => {
  clearAuthSession();
  createTerminalClient("st_1", socketToken());
  expect(MockWebSocket.instance!.url).toBe("ws://hub.test:3001/api/stations/st_1/terminal");
});
