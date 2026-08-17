// The wire shapes the hub sends and supermessage reads.
//
// Snake_case throughout, like every other Matrix event body and like
// `matrix-as/live.ts`'s existing `deltaContent`. `schema_version` in particular
// is snake_case because that is the field supermessage's `readSchemaVersion`
// looks for; camelCasing it makes every payload read as "assume the baseline
// version" with no error raised anywhere.

import { describe, expect, it } from "bun:test";
import {
  LiveThoughtDelta,
  LiveToolUpdate,
  PermissionRequestEvent,
  ToolStatus,
  TurnActivity,
} from "./matrix-events";

describe("ToolStatus", () => {
  it("is exactly ACP's vocabulary, so the console and the room cannot drift", () => {
    expect(ToolStatus.options).toEqual(["pending", "in_progress", "completed", "failed"]);
  });

  it("rejects a status nobody defined", () => {
    expect(ToolStatus.safeParse("cancelled").success).toBe(false);
  });
});

describe("LiveThoughtDelta", () => {
  it("accepts a delta", () => {
    const parsed = LiveThoughtDelta.parse({
      room_id: "!r:example.org",
      session_id: "sess_1",
      seq: 3,
      text: "Considering the node's uptime.",
      done: false,
    });
    expect(parsed.seq).toBe(3);
  });

  it("requires done, because a receiver keys the end of a turn off it", () => {
    expect(
      LiveThoughtDelta.safeParse({
        room_id: "!r:example.org",
        session_id: "sess_1",
        seq: 3,
        text: "x",
      }).success
    ).toBe(false);
  });
});

describe("LiveToolUpdate", () => {
  it("accepts an update", () => {
    const parsed = LiveToolUpdate.parse({
      room_id: "!r:example.org",
      session_id: "sess_1",
      seq: 4,
      tool_call_id: "call_1",
      title: "Read src/main.ts",
      kind: "read",
      status: "in_progress",
      locations: ["src/main.ts"],
    });
    expect(parsed.tool_call_id).toBe("call_1");
  });

  it("tolerates a missing kind, which ACP does not always send", () => {
    const parsed = LiveToolUpdate.parse({
      room_id: "!r:example.org",
      session_id: "sess_1",
      seq: 4,
      tool_call_id: "call_1",
      title: "Something",
      status: "pending",
      locations: [],
    });
    expect(parsed.kind).toBeUndefined();
  });

  it("requires the tool call id, since it is the identity updates merge onto", () => {
    expect(
      LiveToolUpdate.safeParse({
        room_id: "!r:example.org",
        session_id: "sess_1",
        seq: 4,
        title: "Something",
        status: "pending",
        locations: [],
      }).success
    ).toBe(false);
  });
});

describe("TurnActivity", () => {
  it("accepts a turn's record", () => {
    const parsed = TurnActivity.parse({
      schema_version: 1,
      session_id: "sess_1",
      tools: [
        {
          id: "call_1",
          title: "Read src/main.ts",
          kind: "read",
          status: "completed",
          locations: ["src/main.ts"],
        },
      ],
      counts: { total: 1, failed: 0, omitted: 0 },
    });
    expect(parsed.counts.total).toBe(1);
  });

  it("carries schema_version in snake_case, which is what the client reads", () => {
    expect(
      TurnActivity.safeParse({
        schemaVersion: 1,
        session_id: "sess_1",
        tools: [],
        counts: { total: 0, failed: 0, omitted: 0 },
      }).success
    ).toBe(false);
  });

  it("allows an empty tool list, so the shape does not depend on the sender's guard", () => {
    // The hub only sends this when a turn used tools, but that is the hub's
    // rule and not the schema's — a schema that made it impossible to express
    // "no tools" would be describing the caller rather than the wire.
    expect(
      TurnActivity.safeParse({
        schema_version: 1,
        session_id: "sess_1",
        tools: [],
        counts: { total: 0, failed: 0, omitted: 0 },
      }).success
    ).toBe(true);
  });
});

describe("PermissionRequestEvent", () => {
  it("accepts a request", () => {
    const parsed = PermissionRequestEvent.parse({
      schema_version: 1,
      session_id: "sess_1",
      request_seq: 41,
      title: "Write src/main.ts",
      options: [
        { option_id: "allow_once", name: "Allow once" },
        { option_id: "reject", name: "Reject" },
      ],
    });
    expect(parsed.options).toHaveLength(2);
  });

  it("refuses an empty option list, which nothing could answer", () => {
    expect(
      PermissionRequestEvent.safeParse({
        schema_version: 1,
        session_id: "sess_1",
        request_seq: 41,
        title: "x",
        options: [],
      }).success
    ).toBe(false);
  });

  it("refuses more than four options, the cap the card can actually render", () => {
    // supermessage's `DECISION_MAX_OPTIONS` renders four and silently drops the
    // rest. Refusing here means the hub never sends one it knows will be
    // discarded — the cap is enforced where it can still be reported, rather
    // than where it can only be lost.
    expect(
      PermissionRequestEvent.safeParse({
        schema_version: 1,
        session_id: "sess_1",
        request_seq: 41,
        title: "x",
        options: [
          { option_id: "a", name: "A" },
          { option_id: "b", name: "B" },
          { option_id: "c", name: "C" },
          { option_id: "d", name: "D" },
          { option_id: "e", name: "E" },
        ],
      }).success
    ).toBe(false);
  });
});
