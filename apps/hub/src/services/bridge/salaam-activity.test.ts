import { expect, test } from "bun:test";
import { SalaamActivityFeed } from "./salaam-activity";
import { ActivityCoalescer } from "./coalesce";

const step = (
  seq: number,
  phase: "started" | "finished",
  id: string,
  extra: Record<string, unknown> = {},
) => ({
  seq,
  phase,
  tool_call_id: id,
  title: "fetch · fetch",
  kind: phase === "started" ? "fetch" : null,
  input: phase === "started" ? JSON.stringify({ action: "call", tool: "fetch" }) : null,
  failed: false,
  ...extra,
});

test("salaam tool steps become the same card actions a streamed ACP tool call does", () => {
  const feed = new SalaamActivityFeed();
  const out = feed.next([step(1, "started", "a"), step(2, "finished", "a")]);
  // The reference: what the coalescer posts for the equivalent live ACP tool call.
  const live = new ActivityCoalescer();
  const expected = [
    ...live.push({
      sessionId: "s",
      seq: 1,
      type: "agent-update",
      createdAt: "",
      payload: {
        sessionUpdate: "tool_call",
        toolCallId: "a",
        title: "fetch · fetch",
        kind: "fetch",
        status: "in_progress",
        rawInput: { action: "call", tool: "fetch" },
      },
    }),
    ...live.push({
      sessionId: "s",
      seq: 2,
      type: "agent-update",
      createdAt: "",
      payload: { sessionUpdate: "tool_call_update", toolCallId: "a", title: "fetch · fetch", status: "completed" },
    }),
    ...live.flush(),
  ];
  expect(out).toEqual(expected);
  expect(out).toEqual([
    { type: "action", action: "fetch · fetch", parameter: { action: "call", tool: "fetch" } },
  ]);
});

test("each step is posted once across polls, a failure is posted, and a bad tail posts nothing", () => {
  const feed = new SalaamActivityFeed();
  const first = [step(1, "started", "a"), step(2, "finished", "a"), step(3, "started", "b")];
  expect(feed.next(first)).toHaveLength(2);
  // The next poll overlaps the last; only new steps are posted.
  const again = feed.next([...first, step(4, "finished", "b", { failed: true })]);
  expect(again).toEqual([{ type: "action", action: "fetch · fetch", result: "failed" }]);
  expect(feed.next([...first, step(4, "finished", "b", { failed: true })])).toEqual([]);
  // Anything but the exact tail shape is ignored rather than guessed at.
  expect(feed.next([{ ...step(9, "started", "c"), extra: 1 }])).toEqual([]);
  expect(feed.next("not a tail")).toEqual([]);
  expect(feed.next(undefined)).toEqual([]);
  // A non-JSON input is shown as the text it is.
  expect(feed.next([step(10, "started", "d", { input: "plain" })])).toEqual([
    { type: "action", action: "fetch · fetch", parameter: "plain" },
  ]);
});

test("a feed restored after a restart starts after the last posted step", () => {
  const feed = new SalaamActivityFeed(2);
  expect(feed.next([step(1, "started", "a"), step(2, "finished", "a"), step(3, "started", "b")])).toHaveLength(1);
  expect(feed.cursor()).toBe(3);
});

test("the plan reaches the card as a durable thought, once per change", () => {
  const feed = new SalaamActivityFeed();
  const plan = (status: string) => ({
    sessionUpdate: "plan",
    entries: [
      { content: "Read RFC 9110", priority: "medium", status },
      { content: "Write answer.md", priority: "medium", status: "pending" },
    ],
  });
  // Not ephemeral: superpipeline leaves ephemeral activities out of a card's activity list.
  expect(feed.plan(plan("pending"))).toEqual([
    { type: "thought", body: "Plan:\n1. Read RFC 9110 (pending)\n2. Write answer.md (pending)" },
  ]);
  expect(feed.plan(plan("pending"))).toEqual([]);
  expect(feed.plan(plan("in_progress"))).toEqual([
    { type: "thought", body: "Plan:\n1. Read RFC 9110 (in progress)\n2. Write answer.md (pending)" },
  ]);
  expect(feed.plan({ sessionUpdate: "plan", entries: "nope" })).toEqual([]);
  expect(feed.plan(null)).toEqual([]);
});
