import { expect, test } from "bun:test";
import type { AcpEventType } from "./acp-session";
import { emptyTranscript, foldEvent, type ChatItem } from "./transcript";
import { foldEvidence, itemFirstSeq, type EvidenceItem } from "./transcript-evidence";

type Ev = { seq: number; type: AcpEventType | string; payload: unknown };
const ev = (seq: number, type: AcpEventType | string, payload: unknown): Ev => ({ seq, type, payload });
const chunk = (seq: number, text: string) =>
  ev(seq, "agent-update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const thought = (seq: number, text: string) =>
  ev(seq, "agent-update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
const fold = (events: Ev[]) => foldEvidence(events);

/** One realistic turn: the shape every harness produces, used by several tests below. */
const TURN: Ev[] = [
  ev(1, "state", { status: "idle" }),
  ev(2, "agent-update", { sessionUpdate: "available_commands_update", availableCommands: [] }),
  ev(3, "user-prompt", { text: "Fix the failing test", images: [{ name: "shot.png", mimeType: "image/png", bytes: "iVBORw0KGgo=" }] }),
  ev(4, "state", { status: "working" }),
  thought(5, "Look at "),
  thought(6, "the test."),
  chunk(7, "Running "),
  chunk(8, "it now."),
  ev(9, "agent-update", { sessionUpdate: "tool_call", toolCallId: "t1", title: "bun test", kind: "execute", status: "pending", rawInput: { command: "bun test" } }),
  ev(10, "permission-request", { toolCall: { toolCallId: "t1", title: "bun test", kind: "execute" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }),
  ev(11, "permission-answer", { requestSeq: 10, optionId: "allow" }),
  ev(12, "agent-update", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed", content: [{ type: "content", content: { type: "text", text: "1 failing" } }], rawOutput: { exitCode: 1 } }),
  chunk(13, "It fails."),
  ev(14, "agent-update", { sessionUpdate: "usage_update", used: 10, size: 100 }),
  ev(15, "error", { message: "quota exceeded", kind: "quota", harness: "x", source: "acp-rejection" }),
  ev(16, "state", { status: "ended", reason: "closed" }),
];

test("a whole turn folds into one item per fact, in order, with every seq it came from", () => {
  expect(fold(TURN)).toEqual([
    { kind: "state", seq: 1, status: "idle" },
    { kind: "other", seq: 2, type: "agent-update:available_commands_update" },
    { kind: "prompt", seq: 3, text: "Fix the failing test", images: [{ name: "shot.png", mimeType: "image/png" }] },
    { kind: "state", seq: 4, status: "working" },
    { kind: "reasoning", seq_from: 5, seq_to: 6, text: "Look at the test." },
    { kind: "message", seq_from: 7, seq_to: 8, text: "Running it now." },
    {
      kind: "tool_call", id: "t1", seq_from: 9, seq_to: 12, title: "bun test", tool_kind: "execute", status: "failed",
      input: { command: "bun test" },
      output: { content: [{ type: "content", content: { type: "text", text: "1 failing" } }], raw: { exitCode: 1 } },
    },
    {
      kind: "permission", seq: 10, answer_seq: 11, tool_call_id: "t1", title: "bun test",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }], outcome: "selected:allow",
    },
    { kind: "message", seq_from: 13, seq_to: 13, text: "It fails." },
    { kind: "other", seq: 14, type: "agent-update:usage_update" },
    { kind: "error", seq: 15, error_kind: "quota", message: "quota exceeded" },
    { kind: "state", seq: 16, status: "ended", reason: "closed" },
  ]);
});

test("image bytes never reach an item", () => {
  expect(JSON.stringify(fold(TURN))).not.toContain("iVBORw0KGgo=");
});

test("a secret split across two chunks is one string after folding", () => {
  const [item] = fold([chunk(1, "key sk-ant-api03-AAAAAAAAAA"), chunk(2, "BBBBBBBBBBBBBBBBBBBB done")]);
  expect(item).toMatchObject({ kind: "message", text: "key sk-ant-api03-AAAAAAAAAABBBBBBBBBBBBBBBBBBBB done" });
});

test("a tool call whose start lies before the range is still an item, marked partial", () => {
  const items = fold(TURN.filter((e) => e.seq >= 12));
  expect(items[0]).toEqual({
    kind: "tool_call", id: "t1", seq_from: 12, seq_to: 12, title: "t1", tool_kind: null, status: "failed",
    input: null,
    output: { content: [{ type: "content", content: { type: "text", text: "1 failing" } }], raw: { exitCode: 1 } },
    partial: true,
  });
});

test("an answer whose request lies before the range is a partial permission, starting at the answer", () => {
  const items = fold(TURN.filter((e) => e.seq >= 11));
  expect(items[0]).toEqual({
    kind: "permission", seq: 10, answer_seq: 11, title: "Permission request", options: [], outcome: "selected:allow", partial: true,
  });
  expect(itemFirstSeq(items[0]!)).toBe(11);
});

test("permission outcomes: cancelled, auto, pending", () => {
  const req = (seq: number) => ev(seq, "permission-request", { toolCall: { title: "edit" }, options: [] });
  const items = fold([
    req(1), ev(2, "permission-answer", { requestSeq: 1, cancelled: true }),
    req(3), ev(4, "permission-answer", { requestSeq: 3, optionId: "allow", auto: true }),
    req(5),
  ]);
  expect(items.map((i) => (i as Extract<EvidenceItem, { kind: "permission" }>).outcome)).toEqual(["cancelled", "auto", "pending"]);
});

test("a repeated tool_call upserts: one item per toolCallId", () => {
  const items = fold([
    ev(1, "agent-update", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", rawInput: { path: "a" } }),
    ev(2, "agent-update", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read again", status: "in_progress" }),
  ]);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ seq_from: 1, seq_to: 2, title: "Read again", status: "in_progress", input: { path: "a" } });
});

test("nothing is dropped: unknown types, unknown updates and malformed payloads become `other`", () => {
  expect(fold([
    ev(1, "something-new", { x: 1 }),
    ev(2, "agent-update", { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "…" } }),
    ev(3, "user-prompt", "not an object"),
    ev(4, "agent-update", null),
    ev(5, "state", { status: 7 }),
  ])).toEqual([
    { kind: "other", seq: 1, type: "something-new" },
    { kind: "other", seq: 2, type: "agent-update:agent_message_chunk" },
    { kind: "other", seq: 3, type: "user-prompt" },
    { kind: "other", seq: 4, type: "agent-update" },
    { kind: "other", seq: 5, type: "state" },
  ]);
});

test("items are in ascending first-seq order, and no two share one", () => {
  const firsts = fold([...TURN, ...TURN.filter((e) => e.seq >= 11).map((e) => ({ ...e, seq: e.seq + 100 }))]).map(itemFirstSeq);
  expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
  expect(new Set(firsts).size).toBe(firsts.length);
});

/**
 * The console and the evidence agree about the conversation. Projected to what both show —
 * who spoke, from which seq, and what — the two folds of one log must match. If a rule in
 * `foldEvent` changes, this goes red until the evidence fold follows (or the change is
 * recorded as a deliberate difference).
 */
test("parity: the evidence fold and the console's foldEvent agree about the conversation", () => {
  const chat = TURN.reduce((t, e) => foldEvent(t, { ...e, sessionId: "s", createdAt: "2026-10-06T00:00:00Z" } as never), emptyTranscript());
  const fromConsole = chat.items.flatMap((it: ChatItem) =>
    it.kind === "user" ? [["prompt", it.seq, it.text]]
    : it.kind === "assistant" ? [["message", it.seq, it.text]]
    : it.kind === "reasoning" ? [["reasoning", it.seq, it.text]]
    : it.kind === "tool" ? [["tool_call", it.seq, `${it.title}/${it.status}`]]
    : it.kind === "permission" ? [["permission", it.seq, it.title]]
    : it.level === "error" ? [["error", it.seq, it.text]]
    : [],
  );
  const fromEvidence = fold(TURN).flatMap((it) =>
    it.kind === "prompt" ? [["prompt", it.seq, it.text]]
    : it.kind === "message" || it.kind === "reasoning" ? [[it.kind, it.seq_from, it.text]]
    : it.kind === "tool_call" ? [["tool_call", it.seq_from, `${it.title}/${it.status}`]]
    : it.kind === "permission" ? [["permission", it.seq, it.title]]
    : it.kind === "error" ? [["error", it.seq, it.message]]
    : [],
  );
  expect(fromEvidence).toEqual(fromConsole);
});
