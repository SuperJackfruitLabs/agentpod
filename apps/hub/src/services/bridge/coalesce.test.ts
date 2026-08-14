/**
 * The coalescer is the seam's own property, not an optimisation.
 *
 * Spike RQ1, measured against live stations on the same trivial prompt
 * ("List the files in this directory, then stop."):
 *
 *   | harness | ACP events | activities at 1:1 |
 *   | Codex   |         57 |                48 |
 *   | Hermes  |      1,051 |             1,045 |
 *
 * An 18x spread between two harnesses running the SAME instruction, so no fixed
 * rate limit fits both. These tests are written against those numbers rather
 * than against round ones, and the load-bearing assertion is not a threshold at
 * all: it is that the activity count depends on the CONTENT, not on how finely
 * the harness chose to chunk it.
 */

import { describe, expect, test } from "bun:test";
import type { AcpEvent } from "@agentpod/contract";

import { ActivityCoalescer } from "./coalesce";

// ─── measured event volumes (spike findings, RQ1) ────────────────────────────

const HERMES_MESSAGE_CHUNKS = 840;
const HERMES_THOUGHT_CHUNKS = 202;
const HERMES_TOTAL_EVENTS = 1051;
const CODEX_TOTAL_EVENTS = 57;

let seq = 0;
const ev = (type: AcpEvent["type"], payload: unknown): AcpEvent => ({
  sessionId: "acps_11111111-2222-3333-4444-555555555555",
  seq: ++seq,
  type,
  payload,
  createdAt: "2026-08-14T00:00:00.000Z",
});

const chunk = (kind: "agent_message_chunk" | "agent_thought_chunk", text: string): AcpEvent =>
  ev("agent-update", { sessionUpdate: kind, content: { type: "text", text } });

const toolCall = (id: string, title: string): AcpEvent =>
  ev("agent-update", { sessionUpdate: "tool_call", toolCallId: id, title, kind: "read", rawInput: { path: "." } });

const toolUpdate = (id: string, status: string): AcpEvent =>
  ev("agent-update", { sessionUpdate: "tool_call_update", toolCallId: id, status, rawOutput: status });

/**
 * Split `text` into exactly `n` chunks, the way a token-streaming harness does.
 * Lossless and gapless: concatenating the chunks reproduces `text` exactly, so
 * a difference between two chunkings is the projection's, not the helper's.
 */
function streamed(kind: "agent_message_chunk" | "agent_thought_chunk", text: string, n: number): AcpEvent[] {
  const out: AcpEvent[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor((i * text.length) / n);
    const end = Math.floor(((i + 1) * text.length) / n);
    out.push(chunk(kind, text.slice(start, end)));
  }
  return out;
}

function drain(events: AcpEvent[], c = new ActivityCoalescer()) {
  const out = events.flatMap((e) => c.push(e));
  return [...out, ...c.flush()];
}

const MESSAGE = "Here are the files in this directory: a.ts, b.ts, c.ts. ".repeat(40);
const REASONING = "I should list the directory and then stop as instructed. ".repeat(10);

