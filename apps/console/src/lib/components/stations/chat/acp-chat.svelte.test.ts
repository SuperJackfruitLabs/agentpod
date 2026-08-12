/**
 * acp-chat.svelte.test.ts
 *
 * Unit tests for the AcpChat session controller — the stateful orchestrator
 * between the ACP api client (REST + WS) and the pure transcript projection.
 * Uses a mocked globalThis.WebSocket (the real createAcpSocket runs against
 * it) plus vi.spyOn on the api module's REST helpers, so no network is
 * touched.
 *
 * Run: cd apps/console && pnpm test src/lib/components/stations/chat/acp-chat
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import type { AcpEvent, AcpSessionRow } from "@agentpod/contract";
import * as api from "$lib/api/acp";
import { AcpChat, ECHO_DEADLINE_MS, _setEchoDeadlineMsForTest } from "./acp-chat.svelte";

// ─── Minimal WebSocket stub ───────────────────────────────────────────────────

class MockWebSocket {
  /** Every socket constructed since the last reset, in creation order. */
  static instances: MockWebSocket[] = [];
  static latest(): MockWebSocket | null {
    return MockWebSocket.instances.at(-1) ?? null;
  }

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
    MockWebSocket.instances.push(this);
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

  /** Test helper: the server/network drops the socket (client never called close). */
  drop() {
    this.readyState = 3; // CLOSED
    this.onclose?.(new CloseEvent("close"));
  }

  /** Test helper: parsed frames sent so far. */
  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
  MockWebSocket.instances = [];
  localStorage.setItem("agentpod.apiUrl", "http://hub.test:3001");
  (globalThis as unknown as Record<string, unknown>).WebSocket = MockWebSocket;
  // Default stub for the session-list refresh the controller fires after a
  // create/end (`sessions` feeds the header's switcher). Tests that care
  // re-spy with their own rows; without this default the background refresh in
  // a create-only test would reach the real http client.
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  _setEchoDeadlineMsForTest(ECHO_DEADLINE_MS); // module-level hook: never leak an override
  MockWebSocket.instances = [];
  localStorage.clear();
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function row(over: Partial<AcpSessionRow> = {}): AcpSessionRow {
  return {
    id: "s1",
    stationId: "st1",
    userId: "u1",
    mode: "ask",
    status: "idle",
    endedReason: null,
    createdAt: "2026-08-09T00:00:00.000Z",
    lastEventAt: "2026-08-09T00:00:00.000Z",
    ...over,
  };
}

function ev(seq: number, type: AcpEvent["type"], payload: unknown): AcpEvent {
  return { sessionId: "s1", seq, type, payload, createdAt: "2026-08-09T00:00:01.000Z" };
}

const chunk = (seq: number, text: string) =>
  ev(seq, "agent-update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

/** Boots a chat attached to an existing idle session and drives it to connected. */
async function connectedChat(): Promise<{ chat: AcpChat; ws: MockWebSocket }> {
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row()]);
  const chat = new AcpChat("st1");
  await chat.init();
  const ws = MockWebSocket.latest()!;
  ws.open();
  ws.fireMessage({ t: "session", session: row() });
  ws.fireMessage({ t: "replay-done", lastSeq: 0 });
  return { chat, ws };
}

// ─── (a) init: attach + replay ───────────────────────────────────────────────

test("init attaches to the newest non-ended session and replays to connected", async () => {
  const ended = row({ id: "s0", status: "ended", createdAt: "2026-08-08T00:00:00.000Z" });
  const active = row({ id: "s1", mode: "accept-edits", createdAt: "2026-08-09T00:00:00.000Z" });
  // The hub returns newest-ACTIVITY-first from SQL; the controller keeps that
  // order and attaches the first non-ended row.
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([active, ended]);

  const chat = new AcpChat("st1");
  await chat.init();

  expect(api.listAcpSessions).toHaveBeenCalledWith("st1", { limit: 100 });
  const ws = MockWebSocket.latest();
  expect(ws).toBeTruthy();
  expect(ws!.url).toContain("/api/acp/sessions/s1/ws");
  expect(chat.connection).toBe("connecting");

  ws!.open();
  expect(ws!.frames()).toEqual([{ t: "subscribe", sinceSeq: 0 }]);

  ws!.fireMessage({ t: "session", session: active });
  ws!.fireMessage({ t: "event", event: ev(1, "user-prompt", { text: "hi" }) });
  ws!.fireMessage({ t: "event", event: chunk(2, "hello") });
  expect(chat.connection).toBe("connecting"); // not connected until replay-done
  ws!.fireMessage({ t: "replay-done", lastSeq: 2 });

  expect(chat.connection).toBe("connected");
  expect(chat.session?.id).toBe("s1");
  expect(chat.mode).toBe("accept-edits"); // synced from the session row
  expect(chat.transcript.lastSeq).toBe(2);
  expect(chat.transcript.items.map((it) => it.kind)).toEqual(["user", "assistant"]);
});

test("init attaches a live session that sits past the hub's default page", async () => {
  // Regression: the hub's session list is paginated (default 20). A station where
  // an idle live session was left running while a dozen short-lived ones were
  // created and ended has it far down the ACTIVITY order — on the default page it
  // isn't in the response at all, so `init` found no live row and the panel
  // opened on "No session" with an empty transcript while the agent was running.
  const rows = [
    ...Array.from({ length: 21 }, (_, i) =>
      row({ id: `dead${i}`, status: "ended", lastEventAt: `2026-08-09T10:${String(i).padStart(2, "0")}:00.000Z` }),
    ),
    row({ id: "alive", status: "idle", lastEventAt: "2026-08-01T00:00:00.000Z" }),
  ];
  const list = vi.spyOn(api, "listAcpSessions").mockResolvedValue(rows);

  const chat = new AcpChat("st1");
  await chat.init();

  // Asking for the deepest page is what makes the 22nd row visible at all.
  expect(list).toHaveBeenCalledWith("st1", { limit: 100 });
  expect(chat.session?.id).toBe("alive");
  expect(MockWebSocket.latest()!.url).toContain("/api/acp/sessions/alive/ws");
});

