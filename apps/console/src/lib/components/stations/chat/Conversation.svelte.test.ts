import { test, expect, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/svelte";
import type { ChatItem } from "./transcript";

// Mock the streamdown-backed renderer — shiki doesn't run reliably in jsdom.
vi.mock("./Response.svelte", () => import("./response.stub.svelte"));

// Static import: compiled during file collection, not inside a test's waitFor.
import Conversation from "./Conversation.svelte";

function toolItem(overrides: Partial<Extract<ChatItem, { kind: "tool" }>> = {}): ChatItem {
  return {
    kind: "tool",
    seq: 4,
    toolCallId: "call_1",
    title: "read main.go",
    status: "completed",
    content: [],
    locations: [],
    ...overrides,
  };
}

function permissionItem(
  overrides: Partial<Extract<ChatItem, { kind: "permission" }>> = {},
): ChatItem {
  return {
    kind: "permission",
    seq: 5,
    requestSeq: 5,
    title: "run go test",
    options: [{ optionId: "allow-1", name: "Allow", kind: "allow_once" }],
    ...overrides,
  };
}

test("renders every item kind", async () => {
  const items: ChatItem[] = [
    { kind: "user", seq: 1, text: "hello agent" },
    { kind: "user", seq: -1, text: "pending prompt", pending: true },
    { kind: "assistant", seq: 2, text: "assistant reply", streaming: false },
    { kind: "reasoning", seq: 3, text: "thinking hard", streaming: false },
    toolItem(),
    permissionItem(),
    { kind: "notice", seq: 6, level: "info", text: "Session ended." },
    { kind: "notice", seq: 7, level: "error", text: "something broke" },
  ];

  const { getByText, getByTestId } = render(Conversation, {
    props: { items, status: "idle", onAnswer: vi.fn() },
  });

  // user bubble + pending opacity
  expect(getByText("hello agent")).toBeTruthy();
  const pending = getByText("pending prompt");
  expect(pending.className).toContain("opacity-60");

  // assistant → stubbed Response
  expect(getByTestId("response-stub").textContent).toContain("assistant reply");

  // reasoning → collapsible "Thinking" trigger
  expect(getByText("Thinking")).toBeTruthy();

  // tool + permission cards
  expect(getByText("read main.go")).toBeTruthy();
  expect(getByText("run go test")).toBeTruthy();
  expect(getByText("Allow")).toBeTruthy();

  // notices: centered label, error tinted
  expect(getByText("Session ended.")).toBeTruthy();
  const err = getByText("something broke");
  expect(err.className).toContain("text-status-error");
});

test("empty state renders Empty copy", () => {
  const { getByText } = render(Conversation, {
    props: { items: [], status: "starting", onAnswer: vi.fn() },
  });
  expect(getByText("No conversation yet.")).toBeTruthy();
  expect(getByText("Send a prompt to start talking to this agent.")).toBeTruthy();
});

test("permission answers are curried with the item's requestSeq", async () => {
  const onAnswer = vi.fn();
  const { getByText } = render(Conversation, {
    props: { items: [permissionItem({ requestSeq: 9, seq: 9 })], status: "waiting", onAnswer },
  });

  await fireEvent.click(getByText("Allow"));
  expect(onAnswer).toHaveBeenCalledWith(9, "allow-1");
});

test("aria-live region announces the latest permission request", async () => {
  const { getByTestId } = render(Conversation, {
    props: { items: [permissionItem()], status: "waiting", onAnswer: vi.fn() },
  });

  const region = getByTestId("chat-announcer");
  expect(region.getAttribute("aria-live")).toBe("polite");
  await waitFor(() => expect(region.textContent).toContain("Agent asks to run go test"));
});

test("an already-answered permission is not announced on mount", async () => {
  const { getByTestId } = render(Conversation, {
    props: {
      items: [permissionItem({ answer: { optionId: "allow-1" } })],
      status: "idle",
      onAnswer: vi.fn(),
    },
  });

  // Let effects flush before asserting the region stayed silent.
  await new Promise((r) => setTimeout(r, 0));
  expect(getByTestId("chat-announcer").textContent ?? "").not.toContain("Agent asks");
});

test("a permission announces when unanswered, and answering does not re-announce", async () => {
  const { getByTestId, rerender } = render(Conversation, {
    props: { items: [permissionItem()], status: "waiting", onAnswer: vi.fn() },
  });

  const region = getByTestId("chat-announcer");
  await waitFor(() => expect(region.textContent).toContain("Agent asks to run go test"));

  // The answer folds in; the region content is unchanged (no dead re-announce).
  await rerender({ items: [permissionItem({ answer: { optionId: "allow-1" } })] as ChatItem[] });
  await new Promise((r) => setTimeout(r, 0));
  expect(region.textContent).toContain("Agent asks to run go test");
});

test("aria-live region announces status flips", async () => {
  const { getByTestId, rerender } = render(Conversation, {
    props: { items: [], status: "working", onAnswer: vi.fn() },
  });

  const region = getByTestId("chat-announcer");
  // First render is not a flip — nothing to announce yet.
  expect(region.textContent ?? "").not.toContain("idle");

  await rerender({ status: "idle" });
  await waitFor(() => expect(region.textContent).toContain("Agent is idle."));
});

test("scroll-away pauses follow; new items show a pill; clicking jumps back", async () => {
  const items: ChatItem[] = [
    { kind: "user", seq: 1, text: "one" },
    { kind: "assistant", seq: 2, text: "two", streaming: false },
  ];
  const { getByTestId, getByText, queryByText, rerender } = render(Conversation, {
    props: { items, status: "working", onAnswer: vi.fn() },
  });

  const container = getByTestId("chat-scroll-container");
  // jsdom computes no layout — stub "scrolled far from the bottom" metrics.
  Object.defineProperty(container, "scrollTop", { value: 0, writable: true, configurable: true });
  Object.defineProperty(container, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(container, "clientHeight", { value: 200, configurable: true });
  await fireEvent.scroll(container);

  await rerender({
    items: [
      ...items,
      { kind: "assistant", seq: 3, text: "three", streaming: false },
      { kind: "notice", seq: 4, level: "info", text: "notice" },
    ] as ChatItem[],
  });

  await waitFor(() => expect(getByText(/2 new messages/)).toBeTruthy());

  await fireEvent.click(getByText(/2 new messages/));
  await waitFor(() => expect(queryByText(/new messages/)).toBeNull());
});

test("streaming growth of the trailing item scrolls to bottom while following", async () => {
  const items: ChatItem[] = [{ kind: "assistant", seq: 1, text: "a", streaming: true }];
  const { getByTestId, rerender } = render(Conversation, {
    props: { items, status: "working", onAnswer: vi.fn() },
  });

  const container = getByTestId("chat-scroll-container");
  let scrollTop = 0;
  Object.defineProperty(container, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
    configurable: true,
  });
  Object.defineProperty(container, "scrollHeight", { value: 500, configurable: true });
  Object.defineProperty(container, "clientHeight", { value: 200, configurable: true });

  // Same item count, longer trailing text — the streaming-growth path.
  await rerender({
    items: [{ kind: "assistant", seq: 1, text: "ab", streaming: true }] as ChatItem[],
  });

  await waitFor(() => expect(scrollTop).toBe(500));
});
