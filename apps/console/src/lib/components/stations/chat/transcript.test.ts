import { test, expect } from "vitest";
import type { AcpEvent, AcpEventType } from "@agentpod/contract";
import { emptyTranscript, foldEvent, addPendingPrompt, type Transcript } from "./transcript";

function ev(seq: number, type: AcpEventType, payload: unknown): AcpEvent {
  return { sessionId: "s1", seq, type, payload, createdAt: "2026-08-09T00:00:00.000Z" };
}

function fold(events: AcpEvent[], start: Transcript = emptyTranscript()): Transcript {
  return events.reduce(foldEvent, start);
}

function chunk(seq: number, text: string): AcpEvent {
  return ev(seq, "agent-update", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });
}

function thought(seq: number, text: string): AcpEvent {
  return ev(seq, "agent-update", {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
  });
}

// ─── (a) live-observed opencode sequence ─────────────────────────────────────

test("folds the live opencode smoke sequence into [user, assistant] with usage and status", () => {
  const t = fold([
    ev(1, "state", { status: "idle" }),
    ev(2, "agent-update", { sessionUpdate: "available_commands_update", availableCommands: [] }),
    ev(3, "user-prompt", { text: "Reply with exactly ACP-SLICE2-OK" }),
    ev(4, "state", { status: "working" }),
    chunk(5, "A"),
    chunk(6, "CP"),
    chunk(7, "-"),
    chunk(8, "SLICE"),
    chunk(9, "2"),
    chunk(10, "-"),
    chunk(11, "OK"),
    ev(12, "agent-update", { sessionUpdate: "usage_update", used: 1234, size: 200000 }),
    ev(13, "state", { status: "idle" }),
  ]);

  expect(t.items).toEqual([
    { kind: "user", seq: 3, text: "Reply with exactly ACP-SLICE2-OK" },
    { kind: "assistant", seq: 5, text: "ACP-SLICE2-OK", streaming: false },
  ]);
  expect(t.status).toBe("idle");
  expect(t.usage).toEqual({ used: 1234, size: 200000 });
  expect(t.lastSeq).toBe(13);
});

// ─── (b) reasoning interleaved with message chunks ───────────────────────────

test("reasoning chunks interleaved with message chunks produce separate items in arrival order", () => {
  const t = fold([
    thought(1, "Think"),
    thought(2, "ing…"),
    chunk(3, "Hello"),
    thought(4, "More"),
    chunk(5, " world"),
  ]);

  expect(t.items).toEqual([
    { kind: "reasoning", seq: 1, text: "Thinking…", streaming: true },
    { kind: "assistant", seq: 3, text: "Hello", streaming: true },
    { kind: "reasoning", seq: 4, text: "More", streaming: true },
    { kind: "assistant", seq: 5, text: " world", streaming: true },
  ]);
});

// ─── (c) tool_call + tool_call_update merge ──────────────────────────────────

test("tool_call then two tool_call_updates merge status/title/content", () => {
  const t = fold([
    chunk(1, "Editing now."),
    ev(2, "agent-update", {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Edit file",
      kind: "edit",
      locations: [{ path: "/srv/a.ts" }],
    }),
    ev(3, "agent-update", {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "in_progress",
    }),
    ev(4, "agent-update", {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      title: "Edited a.ts",
      content: [{ type: "diff", path: "/srv/a.ts", oldText: "old", newText: "new" }],
    }),
  ]);

  expect(t.items[1]).toEqual({
    kind: "tool",
    seq: 2,
    toolCallId: "t1",
    title: "Edited a.ts",
    toolKind: "edit",
    status: "completed",
    content: [{ type: "diff", path: "/srv/a.ts", oldText: "old", newText: "new" }],
    locations: ["/srv/a.ts"],
  });
});