// ─── (b) init: only ended sessions → idle, no socket ─────────────────────────

test("init with only ended sessions stays idle without opening a socket", async () => {
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row({ status: "ended" })]);

  const chat = new AcpChat("st1");
  await chat.init();

  expect(MockWebSocket.instances).toHaveLength(0);
  expect(chat.session).toBeNull();
  expect(chat.connection).toBe("idle");
});

test("init surfaces the api error when listing sessions fails", async () => {
  vi.spyOn(api, "listAcpSessions").mockRejectedValue(
    new Error("Couldn't reach the hub — check your connection."),
  );

  const chat = new AcpChat("st1");
  await chat.init();

  expect(chat.error).toBe("Couldn't reach the hub — check your connection.");
  expect(chat.connection).toBe("idle");
  expect(MockWebSocket.instances).toHaveLength(0);
});

// ─── (c) prompt with no session: create → subscribe → prompt ─────────────────

test("prompt with no session creates one, subscribes, sends, and reconciles the echo", async () => {
  vi.spyOn(api, "createAcpSession").mockResolvedValue(row());

  const chat = new AcpChat("st1");
  await chat.prompt("hello");

  expect(api.createAcpSession).toHaveBeenCalledWith("st1", "ask");
  const ws = MockWebSocket.latest()!;
  expect(ws.url).toContain("/api/acp/sessions/s1/ws");

  // Optimistic item visible immediately.
  expect(chat.transcript.items).toEqual([
    { kind: "user", seq: -1, text: "hello", pending: true },
  ]);

  ws.open(); // buffered frames flush in order: subscribe first, then prompt
  expect(ws.frames()).toEqual([
    { t: "subscribe", sinceSeq: 0 },
    { t: "prompt", text: "hello" },
  ]);

  // The echoed user-prompt event replaces the optimistic item.
  ws.fireMessage({ t: "event", event: ev(1, "user-prompt", { text: "hello" }) });
  expect(chat.transcript.items).toEqual([{ kind: "user", seq: 1, text: "hello" }]);
});

test("prompt surfaces the create failure message and keeps no session", async () => {
  vi.spyOn(api, "createAcpSession").mockRejectedValue(
    new Error("That station's node is offline."),
  );

  const chat = new AcpChat("st1");
  await chat.prompt("hello");

  expect(chat.error).toBe("That station's node is offline.");
  expect(chat.session).toBeNull();
  expect(MockWebSocket.instances).toHaveLength(0);
  expect(chat.transcript.items).toEqual([]); // no optimistic item for a failed create
});

// ─── prompt: double-submission guard ─────────────────────────────────────────

test("concurrent prompts with no session issue exactly one create", async () => {
  const createSpy = vi.spyOn(api, "createAcpSession").mockResolvedValue(row());

  const chat = new AcpChat("st1");
  const first = chat.prompt("one");
  const second = chat.prompt("two"); // refused: create in flight
  await Promise.all([first, second]);

  expect(createSpy).toHaveBeenCalledTimes(1);
  expect(MockWebSocket.instances).toHaveLength(1);
  const ws = MockWebSocket.latest()!;
  ws.open();
  expect(ws.frames()).toEqual([
    { t: "subscribe", sinceSeq: 0 },
    { t: "prompt", text: "one" },
  ]);
  expect(chat.transcript.items).toEqual([
    { kind: "user", seq: -1, text: "one", pending: true },
  ]);
});

test("prompt while an optimistic prompt is still pending is a no-op", async () => {
  const { chat, ws } = await connectedChat();
  await chat.prompt("first");
  const framesBefore = ws.sent.length;

  await chat.prompt("second"); // refused: pending echo outstanding

  expect(ws.sent).toHaveLength(framesBefore);
  expect(chat.transcript.items).toEqual([
    { kind: "user", seq: -1, text: "first", pending: true },
  ]);
});

test("prompt while the agent is working is a no-op", async () => {
  const { chat, ws } = await connectedChat();
  ws.fireMessage({ t: "event", event: ev(1, "user-prompt", { text: "go" }) });
  ws.fireMessage({ t: "event", event: ev(2, "state", { status: "working" }) });
  const framesBefore = ws.sent.length;

  await chat.prompt("more"); // refused: one turn at a time

  expect(ws.sent).toHaveLength(framesBefore);
  expect(chat.transcript.items.filter((it) => it.kind === "user")).toHaveLength(1);
});

test("busy mirrors every refusal window the composer must respect", async () => {
  // (1) create in flight — the POST is deliberately left unresolved.
  let resolveCreate: (r: AcpSessionRow) => void = () => {};
  vi.spyOn(api, "createAcpSession").mockReturnValue(
    new Promise<AcpSessionRow>((res) => {
      resolveCreate = res;
    }),
  );

  const fresh = new AcpChat("st1");
  expect(fresh.busy).toBe(false); // idle, no session
  const inFlight = fresh.prompt("hello");
  expect(fresh.busy).toBe(true);
  resolveCreate(row());
  await inFlight;

  // (2) replay in flight — the transcript, and so the status, isn't trustworthy.
  expect(fresh.replaying).toBe(true);
  expect(fresh.busy).toBe(true);
  MockWebSocket.latest()!.fireMessage({ t: "replay-done", lastSeq: 0 });
  expect(fresh.replaying).toBe(false);

  // (3) optimistic prompt awaiting its echo.
  expect(fresh.busy).toBe(true);
  MockWebSocket.latest()!.fireMessage({
    t: "event",
    event: ev(1, "user-prompt", { text: "hello" }),
  });
  expect(fresh.busy).toBe(false);

  // (4) agent working.
  MockWebSocket.latest()!.fireMessage({ t: "event", event: ev(2, "state", { status: "working" }) });
  expect(fresh.busy).toBe(true);
  MockWebSocket.latest()!.fireMessage({ t: "event", event: ev(3, "state", { status: "idle" }) });
  expect(fresh.busy).toBe(false);
});

