// What the Matrix path does with an ACP update kind it does not handle.
//
// It used to do nothing at all — no default case, no log, no record — which is
// how `tool_call` came to be discarded for the entire life of the bridge
// without a single line anywhere saying so. The kaambaan coalescer keeps
// `unmapped()`/`losses()` for exactly this reason, and lists its dropped kinds
// explicitly "so a NEW kind shows up in `unmapped()` instead of joining this
// set by accident" (`bridge/coalesce.ts:53-62`). This is that discipline, on
// the path that lacked it.

import { beforeEach, describe, expect, it } from "bun:test";
import { PermissionRequestEvent, TurnActivity, type ToolStatus } from "@agentpod/contract";
import {
  _resetUnmappedForTest,
  foldToolUpdate,
  noteUnmappedKind,
  permissionRequestContent,
  TURN_TOOLS_MAX,
  turnActivityContent,
  unmappedKinds,
  type ToolRecord,
} from "./activity";

describe("unmapped session update kinds", () => {
  beforeEach(() => {
    _resetUnmappedForTest();
  });

  it("has nothing to report before anything unknown arrives", () => {
    expect(unmappedKinds()).toEqual([]);
  });

  it("reports a kind it has never seen, so the caller can log it once", () => {
    expect(noteUnmappedKind("plan")).toBe(true);
    expect(unmappedKinds()).toEqual(["plan"]);
  });

  it("does not report the same kind twice, so a busy session logs once", () => {
    // A single turn emits hundreds of the same update. A line per event would
    // bury the signal this exists to raise.
    expect(noteUnmappedKind("plan")).toBe(true);
    expect(noteUnmappedKind("plan")).toBe(false);
    expect(noteUnmappedKind("plan")).toBe(false);
    expect(unmappedKinds()).toEqual(["plan"]);
  });

  it("keeps kinds sorted, so two runs of the same fleet read the same", () => {
    noteUnmappedKind("usage_update");
    noteUnmappedKind("current_mode_update");
    noteUnmappedKind("plan");
    expect(unmappedKinds()).toEqual(["current_mode_update", "plan", "usage_update"]);
  });

  it("ignores a kind that is not a string, rather than recording garbage", () => {
    // `payload.sessionUpdate` comes off a `z.unknown()` payload — nothing
    // upstream promises it is a string, or present at all.
    expect(noteUnmappedKind(undefined as unknown as string)).toBe(false);
    expect(noteUnmappedKind(42 as unknown as string)).toBe(false);
    expect(noteUnmappedKind("")).toBe(false);
    expect(unmappedKinds()).toEqual([]);
  });
});

// Folding `tool_call` / `tool_call_update` into a turn's record.
//
// The rule that matters is **upsert, never append**, and the console records
// why at `transcript.ts:299-305`: a buggy or hostile agent repeating a
// `toolCallId` must merge rather than produce two records with one identity.
describe("folding tool calls", () => {
  it("records a tool call", () => {
    const tools = new Map<string, ToolRecord>();
    const record = foldToolUpdate(tools, {
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Read src/main.ts",
      kind: "read",
      status: "in_progress",
      locations: [{ path: "src/main.ts" }],
    });

    expect(record).toEqual({
      id: "c1",
      title: "Read src/main.ts",
      kind: "read",
      status: "in_progress",
      locations: ["src/main.ts"],
    });
    expect(tools.size).toBe(1);
  });

  it("merges an update onto the call it belongs to", () => {
    const tools = new Map<string, ToolRecord>();
    foldToolUpdate(tools, {
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Run tests",
      status: "pending",
    });
    const record = foldToolUpdate(tools, {
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "failed",
    });

    // The title survives an update that did not carry one: a ticker that
    // forgets what it is doing halfway through is worse than one a moment stale.
    expect(record).toMatchObject({ id: "c1", title: "Run tests", status: "failed" });
    expect(tools.size).toBe(1);
  });

  it("merges a repeated tool_call id rather than recording it twice", () => {
    const tools = new Map<string, ToolRecord>();
    foldToolUpdate(tools, { sessionUpdate: "tool_call", toolCallId: "c1", title: "First" });
    foldToolUpdate(tools, { sessionUpdate: "tool_call", toolCallId: "c1", title: "Second" });

    expect(tools.size).toBe(1);
    expect(tools.get("c1")?.title).toBe("Second");
  });

  it("keeps the order tools were first used in", () => {
    const tools = new Map<string, ToolRecord>();
    foldToolUpdate(tools, { sessionUpdate: "tool_call", toolCallId: "z", title: "Z" });
    foldToolUpdate(tools, { sessionUpdate: "tool_call", toolCallId: "a", title: "A" });
    // An update to the earlier call must not move it to the end.
    foldToolUpdate(tools, { sessionUpdate: "tool_call_update", toolCallId: "z", status: "completed" });

    expect([...tools.keys()]).toEqual(["z", "a"]);
  });

  it("ignores a call with no id, since nothing could merge onto it", () => {
    const tools = new Map<string, ToolRecord>();
    expect(foldToolUpdate(tools, { sessionUpdate: "tool_call", title: "Nameless" })).toBeNull();
    expect(tools.size).toBe(0);
  });

  it("ignores anything that is not a tool update", () => {
    const tools = new Map<string, ToolRecord>();
    expect(foldToolUpdate(tools, { sessionUpdate: "agent_message_chunk" })).toBeNull();
    expect(foldToolUpdate(tools, null)).toBeNull();
    expect(foldToolUpdate(tools, "nonsense")).toBeNull();
    expect(tools.size).toBe(0);
  });

  it("defaults a status nobody sent, rather than inventing one", () => {
    const tools = new Map<string, ToolRecord>();
    const record = foldToolUpdate(tools, { sessionUpdate: "tool_call", toolCallId: "c1" });
    expect(record?.status).toBe("pending");
    // And falls back to the id when there is no title at all, so a card can
    // never render a nameless row.
    expect(record?.title).toBe("c1");
  });

  it("ignores a status outside ACP's vocabulary", () => {
    const tools = new Map<string, ToolRecord>();
    foldToolUpdate(tools, { sessionUpdate: "tool_call", toolCallId: "c1", status: "completed" });
    const record = foldToolUpdate(tools, {
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "cancelled",
    });
    expect(record?.status).toBe("completed");
  });

  it("reads location paths and skips entries that have none", () => {
    const tools = new Map<string, ToolRecord>();
    const record = foldToolUpdate(tools, {
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      locations: [{ path: "a.ts" }, { line: 3 }, "b.ts", null],
    });
    expect(record?.locations).toEqual(["a.ts"]);
  });
});

