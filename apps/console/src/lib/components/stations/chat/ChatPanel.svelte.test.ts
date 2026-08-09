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

  MockWebSocket.latest()!.fireMessage({
    t: "event",
    event: ev(1, "user-prompt", { text: "first" }),
  });
  await tick();
  expect(box.readOnly).toBe(false);
  expect(box.getAttribute("aria-disabled")).toBeNull();
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

test("after the session ends, New session returns to the empty state", async () => {
  const u = await renderConnected();
  u.ws.fireMessage({ t: "event", event: ev(1, "state", { status: "ended", reason: "done" }) });
  await tick();
  expect(u.getByText("Ended")).toBeTruthy();

  await fireEvent.click(u.getByRole("button", { name: "New session" }));
  await tick();

  expect(u.getByText("No conversation yet.")).toBeTruthy();
  expect(u.getByText("No session")).toBeTruthy();
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