test("status and busy follow the session row until the stream speaks", async () => {
  // Reattaching to a session the hub says is WORKING: the transcript has no
  // state event yet, so only the row knows — and the composer must not offer to
  // send into a turn the hub would reject.
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row({ status: "working" })]);
  const chat = new AcpChat("st1");
  await chat.init();

  expect(chat.status).toBe("working");
  expect(chat.working).toBe(true);
  expect(chat.busy).toBe(true);

  const ws = MockWebSocket.latest()!;
  ws.open();
  ws.fireMessage({ t: "replay-done", lastSeq: 0 });
  // Still working per the row; the stream hasn't contradicted it.
  expect(chat.busy).toBe(true);

  ws.fireMessage({ t: "event", event: ev(1, "state", { status: "idle" }) });
  expect(chat.status).toBe("idle");
  expect(chat.busy).toBe(false);
});

test("prompt after destroy dials nothing", async () => {
  vi.spyOn(api, "createAcpSession").mockResolvedValue(row());
  const { chat, ws } = await connectedChat();
  chat.destroy();
  const count = MockWebSocket.instances.length;

  await chat.prompt("late");

  expect(MockWebSocket.instances).toHaveLength(count); // no redial
  expect(api.createAcpSession).not.toHaveBeenCalled();
  expect(ws.sent.filter((s) => (JSON.parse(s) as { t: string }).t === "prompt")).toHaveLength(0);
});

// ─── (d) reconnect budget ────────────────────────────────────────────────────

test("unexpected close reconnects and re-subscribes with sinceSeq = lastSeq", async () => {
  vi.useFakeTimers();
  const { chat, ws } = await connectedChat();
  ws.fireMessage({ t: "event", event: ev(1, "user-prompt", { text: "hi" }) });
  ws.fireMessage({ t: "event", event: chunk(2, "yo") });
  expect(chat.transcript.lastSeq).toBe(2);

  ws.drop();
  expect(chat.connection).toBe("reconnecting");
  expect(MockWebSocket.instances).toHaveLength(1); // backoff pending, not yet redialed

  vi.advanceTimersByTime(1000);
  const ws2 = MockWebSocket.latest()!;
  expect(ws2).not.toBe(ws);
  ws2.open();
  expect(ws2.frames()).toEqual([{ t: "subscribe", sinceSeq: 2 }]);

  ws2.fireMessage({ t: "replay-done", lastSeq: 2 });
  expect(chat.connection).toBe("connected");
});

test("three failed reconnects exhaust the budget; retry() resets it", async () => {
  vi.useFakeTimers();
  const { chat, ws } = await connectedChat();

  ws.drop();
  vi.advanceTimersByTime(1000);
  MockWebSocket.latest()!.drop();
  vi.advanceTimersByTime(2000);
  MockWebSocket.latest()!.drop();
  vi.advanceTimersByTime(4000);
  MockWebSocket.latest()!.drop();

  expect(chat.connection).toBe("disconnected");
  expect(chat.error).toBe("Couldn't reach the hub — check your connection.");
  const count = MockWebSocket.instances.length;
  vi.advanceTimersByTime(60_000);
  expect(MockWebSocket.instances).toHaveLength(count); // budget spent — no more dials

  chat.retry();
  const ws5 = MockWebSocket.latest()!;
  expect(MockWebSocket.instances).toHaveLength(count + 1);
  ws5.open();
  ws5.fireMessage({ t: "replay-done", lastSeq: 0 });
  expect(chat.connection).toBe("connected");
  expect(chat.error).toBeNull();

  // The budget was reset: a fresh drop goes back to reconnecting, not disconnected.
  ws5.drop();
  expect(chat.connection).toBe("reconnecting");
});

// ─── (e) bye → session over, no reconnect ────────────────────────────────────

test("bye ends the session: ended notice, idle connection, no reconnect", async () => {
  vi.useFakeTimers();
  const { chat, ws } = await connectedChat();

  ws.fireMessage({ t: "bye", reason: "agent exited" });

  expect(chat.transcript.status).toBe("ended");
  const last = chat.transcript.items.at(-1);
  expect(last).toMatchObject({ kind: "notice", level: "info" });
  expect((last as { text: string }).text).toContain("Session ended");
  expect(chat.connection).toBe("idle");

  // The socket close that follows a bye is expected — never a reconnect.
  vi.advanceTimersByTime(60_000);
  expect(MockWebSocket.instances).toHaveLength(1);
});

test("bye after an ended state event does not duplicate the ended notice", async () => {
  const { chat, ws } = await connectedChat();

  ws.fireMessage({ t: "event", event: ev(3, "state", { status: "ended", reason: "done" }) });
  ws.fireMessage({ t: "bye", reason: "ended" });

  const notices = chat.transcript.items.filter((it) => it.kind === "notice");
  expect(notices).toHaveLength(1);
  expect(chat.connection).toBe("idle");
});

// ─── (f) answer ──────────────────────────────────────────────────────────────

test("answer sends the permission-answer frame with the chosen optionId", async () => {
  const { ws, chat } = await connectedChat();
  const before = ws.sent.length;

  chat.answer(5, "allow");
  chat.answer(6, "reject");

  expect(ws.frames().slice(before)).toEqual([
    { t: "permission-answer", requestSeq: 5, optionId: "allow" },
    { t: "permission-answer", requestSeq: 6, optionId: "reject" },
  ]);
});

// ─── (g) destroy: close only — hub-owned session, never DELETE ───────────────

test("destroy closes the socket without DELETE and never reconnects", async () => {
  vi.useFakeTimers();
  const endSpy = vi.spyOn(api, "endAcpSession");
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const { chat, ws } = await connectedChat();

  chat.destroy();

  expect(ws.readyState).toBe(3); // CLOSED
  expect(endSpy).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled(); // no DELETE (or any request) fired
  vi.advanceTimersByTime(60_000);
  expect(MockWebSocket.instances).toHaveLength(1);
  vi.unstubAllGlobals();
});

// ─── (h) end: DELETE; ended state arrives via events ─────────────────────────

