/**
 * ChatPanel.svelte.test.ts
 *
 * Integration tests for the composed chat panel: the REAL AcpChat controller
 * driving the real header / conversation / composer against a mocked api layer
 * (REST spies + a MockWebSocket global). Only Response.svelte is stubbed —
 * its streamdown/shiki renderer isn't jsdom-friendly.
 *
 * Run: cd apps/console && pnpm test src/lib/components/stations/chat/ChatPanel
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import type { AcpEvent, AcpSessionRow } from "@agentpod/contract";
import * as api from "$lib/api/acp";

// The streamdown-backed markdown renderer doesn't run reliably in jsdom.
vi.mock("./Response.svelte", () => import("./response.stub.svelte"));

vi.mock("svelte-sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { toast } from "svelte-sonner";

// bits-ui's Select (the session switcher) opens on `pointerdown` and picks on
// `pointerup`, touching pointer-capture methods jsdom doesn't implement.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "mouse";
    }
  }
  // @ts-expect-error jsdom has no native PointerEvent
  window.PointerEvent = PointerEventPolyfill;
}
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};

// Static import: compiled during file collection, not inside a waitFor window.
import ChatPanel from "./ChatPanel.svelte";

// ─── Minimal WebSocket stub (mirrors acp-chat.svelte.test.ts) ────────────────

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static latest(): MockWebSocket | null {
    return MockWebSocket.instances.at(-1) ?? null;
  }

  url: string;
  readyState = 0; // CONNECTING
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
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

  open() {
    this.readyState = 1; // OPEN
    this.onopen?.(new Event("open"));
  }

  fireMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  drop() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }

  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(toast.error).mockClear();
  MockWebSocket.instances = [];
  localStorage.setItem("agentpod.apiUrl", "http://hub.test:3001");
  (globalThis as unknown as Record<string, unknown>).WebSocket = MockWebSocket;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  MockWebSocket.instances = [];
  localStorage.clear();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

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

/** Renders the panel with no live session (the empty-state path). */
async function renderIdle() {
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([]);
  const utils = render(ChatPanel, { props: { stationId: "st1" } });
  await waitFor(() => expect(api.listAcpSessions).toHaveBeenCalledWith("st1"));
  await tick();
  return utils;
}

/** Renders the panel attached to an existing idle session, fully connected. */
async function renderConnected() {
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row()]);
  const utils = render(ChatPanel, { props: { stationId: "st1" } });
  await waitFor(() => expect(MockWebSocket.latest()).toBeTruthy());
  const ws = MockWebSocket.latest()!;
  ws.open();
  ws.fireMessage({ t: "session", session: row() });
  ws.fireMessage({ t: "replay-done", lastSeq: 0 });
  await tick();
  return { ...utils, ws };
}

const composer = (u: { getByPlaceholderText: (t: string) => HTMLElement }) =>
  u.getByPlaceholderText("Message the agent…") as HTMLTextAreaElement;

// ─── Mount / attach ─────────────────────────────────────────────────────────

test("mounts, lists sessions, and shows the empty state when there is none", async () => {
  const u = await renderIdle();

  expect(u.getByText("No conversation yet.")).toBeTruthy();
  expect(u.getByText("No session")).toBeTruthy();
  expect(MockWebSocket.instances).toHaveLength(0);
  // No session → no destructive action offered yet.
  expect(u.queryByRole("button", { name: "End session" })).toBeNull();
});

test("attaches to a live session: subscribes and reports the session status", async () => {
  const u = await renderConnected();

  expect(u.ws.url).toContain("/api/acp/sessions/s1/ws");
  expect(u.ws.frames()).toEqual([{ t: "subscribe", sinceSeq: 0 }]);
  expect(u.getByText("Idle")).toBeTruthy();
  expect(u.getByRole("button", { name: "End session" })).toBeTruthy();
});

test("renders replayed transcript items", async () => {
  const u = await renderConnected();

  u.ws.fireMessage({ t: "event", event: ev(1, "user-prompt", { text: "run the tests" }) });
  u.ws.fireMessage({
    t: "event",
    event: ev(2, "agent-update", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "on it" },
    }),
  });
  await tick();

  expect(u.getByText("run the tests")).toBeTruthy();
  expect(u.getByTestId("response-stub").textContent).toContain("on it");
});