describe("ActivityCoalescer — volume", () => {
  test("the same content chunked 1,042 ways and 3 ways produces the same activities", () => {
    // THE INVARIANT. The two harnesses ran the same prompt; only the streaming
    // granularity differed. If the projection is sensitive to that, the board
    // gets a different story from each harness for identical work — and one of
    // them gets it a thousand posts at a time.
    const hermes = drain([
      ...streamed("agent_thought_chunk", REASONING, HERMES_THOUGHT_CHUNKS),
      ...streamed("agent_message_chunk", MESSAGE, HERMES_MESSAGE_CHUNKS),
    ]);
    const codex = drain([
      ...streamed("agent_thought_chunk", REASONING, 1),
      ...streamed("agent_message_chunk", MESSAGE, 2),
    ]);

    expect(hermes).toEqual(codex);
  });

  test("Hermes's measured 1,051-event run posts fewer than 40 activities", () => {
    // 1,045 at 1:1 was the spike's number. Removing the coalescer must fail
    // HERE, on volume — not merely on the shape of one activity.
    const events = [
      ...streamed("agent_thought_chunk", REASONING, HERMES_THOUGHT_CHUNKS),
      ...streamed("agent_message_chunk", MESSAGE, HERMES_MESSAGE_CHUNKS),
      toolCall("t1", "Read ."),
      toolUpdate("t1", "completed"),
      ev("agent-update", { sessionUpdate: "usage_update", used: 18375, size: 262144 }),
      ev("agent-update", { sessionUpdate: "available_commands_update", availableCommands: [] }),
      ev("agent-update", { sessionUpdate: "session_info_update", threadStatus: { type: "idle" } }),
      ...streamed("agent_message_chunk", "Done.", 4),
    ];
    expect(events.length).toBeGreaterThan(HERMES_TOTAL_EVENTS - 60);

    const activities = drain(events);
    expect(activities.length).toBeLessThan(40);
  });

  test("the 18x spread between harnesses does not survive the projection", () => {
    const hermesEvents = [
      ...streamed("agent_thought_chunk", REASONING, HERMES_THOUGHT_CHUNKS),
      ...streamed("agent_message_chunk", MESSAGE, HERMES_MESSAGE_CHUNKS),
    ];
    const codexEvents = [
      ...streamed("agent_thought_chunk", REASONING, 5),
      ...streamed("agent_message_chunk", MESSAGE, 43),
    ];
    expect(hermesEvents.length / codexEvents.length).toBeGreaterThan(17);

    const ratio = drain(hermesEvents).length / drain(codexEvents).length;
    expect(ratio).toBe(1);
  });

  test("an unbroken stream is still bounded — the buffer flushes on size", () => {
    // The safety valve. A long single message must not become one 200 KB
    // activity body, and must not become 20,000 activities either.
    const activities = drain(streamed("agent_message_chunk", "x".repeat(200_000), 20_000));
    expect(activities.length).toBeGreaterThan(1);
    expect(activities.length).toBeLessThan(200);
    for (const a of activities) expect((a.body ?? "").length).toBeLessThan(10_000);
  });

  test("no text is lost or reordered by coalescing", () => {
    const activities = drain(streamed("agent_message_chunk", MESSAGE, HERMES_MESSAGE_CHUNKS));
    expect(activities.map((a) => a.body).join("")).toBe(MESSAGE);
  });
});

describe("ActivityCoalescer — boundaries", () => {
  test("a tool call is a boundary: text before it is not merged with text after", () => {
    const activities = drain([
      chunk("agent_message_chunk", "Looking at the file. "),
      toolCall("t1", "Read a.ts"),
      chunk("agent_message_chunk", "It defines two exports."),
    ]);
    expect(activities.map((a) => a.type)).toEqual(["response", "action", "response"]);
    expect(activities[0]!.body).toBe("Looking at the file. ");
    expect(activities[2]!.body).toBe("It defines two exports.");
  });

  test("reasoning and speech never merge into one activity", () => {
    // kaambaan has no reasoning affordance, so both land as text — but merging
    // them would put the agent's private reasoning inside what it said.
    const activities = drain([
      chunk("agent_thought_chunk", "The user wants a listing. "),
      chunk("agent_message_chunk", "Here are the files."),
    ]);
    expect(activities.map((a) => a.type)).toEqual(["thought", "response"]);
    expect(activities[0]!.ephemeral).toBe(true);
    expect(activities[1]!.ephemeral).toBeFalsy();
  });

  test("durable events are never coalesced with each other", () => {
    const activities = drain([toolCall("t1", "Read a"), toolCall("t2", "Read b"), toolCall("t3", "Read c")]);
    expect(activities).toHaveLength(3);
    expect(activities.map((a) => a.action)).toEqual(["Read a", "Read b", "Read c"]);
  });

  test("consecutive updates for one tool call collapse to its last state", () => {
    const activities = drain([
      toolCall("t1", "Run tests"),
      toolUpdate("t1", "in_progress"),
      toolUpdate("t1", "in_progress"),
      toolUpdate("t1", "completed"),
    ]);
    expect(activities).toHaveLength(2);
    expect(activities[1]!.result).toBe("completed");
  });

  test("flush emits the tail, so the last thing an agent said always reaches the board", () => {
    const c = new ActivityCoalescer();
    expect(c.push(chunk("agent_message_chunk", "All done."))).toEqual([]);
    expect(c.flush().map((a) => a.body)).toEqual(["All done."]);
    expect(c.flush()).toEqual([]);
  });
});