test("end() DELETEs via the api; the ended state arrives via events, not locally", async () => {
  const endSpy = vi.spyOn(api, "endAcpSession").mockResolvedValue(undefined);
  const { chat, ws } = await connectedChat();

  await chat.end();

  expect(endSpy).toHaveBeenCalledWith("s1");
  expect(chat.transcript.status).not.toBe("ended"); // not forced locally
  expect(chat.session).not.toBeNull();

  ws.fireMessage({ t: "event", event: ev(3, "state", { status: "ended", reason: "ended by user" }) });
  ws.fireMessage({ t: "bye", reason: "ended" });

  expect(chat.transcript.status).toBe("ended");
  expect(chat.connection).toBe("idle");
});

// ─── Synthetic seq-0 error events ────────────────────────────────────────────

test("a rejected prompt releases the pending item and hands its text back", async () => {
  const failed: string[] = [];
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row()]);
  const chat = new AcpChat("st1", { onPromptFailed: (text) => failed.push(text) });
  await chat.init();
  const ws = MockWebSocket.latest()!;
  ws.open();
  ws.fireMessage({ t: "replay-done", lastSeq: 0 });

  await chat.prompt("do it");
  expect(chat.transcript.items.at(-1)).toMatchObject({ kind: "user", pending: true });
  expect(chat.busy).toBe(true);

  // The hub refuses the turn ("Session is busy — wait for the current turn…").
  ws.fireMessage({ t: "event", event: ev(0, "error", { message: "Session is busy." }) });

  // No ghost bubble, no notice folded between prompt and echo, composer usable.
  expect(chat.transcript.items).toEqual([]);
  expect(chat.busy).toBe(false);
  expect(chat.error).toBe("Session is busy.");
  expect(failed).toEqual(["do it"]);

  // And the session is still usable: the next prompt goes out normally.
  await chat.prompt("again");
  expect(ws.frames()).toContainEqual({ t: "prompt", text: "again" });
});

test("an exhausted reconnect budget releases a pending prompt instead of wedging", async () => {
  vi.useFakeTimers();
  const failed: string[] = [];
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row()]);
  const chat = new AcpChat("st1", { onPromptFailed: (text) => failed.push(text) });
  await chat.init();
  MockWebSocket.latest()!.open();
  MockWebSocket.latest()!.fireMessage({ t: "replay-done", lastSeq: 0 });
  await chat.prompt("lost in transit");
  expect(chat.busy).toBe(true);

  MockWebSocket.latest()!.drop();
  vi.advanceTimersByTime(1000);
  MockWebSocket.latest()!.drop();
  vi.advanceTimersByTime(2000);
  MockWebSocket.latest()!.drop();
  vi.advanceTimersByTime(4000);
  MockWebSocket.latest()!.drop();

  expect(chat.connection).toBe("disconnected");
  expect(chat.transcript.items).toEqual([]); // the echo will never arrive
  expect(chat.busy).toBe(false);
  expect(failed).toEqual(["lost in transit"]);
  expect(chat.error).toBe("Couldn't reach the hub — check your connection.");
});

test("a reconnect that succeeds without the echo releases the prompt (blip mid-send)", async () => {
  vi.useFakeTimers();
  const failed: string[] = [];
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row()]);
  const chat = new AcpChat("st1", { onPromptFailed: (text) => failed.push(text) });
  await chat.init();
  const ws1 = MockWebSocket.latest()!;
  ws1.open();
  ws1.fireMessage({ t: "replay-done", lastSeq: 0 });
  await chat.prompt("did the hub see this?");
  expect(chat.busy).toBe(true);

  // One drop; the FIRST reconnect succeeds and replays — and the replay carries
  // no echo, which is the hub telling us it never saw the prompt.
  ws1.drop();
  vi.advanceTimersByTime(1000);
  const ws2 = MockWebSocket.latest()!;
  expect(ws2).not.toBe(ws1);
  ws2.open();
  ws2.fireMessage({ t: "replay-done", lastSeq: 0 });

  expect(chat.connection).toBe("connected");
  expect(chat.transcript.items).toEqual([]); // no ghost bubble
  expect(chat.busy).toBe(false);
  expect(failed).toEqual(["did the hub see this?"]);
  expect(chat.error).toBe("Couldn't send that message — it's back in the box, try again.");
});

test("replay-done on the socket the prompt was sent on does NOT release it", async () => {
  // A fresh session answers subscribe before it has finished handling the prompt
  // flushed right behind it — releasing there would kill a prompt in flight.
  const failed: string[] = [];
  vi.spyOn(api, "createAcpSession").mockResolvedValue(row());
  const chat = new AcpChat("st1", { onPromptFailed: (text) => failed.push(text) });
  await chat.prompt("hello");
  const ws = MockWebSocket.latest()!;
  ws.open();

  ws.fireMessage({ t: "replay-done", lastSeq: 0 });

  expect(chat.transcript.items).toEqual([
    { kind: "user", seq: -1, text: "hello", pending: true },
  ]);
  expect(failed).toEqual([]);
  expect(chat.error).toBeNull();

  // …and the echo that follows reconciles it as usual.
  ws.fireMessage({ t: "event", event: ev(1, "user-prompt", { text: "hello" }) });
  expect(chat.transcript.items).toEqual([{ kind: "user", seq: 1, text: "hello" }]);
  expect(chat.busy).toBe(false);
});

test("an error for a different client frame never steals the pending prompt", async () => {
  // The hub's error frame is the catch-all for cancel/permission-answer/set-mode
  // too, so position alone must not decide whose failure it is — restoring the
  // draft here would invite a duplicate send while the real prompt is in flight.
  const failed: string[] = [];
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row()]);
  const chat = new AcpChat("st1", { onPromptFailed: (text) => failed.push(text) });
  await chat.init();
  const ws = MockWebSocket.latest()!;
  ws.open();
  ws.fireMessage({ t: "replay-done", lastSeq: 0 });
  await chat.prompt("real prompt");

  chat.answer(7, "allow"); // whatever the error turns out to be, it's this frame's
  ws.fireMessage({
    t: "event",
    event: ev(0, "error", { message: "No pending permission request." }),
  });

  expect(chat.transcript.items).toEqual([
    { kind: "user", seq: -1, text: "real prompt", pending: true },
  ]);
  expect(failed).toEqual([]);
  expect(chat.error).toBe("No pending permission request.");

  // The prompt resolves the normal way when its echo lands.
  ws.fireMessage({ t: "event", event: ev(1, "user-prompt", { text: "real prompt" }) });
  expect(chat.transcript.items).toEqual([{ kind: "user", seq: 1, text: "real prompt" }]);
});