// ─── First prompt (session creation) ────────────────────────────────────────

test("typing + Enter with no session creates one and shows the optimistic bubble", async () => {
  const u = await renderIdle();
  const create = vi.spyOn(api, "createAcpSession").mockResolvedValue(row());

  const box = composer(u);
  await fireEvent.input(box, { target: { value: "hello agent" } });
  await fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(create).toHaveBeenCalledWith("st1", "ask"));
  await tick();

  expect(u.getByText("hello agent")).toBeTruthy();
  const ws = MockWebSocket.latest()!;
  ws.open();
  expect(ws.frames()).toEqual([
    { t: "subscribe", sinceSeq: 0 },
    { t: "prompt", text: "hello agent" },
  ]);
});

test("the chosen mode chip seeds session creation", async () => {
  const u = await renderIdle();
  const create = vi.spyOn(api, "createAcpSession").mockResolvedValue(row({ mode: "accept-edits" }));

  await fireEvent.click(u.getByRole("button", { name: "Accept edits" }));
  const box = composer(u);
  await fireEvent.input(box, { target: { value: "edit away" } });
  await fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => expect(create).toHaveBeenCalledWith("st1", "accept-edits"));
});

test("the composer refuses sends while a create is in flight and until the echo lands", async () => {
  const u = await renderIdle();
  let resolveCreate: (r: AcpSessionRow) => void = () => {};
  vi.spyOn(api, "createAcpSession").mockReturnValue(
    new Promise<AcpSessionRow>((res) => {
      resolveCreate = res;
    }),
  );

  const box = composer(u);
  await fireEvent.input(box, { target: { value: "first" } });
  await fireEvent.keyDown(box, { key: "Enter" });
  await tick();

  // Create in flight: a second message must not be typeable-and-lost — the
  // controller would refuse it and PromptInput would clear the draft.
  expect(box.readOnly).toBe(true);
  expect(box.getAttribute("aria-disabled")).toBe("true");

  resolveCreate(row());
  await waitFor(() => expect(MockWebSocket.latest()).toBeTruthy());
  await tick();
  // Optimistic prompt still awaiting its echo → still refused.
  expect(box.readOnly).toBe(true);

  // Replay still in flight is also a refusal window (the transcript, and so the
  // status, isn't trustworthy yet).
  MockWebSocket.latest()!.fireMessage({
    t: "event",
    event: ev(1, "user-prompt", { text: "first" }),
  });
  await tick();
  expect(box.readOnly).toBe(true);

  MockWebSocket.latest()!.fireMessage({ t: "replay-done", lastSeq: 1 });
  await tick();
  expect(box.readOnly).toBe(false);
  expect(box.getAttribute("aria-disabled")).toBeNull();
});

test("reattaching to a working session is not sendable, and says why", async () => {
  // The header's status and the composer's must come from ONE machine: a header
  // reading "Working…" over an enabled Send button is how a prompt gets fired
  // into someone else's turn and rejected by the hub.
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([row({ status: "working" })]);
  const u = render(ChatPanel, { props: { stationId: "st1" } });
  await waitFor(() => expect(MockWebSocket.latest()).toBeTruthy());
  await tick();

  // Before replay-done: transport state is what the user is told.
  expect(u.getByText("Connecting…")).toBeTruthy();
  expect(u.queryByRole("button", { name: "Send" })).toBeNull();
  expect(u.getByRole("button", { name: "Stop the current turn" })).toBeTruthy();

  const box = composer(u);
  await fireEvent.input(box, { target: { value: "cut in line" } });
  await fireEvent.keyDown(box, { key: "Enter" });
  // Refused, and the draft is still there to send when the turn ends.
  expect(box.value).toBe("cut in line");
  expect(MockWebSocket.latest()!.frames()).not.toContainEqual({
    t: "prompt",
    text: "cut in line",
  });

  const ws = MockWebSocket.latest()!;
  ws.open();
  ws.fireMessage({ t: "replay-done", lastSeq: 0 });
  await tick();
  expect(u.getByText("Working…")).toBeTruthy(); // row status still says working

  ws.fireMessage({ t: "event", event: ev(1, "state", { status: "idle" }) });
  await tick();
  expect(u.getByRole("button", { name: "Send" })).toBeTruthy();
  expect(box.readOnly).toBe(false);
});