describe("kinds this path does handle", () => {
  beforeEach(() => {
    _resetUnmappedForTest();
  });

  it("never records a handled kind, however malformed one payload was", () => {
    // A `tool_call` with no `toolCallId` is malformed, not unsupported. Since a
    // kind is recorded at most once, letting one bad payload through would
    // leave `tool_call` listed as dropped for the life of the process — a lie
    // that never corrects itself. Caught by reading a test's log output rather
    // than its pass count.
    expect(noteUnmappedKind("tool_call")).toBe(false);
    expect(noteUnmappedKind("tool_call_update")).toBe(false);
    expect(noteUnmappedKind("agent_message_chunk")).toBe(false);
    expect(noteUnmappedKind("agent_thought_chunk")).toBe(false);
    expect(unmappedKinds()).toEqual([]);
  });

  it("still records one nobody handles", () => {
    expect(noteUnmappedKind("usage_update")).toBe(true);
    expect(unmappedKinds()).toEqual(["usage_update"]);
  });
});

// The durable record: one event per turn, never one per action.
describe("the per-turn record", () => {
  function rec(id: string, status: ToolStatus = "completed"): ToolRecord {
    return { id, title: `Do ${id}`, kind: "execute", status, locations: [] };
  }

  it("counts everything and lists what fits", () => {
    const tools = new Map([
      ["a", rec("a")],
      ["b", rec("b", "failed")],
    ]);
    const content = turnActivityContent("sess_1", tools);
    expect(content.schema_version).toBe(1);
    expect(content.session_id).toBe("sess_1");
    expect(content.tools).toHaveLength(2);
    expect(content.counts).toEqual({ total: 2, failed: 1, omitted: 0 });
  });

  it("caps the list and says how many it left out", () => {
    // A pathological turn must not produce an unbounded event. The counts still
    // describe the whole turn, so a capped list is never mistaken for a
    // complete one.
    const tools = new Map(
      Array.from({ length: TURN_TOOLS_MAX + 5 }, (_, i) => [`t${i}`, rec(`t${i}`)] as const)
    );
    const content = turnActivityContent("sess_1", tools);
    expect(content.tools).toHaveLength(TURN_TOOLS_MAX);
    expect(content.counts.total).toBe(TURN_TOOLS_MAX + 5);
    expect(content.counts.omitted).toBe(5);
  });

  it("keeps the order the tools were first used in", () => {
    const tools = new Map([
      ["z", rec("z")],
      ["a", rec("a")],
    ]);
    expect(turnActivityContent("sess_1", tools).tools.map((t) => t.id)).toEqual(["z", "a"]);
  });

  it("omits a kind the harness never gave", () => {
    const tools = new Map([["a", { ...rec("a"), kind: undefined }]]);
    expect("kind" in turnActivityContent("sess_1", tools).tools[0]!).toBe(false);
  });

  it("produces a body the contract accepts", () => {
    // The schema is the shared vocabulary; a builder that drifts from it would
    // be caught here rather than on a homeserver.
    const tools = new Map([["a", rec("a")]]);
    expect(TurnActivity.safeParse(turnActivityContent("sess_1", tools)).success).toBe(true);
  });
});

describe("a permission request a client can render", () => {
  const opts = [
    { optionId: "allow_once", name: "Allow once" },
    { optionId: "reject", name: "Reject" },
  ];

  it("carries the options a card can offer", () => {
    const content = permissionRequestContent("sess_1", 41, "Write src/main.ts", opts)!;
    expect(content.options).toEqual([
      { option_id: "allow_once", name: "Allow once" },
      { option_id: "reject", name: "Reject" },
    ]);
    expect(content.request_seq).toBe(41);
  });

  it("says nothing when there is nothing to choose between", () => {
    // The prose already handles this case in words. An event carrying an empty
    // option list would render as a card with no way to answer it.
    expect(permissionRequestContent("sess_1", 41, "x", [])).toBeNull();
  });

  it("caps at four, the most a card can render", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ optionId: `o${i}`, name: `O${i}` }));
    const content = permissionRequestContent("sess_1", 41, "x", five)!;
    expect(content.options).toHaveLength(4);
  });

  it("produces a body the contract accepts", () => {
    expect(
      PermissionRequestEvent.safeParse(permissionRequestContent("sess_1", 41, "x", opts)).success
    ).toBe(true);
  });
});