test("an ending session releases a pending prompt instead of keeping a phantom", async () => {
  const failed: string[] = [];
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row()]);
  const chat = new AcpChat("st1", { onPromptFailed: (text) => failed.push(text) });
  await chat.init();
  const ws = MockWebSocket.latest()!;
  ws.open();
  ws.fireMessage({ t: "replay-done", lastSeq: 0 });
  await chat.prompt("too late");

  ws.fireMessage({ t: "event", event: ev(1, "state", { status: "ended", reason: "stopped" }) });

  expect(chat.transcript.status).toBe("ended");
  expect(chat.transcript.items).toEqual([
    { kind: "notice", seq: 1, level: "info", text: "Session ended — stopped" },
  ]);
  expect(failed).toEqual(["too late"]);
  expect(chat.busy).toBe(false);
});

test("bye with a pending prompt leaves no phantom message either", async () => {
  const failed: string[] = [];
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row()]);
  const chat = new AcpChat("st1", { onPromptFailed: (text) => failed.push(text) });
  await chat.init();
  const ws = MockWebSocket.latest()!;
  ws.open();
  ws.fireMessage({ t: "replay-done", lastSeq: 0 });
  await chat.prompt("never sent");

  ws.fireMessage({ t: "bye", reason: "ended" });

  expect(failed).toEqual(["never sent"]);
  expect(chat.transcript.items.filter((it) => it.kind === "user")).toEqual([]);
  expect(chat.transcript.status).toBe("ended");
  expect(chat.busy).toBe(false);
});

test("seq-0 error with no live turn goes to error only — never both surfaces", async () => {
  const { chat, ws } = await connectedChat();

  ws.fireMessage({ t: "event", event: ev(0, "error", { message: "Prompt failed." }) });

  // The strip owns it: duplicating the sentence as a transcript notice too made
  // screen readers and eyes read the same failure twice.
  expect(chat.transcript.items).toEqual([]);
  expect(chat.transcript.lastSeq).toBe(0);
  expect(chat.error).toBe("Prompt failed.");
});

test("seq-0 error during a live turn folds a notice without setting error", async () => {
  const { chat, ws } = await connectedChat();
  ws.fireMessage({ t: "event", event: ev(1, "user-prompt", { text: "go" }) });
  ws.fireMessage({ t: "event", event: ev(2, "state", { status: "working" }) });
  expect(chat.working).toBe(true);

  ws.fireMessage({ t: "event", event: ev(0, "error", { message: "Tool hiccup." }) });

  expect(chat.transcript.items.at(-1)).toMatchObject({ kind: "notice", text: "Tool hiccup." });
  expect(chat.error).toBeNull();
});

// ─── Small surface: cancel / setMode / derived getters ───────────────────────

test("cancel sends {t:'cancel'}; setMode sends set-mode and updates locally", async () => {
  const { chat, ws } = await connectedChat();
  const before = ws.sent.length;

  chat.cancel();
  chat.setMode("full-auto");

  expect(chat.mode).toBe("full-auto");
  expect(ws.frames().slice(before)).toEqual([
    { t: "cancel" },
    { t: "set-mode", mode: "full-auto" },
  ]);
});

test("pendingPermissions counts unanswered permission items", async () => {
  const { chat, ws } = await connectedChat();

  ws.fireMessage({
    t: "event",
    event: ev(1, "permission-request", {
      toolCall: { title: "Edit file" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    }),
  });
  expect(chat.pendingPermissions).toBe(1);

  ws.fireMessage({
    t: "event",
    event: ev(2, "permission-answer", { requestSeq: 1, optionId: "allow" }),
  });
  expect(chat.pendingPermissions).toBe(0);
});

// ─── Session preamble: agent output that precedes the first prompt ───────────

test("pre-prompt agent output is exposed as preamble and kept out of the conversation", async () => {
  const { chat, ws } = await connectedChat();

  // The harness banner arrives as an agent message before anyone has spoken.
  ws.fireMessage({ t: "event", event: chunk(1, "pi v0.84.1\n\nSkills\n\n/s/basecamp/SKILL.md") });

  expect(chat.preamble?.summary).toBe("pi v0.84.1");
  expect(chat.preamble?.text).toContain("/s/basecamp/SKILL.md");
  expect(chat.conversation).toEqual([]);

  // A real turn: the reply is conversation, and the preamble stays put.
  ws.fireMessage({ t: "event", event: ev(2, "user-prompt", { text: "hi" }) });
  ws.fireMessage({ t: "event", event: chunk(3, "hello") });

  expect(chat.preamble?.summary).toBe("pi v0.84.1");
  expect(chat.conversation.map((it) => it.kind)).toEqual(["user", "assistant"]);
});

test("a replayed history splits the same way — preamble is positional, not remembered", async () => {
  // Reattaching replays the persisted stream from seq 0, so the banner is just
  // whatever precedes the first user-prompt event. Same rule, no extra state.
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row(), row({ id: "s2" })]);
  const chat = new AcpChat("st1");
  await chat.init();
  const ws = MockWebSocket.latest()!;
  ws.open();
  for (const event of [
    chunk(1, "pi v0.84.1\nSkills"),
    ev(2, "user-prompt", { text: "hi" }),
    chunk(3, "hello"),
  ]) {
    ws.fireMessage({ t: "event", event });
  }
  ws.fireMessage({ t: "replay-done", lastSeq: 3 });

  expect(chat.preamble).toEqual({ text: "pi v0.84.1\nSkills", summary: "pi v0.84.1", more: 1 });
  expect(chat.conversation.map((it) => it.kind)).toEqual(["user", "assistant"]);
});