test("tool_call status defaults to pending; content entries map text and drop unknown types", () => {
  const t = fold([
    ev(1, "agent-update", {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "Run tests",
      content: [
        { type: "content", content: { type: "text", text: "42 passing" } },
        { type: "content", content: { type: "image", data: "…" } },
        { type: "terminal", terminalId: "term-1" },
      ],
    }),
  ]);

  expect(t.items[0]).toEqual({
    kind: "tool",
    seq: 1,
    toolCallId: "t2",
    title: "Run tests",
    toolKind: undefined,
    status: "pending",
    content: [{ type: "text", text: "42 passing" }],
    locations: [],
  });
});

test("tool_call_update for an unknown toolCallId is ignored", () => {
  const before = fold([chunk(1, "hi")]);
  const after = foldEvent(
    before,
    ev(2, "agent-update", {
      sessionUpdate: "tool_call_update",
      toolCallId: "nope",
      status: "completed",
    }),
  );
  expect(after.items).toEqual(before.items);
  expect(after.lastSeq).toBe(2);
});

test("foldEvent reuses untouched item references", () => {
  const before = fold([
    ev(1, "user-prompt", { text: "go" }),
    ev(2, "agent-update", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read" }),
  ]);
  const after = foldEvent(
    before,
    ev(3, "agent-update", {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    }),
  );
  expect(after).not.toBe(before);
  expect(after.items[0]).toBe(before.items[0]); // untouched user item: same ref
  expect(after.items[1]).not.toBe(before.items[1]); // merged tool item: new ref
});

// ─── (d) permission request + answer roundtrip ───────────────────────────────

const permReq = {
  toolCall: { toolCallId: "t9", title: "Run rm -rf ./dist", kind: "execute" },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
};

test("permission request then selected answer", () => {
  const t = fold([
    ev(1, "permission-request", permReq),
    ev(2, "permission-answer", { requestSeq: 1, optionId: "allow" }),
  ]);

  expect(t.items).toEqual([
    {
      kind: "permission",
      seq: 1,
      requestSeq: 1,
      title: "Run rm -rf ./dist",
      toolKind: "execute",
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
      answer: { optionId: "allow", cancelled: undefined, auto: undefined },
    },
  ]);
});

test("permission answer with cancelled:true", () => {
  const t = fold([
    ev(1, "permission-request", permReq),
    ev(2, "permission-answer", { requestSeq: 1, cancelled: true }),
  ]);
  expect(t.items[0]).toMatchObject({ kind: "permission", answer: { cancelled: true } });
});

test("auto-approved permission (accept-edits/full-auto) carries auto:true", () => {
  const t = fold([
    ev(1, "permission-request", { ...permReq, auto: true }),
    ev(2, "permission-answer", { requestSeq: 1, optionId: "allow", auto: true }),
  ]);
  expect(t.items[0]).toMatchObject({
    kind: "permission",
    answer: { optionId: "allow", auto: true },
  });
});

test("permission answer for an unknown requestSeq is ignored", () => {
  const t = fold([ev(1, "permission-answer", { requestSeq: 99, optionId: "allow" })]);
  expect(t.items).toEqual([]);
  expect(t.lastSeq).toBe(1);
});

test("permission title falls back to the tool name when title is missing", () => {
  const t = fold([
    ev(1, "permission-request", {
      toolCall: { toolCallId: "t9", name: "bash" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    }),
  ]);
  expect(t.items[0]).toMatchObject({ kind: "permission", title: "bash" });
});

// ─── (e) duplicates and seq-0 synthetic events ───────────────────────────────

test("duplicate seq delivery is a no-op returning the same object reference", () => {
  const t1 = fold([chunk(1, "he"), chunk(2, "llo")]);
  const t2 = foldEvent(t1, chunk(2, "llo"));
  expect(t2).toBe(t1);
  const t3 = foldEvent(t1, chunk(1, "he"));
  expect(t3).toBe(t1);
});

test("seq-0 synthetic error adds a notice but does not move lastSeq", () => {
  const before = fold([chunk(1, "hi")]);
  const after = foldEvent(before, ev(0, "error", { message: "connection lost" }));
  expect(after.items.at(-1)).toEqual({
    kind: "notice",
    seq: 0,
    level: "error",
    text: "connection lost",
  });
  expect(after.lastSeq).toBe(1);
});

test("persisted error event adds an error notice and advances lastSeq", () => {
  const t = fold([ev(1, "error", { message: "spawn failed: ENOENT" })]);
  expect(t.items).toEqual([
    { kind: "notice", seq: 1, level: "error", text: "spawn failed: ENOENT" },
  ]);
  expect(t.lastSeq).toBe(1);
});

// ─── (f) ended state ─────────────────────────────────────────────────────────

test("ended state appends an info notice with the reason", () => {
  const t = fold([ev(1, "state", { status: "ended", reason: "agent exited" })]);
  expect(t.status).toBe("ended");
  expect(t.items).toEqual([
    { kind: "notice", seq: 1, level: "info", text: "Session ended — agent exited" },
  ]);
});

test("ended state without a reason uses the plain copy; other states push nothing", () => {
  const ended = fold([ev(1, "state", { status: "ended" })]);
  expect(ended.items).toEqual([{ kind: "notice", seq: 1, level: "info", text: "Session ended." }]);

  const working = fold([ev(1, "state", { status: "working" })]);
  expect(working.status).toBe("working");
  expect(working.items).toEqual([]);
});

test("ended state closes any open streaming items", () => {
  const t = fold([chunk(1, "partial"), ev(2, "state", { status: "ended", reason: "cancelled" })]);
  expect(t.items[0]).toMatchObject({ kind: "assistant", text: "partial", streaming: false });
});

// ─── (g) optimistic pending prompt ───────────────────────────────────────────

test("optimistic pending prompt is replaced by the real user-prompt event, not duplicated", () => {
  const withPending = addPendingPrompt(fold([ev(1, "state", { status: "idle" })]), "do the thing");
  expect(withPending.items).toEqual([
    { kind: "user", seq: -1, text: "do the thing", pending: true },
  ]);
  expect(withPending.lastSeq).toBe(1); // pending prompt never moves the cursor

  const t = foldEvent(withPending, ev(2, "user-prompt", { text: "do the thing" }));
  expect(t.items).toEqual([{ kind: "user", seq: 2, text: "do the thing" }]);
  expect(t.lastSeq).toBe(2);
});

test("user-prompt without a pending item pushes normally and closes streaming items", () => {
  const t = fold([chunk(1, "old answer"), ev(2, "user-prompt", { text: "next question" })]);
  expect(t.items).toEqual([
    { kind: "assistant", seq: 1, text: "old answer", streaming: false },
    { kind: "user", seq: 2, text: "next question" },
  ]);
});

// ─── forward compat / malformed payloads ─────────────────────────────────────

test("unknown sessionUpdate values and malformed payloads are ignored but still advance lastSeq", () => {
  const t = fold([
    ev(1, "agent-update", { sessionUpdate: "plan", entries: [] }),
    ev(2, "agent-update", { sessionUpdate: "shiny_new_update", stuff: true }),
    ev(3, "agent-update", null),
    ev(4, "agent-update", "not an object"),
    ev(5, "user-prompt", { text: 42 }),
    ev(6, "state", { status: "hyperspace" }),
    ev(7, "error", { message: 7 }),
    ev(8, "agent-update", { sessionUpdate: "agent_message_chunk", content: { type: "image" } }),
  ]);
  expect(t.items).toEqual([]);
  expect(t.status).toBe("starting");
  expect(t.lastSeq).toBe(8);
});

test("emptyTranscript starts at seq 0, starting status, no usage", () => {
  const t = emptyTranscript();
  expect(t).toEqual({ items: [], lastSeq: 0, status: "starting", usage: undefined });
});
