/**
 * The fleet's live state, per reader — pure: events in, ContentState out.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FleetContentState } from "@agentpod/contract";

import {
  ACTIVE_WITHIN_MS,
  NAME_MAX,
  TURN_SILENT_MAX_MS,
  applyFleetEvent,
  contentState,
  emptyFleet,
  endedOnFinish,
  inlineGateOptions,
  inlinePermissionOptions,
  isFleetActive,
  nextExpiry,
  pruneFleet,
  type FleetEvent,
  type FleetState,
} from "./state";

const FIXTURE = join(import.meta.dir, "../../../../../../packages/contract/fixtures/fleet-content-state.json");

const s = (unix: number) => unix * 1000;

function run(events: FleetEvent[], from: FleetState = emptyFleet()) {
  let state = from;
  const changes: string[] = [];
  for (const e of events) {
    const r = applyFleetEvent(state, e);
    state = r.state;
    changes.push(r.change);
  }
  return { state, changes };
}

const permission = (roomId: string, agent: string, at: number, question = "Run git push origin main?") =>
  ({
    type: "decision-asked",
    decision: {
      key: `perm:${roomId}`,
      roomId,
      eventId: "$perm1",
      agent,
      kind: "permission",
      question,
      options: inlinePermissionOptions([
        { optionId: "allow_once", name: "Allow once" },
        { optionId: "allow_always", name: "Allow always" },
        { optionId: "reject_once", name: "Reject" },
      ]),
      askedAt: at,
    },
  }) as const;

describe("the shared fixture", () => {
  test("is exactly what the hub builds from the events behind it", () => {
    const { state } = run([
      // Echo finished earlier and is still inside the active window: counted in `more`.
      { type: "turn-started", roomId: "!echo:hs", name: "Analyst Echo", at: s(1790669300) },
      { type: "turn-finished", roomId: "!echo:hs", name: "Analyst Echo", total: 2, failed: 0, at: s(1790669400) },
      { type: "turn-started", roomId: "!quill:hs", name: "Writer Quill", at: s(1790669450) },
      { type: "step", roomId: "!quill:hs", name: "Writer Quill", title: "Build", completed: 3, total: 4, at: s(1790669480) },
      {
        type: "turn-finished",
        roomId: "!quill:hs",
        name: "Writer Quill",
        total: 7,
        failed: 1,
        failedAt: 4,
        at: s(1790669500),
      },
      { type: "turn-started", roomId: "!lyra:hs", name: "Artistic Lyra", at: s(1790669880) },
      {
        type: "step",
        roomId: "!lyra:hs",
        name: "Artistic Lyra",
        title: "Running the tests",
        completed: 3,
        total: 7,
        at: s(1790670100),
      },
      { type: "turn-started", roomId: "!ray:hs", name: "Research Ray", at: s(1790670000) },
      permission("!ray:hs", "Research Ray", s(1790670050)),
    ]);
    const fixtureText = readFileSync(FIXTURE, "utf8");
    const built = contentState(state, s(1790670123));
    expect(built).toEqual(JSON.parse(fixtureText));
    // Key order too — the app decodes by key, but a reviewer diffs by eye.
    expect(JSON.stringify(built)).toBe(JSON.stringify(JSON.parse(fixtureText)));
    expect(FleetContentState.parse(built)).toEqual(built);
  });
});

describe("transitions", () => {
  const room = "!a:hs";
  const name = "Lyra";

  test("a turn starting makes the agent working, since the turn's start", () => {
    const { state, changes } = run([{ type: "turn-started", roomId: room, name, at: s(100) }]);
    const cs = contentState(state, s(110));
    expect(cs.agents).toEqual([{ roomId: room, name, state: "working", since: 100 }]);
    expect(cs.working).toBe(1);
    expect(changes).toEqual(["routine"]);
  });

  test("a step moves the title and the counts, and is routine", () => {
    const { state, changes } = run([
      { type: "turn-started", roomId: room, name, at: s(100) },
      { type: "step", roomId: room, name, title: "Reading files", completed: 1, total: 2, at: s(105) },
    ]);
    expect(contentState(state, s(110)).agents[0]).toEqual({
      roomId: room,
      name,
      state: "working",
      step: "Reading files",
      completed: 1,
      total: 2,
      since: 100,
    });
    expect(changes).toEqual(["routine", "routine"]);
  });

  test("words with no turn start one (an unprompted agent speaking)", () => {
    const { state } = run([{ type: "spoke", roomId: room, name, at: s(100) }]);
    expect(contentState(state, s(101)).agents[0]!.state).toBe("working");
  });

  test("working again after a permission pause is the same turn", () => {
    const { state } = run([
      { type: "turn-started", roomId: room, name, at: s(100) },
      { type: "turn-started", roomId: room, name, at: s(200) },
    ]);
    expect(contentState(state, s(201)).agents[0]!.since).toBe(100);
  });

  test("a turn finishing clean is done, with its step count, and is important", () => {
    const { state, changes } = run([
      { type: "turn-started", roomId: room, name, at: s(100) },
      { type: "turn-finished", roomId: room, name, total: 7, failed: 0, at: s(160) },
    ]);
    expect(contentState(state, s(170)).agents[0]).toEqual({
      roomId: room,
      name,
      state: "done",
      completed: 7,
      total: 7,
      since: 160,
    });
    expect(changes[1]).toBe("important");
  });

  test("a turn with a failed tool is failed, at the step that failed", () => {
    const { state } = run([
      { type: "turn-started", roomId: room, name, at: s(100) },
      { type: "turn-finished", roomId: room, name, total: 7, failed: 2, failedAt: 4, at: s(160) },
    ]);
    expect(contentState(state, s(170)).agents[0]).toMatchObject({
      state: "failed",
      step: "Failed at step 4 of 7",
      completed: 4,
      total: 7,
    });
  });

  test("a turn that errored with no tools is failed, with no step", () => {
    const { state } = run([
      { type: "turn-started", roomId: room, name, at: s(100) },
      { type: "turn-finished", roomId: room, name, total: 0, failed: 0, errored: true, at: s(160) },
    ]);
    expect(contentState(state, s(170)).agents[0]).toEqual({ roomId: room, name, state: "failed", since: 160 });
  });

  test("a turn that only talked is active, not done", () => {
    const { state } = run([
      { type: "turn-started", roomId: room, name, at: s(100) },
      { type: "turn-finished", roomId: room, name, total: 0, failed: 0, at: s(160) },
    ]);
    expect(contentState(state, s(170)).agents[0]).toEqual({ roomId: room, name, state: "active", since: 160 });
  });

  test("a permission makes its agent needs_you, first in the list, and is important", () => {
    const { state, changes } = run([
      { type: "turn-started", roomId: "!b:hs", name: "Other", at: s(300) },
      { type: "turn-started", roomId: room, name, at: s(100) },
      permission(room, name, s(150)),
    ]);
    const cs = contentState(state, s(310));
    expect(cs.agents.map((a) => [a.name, a.state])).toEqual([
      [name, "needs_you"],
      ["Other", "working"],
    ]);
    expect(cs.agents[0]).toEqual({ roomId: room, name, state: "needs_you", step: "Waiting for you", since: 100 });
    expect(cs.needsYou).toBe(1);
    expect(cs.working).toBe(1);
    expect(cs.decision).toMatchObject({ roomId: room, eventId: "$perm1", agent: name, kind: "permission" });
    expect(changes[2]).toBe("important");
  });

  test("the same decision asked twice is no change", () => {
    const { changes } = run([permission(room, name, s(1)), permission(room, name, s(2))]);
    expect(changes).toEqual(["important", "none"]);
  });

  test("a decision clearing flushes; clearing one that was never there does nothing", () => {
    const { state, changes } = run([
      { type: "turn-started", roomId: room, name, at: s(100) },
      permission(room, name, s(150)),
      { type: "decision-cleared", key: `perm:${room}` },
      { type: "decision-cleared", key: `perm:${room}` },
    ]);
    expect(changes.slice(2)).toEqual(["flush", "none"]);
    const cs = contentState(state, s(160));
    expect(cs.decision).toBeUndefined();
    expect(cs.agents[0]!.state).toBe("working");
  });

  test("the decision shown is the oldest; needsYou counts them all", () => {
    const { state } = run([
      permission("!late:hs", "Late", s(200), "Second?"),
      permission("!early:hs", "Early", s(100), "First?"),
      {
        type: "decision-asked",
        decision: {
          key: "gate:g1",
          roomId: "!board:hs",
          eventId: "$gate",
          agent: "lyra",
          kind: "gate",
          question: 'Approve "Ship it"?',
          options: inlineGateOptions([
            { id: "approve", label: "Approve" },
            { id: "request_changes", label: "Request changes" },
            { id: "reject", label: "Reject" },
          ]),
          askedAt: s(300),
          boardId: "brd_1",
        },
      },
    ]);
    const cs = contentState(state, s(301));
    expect(cs.decision!.question).toBe("First?");
    expect(cs.needsYou).toBe(3);
  });

  test("a gate is a decision, not an agent row", () => {
    const { state } = run([
      {
        type: "decision-asked",
        decision: {
          key: "gate:g1",
          roomId: "!board:hs",
          eventId: "$gate",
          agent: "lyra",
          kind: "gate",
          question: "Approve?",
          options: [],
          askedAt: s(300),
          boardId: "brd_1",
        },
      },
    ]);
    const cs = contentState(state, s(301));
    expect(cs.agents).toEqual([]);
    expect(cs.needsYou).toBe(1);
    expect(isFleetActive(state, s(99_999))).toBe(true);
  });

  test("a new turn forgets the last one's outcome", () => {
    const { state } = run([
      { type: "turn-started", roomId: room, name, at: s(100) },
      { type: "turn-finished", roomId: room, name, total: 3, failed: 1, failedAt: 2, at: s(110) },
      { type: "turn-started", roomId: room, name, at: s(120) },
    ]);
    expect(contentState(state, s(121)).agents[0]).toEqual({ roomId: room, name, state: "working", since: 120 });
  });
});

describe("options", () => {
  test("a permission offers allow-once and reject inline, by name — never allow-always", () => {
    expect(
      inlinePermissionOptions([
        { optionId: "allow_always", name: "Allow always" },
        { optionId: "allow_once", name: "Allow once" },
        { optionId: "reject_always", name: "Reject always" },
        { optionId: "reject_once", name: "Reject" },
      ])
    ).toEqual([
      { id: "Allow once", label: "Allow once", declines: false },
      { id: "Reject", label: "Reject", declines: true },
    ]);
    expect(inlinePermissionOptions([{ optionId: "a", name: "Allow always" }])).toEqual([]);
    expect(inlinePermissionOptions([{ optionId: "d", name: "Deny" }])).toEqual([{ id: "Deny", label: "Deny", declines: true }]);
  });

  test("a gate offers approve and reject inline; request changes needs the app", () => {
    expect(
      inlineGateOptions([
        { id: "approve", label: "Approve" },
        { id: "request_changes", label: "Request changes" },
        { id: "reject", label: "Reject" },
      ])
    ).toEqual([
      { id: "approve", label: "Approve", declines: false },
      { id: "reject", label: "Reject", declines: true },
    ]);
  });
});

describe("quiet", () => {
  const room = "!a:hs";

  test("an agent stays active for 15 minutes after it last did something, then drops out", () => {
    const { state } = run([
      { type: "turn-started", roomId: room, name: "Lyra", at: s(100) },
      { type: "turn-finished", roomId: room, name: "Lyra", total: 1, failed: 0, at: s(200) },
    ]);
    expect(isFleetActive(state, s(200) + ACTIVE_WITHIN_MS)).toBe(true);
    expect(isFleetActive(state, s(200) + ACTIVE_WITHIN_MS + 1)).toBe(false);
    expect(contentState(state, s(200) + ACTIVE_WITHIN_MS + 1).agents).toEqual([]);
    expect(nextExpiry(state, s(250))).toBe(s(200) + ACTIVE_WITHIN_MS + 1);
    expect(endedOnFinish(state)).toBe(true);
  });

  test("a working turn keeps the fleet active past the window, but not forever", () => {
    const { state } = run([{ type: "turn-started", roomId: room, name: "Lyra", at: s(100) }]);
    expect(isFleetActive(state, s(100) + ACTIVE_WITHIN_MS + 60_000)).toBe(true);
    expect(isFleetActive(state, s(100) + TURN_SILENT_MAX_MS + 1)).toBe(false);
    expect(nextExpiry(state, s(101))).toBe(s(100) + TURN_SILENT_MAX_MS + 1);
  });

  test("a pending decision keeps the fleet active however long it waits", () => {
    const { state } = run([permission(room, "Lyra", s(100))]);
    expect(isFleetActive(state, s(100) + 10 * TURN_SILENT_MAX_MS)).toBe(true);
    expect(nextExpiry(state, s(101))).toBeNull();
  });

  test("the last thing being words, not a finished turn, ends at once", () => {
    const { state } = run([
      { type: "turn-started", roomId: room, name: "Lyra", at: s(100) },
      { type: "turn-finished", roomId: room, name: "Lyra", total: 0, failed: 0, at: s(200) },
    ]);
    expect(endedOnFinish(state)).toBe(false);
  });

  test("pruning forgets agents past the window and keeps the rest", () => {
    const { state } = run([
      { type: "turn-started", roomId: "!old:hs", name: "Old", at: s(100) },
      { type: "turn-finished", roomId: "!old:hs", name: "Old", total: 1, failed: 0, at: s(100) },
      { type: "turn-started", roomId: room, name: "Lyra", at: s(1_000) },
    ]);
    const pruned = pruneFleet(state, s(100) + ACTIVE_WITHIN_MS + 1);
    expect([...pruned.agents.keys()]).toEqual([room]);
  });
});

describe("bounds", () => {
  test("three agents at most, the rest counted in `more`", () => {
    const events: FleetEvent[] = [];
    for (let i = 0; i < 5; i++) events.push({ type: "turn-started", roomId: `!r${i}:hs`, name: `A${i}`, at: s(100 + i) });
    const cs = contentState(run(events).state, s(200));
    expect(cs.agents.map((a) => a.name)).toEqual(["A4", "A3", "A2"]);
    expect(cs.more).toBe(2);
    expect(cs.working).toBe(5);
  });

  test("long text is cut to its bound with an ellipsis, counted in characters", () => {
    const { state } = run([
      { type: "turn-started", roomId: "!a:hs", name: "N".repeat(100), at: s(100) },
      { type: "step", roomId: "!a:hs", name: "N".repeat(100), title: "🔧".repeat(100), completed: 0, total: 1, at: s(101) },
      permission("!b:hs", "Ray", s(102), "q".repeat(500)),
    ]);
    const cs = contentState(state, s(103));
    const working = cs.agents.find((a) => a.state === "working")!;
    expect([...working.step!].length).toBe(60);
    expect(working.step!.endsWith("…")).toBe(true);
    expect([...working.name].length).toBe(NAME_MAX);
    expect([...cs.decision!.question].length).toBe(120);
    expect(FleetContentState.safeParse(cs).success).toBe(true);
  });

  test("whitespace in a step title is collapsed to one line", () => {
    const { state } = run([
      { type: "turn-started", roomId: "!a:hs", name: "Lyra", at: s(100) },
      { type: "step", roomId: "!a:hs", name: "Lyra", title: "  Run\n\n tests  ", completed: 0, total: 1, at: s(101) },
    ]);
    expect(contentState(state, s(102)).agents[0]!.step).toBe("Run tests");
  });

  test("an option whose id is too long to answer with is dropped, not cut", () => {
    expect(inlinePermissionOptions([{ optionId: "a", name: `Allow once ${"x".repeat(100)}` }])).toEqual([]);
  });
});