test("no pre-prompt output → no preamble, and switching sessions drops the old one", async () => {
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row(), row({ id: "s2" })]);
  const chat = new AcpChat("st1");
  await chat.init();
  const ws = MockWebSocket.latest()!;
  ws.open();
  ws.fireMessage({ t: "event", event: chunk(1, "pi v0.84.1") });
  expect(chat.preamble?.summary).toBe("pi v0.84.1");

  await chat.attach("s2");
  // A fresh transcript means a fresh preamble — never the previous session's.
  expect(chat.preamble).toBeNull();

  const ws2 = MockWebSocket.latest()!;
  ws2.open();
  ws2.fireMessage({ t: "event", event: ev(1, "user-prompt", { text: "hi" }) });
  ws2.fireMessage({ t: "event", event: chunk(2, "hello") });
  expect(chat.preamble).toBeNull();
  expect(chat.conversation).toHaveLength(2);
});

// ─── The dead socket: a send into a connection nothing has noticed is gone ───
//
// Live-dogfooding defect: after a laptop sleep the browser still held a socket
// it believed was OPEN (no close event ever fired). The prompt frame went into
// it, the hub never saw it, and because no close/error/reconnect/replay-done/bye
// followed, NO existing release path fired — the pending item stayed trailing,
// `busy` latched true, and the composer was read-only until a page reload.

/** Boots a connected chat that records every prompt handed back. */
async function chatWithFailures(): Promise<{
  chat: AcpChat;
  ws: MockWebSocket;
  failed: string[];
}> {
  const failed: string[] = [];
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row()]);
  const chat = new AcpChat("st1", { onPromptFailed: (text) => failed.push(text) });
  await chat.init();
  const ws = MockWebSocket.latest()!;
  ws.open();
  ws.fireMessage({ t: "replay-done", lastSeq: 0 });
  return { chat, ws, failed };
}

test("a prompt whose echo never arrives is released at the echo deadline", async () => {
  vi.useFakeTimers();
  const { chat, ws, failed } = await chatWithFailures();

  await chat.prompt("sent after the laptop woke");

  // The frame was written into a socket the browser still calls OPEN, so no
  // close, error, reconnect, replay-done or bye is ever coming.
  expect(ws.frames()).toContainEqual({ t: "prompt", text: "sent after the laptop woke" });
  expect(chat.transcript.items).toEqual([
    { kind: "user", seq: -1, text: "sent after the laptop woke", pending: true },
  ]);
  expect(chat.busy).toBe(true);

  vi.advanceTimersByTime(ECHO_DEADLINE_MS - 1);
  expect(chat.busy).toBe(true); // not a hair early — a slow link still wins

  vi.advanceTimersByTime(1);

  expect(chat.transcript.items).toEqual([]); // no ghost bubble
  expect(chat.busy).toBe(false); // composer usable again
  expect(failed).toEqual(["sent after the laptop woke"]); // text handed back
  expect(chat.error).toBe("Couldn't send that message — it's back in the box, try again.");

  // And the panel really is usable: the next prompt is accepted, not refused.
  await chat.prompt("again");
  expect(chat.transcript.items).toEqual([
    { kind: "user", seq: -1, text: "again", pending: true },
  ]);
});

test("an echoed prompt clears the echo deadline — nothing fires late", async () => {
  vi.useFakeTimers();
  const { chat, ws, failed } = await chatWithFailures();

  await chat.prompt("healthy");
  ws.fireMessage({ t: "event", event: ev(1, "user-prompt", { text: "healthy" }) });

  expect(vi.getTimerCount()).toBe(0); // no leaked deadline
  vi.advanceTimersByTime(ECHO_DEADLINE_MS * 3);

  expect(chat.transcript.items).toEqual([{ kind: "user", seq: 1, text: "healthy" }]);
  expect(failed).toEqual([]);
  expect(chat.error).toBeNull();
  expect(chat.busy).toBe(false);
});

test("an attributed error clears the echo deadline too", async () => {
  vi.useFakeTimers();
  const { chat, ws, failed } = await chatWithFailures();

  await chat.prompt("rejected");
  ws.fireMessage({ t: "event", event: ev(0, "error", { message: "Session is busy." }) });

  expect(failed).toEqual(["rejected"]);
  expect(chat.error).toBe("Session is busy.");
  expect(vi.getTimerCount()).toBe(0);

  // The deadline must not fire a second release and overwrite the real reason.
  vi.advanceTimersByTime(ECHO_DEADLINE_MS * 3);
  expect(failed).toEqual(["rejected"]);
  expect(chat.error).toBe("Session is busy.");
});

test("a prompt while the socket is not OPEN redials instead of writing into it", async () => {
  const { chat, ws, failed } = await chatWithFailures();
  // The cheap half of the bug: the browser HAS noticed (CLOSED) but no close
  // event was delivered to this tab, so `socket` is still non-null here.
  ws.readyState = 3;

  await chat.prompt("redial me");

  expect(MockWebSocket.instances).toHaveLength(2); // redialed, not written into
  const ws2 = MockWebSocket.latest()!;
  expect(ws2).not.toBe(ws);
  expect(ws.frames()).not.toContainEqual({ t: "prompt", text: "redial me" });

  ws2.open(); // buffered frames flush in order: subscribe still precedes the prompt
  expect(ws2.frames()).toEqual([
    { t: "subscribe", sinceSeq: 0 },
    { t: "prompt", text: "redial me" },
  ]);

  // Replay on the socket the prompt went out on proves nothing — the echo does.
  ws2.fireMessage({ t: "replay-done", lastSeq: 0 });
  expect(failed).toEqual([]);
  ws2.fireMessage({ t: "event", event: ev(1, "user-prompt", { text: "redial me" }) });
  expect(chat.transcript.items).toEqual([{ kind: "user", seq: 1, text: "redial me" }]);
  expect(chat.busy).toBe(false);
});

test("destroy() clears the echo deadline — no release after unmount", async () => {
  vi.useFakeTimers();
  _setEchoDeadlineMsForTest(500);
  const { chat, failed } = await chatWithFailures();
  await chat.prompt("in flight at unmount");

  chat.destroy();

  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(60_000);
  expect(failed).toEqual([]);
  expect(chat.error).toBeNull();
});

