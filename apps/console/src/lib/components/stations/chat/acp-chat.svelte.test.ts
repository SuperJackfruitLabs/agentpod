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
import { AcpChat } from "./acp-chat.svelte";

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
});

afterEach(() => {
  vi.useRealTimers();
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
  // Deliberately unsorted: the controller must pick the newest by createdAt.
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([active, ended]);

  const chat = new AcpChat("st1");
  await chat.init();

  expect(api.listAcpSessions).toHaveBeenCalledWith("st1");
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

test("newSession resets to the empty state", async () => {
  const { chat, ws } = await connectedChat();
  ws.fireMessage({ t: "event", event: ev(1, "user-prompt", { text: "hi" }) });
  ws.fireMessage({ t: "bye", reason: "ended" });

  chat.newSession();

  expect(chat.session).toBeNull();
  expect(chat.transcript.items).toEqual([]);
  expect(chat.transcript.lastSeq).toBe(0);
  expect(chat.connection).toBe("idle");
  expect(chat.error).toBeNull();
});