test("a prompt the hub rejects gives the text back and frees the composer", async () => {
  const u = await renderConnected();
  const box = composer(u);
  await fireEvent.input(box, { target: { value: "do it" } });
  await fireEvent.keyDown(box, { key: "Enter" });
  await tick();
  expect(u.getByText("do it")).toBeTruthy(); // optimistic bubble
  expect(box.readOnly).toBe(true);

  u.ws.fireMessage({
    t: "event",
    event: ev(0, "error", { message: "Session is busy — wait for the current turn to finish." }),
  });
  await tick();

  // No ghost bubble wedging the composer, the text is back, the error is shown.
  expect(u.queryByText("do it")).toBeNull();
  expect(box.readOnly).toBe(false);
  expect(box.value).toBe("do it");
  expect(
    u.getByText("Session is busy — wait for the current turn to finish."),
  ).toBeTruthy();
});

test("a prompt lost with the socket comes back when the reconnect budget runs out", async () => {
  vi.useFakeTimers();
  const u = await renderConnected();
  const box = composer(u);
  await fireEvent.input(box, { target: { value: "lost in transit" } });
  await fireEvent.keyDown(box, { key: "Enter" });
  await tick();
  expect(box.readOnly).toBe(true);

  MockWebSocket.latest()!.drop();
  await vi.advanceTimersByTimeAsync(1000);
  MockWebSocket.latest()!.drop();
  await vi.advanceTimersByTimeAsync(2000);
  MockWebSocket.latest()!.drop();
  await vi.advanceTimersByTimeAsync(4000);
  MockWebSocket.latest()!.drop();
  await tick();

  expect(u.queryByText("lost in transit")).toBeNull(); // no ghost bubble
  expect(box.readOnly).toBe(false);
  expect(box.value).toBe("lost in transit");
  expect(u.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("sending keeps focus in the composer, through the create and the echo", async () => {
  const u = await renderIdle();
  vi.spyOn(api, "createAcpSession").mockResolvedValue(row());

  const box = composer(u);
  box.focus();
  await fireEvent.input(box, { target: { value: "hello agent" } });
  await fireEvent.keyDown(box, { key: "Enter" });
  await tick();

  // The refusal window must never blur the composer: a keyboard user would
  // otherwise land at <body> and have to Tab through the whole transcript
  // (tool and permission cards are full of focusable controls) every turn.
  expect(document.activeElement).toBe(box);

  await waitFor(() => expect(MockWebSocket.latest()).toBeTruthy());
  MockWebSocket.latest()!.fireMessage({
    t: "event",
    event: ev(1, "user-prompt", { text: "hello agent" }),
  });
  await tick();

  expect(document.activeElement).toBe(box);
});

test("a failed create surfaces the strip and a toast, and stays sendable", async () => {
  const u = await renderIdle();
  vi.spyOn(api, "createAcpSession").mockRejectedValue(
    new Error("Couldn't start a session — the node is offline."),
  );

  const box = composer(u);
  await fireEvent.input(box, { target: { value: "hello" } });
  await fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() =>
    expect(u.getByText("Couldn't start a session — the node is offline.")).toBeTruthy(),
  );
  expect(toast.error).toHaveBeenCalledWith("Couldn't start the session", {
    description: "Couldn't start a session — the node is offline.",
  });
  // Nothing is live, so there's nothing to retry a connection to.
  expect(u.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(box.readOnly).toBe(false);
});

// ─── Turn controls ──────────────────────────────────────────────────────────

test("while working the composer offers Stop, which cancels the turn", async () => {
  const u = await renderConnected();
  u.ws.fireMessage({ t: "event", event: ev(1, "state", { status: "working" }) });
  await tick();

  expect(u.queryByRole("button", { name: "Send" })).toBeNull();
  await fireEvent.click(u.getByRole("button", { name: "Stop the current turn" }));

  expect(u.ws.frames()).toContainEqual({ t: "cancel" });
  expect(u.getByText("Working…")).toBeTruthy();
});

test("answering a permission request sends permission-answer for that request", async () => {
  const u = await renderConnected();
  u.ws.fireMessage({
    t: "event",
    event: ev(4, "permission-request", {
      toolCall: { toolCallId: "t9", title: "Run rm -rf ./dist", kind: "execute" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    }),
  });
  await tick();

  await fireEvent.click(u.getByRole("button", { name: "Allow" }));

  expect(u.ws.frames()).toContainEqual({
    t: "permission-answer",
    requestSeq: 4,
    optionId: "allow",
  });
});

test("ending a session goes through the confirm dialog and DELETEs", async () => {
  const u = await renderConnected();
  const end = vi.spyOn(api, "endAcpSession").mockResolvedValue(undefined);

  await fireEvent.click(u.getByRole("button", { name: "End session" }));
  const confirm = await waitFor(() => {
    const buttons = u.getAllByRole("button", { name: "End session" });
    const inDialog = buttons.find((b) => b.closest('[role="dialog"]') !== null);
    if (!inDialog) throw new Error("confirm button not rendered yet");
    return inDialog;
  });
  await fireEvent.click(confirm);

  await waitFor(() => expect(end).toHaveBeenCalledWith("s1"));
});

test("after the session ends, New session creates and attaches a fresh one", async () => {
  const u = await renderConnected();
  u.ws.fireMessage({ t: "event", event: ev(1, "state", { status: "ended", reason: "done" }) });
  await tick();
  expect(u.getByText("Ended")).toBeTruthy();

  const created = row({ id: "s2", lastEventAt: minutesAgo(0) });
  const create = vi.spyOn(api, "createAcpSession").mockResolvedValue(created);
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([created, row()]);

  await fireEvent.click(u.getByRole("button", { name: "New session" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith("st1", "ask"));
  await tick();

  // A fresh transcript on a new socket — not a local reset of the old session.
  expect(u.getByText("No conversation yet.")).toBeTruthy();
  const ws2 = MockWebSocket.latest()!;
  expect(ws2).not.toBe(u.ws);
  expect(ws2.url).toContain("/api/acp/sessions/s2/ws");
  expect(u.ws.readyState).toBe(3);
  ws2.open();
  expect(ws2.frames()).toEqual([{ t: "subscribe", sinceSeq: 0 }]);
});

// ─── Session switcher ───────────────────────────────────────────────────────

/** ISO timestamp `minutes` ago — keeps relative labels deterministic. */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const sessionA = row({
  id: "sa",
  createdAt: "2026-08-09T10:00:00.000Z",
  lastEventAt: minutesAgo(90),
});
const sessionB = row({
  id: "sb",
  mode: "full-auto",
  createdAt: "2026-08-09T11:00:00.000Z",
  lastEventAt: minutesAgo(5),
});

/** Two live sessions on the station, attached to the newest-activity one (B). */
async function renderTwoSessions() {
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([sessionB, sessionA]);
  const utils = render(ChatPanel, { props: { stationId: "st1" } });
  await waitFor(() => expect(MockWebSocket.latest()).toBeTruthy());
  const ws = MockWebSocket.latest()!;
  ws.open();
  ws.fireMessage({ t: "event", event: ev(1, "user-prompt", { text: "hello from B" }) });
  ws.fireMessage({ t: "replay-done", lastSeq: 1 });
  await tick();
  return { ...utils, ws };
}

/** Opens the switcher and clicks the option whose accessible name matches. */
async function switchTo(
  u: { getByRole: (role: string, options: { name: RegExp }) => HTMLElement },
  name: RegExp,
): Promise<void> {
  const trigger = u.getByRole("button", { name: /^Switch session/ });
  await fireEvent.pointerDown(trigger, { pointerId: 1, button: 0, pointerType: "mouse" });
  const option = await waitFor(() => u.getByRole("option", { name }));
  await fireEvent.pointerUp(option, { pointerId: 1, button: 0, pointerType: "mouse" });
  await tick();
}

test("the switcher lists the station's sessions and switching re-attaches", async () => {
  const endSpy = vi.spyOn(api, "endAcpSession");
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const u = await renderTwoSessions();
  expect(u.getByText("hello from B")).toBeTruthy();
  expect(
    u.getByRole("button", { name: /^Switch session — currently Session 2 · idle · 5m ago$/ }),
  ).toBeTruthy();

  await switchTo(u, /^Session 1 · idle · 1h ago$/);

  // The old socket is closed and a new one subscribes to the chosen session.
  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
  const wsA = MockWebSocket.latest()!;
  expect(wsA).not.toBe(u.ws);
  expect(wsA.url).toContain("/api/acp/sessions/sa/ws");
  expect(u.ws.readyState).toBe(3);
  wsA.open();
  expect(wsA.frames()).toEqual([{ t: "subscribe", sinceSeq: 0 }]);

  // B's transcript is gone and A's replay takes its place.
  expect(u.queryByText("hello from B")).toBeNull();
  wsA.fireMessage({ t: "event", event: ev(7, "user-prompt", { text: "hello from A" }) });
  wsA.fireMessage({ t: "replay-done", lastSeq: 7 });
  await tick();
  expect(u.getByText("hello from A")).toBeTruthy();
  expect(
    u.getByRole("button", { name: /^Switch session — currently Session 1 · idle · 1h ago$/ }),
  ).toBeTruthy();

  // Sessions are hub-owned: switching never ends one.
  expect(endSpy).not.toHaveBeenCalled();
  expect(fetchSpy.mock.calls).toEqual([]);
});

test("drafts are per session: parked on the way out, restored on the way back", async () => {
  // One shared buffer would leave words written for one agent an Enter away from
  // another; clearing on switch would destroy them. Parking does neither.
  const u = await renderTwoSessions();
  const box = composer(u);
  await fireEvent.input(box, { target: { value: "written for B" } });

  await switchTo(u, /^Session 1/);
  expect(box.value).toBe(""); // A has no draft of its own

  await fireEvent.input(box, { target: { value: "written for A" } });
  await switchTo(u, /^Session 2/);
  expect(box.value).toBe("written for B"); // B's own draft came back

  await switchTo(u, /^Session 1/);
  expect(box.value).toBe("written for A");
});

test("a parked draft is dropped once its session has ended", async () => {
  const u = await renderTwoSessions();
  const box = composer(u);
  await fireEvent.input(box, { target: { value: "parked in B" } });
  await switchTo(u, /^Session 1/); // B's draft is parked

  // Ending A re-reads the list, which is where this panel learns B ended too.
  vi.spyOn(api, "endAcpSession").mockResolvedValue(undefined);
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([
    { ...sessionB, status: "ended" },
    sessionA,
  ]);
  await fireEvent.click(u.getByRole("button", { name: "End session" }));
  const confirm = await waitFor(() => {
    const inDialog = u
      .getAllByRole("button", { name: "End session" })
      .find((b) => b.closest('[role="dialog"]') !== null);
    if (!inDialog) throw new Error("confirm button not rendered yet");
    return inDialog;
  });
  await fireEvent.click(confirm);
  await waitFor(() => expect(api.endAcpSession).toHaveBeenCalled());
  await tick();

  await switchTo(u, /^Session 2/);

  // Nothing can be sent into an ended session, so its draft is not handed back.
  expect(box.value).toBe("");
});

test("re-picking the attached session churns nothing", async () => {
  // The list is also a status display, so it gets clicked idly. Re-attaching
  // there would drop a live socket and replay the transcript for no reason.
  const u = await renderTwoSessions();
  const box = composer(u);
  await fireEvent.input(box, { target: { value: "still mine" } });

  await switchTo(u, /^Session 2/);

  expect(MockWebSocket.instances).toHaveLength(1);
  expect(u.ws.readyState).toBe(1);
  expect(box.value).toBe("still mine");
  expect(u.getByText("hello from B")).toBeTruthy();
});

test("with one session the panel shows no switcher", async () => {
  const u = await renderConnected();
  expect(u.queryByRole("button", { name: /^Switch session/ })).toBeNull();
});

// ─── Reading an ended session, and sending from one ─────────────────────────

const endedA = row({
  id: "sa",
  status: "ended",
  createdAt: "2026-08-09T10:00:00.000Z",
  lastEventAt: minutesAgo(120),
});

/** Two sessions where the older one has ended; attached to the live one (B). */
async function renderWithEnded() {
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([sessionB, endedA]);
  const utils = render(ChatPanel, { props: { stationId: "st1" } });
  await waitFor(() => expect(MockWebSocket.latest()).toBeTruthy());
  const ws = MockWebSocket.latest()!;
  ws.open();
  ws.fireMessage({ t: "replay-done", lastSeq: 0 });
  await tick();
  return { ...utils, ws };
}

/** Switches to the ended session A and replays its ended state event. */
async function readEndedSession(u: Awaited<ReturnType<typeof renderWithEnded>>) {
  await switchTo(u, /^Session 1 · ended/);
  const wsA = MockWebSocket.latest()!;
  wsA.open();
  wsA.fireMessage({ t: "event", event: ev(3, "state", { status: "ended", reason: "done" }) });
  wsA.fireMessage({ t: "replay-done", lastSeq: 3 });
  await tick();
  return wsA;
}

test("sending from an ended session re-points the header at the new session", async () => {
  // Regression: only the switcher and "New session" resynced the pick, so
  // prompt()'s lazy create left the header naming the ENDED session the user had
  // been reading while the socket and transcript were the new one's — and the
  // stale pick then swallowed the next click on either of them.
  const u = await renderWithEnded();
  await readEndedSession(u);
  expect(u.getByRole("button", { name: /currently Session 1 · ended/ })).toBeTruthy();

  const created = row({
    id: "sc",
    createdAt: "2026-08-09T12:00:00.000Z",
    lastEventAt: minutesAgo(0),
  });
  vi.spyOn(api, "createAcpSession").mockResolvedValue(created);
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([created, sessionB, endedA]);

  const box = composer(u);
  await fireEvent.input(box, { target: { value: "follow-up" } });
  await fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(api.createAcpSession).toHaveBeenCalledWith("st1", "ask"));
  await tick();

  // The header names what is actually attached, not what was being read.
  expect(MockWebSocket.latest()!.url).toContain("/api/acp/sessions/sc/ws");
  expect(
    u.getByRole("button", { name: /^Switch session — currently Session 3 · idle · just now$/ }),
  ).toBeTruthy();

  // …and the session just read is selectable again straight away (no sticky pick).
  await switchTo(u, /^Session 1 · ended/);
  await waitFor(() => expect(MockWebSocket.latest()!.url).toContain("/api/acp/sessions/sa/ws"));
});

test("an attached ended session says plainly that sending starts a new one", async () => {
  const notice = "This session has ended — sending starts a new one.";
  const u = await renderWithEnded();
  expect(u.queryByText(notice)).toBeNull(); // live session: nothing to explain

  await readEndedSession(u);

  const line = u.getByText(notice);
  const box = composer(u);
  // Visible AND announced on focus — a composer that quietly spawns a second
  // agent process on the host is the one thing that must not be a surprise.
  expect(box.getAttribute("aria-describedby")).toBe(line.id);
  expect(line.id.length).toBeGreaterThan(0);
  // Not a dead end: sending is still allowed, it just starts a session.
  expect(box.readOnly).toBe(false);
});

test("a draft typed with no session survives switching away to read one", async () => {
  // Every session ended, so the switcher is up while nothing is attached. This
  // draft has no session to be parked under — the bug dropped it on the floor.
  const endedB = { ...sessionB, status: "ended" as const };
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([endedB, endedA]);
  const u = render(ChatPanel, { props: { stationId: "st1" } });
  await waitFor(() => expect(api.listAcpSessions).toHaveBeenCalledWith("st1"));
  await tick();
  expect(MockWebSocket.instances).toHaveLength(0); // nothing live to attach
  const box = composer(u);
  await fireEvent.input(box, { target: { value: "typed before any session" } });

  await switchTo(u, /^Session 1 · ended/);
  expect(box.value).toBe(""); // the session being read has no draft of its own

  // The pre-session text was written for whatever session came next — so it is
  // waiting in the one this creates, not gone.
  const created = row({
    id: "sc",
    createdAt: "2026-08-09T12:00:00.000Z",
    lastEventAt: minutesAgo(0),
  });
  vi.spyOn(api, "createAcpSession").mockResolvedValue(created);
  await fireEvent.click(u.getByRole("button", { name: "New session" }));
  await waitFor(() => expect(api.createAcpSession).toHaveBeenCalled());
  await tick();

  expect(box.value).toBe("typed before any session");
});

test("a draft typed into an ENDED session survives New session", async () => {
  // Regression (4b review): the draft was parked under the ended session's own
  // slot, which the pruning effect then garbage-collected — the text the user
  // had just typed vanished on the click that was supposed to carry it forward.
  const u = await renderWithEnded();
  await readEndedSession(u);
  expect(u.getByText("This session has ended — sending starts a new one.")).toBeTruthy();

  const box = composer(u);
  await fireEvent.input(box, { target: { value: "carry me into the next one" } });

  const created = row({
    id: "sc",
    createdAt: "2026-08-09T12:00:00.000Z",
    lastEventAt: minutesAgo(0),
  });
  vi.spyOn(api, "createAcpSession").mockResolvedValue(created);
  vi.spyOn(api, "listAcpSessions").mockResolvedValue([created, sessionB, endedA]);

  await fireEvent.click(u.getByRole("button", { name: "New session" }));
  await waitFor(() => expect(api.createAcpSession).toHaveBeenCalledWith("st1", "ask"));
  await tick();

  // The new session is attached AND the words are still in the composer.
  expect(MockWebSocket.latest()!.url).toContain("/api/acp/sessions/sc/ws");
  expect(box.value).toBe("carry me into the next one");
});

test("a failed create from an ended session keeps the draft on screen", async () => {
  // The draft is only ever MOVED when the pick actually moves: a create that
  // failed leaves the same (ended) session attached, so the text stays put.
  const u = await renderWithEnded();
  await readEndedSession(u);
  const box = composer(u);
  await fireEvent.input(box, { target: { value: "still here" } });

  vi.spyOn(api, "createAcpSession").mockRejectedValue(new Error("Couldn't start a session."));
  await fireEvent.click(u.getByRole("button", { name: "New session" }));
  await waitFor(() => expect(api.createAcpSession).toHaveBeenCalled());
  await tick();

  expect(box.value).toBe("still here");
});

// ─── Session history ────────────────────────────────────────────────────────

/** `n` sessions, newest activity first (created oldest-first), each titled. */
function manySessions(n: number): AcpSessionRow[] {
  return Array.from({ length: n }, (_, i) => {
    const age = n - 1 - i; // index 0 = newest activity
    return row({
      id: `sh${age}`,
      title: `Task ${age}`,
      createdAt: new Date(Date.UTC(2026, 7, 1, age)).toISOString(),
      lastEventAt: minutesAgo(age),
      lastSeq: age + 1,
    });
  });
}

test("past 8 sessions the switcher hands off to the history dialog", async () => {
  const endSpy = vi.spyOn(api, "endAcpSession");
  const sessions = manySessions(9);
  vi.spyOn(api, "listAcpSessions").mockResolvedValue(sessions);
  const u = render(ChatPanel, { props: { stationId: "st1" } });
  await waitFor(() => expect(MockWebSocket.latest()).toBeTruthy());
  const ws = MockWebSocket.latest()!;
  ws.open();
  ws.fireMessage({ t: "replay-done", lastSeq: 0 });
  await tick();

  // The oldest session is past the switcher's cap — history is the way to it.
  const trigger = u.getByRole("button", { name: /^Switch session/ });
  await fireEvent.pointerDown(trigger, { pointerId: 1, button: 0, pointerType: "mouse" });
  const all = await waitFor(() => u.getByRole("option", { name: /All sessions/ }));
  await fireEvent.pointerUp(all, { pointerId: 1, button: 0, pointerType: "mouse" });

  const dialog = await waitFor(() => {
    const found = u.getAllByRole("dialog").find((d) => d.textContent?.includes("All sessions"));
    if (!found) throw new Error("history dialog not open yet");
    return found;
  });
  const oldest = await waitFor(() => {
    const found = u.getAllByRole("button").find((b) => b.textContent?.includes("Task 0"));
    if (!found) throw new Error("history rows not rendered yet");
    return found;
  });
  expect(dialog.textContent).toContain("Task 0");

  // Selecting there goes through the SAME attach path the switcher uses: the old
  // socket is dropped, a new one subscribes, and the header names what it landed on.
  await fireEvent.click(oldest);
  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
  const ws2 = MockWebSocket.latest()!;
  expect(ws2.url).toContain("/api/acp/sessions/sh0/ws");
  expect(ws.readyState).toBe(3);
  ws2.open();
  expect(ws2.frames()).toEqual([{ t: "subscribe", sinceSeq: 0 }]);
  await waitFor(() =>
    expect(u.getByRole("button", { name: /^Switch session — currently Task 0 ·/ })).toBeTruthy(),
  );

  // The dialog got out of the way, and history ended nothing.
  await waitFor(() =>
    expect(u.queryAllByRole("dialog").some((d) => d.textContent?.includes("All sessions"))).toBe(
      false,
    ),
  );
  expect(endSpy).not.toHaveBeenCalled();
});

test("switching from history parks the draft exactly like the switcher does", async () => {
  const sessions = manySessions(9);
  vi.spyOn(api, "listAcpSessions").mockResolvedValue(sessions);
  const u = render(ChatPanel, { props: { stationId: "st1" } });
  await waitFor(() => expect(MockWebSocket.latest()).toBeTruthy());
  MockWebSocket.latest()!.open();
  MockWebSocket.latest()!.fireMessage({ t: "replay-done", lastSeq: 0 });
  await tick();

  const box = composer(u);
  await fireEvent.input(box, { target: { value: "written for Task 8" } });

  const trigger = u.getByRole("button", { name: /^Switch session/ });
  await fireEvent.pointerDown(trigger, { pointerId: 1, button: 0, pointerType: "mouse" });
  const all = await waitFor(() => u.getByRole("option", { name: /All sessions/ }));
  await fireEvent.pointerUp(all, { pointerId: 1, button: 0, pointerType: "mouse" });
  const oldest = await waitFor(() => {
    const found = u.getAllByRole("button").find((b) => b.textContent?.includes("Task 0"));
    if (!found) throw new Error("history rows not rendered yet");
    return found;
  });
  await fireEvent.click(oldest);
  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
  await tick();

  expect(box.value).toBe(""); // Task 0 has no draft of its own

  // …and the parked one comes back on the way home.
  await switchTo(u, /^Task 8 ·/);
  await waitFor(() => expect(box.value).toBe("written for Task 8"));
});

// ─── Connection failures ────────────────────────────────────────────────────

test("an exhausted reconnect budget shows the offline strip with a working Retry", async () => {
  vi.useFakeTimers();
  const u = await renderConnected();

  MockWebSocket.latest()!.drop();
  await vi.advanceTimersByTimeAsync(1000);
  MockWebSocket.latest()!.drop();
  await vi.advanceTimersByTimeAsync(2000);
  MockWebSocket.latest()!.drop();
  await vi.advanceTimersByTimeAsync(4000);
  MockWebSocket.latest()!.drop();
  await tick();

  expect(u.getByText("Couldn't reach the hub — check your connection.")).toBeTruthy();
  expect(u.getByText("Disconnected")).toBeTruthy();

  const before = MockWebSocket.instances.length;
  await fireEvent.click(u.getByRole("button", { name: "Retry" }));
  await tick();

  expect(MockWebSocket.instances.length).toBe(before + 1);
  expect(u.queryByText("Couldn't reach the hub — check your connection.")).toBeNull();
});

test("unmount closes the socket but never ends the session", async () => {
  const u = await renderConnected();
  const end = vi.spyOn(api, "endAcpSession");

  u.unmount();

  expect(u.ws.readyState).toBe(3);
  expect(end).not.toHaveBeenCalled();
});