test("newSession() clears the echo deadline", async () => {
  vi.useFakeTimers();
  _setEchoDeadlineMsForTest(500);
  vi.spyOn(api, "createAcpSession").mockResolvedValue(row({ id: "s2" }));
  const { chat, failed } = await chatWithFailures();
  await chat.prompt("abandoned");

  await chat.newSession();

  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(60_000);
  expect(chat.transcript.items).toEqual([]);
  expect(failed).toEqual([]);
  expect(chat.error).toBeNull();
});

test("newSession creates a session and attaches it (no local-reset-only)", async () => {
  const { chat, ws } = await connectedChat();
  ws.fireMessage({ t: "event", event: ev(1, "user-prompt", { text: "hi" }) });
  ws.fireMessage({ t: "bye", reason: "ended" });
  const created = row({ id: "s2", lastEventAt: "2026-08-09T02:00:00.000Z" });
  vi.spyOn(api, "createAcpSession").mockResolvedValue(created);
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([created, row()]);

  await chat.newSession();

  expect(api.createAcpSession).toHaveBeenCalledWith("st1", "ask");
  expect(chat.session?.id).toBe("s2");
  expect(chat.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
  expect(chat.transcript.items).toEqual([]);
  expect(chat.transcript.lastSeq).toBe(0);
  expect(chat.connection).toBe("connecting");
  expect(chat.error).toBeNull();

  const ws2 = MockWebSocket.latest()!;
  expect(ws2).not.toBe(ws);
  expect(ws2.url).toContain("/api/acp/sessions/s2/ws");
  ws2.open();
  expect(ws2.frames()).toEqual([{ t: "subscribe", sinceSeq: 0 }]);
});

test("newSession surfaces a failed create and keeps the current session attached", async () => {
  const { chat, ws } = await connectedChat();
  vi.spyOn(api, "createAcpSession").mockRejectedValue(new Error("That station's node is offline."));

  await chat.newSession();

  expect(chat.error).toBe("That station's node is offline.");
  expect(chat.session?.id).toBe("s1");
  expect(ws.readyState).toBe(1); // the live socket is untouched by a failed create
  expect(MockWebSocket.instances).toHaveLength(1);
  expect(chat.busy).toBe(false); // the create window closed
});

test("concurrent newSession calls issue exactly one create", async () => {
  const { chat } = await connectedChat();
  const createSpy = vi.spyOn(api, "createAcpSession").mockResolvedValue(row({ id: "s2" }));

  await Promise.all([chat.newSession(), chat.newSession()]);

  expect(createSpy).toHaveBeenCalledTimes(1);
});

// ─── Several sessions per station: list + attach (hub-owned, never DELETE) ────

test("init keeps the hub's order and attaches the first live session", async () => {
  // The hub orders newest-ACTIVITY-first in SQL (lastEventAt desc, id desc).
  // Re-sorting by createdAt here would bury a session that just streamed under
  // one that has been idle since the moment it was created.
  const busyOld = row({
    id: "old",
    createdAt: "2026-08-01T00:00:00.000Z",
    lastEventAt: "2026-08-09T12:00:00.000Z",
  });
  const quietNew = row({
    id: "new",
    createdAt: "2026-08-09T00:00:00.000Z",
    lastEventAt: "2026-08-09T00:00:00.000Z",
  });
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([busyOld, quietNew]);

  const chat = new AcpChat("st1");
  await chat.init();

  expect(chat.sessions.map((s) => s.id)).toEqual(["old", "new"]);
  expect(chat.session?.id).toBe("old");
  expect(MockWebSocket.latest()!.url).toContain("/api/acp/sessions/old/ws");
});

test("init skips an ended session at the head but still lists it", async () => {
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([
    row({ id: "e1", status: "ended" }),
    row({ id: "s2" }),
  ]);

  const chat = new AcpChat("st1");
  await chat.init();

  expect(chat.session?.id).toBe("s2");
  // The ended one stays switchable — its transcript is still worth reading.
  expect(chat.sessions.map((s) => s.id)).toEqual(["e1", "s2"]);
});

test("attach swaps the socket and the transcript to another session, DELETEing nothing", async () => {
  const endSpy = vi.spyOn(api, "endAcpSession");
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const a = row({ id: "sa" });
  const b = row({ id: "sb", mode: "full-auto" });
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([a, b]);
  const chat = new AcpChat("st1");
  await chat.init();
  const wsA = MockWebSocket.latest()!;
  wsA.open();
  wsA.fireMessage({ t: "event", event: ev(1, "user-prompt", { text: "in A" }) });
  wsA.fireMessage({ t: "replay-done", lastSeq: 1 });
  expect(chat.transcript.items).toHaveLength(1);

  await chat.attach("sb");

  expect(wsA.readyState).toBe(3); // the old socket is closed…
  const wsB = MockWebSocket.latest()!;
  expect(wsB).not.toBe(wsA); // …and replaced
  expect(wsB.url).toContain("/api/acp/sessions/sb/ws");
  expect(chat.session?.id).toBe("sb");
  expect(chat.mode).toBe("full-auto"); // B's mode, not A's
  expect(chat.transcript.items).toEqual([]); // A's transcript is gone
  expect(chat.transcript.lastSeq).toBe(0);
  expect(chat.connection).toBe("connecting");

  wsB.open();
  expect(wsB.frames()).toEqual([{ t: "subscribe", sinceSeq: 0 }]); // B replays whole

  wsB.fireMessage({ t: "event", event: ev(4, "user-prompt", { text: "in B" }) });
  wsB.fireMessage({ t: "replay-done", lastSeq: 4 });
  expect(chat.transcript.items).toEqual([{ kind: "user", seq: 4, text: "in B" }]);
  expect(chat.connection).toBe("connected");

  // Switching is navigation, never destruction — the sessions are hub-owned.
  expect(endSpy).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

test("attach never reconnects the session it left", async () => {
  vi.useFakeTimers();
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row({ id: "sa" }), row({ id: "sb" })]);
  const chat = new AcpChat("st1");
  await chat.init();
  MockWebSocket.latest()!.open();

  await chat.attach("sb");
  const count = MockWebSocket.instances.length;
  vi.advanceTimersByTime(60_000);

  // A manual close is not a drop: the old socket must not schedule a redial.
  expect(MockWebSocket.instances).toHaveLength(count);
});

test("attach mid-pending never leaks the optimistic prompt into the next session", async () => {
  vi.useFakeTimers();
  const failed: string[] = [];
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row({ id: "sa" }), row({ id: "sb" })]);
  const chat = new AcpChat("st1", { onPromptFailed: (text) => failed.push(text) });
  await chat.init();
  const wsA = MockWebSocket.latest()!;
  wsA.open();
  wsA.fireMessage({ t: "replay-done", lastSeq: 0 });
  await chat.prompt("meant for A");
  expect(chat.busy).toBe(true);

  await chat.attach("sb");

  expect(chat.transcript.items).toEqual([]); // no ghost bubble in B
  // NOT handed back: the composer now points at another agent's session.
  expect(failed).toEqual([]);
  const wsB = MockWebSocket.latest()!;
  wsB.open();
  wsB.fireMessage({ t: "replay-done", lastSeq: 0 });
  expect(chat.busy).toBe(false); // and busy is not latched behind A's prompt
  expect(vi.getTimerCount()).toBe(0); // A's echo deadline went with it

  vi.advanceTimersByTime(ECHO_DEADLINE_MS * 3);
  expect(chat.error).toBeNull();
  expect(failed).toEqual([]);
});