describe("ActivityCoalescer — projection", () => {
  test("a permission request carries its options where kaambaan actually stores them", () => {
    // The spike put them in `signalMetadata`, which the REST handler does not
    // read (kaambaan index.ts:390-403 destructures parameter/result/signal and
    // no metadata field), so the options were silently dropped on the wire.
    //
    // And they are translated on the way: kaambaan's option is `{name, title}`
    // and it echoes `name` back as the answer, so `name` has to be the ACP
    // optionId. Sending the ACP option verbatim would make the human's LABEL
    // the identity, and the answer would map to no option at all.
    const options = [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ];
    const request = ev("permission-request", { toolCall: { title: "Write a.ts" }, options });
    const [a] = drain([request]);
    expect(a!.type).toBe("elicitation");
    expect(a!.signal).toBe("select");
    expect(a!.parameter).toMatchObject({
      requestSeq: request.seq,
      options: [
        { name: "allow_once", title: "Allow once" },
        { name: "reject_once", title: "Reject" },
      ],
    });
    expect(a!.body).toContain("Write a.ts");
  });

  test("a permission request the hub already answered is NOT an elicitation", () => {
    // full-auto answers every request, and accept-edits answers the edit ones —
    // and both still persist a `permission-request` event, marked `auto`.
    // Projecting one as an elicitation moves the card to `input-required` and
    // waits for a human to decide something that was decided microseconds ago.
    const [a] = drain([
      ev("permission-request", {
        toolCall: { title: "Write a.ts" },
        options: [{ optionId: "allow_once", name: "Allow once" }],
        auto: true,
      }),
    ]);
    expect(a!.type).not.toBe("elicitation");
    expect(a!.signal).toBeUndefined();
  });

  test("an error projects durably", () => {
    const [a] = drain([ev("error", { message: "harness exited" })]);
    expect(a).toMatchObject({ type: "error", body: "harness exited" });
  });

  test("session lifecycle and command catalogues are dropped deliberately", () => {
    const c = new ActivityCoalescer();
    const dropped = drain(
      [
        ev("state", { status: "working" }),
        ev("agent-update", { sessionUpdate: "available_commands_update", availableCommands: [] }),
        ev("agent-update", { sessionUpdate: "session_info_update", title: "x" }),
        ev("agent-update", { sessionUpdate: "current_mode_update", currentModeId: "ask" }),
      ],
      c,
    );
    expect(dropped).toEqual([]);
    expect(c.unmapped()).toEqual([]);
  });

  test("an unrecognised update kind is recorded rather than silently dropped", () => {
    const c = new ActivityCoalescer();
    drain([ev("agent-update", { sessionUpdate: "some_future_kind" })], c);
    expect(c.unmapped()).toEqual(["agent-update:some_future_kind"]);
  });

  test("context occupancy warns once, above the threshold only", () => {
    // `usage_update` is {used, size} — how full the context is. NOT tokens and
    // NOT money: RQ5 found zero token or cost fields across 1,108 events.
    const c = new ActivityCoalescer();
    expect(drain([ev("agent-update", { sessionUpdate: "usage_update", used: 16256, size: 258400 })], c)).toEqual([]);

    const warned = c.push(ev("agent-update", { sessionUpdate: "usage_update", used: 230_000, size: 258_400 }));
    expect(warned).toHaveLength(1);
    expect(warned[0]!.ephemeral).toBeFalsy();
    expect(warned[0]!.body).toContain("89%");

    expect(c.push(ev("agent-update", { sessionUpdate: "usage_update", used: 240_000, size: 258_400 }))).toEqual([]);
    expect(c.contextPeak()).toEqual({ pct: 93, used: 240_000, size: 258_400 });
  });

  test("reasoning collapsing into text is recorded as a loss", () => {
    const c = new ActivityCoalescer();
    drain([chunk("agent_thought_chunk", "hmm")], c);
    expect(c.losses().join(" ")).toContain("agent_thought_chunk");
  });
});
