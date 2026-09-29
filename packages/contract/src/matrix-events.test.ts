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


import { TURN_ERROR_CONTENT_KEY, TurnErrorCard } from "./matrix-events";

describe("TurnErrorCard — a failed turn, drawable, on the room's error notice", () => {
  // krishna, ashram, 2026-09-26 05:43: what the hub recorded for that turn.
  const krishna = {
    schema_version: 1,
    kind: "quota",
    message: "You've reached your weekly (7-day) usage limit.",
    harness: "openclaw",
    provider: "kimi-coding",
    model: "k2p6",
    retryable: false,
    attempts: [
      { provider: "kimi-coding", model: "k2p6", kind: "quota", message: "You've reached your weekly (7-day) usage limit." },
      { provider: "opencode-go", model: "hy3-preview", kind: "bad_request", message: "Request is missing x-opencode-session" },
    ],
  };

  it("rides under one namespaced key on the notice", () => {
    expect(TURN_ERROR_CONTENT_KEY).toBe("dev.agentpod.turn_error");
  });

  it("parses krishna's failed turn", () => {
    expect(TurnErrorCard.parse(krishna)).toEqual(krishna);
  });

  it("needs only what every error has", () => {
    const bare = { schema_version: 1, kind: "node_offline", message: "Couldn't reach the node.", harness: "pi" };
    expect(TurnErrorCard.parse(bare)).toEqual(bare);
  });

  it("is bounded: a client draws every attempt it is given", () => {
    const many = { ...krishna, attempts: Array.from({ length: 17 }, () => krishna.attempts[0]) };
    expect(TurnErrorCard.safeParse(many).success).toBe(false);
  });
});

import { VOICE_TRANSCRIPT_CONTENT_KEY, VoiceTranscript } from "./matrix-events";

describe("VoiceTranscript — a voice note's words, drawable under the note", () => {
  it("the key is namespaced and versioned", () => {
    expect(VOICE_TRANSCRIPT_CONTENT_KEY).toBe("dev.agentpod.voice_transcript");
    const t = { schema_version: 1, text: "send the report by Friday", language: "en", seconds: 42 };
    expect(VoiceTranscript.parse(t)).toEqual(t);
  });

  it("only text is required beside the version", () => {
    expect(VoiceTranscript.parse({ schema_version: 1, text: "hi" })).toEqual({ schema_version: 1, text: "hi" });
  });

  it("an unknown version or an unbounded field is refused", () => {
    expect(() => VoiceTranscript.parse({ schema_version: 2, text: "hi" })).toThrow();
    expect(() => VoiceTranscript.parse({ schema_version: 1, text: "x".repeat(20_001) })).toThrow();
    expect(() => VoiceTranscript.parse({ schema_version: 1, text: "hi", seconds: -1 })).toThrow();
  });
});

import { VOICE_REPLY_CONTENT_KEY, VoiceReply } from "./matrix-events";

describe("VoiceReply — an agent's reply, spoken, on its voice message", () => {
  const reply = { schema_version: 1, text_event_id: "$text:id.agentpod.dev", voice: "af_heart", seconds: 12 };

  it("rides under one namespaced, versioned key", () => {
    expect(VOICE_REPLY_CONTENT_KEY).toBe("dev.agentpod.voice_reply");
    expect(VoiceReply.parse(reply)).toEqual(reply);
  });

  it("seconds is optional; a blend is a voice", () => {
    const blend = { schema_version: 1, text_event_id: "$t", voice: "af_heart:60+af_bella:40" };
    expect(VoiceReply.parse(blend)).toEqual(blend);
  });

  it("strips what it does not know", () => {
    expect(VoiceReply.parse({ ...reply, text: "the words" })).toEqual(reply);
  });

  it("an unknown version, a missing text event or an unbounded field is refused", () => {
    expect(() => VoiceReply.parse({ ...reply, schema_version: 2 })).toThrow();
    expect(() => VoiceReply.parse({ schema_version: 1, voice: "af_heart" })).toThrow();
    expect(() => VoiceReply.parse({ ...reply, voice: "x".repeat(65) })).toThrow();
    expect(() => VoiceReply.parse({ ...reply, seconds: 3601 })).toThrow();
    expect(() => VoiceReply.parse({ ...reply, seconds: 1.5 })).toThrow();
    expect(() => VoiceReply.parse({ ...reply, seconds: -1 })).toThrow();
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GATE_REQUEST_CONTENT_KEY,
  GateRequestCard,
  PERMISSION_REQUEST_CONTENT_KEY,
} from "./matrix-events";

describe("requests embedded in the prose message", () => {
  it("the keys are namespaced and fixed — supermessage reads them by name", () => {
    expect(PERMISSION_REQUEST_CONTENT_KEY).toBe("dev.agentpod.permission");
    expect(GATE_REQUEST_CONTENT_KEY).toBe("dev.superpipeline.gate");
  });

  const corpus = JSON.parse(
    readFileSync(join(import.meta.dir, "../../../fixtures/ecosystem-identity/matrix_gate_events.json"), "utf8")
  ) as { events: Array<{ suiteEventType: string; accept: Array<{ content: Record<string, unknown> }>; reject: Array<{ why: string; content: Record<string, unknown> }> }> };
  const gate = corpus.events.find((e) => e.suiteEventType === "dev.superpipeline.gate.v1")!;

  it("every gate the shared corpus accepts parses as an embedded card, minus its body", () => {
    for (const { content } of gate.accept) {
      const { body: _body, ...card } = content;
      expect(GateRequestCard.safeParse(card).success).toBe(true);
    }
  });

  it("refuses the corpus's gates that could not be answered", () => {
    const unanswerable = gate.reject.filter((r) =>
      /outside GateDecision|empty options|duplicate option ids|handoff_summary that is not a string/.test(r.why)
    );
    expect(unanswerable.length).toBe(4);
    for (const { content } of unanswerable) {
      const { body: _body, ...card } = content;
      expect(GateRequestCard.safeParse(card).success).toBe(false);
    }
  });
});