test("attach to an id that is gone re-reads the list and keeps the live session", async () => {
  const list = vi.spyOn(api, "listAcpSessions").mockResolvedValue([row({ id: "sa" })]);
  const chat = new AcpChat("st1");
  await chat.init();
  const wsA = MockWebSocket.latest()!;
  wsA.open();
  wsA.fireMessage({ t: "replay-done", lastSeq: 0 });

  await chat.attach("gone");

  expect(list).toHaveBeenCalledTimes(2); // re-read before giving up
  expect(chat.session?.id).toBe("sa"); // still attached, socket untouched
  expect(wsA.readyState).toBe(1);
  expect(MockWebSocket.instances).toHaveLength(1);
  expect(chat.error).toBe("Couldn't open that session — it's no longer there.");
});

test("attach resolves a session the first page never had, via a deep re-read", async () => {
  // The history dialog pages far deeper than the switcher, so a legitimate pick
  // can be a session this controller has never seen. The re-read asks for the
  // hub's maximum page rather than its default, or that pick would be reported
  // as "no longer there".
  const list = vi.spyOn(api, "listAcpSessions").mockResolvedValue([row({ id: "sa" })]);
  const chat = new AcpChat("st1");
  await chat.init();
  MockWebSocket.latest()!.open();

  const ancient = row({ id: "s99", createdAt: "2026-01-01T00:00:00.000Z" });
  list.mockResolvedValue([row({ id: "sa" }), ancient]);
  await chat.attach("s99");

  expect(list).toHaveBeenLastCalledWith("st1", { limit: 100 });
  expect(chat.session?.id).toBe("s99");
  expect(chat.error).toBeNull();
  expect(MockWebSocket.latest()!.url).toContain("/api/acp/sessions/s99/ws");
});

test("attach after destroy dials nothing", async () => {
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row({ id: "sa" }), row({ id: "sb" })]);
  const chat = new AcpChat("st1");
  await chat.init();
  chat.destroy();
  const count = MockWebSocket.instances.length;

  await chat.attach("sb");

  expect(MockWebSocket.instances).toHaveLength(count);
});

test("the session frame refreshes that row in the list without reordering it", async () => {
  const a = row({ id: "sa" });
  const b = row({ id: "sb" });
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([a, b]);
  const chat = new AcpChat("st1");
  await chat.init();
  const ws = MockWebSocket.latest()!;
  ws.open();

  ws.fireMessage({ t: "session", session: { ...a, status: "working" } });

  // The switcher's <Status> must follow the stream, but a list that reshuffles
  // itself under the pointer is how a user picks the wrong session.
  expect(chat.sessions.map((s) => s.id)).toEqual(["sa", "sb"]);
  expect(chat.sessions[0].status).toBe("working");
});

test("a prompt into an attached ENDED session creates a new one instead", async () => {
  // Reading an ended session and typing a follow-up is an obvious move now that
  // the switcher offers them. The row says ended, but a replay that carried no
  // state event leaves the transcript's own status at the "starting" placeholder
  // — deciding on that alone writes the frame into a session that can never
  // answer it.
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([
    row({ id: "sa" }),
    row({ id: "se", status: "ended" }),
  ]);
  const chat = new AcpChat("st1");
  await chat.init();
  await chat.attach("se");
  const wsE = MockWebSocket.latest()!;
  wsE.open();
  wsE.fireMessage({ t: "replay-done", lastSeq: 0 });
  expect(chat.status).toBe("ended");
  expect(chat.busy).toBe(false);
  vi.spyOn(api, "createAcpSession").mockResolvedValue(row({ id: "sn" }));

  await chat.prompt("carry on");

  expect(api.createAcpSession).toHaveBeenCalledWith("st1", "ask");
  expect(chat.session?.id).toBe("sn");
  expect(wsE.frames()).not.toContainEqual({ t: "prompt", text: "carry on" });
  const wsN = MockWebSocket.latest()!;
  wsN.open();
  expect(wsN.frames()).toEqual([
    { t: "subscribe", sinceSeq: 0 },
    { t: "prompt", text: "carry on" },
  ]);
});

test("end() refreshes the session list so the switcher shows it ended", async () => {
  vi.spyOn(api, "endAcpSession").mockResolvedValue(undefined);
  const { chat } = await connectedChat();
  expect(chat.sessions.map((s) => s.status)).toEqual(["idle"]);
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row({ status: "ended" })]);

  await chat.end();

  expect(chat.sessions.map((s) => s.status)).toEqual(["ended"]);
});
