/**
 * Characterization: the exact traffic of the room outbound path, pinned before it splits.
 *
 * outbound.test.ts proves the behaviours one at a time (coalescing, typing, marks, the held
 * error, live streams, the turn record, the voice hand-off). This file pins the WHOLE of what a
 * session's events make the room path do, as it is today, in ONE ordered trace per scenario, so a
 * restructure that moves the code cannot reorder or change any of it unnoticed:
 *
 *   - every client call (sendText with its extra content, sendTyping, sendReaction, redact,
 *     sendToDevice, sendCustomEvent), in order, with its arguments,
 *   - how many quiet sends were in flight for the room at each sendText (the `beginQuietSend`
 *     brackets around edits and counted answers),
 *   - the push kind / turn counts each event id was noted with,
 *   - the fleet Live Activity notes (reader and event), in order,
 *   - the pending permission the room holds, the voice hand-off, and the attachment count,
 *   - what happens when a send throws or rejects, and when the previous event never finishes.
 *
 * Volatile values (timestamps) are replaced by placeholders before comparing. Each test uses its
 * own session id and resets its own counters, so none depends on running after another.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AcpEvent } from "@agentpod/contract";
import { _resetHubEventsForTest, hubEventKind, hubEventTurn, quietSendsInFlight } from "../push/hub-events";
import { setFleetSink } from "../push/fleet/sink";
import { clearPendingPermission, pendingPermissionFor } from "./permissions";
import {
  _attachedCountForTest,
  attachRoomToSession,
  detachRoom,
  EVENT_ORDER_WAIT_MS,
  FLUSH_SAFETY_MS,
  forgetTurnTrigger,
  noteTurnTrigger,
  TYPING_REFRESH_MS,
  type OutboundDeps,
} from "./outbound";

const ROOM = "!char-room:id.agentpod.dev";
const AGENT = "@agent_char:id.agentpod.dev";
const READER = "@reader:id.agentpod.dev";

type Call = [string, ...unknown[]];

let trace: Call[] = [];
let fleetNotes: unknown[] = [];
let listeners: Array<(e: AcpEvent) => void> = [];
let textCount = 0;
let sessions: string[] = [];
let seq = 0;

const sink = {
  note: (reader: string, event: unknown) => fleetNotes.push({ reader, event }),
  clearDecision: () => {},
  reconcileGates: () => {},
  knowsDecision: () => false,
};

beforeEach(() => {
  trace = [];
  fleetNotes = [];
  listeners = [];
  textCount = 0;
  sessions = [];
  seq = 0;
  _resetHubEventsForTest();
  setFleetSink(null);
});

afterEach(() => {
  for (const s of sessions) detachRoom(s);
  clearPendingPermission(ROOM);
  setFleetSink(null);
});

interface RigOpts {
  failText?: (body: string) => boolean;
  failCustom?: (type: string) => boolean;
  failToDevice?: boolean;
  noOptional?: boolean;
  speak?: boolean;
  flushDelayMs?: number;
  eventOrderWaitMs?: number;
  /** A sendText that never returns, once, for the body that matches. */
  hangText?: (body: string) => boolean;
}

function rig(session: string, opts: RigOpts = {}): OutboundDeps {
  sessions.push(session);
  const client: OutboundDeps["client"] = {
    sendText: async (userId, roomId, body, extra) => {
      trace.push(["sendText", userId, roomId, body, extra ?? null, { quiet: quietSendsInFlight(roomId) }]);
      if (opts.hangText?.(body)) return new Promise<string | null>(() => {});
      if (opts.failText?.(body)) throw new Error("homeserver said no");
      textCount += 1;
      return `$text-${textCount}`;
    },
    sendTyping: async (userId, roomId, on) => {
      trace.push(["sendTyping", userId, roomId, on]);
    },
  };
  if (!opts.noOptional) {
    client.sendReaction = async (userId, roomId, target, key) => {
      trace.push(["sendReaction", userId, roomId, target, key]);
      return `$reaction-${key}`;
    };
    client.redact = async (userId, roomId, eventId) => {
      trace.push(["redact", userId, roomId, eventId]);
    };
    client.sendToDevice = async (userId, target, type, content) => {
      trace.push(["sendToDevice", userId, target, type, content]);
      if (opts.failToDevice) throw new Error("to-device refused");
    };
    client.sendCustomEvent = async (userId, roomId, type, content) => {
      trace.push(["sendCustomEvent", userId, roomId, type, content]);
      if (opts.failCustom?.(type)) throw new Error("custom refused");
      return `$custom-${type}`;
    };
  }
  return {
    client,
    readerFor: async () => READER,
    nameFor: async () => "Char Agent",
    subscribe: (_sessionId, fn) => {
      listeners.push(fn);
      trace.push(["subscribe", _sessionId]);
      return () => {
        trace.push(["unsubscribe", _sessionId]);
        listeners = listeners.filter((l) => l !== fn);
      };
    },
    flushDelayMs: opts.flushDelayMs ?? 60_000,
    eventOrderWaitMs: opts.eventOrderWaitMs,
    typingRefreshMs: 60_000,
    ...(opts.speak
      ? {
          speak: async (turn) => {
            trace.push(["speak", turn]);
          },
        }
      : {}),
  };
}

const ev = (session: string, type: AcpEvent["type"], payload: unknown): AcpEvent => ({
  sessionId: session,
  seq: ++seq,
  type,
  payload,
  createdAt: "2026-01-01T00:00:00.000Z",
});
const chunk = (s: string, text: string) =>
  ev(s, "agent-update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const thought = (s: string, text: string) =>
  ev(s, "agent-update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
const stateEv = (s: string, status: string, extra: Record<string, unknown> = {}) =>
  ev(s, "state", { status, ...extra });

function emit(e: AcpEvent) {
  // `listeners` is replaced, never mutated, by an unsubscribe, so this walk is safe.
  for (const l of listeners) l(e);
}

/** Let the per-room chain and the fire-and-forget sends run. */
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (k, v) => (k === "at" || k === "askedAt" ? "<time>" : v)));
}

test("the exported constants", () => {
  expect({ FLUSH_SAFETY_MS, TYPING_REFRESH_MS, EVENT_ORDER_WAIT_MS }).toMatchInlineSnapshot(`
    {
      "EVENT_ORDER_WAIT_MS": 30000,
      "FLUSH_SAFETY_MS": 20000,
      "TYPING_REFRESH_MS": 20000,
    }
  `);
});

test("a full turn: trigger, thought, tools, answer, permission pause, more answer, idle — every call in order", async () => {
  const S = "acps_char_full";
  setFleetSink(sink);
  attachRoomToSession(S, ROOM, AGENT, rig(S, { speak: true }));
  noteTurnTrigger(S, "$trigger-1", { voice: true });
  emit(stateEv(S, "working"));
  await settle();
  emit(thought(S, "Let me think about this carefully."));
  emit(ev(S, "agent-update", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a file", kind: "read", status: "in_progress", locations: [{ path: "/a" }] }));
  emit(ev(S, "agent-update", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }));
  emit(ev(S, "agent-update", { sessionUpdate: "tool_call", toolCallId: "t2", title: "Run tests", status: "failed" }));
  emit(chunk(S, "First part of the answer, long enough to stream."));
  await settle();
  emit(
    ev(S, "permission-request", {
      toolCall: { title: "write /etc/hosts" },
      options: [
        { optionId: "allow", name: "Allow" },
        { optionId: "reject", name: "Reject" },
        { bogus: true },
      ],
    })
  );
  emit(stateEv(S, "waiting"));
  await settle();
  const pending = pendingPermissionFor(ROOM);
  emit(stateEv(S, "working"));
  emit(chunk(S, "Second part."));
  emit(ev(S, "agent-update", { sessionUpdate: "plan", entries: [] }));
  emit(ev(S, "user-prompt", { text: "echo" }));
  emit(stateEv(S, "idle"));
  await settle(40);

  expect(normalize(trace)).toMatchInlineSnapshot(`
    [
      [
        "subscribe",
        "acps_char_full",
      ],
      [
        "sendTyping",
        "@agent_char:id.agentpod.dev",
        "!char-room:id.agentpod.dev",
        true,
      ],
      [
        "sendReaction",
        "@agent_char:id.agentpod.dev",
        "!char-room:id.agentpod.dev",
        "$trigger-1",
        "👀",
      ],
      [
        "sendToDevice",
        "@agent_char:id.agentpod.dev",
        "@reader:id.agentpod.dev",
        "dev.agentpod.thought.delta",
        {
          "done": false,
          "room_id": "!char-room:id.agentpod.dev",
          "seq": 1,
          "session_id": "acps_char_full",
          "text": "Let me think about this carefully.",
        },
      ],
      [
        "sendToDevice",
        "@agent_char:id.agentpod.dev",
        "@reader:id.agentpod.dev",
        "dev.agentpod.tool.update",
        {
          "kind": "read",
          "locations": [
            "/a",
          ],
          "room_id": "!char-room:id.agentpod.dev",
          "seq": 1,
          "session_id": "acps_char_full",
          "status": "in_progress",
          "title": "Read a file",
          "tool_call_id": "t1",
        },
      ],
      [
        "sendToDevice",
        "@agent_char:id.agentpod.dev",
        "@reader:id.agentpod.dev",
        "dev.agentpod.tool.update",
        {
          "kind": "read",
          "locations": [
            "/a",
          ],
          "room_id": "!char-room:id.agentpod.dev",
          "seq": 2,
          "session_id": "acps_char_full",
          "status": "completed",
          "title": "Read a file",
          "tool_call_id": "t1",
        },
      ],
      [
        "sendToDevice",
        "@agent_char:id.agentpod.dev",
        "@reader:id.agentpod.dev",
        "dev.agentpod.tool.update",
        {
          "locations": [],
          "room_id": "!char-room:id.agentpod.dev",
          "seq": 3,
          "session_id": "acps_char_full",
          "status": "failed",
          "title": "Run tests",
          "tool_call_id": "t2",
        },
      ],
      [
        "sendToDevice",
        "@agent_char:id.agentpod.dev",
        "@reader:id.agentpod.dev",
        "dev.agentpod.stream.delta",
        {
          "done": false,
          "room_id": "!char-room:id.agentpod.dev",
          "seq": 1,
          "session_id": "acps_char_full",
          "text": "First part of the answer, long enough to stream.",
        },
      ],
      [
        "sendText",
        "@agent_char:id.agentpod.dev",
        "!char-room:id.agentpod.dev",
        
    "Permission needed: write /etc/hosts

    1. Allow
    2. Reject

    Reply with the number, or the option's name."
    ,
        {
          "dev.agentpod.permission": {
            "options": [
              {
                "name": "Allow",
                "option_id": "allow",
              },
              {
                "name": "Reject",
                "option_id": "reject",
              },
            ],
            "request_seq": 7,
            "schema_version": 1,
            "session_id": "acps_char_full",
            "title": "write /etc/hosts",
          },
        },
        {
          "quiet": 0,
        },
      ],
      [
        "sendCustomEvent",
        "@agent_char:id.agentpod.dev",
        "!char-room:id.agentpod.dev",
        "dev.agentpod.permission.v1",
        {
          "options": [
            {
              "name": "Allow",
              "option_id": "allow",
            },
            {
              "name": "Reject",
              "option_id": "reject",
            },
          ],
          "request_seq": 7,
          "schema_version": 1,
          "session_id": "acps_char_full",
          "title": "write /etc/hosts",
        },
      ],
      [
        "sendToDevice",
        "@agent_char:id.agentpod.dev",
        "@reader:id.agentpod.dev",
        "dev.agentpod.stream.delta",
        {
          "done": true,
          "room_id": "!char-room:id.agentpod.dev",
          "seq": 2,
          "session_id": "acps_char_full",
          "text": "First part of the answer, long enough to stream.",
        },
      ],
      [
        "sendCustomEvent",
        "@agent_char:id.agentpod.dev",
        "!char-room:id.agentpod.dev",
        "dev.agentpod.turn.v1",
        {
          "counts": {
            "failed": 1,
            "omitted": 0,
            "total": 2,
          },
          "schema_version": 1,
          "session_id": "acps_char_full",
          "tools": [
            {
              "id": "t1",
              "kind": "read",
              "locations": [
                "/a",
              ],
              "status": "completed",
              "title": "Read a file",
            },
            {
              "id": "t2",
              "locations": [],
              "status": "failed",
              "title": "Run tests",
            },
          ],
        },
      ],
      [
        "sendText",
        "@agent_char:id.agentpod.dev",
        "!char-room:id.agentpod.dev",
        "First part of the answer, long enough to stream.",
        null,
        {
          "quiet": 1,
        },
      ],
      [
        "sendTyping",
        "@agent_char:id.agentpod.dev",
        "!char-room:id.agentpod.dev",
        false,
      ],
      [
        "sendTyping",
        "@agent_char:id.agentpod.dev",
        "!char-room:id.agentpod.dev",
        true,
      ],
      [
        "redact",
        "@agent_char:id.agentpod.dev",
        "!char-room:id.agentpod.dev",
        "$reaction-👀",
      ],
      [
        "sendReaction",
        "@agent_char:id.agentpod.dev",
        "!char-room:id.agentpod.dev",
        "$trigger-1",
        "👀",
      ],
      [
        "sendToDevice",
        "@agent_char:id.agentpod.dev",
        "@reader:id.agentpod.dev",
        "dev.agentpod.stream.delta",
        {
          "done": false,
          "room_id": "!char-room:id.agentpod.dev",
          "seq": 1,
          "session_id": "acps_char_full",
          "text": "Second part.",
        },
      ],
      [
        "sendToDevice",
        "@agent_char:id.agentpod.dev",
        "@reader:id.agentpod.dev",
        "dev.agentpod.stream.delta",
        {
          "done": true,
          "room_id": "!char-room:id.agentpod.dev",
          "seq": 2,
          "session_id": "acps_char_full",
          "text": "Second part.",
        },
      ],
      [
        "sendText",
        "@agent_char:id.agentpod.dev",
        "!char-room:id.agentpod.dev",
        "Second part.",
        null,
        {
          "quiet": 0,
        },
      ],
      [
        "sendTyping",
        "@agent_char:id.agentpod.dev",
        "!char-room:id.agentpod.dev",
        false,
      ],
      [
        "redact",
        "@agent_char:id.agentpod.dev",
        "!char-room:id.agentpod.dev",
        "$reaction-👀",
      ],
      [
        "sendReaction",
        "@agent_char:id.agentpod.dev",
        "!char-room:id.agentpod.dev",
        "$trigger-1",
        "✅",
      ],
      [
        "speak",
        {
          "agentUser": "@agent_char:id.agentpod.dev",
          "roomId": "!char-room:id.agentpod.dev",
          "sessionId": "acps_char_full",
          "text": 
    "First part of the answer, long enough to stream.

    Second part."
    ,
          "textEventId": "$text-3",
          "voiceTriggered": true,
        },
      ],
    ]
  `);
  expect(normalize(fleetNotes)).toMatchInlineSnapshot(`
    [
      {
        "event": {
          "at": "<time>",
          "mxid": "@agent_char:id.agentpod.dev",
          "name": "Char Agent",
          "roomId": "!char-room:id.agentpod.dev",
          "type": "turn-started",
        },
        "reader": "@reader:id.agentpod.dev",
      },
      {
        "event": {
          "at": "<time>",
          "mxid": "@agent_char:id.agentpod.dev",
          "name": "Char Agent",
          "roomId": "!char-room:id.agentpod.dev",
          "type": "thinking",
        },
        "reader": "@reader:id.agentpod.dev",
      },
      {
        "event": {
          "at": "<time>",
          "completed": 0,
          "mxid": "@agent_char:id.agentpod.dev",
          "name": "Char Agent",
          "roomId": "!char-room:id.agentpod.dev",
          "title": "Read a file",
          "total": 1,
          "type": "step",
        },
        "reader": "@reader:id.agentpod.dev",
      },
      {
        "event": {
          "at": "<time>",
          "completed": 1,
          "mxid": "@agent_char:id.agentpod.dev",
          "name": "Char Agent",
          "roomId": "!char-room:id.agentpod.dev",
          "title": "Read a file",
          "total": 1,
          "type": "step",
        },
        "reader": "@reader:id.agentpod.dev",
      },
      {
        "event": {
          "at": "<time>",
          "completed": 2,
          "mxid": "@agent_char:id.agentpod.dev",
          "name": "Char Agent",
          "roomId": "!char-room:id.agentpod.dev",
          "title": "Run tests",
          "total": 2,
          "type": "step",
        },
        "reader": "@reader:id.agentpod.dev",
      },
      {
        "event": {
          "at": "<time>",
          "mxid": "@agent_char:id.agentpod.dev",
          "name": "Char Agent",
          "roomId": "!char-room:id.agentpod.dev",
          "type": "spoke",
        },
        "reader": "@reader:id.agentpod.dev",
      },
      {
        "event": {
          "decision": {
            "agent": "Char Agent",
            "askedAt": "<time>",
            "eventId": "$text-1",
            "key": "perm:!char-room:id.agentpod.dev",
            "kind": "permission",
            "options": [
              {
                "declines": false,
                "id": "Allow",
                "label": "Allow",
              },
              {
                "declines": true,
                "id": "Reject",
                "label": "Reject",
              },
            ],
            "question": "write /etc/hosts",
            "roomId": "!char-room:id.agentpod.dev",
          },
          "type": "decision-asked",
        },
        "reader": "@reader:id.agentpod.dev",
      },
      {
        "event": {
          "at": "<time>",
          "mxid": "@agent_char:id.agentpod.dev",
          "name": "Char Agent",
          "roomId": "!char-room:id.agentpod.dev",
          "type": "turn-started",
        },
        "reader": "@reader:id.agentpod.dev",
      },
      {
        "event": {
          "at": "<time>",
          "mxid": "@agent_char:id.agentpod.dev",
          "name": "Char Agent",
          "roomId": "!char-room:id.agentpod.dev",
          "type": "spoke",
        },
        "reader": "@reader:id.agentpod.dev",
      },
      {
        "event": {
          "at": "<time>",
          "errored": false,
          "failed": 1,
          "failedAt": 2,
          "mxid": "@agent_char:id.agentpod.dev",
          "name": "Char Agent",
          "roomId": "!char-room:id.agentpod.dev",
          "total": 2,
          "type": "turn-finished",
        },
        "reader": "@reader:id.agentpod.dev",
      },
    ]
  `);
  expect({
    pending,
    afterTurn: pendingPermissionFor(ROOM) ?? null,
    kinds: ["$text-1", "$text-2", "$text-3", "$custom-dev.agentpod.permission.v1"].map((id) => [
      id,
      hubEventKind(id) ?? null,
      hubEventTurn(id) ?? null,
    ]),
    attached: _attachedCountForTest(),
  }).toMatchInlineSnapshot(`
    {
      "afterTurn": null,
      "attached": 1,
      "kinds": [
        [
          "$text-1",
          "permission",
          null,
        ],
        [
          "$text-2",
          "answer",
          {
            "failed": 1,
            "total": 2,
          },
        ],
        [
          "$text-3",
          null,
          null,
        ],
        [
          "$custom-dev.agentpod.permission.v1",
          "companion",
          null,
        ],
      ],
      "pending": {
        "options": [
          {
            "name": "Allow",
            "optionId": "allow",
          },
          {
            "name": "Reject",
            "optionId": "reject",
          },
        ],
        "requestSeq": 7,
        "sessionId": "acps_char_full",
      },
    }
  `);
});

/** Everything one test observed, normalised, for one snapshot. */
function observed(ids: string[] = [], extra: Record<string, unknown> = {}) {
  return normalize({
    ...extra,
    trace,
    fleet: fleetNotes,
    kinds: ids.map((id) => [id, hubEventKind(id) ?? null, hubEventTurn(id) ?? null]),
    attached: _attachedCountForTest(),
  });
}

test("an error inside a turn is held to the turn end, then reported with its card", async () => {
  const S = "acps_char_err";
  setFleetSink(sink);
  attachRoomToSession(S, ROOM, AGENT, rig(S, { speak: true }));
  noteTurnTrigger(S, "$trigger-e");
  emit(stateEv(S, "working"));
  emit(ev(S, "error", { message: "quota exhausted", code: "rate_limited" }));
  emit(stateEv(S, "idle"));
  await settle(30);
  expect(observed(["$text-1"])).toMatchInlineSnapshot(`
    {
      "attached": 1,
      "fleet": [
        {
          "event": {
            "at": "<time>",
            "mxid": "@agent_char:id.agentpod.dev",
            "name": "Char Agent",
            "roomId": "!char-room:id.agentpod.dev",
            "type": "turn-started",
          },
          "reader": "@reader:id.agentpod.dev",
        },
        {
          "event": {
            "at": "<time>",
            "errored": true,
            "failed": 0,
            "mxid": "@agent_char:id.agentpod.dev",
            "name": "Char Agent",
            "roomId": "!char-room:id.agentpod.dev",
            "total": 0,
            "type": "turn-finished",
          },
          "reader": "@reader:id.agentpod.dev",
        },
      ],
      "kinds": [
        [
          "$text-1",
          null,
          null,
        ],
      ],
      "trace": [
        [
          "subscribe",
          "acps_char_err",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          true,
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-e",
          "👀",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          false,
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          false,
        ],
        [
          "redact",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$reaction-👀",
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-e",
          "❌",
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "This agent reported an error: quota exhausted",
          null,
          {
            "quiet": 0,
          },
        ],
      ],
    }
  `);
});

test("an error followed by an answer is dropped; the answer is the outcome", async () => {
  const S = "acps_char_recover";
  attachRoomToSession(S, ROOM, AGENT, rig(S, { speak: true }));
  noteTurnTrigger(S, "$trigger-r");
  emit(stateEv(S, "working"));
  emit(ev(S, "error", { message: "first model failed" }));
  emit(chunk(S, "Fallback answer."));
  emit(stateEv(S, "idle"));
  await settle(30);
  expect(observed(["$text-1"])).toMatchInlineSnapshot(`
    {
      "attached": 1,
      "fleet": [],
      "kinds": [
        [
          "$text-1",
          null,
          null,
        ],
      ],
      "trace": [
        [
          "subscribe",
          "acps_char_recover",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          true,
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-r",
          "👀",
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": false,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 1,
            "session_id": "acps_char_recover",
            "text": "Fallback answer.",
          },
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": true,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 2,
            "session_id": "acps_char_recover",
            "text": "Fallback answer.",
          },
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "Fallback answer.",
          null,
          {
            "quiet": 0,
          },
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          false,
        ],
        [
          "redact",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$reaction-👀",
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-r",
          "✅",
        ],
        [
          "speak",
          {
            "agentUser": "@agent_char:id.agentpod.dev",
            "roomId": "!char-room:id.agentpod.dev",
            "sessionId": "acps_char_recover",
            "text": "Fallback answer.",
            "textEventId": "$text-1",
            "voiceTriggered": false,
          },
        ],
      ],
    }
  `);
});

test("an error outside a turn is said at once, with a null payload made {}", async () => {
  const S = "acps_char_err_outside";
  attachRoomToSession(S, ROOM, AGENT, rig(S));
  emit(ev(S, "error", null));
  await settle();
  expect(observed()).toMatchInlineSnapshot(`
    {
      "attached": 1,
      "fleet": [],
      "kinds": [],
      "trace": [
        [
          "subscribe",
          "acps_char_err_outside",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          false,
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "This agent reported an error: unknown",
          null,
          {
            "quiet": 0,
          },
        ],
      ],
    }
  `);
});

test("a silent turn: a reason from the end state, then the session ends and detaches", async () => {
  const S = "acps_char_silent";
  setFleetSink(sink);
  attachRoomToSession(S, ROOM, AGENT, rig(S, { speak: true }));
  noteTurnTrigger(S, "$trigger-s");
  emit(stateEv(S, "working"));
  emit(stateEv(S, "ended", { reason: "  the node went away  " }));
  await settle(30);
  emit(chunk(S, "after the end"));
  await settle();
  expect(observed()).toMatchInlineSnapshot(`
    {
      "attached": 0,
      "fleet": [
        {
          "event": {
            "at": "<time>",
            "mxid": "@agent_char:id.agentpod.dev",
            "name": "Char Agent",
            "roomId": "!char-room:id.agentpod.dev",
            "type": "turn-started",
          },
          "reader": "@reader:id.agentpod.dev",
        },
        {
          "event": {
            "at": "<time>",
            "errored": true,
            "failed": 0,
            "mxid": "@agent_char:id.agentpod.dev",
            "name": "Char Agent",
            "roomId": "!char-room:id.agentpod.dev",
            "total": 0,
            "type": "turn-finished",
          },
          "reader": "@reader:id.agentpod.dev",
        },
      ],
      "kinds": [],
      "trace": [
        [
          "subscribe",
          "acps_char_silent",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          true,
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-s",
          "👀",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          false,
        ],
        [
          "redact",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$reaction-👀",
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-s",
          "❌",
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "This turn ended without a reply — the node went away",
          null,
          {
            "quiet": 0,
          },
        ],
        [
          "unsubscribe",
          "acps_char_silent",
        ],
      ],
    }
  `);
});

test("a silent turn without a reason gets the stock notice; one that chose silence is done", async () => {
  const S = "acps_char_silent2";
  attachRoomToSession(S, ROOM, AGENT, rig(S));
  noteTurnTrigger(S, "$trigger-a");
  emit(stateEv(S, "working"));
  emit(stateEv(S, "idle"));
  await settle(30);
  noteTurnTrigger(S, "$trigger-b");
  emit(stateEv(S, "working"));
  emit(stateEv(S, "idle", { silent: true }));
  await settle(30);
  // An unprompted turn: nothing to mark, nothing said.
  emit(stateEv(S, "working"));
  emit(stateEv(S, "idle"));
  await settle(30);
  expect(observed()).toMatchInlineSnapshot(`
    {
      "attached": 1,
      "fleet": [],
      "kinds": [],
      "trace": [
        [
          "subscribe",
          "acps_char_silent2",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          true,
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-a",
          "👀",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          false,
        ],
        [
          "redact",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$reaction-👀",
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-a",
          "❌",
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "This turn ended without a reply — the agent reported no answer and no error. Its own logs will say why.",
          null,
          {
            "quiet": 0,
          },
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          true,
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-b",
          "👀",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          false,
        ],
        [
          "redact",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$reaction-👀",
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-b",
          "✅",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          true,
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          false,
        ],
      ],
    }
  `);
});

test("a safety-timer flush leaves the message open; the turn end edits it, quietly", async () => {
  const S = "acps_char_timer";
  attachRoomToSession(S, ROOM, AGENT, rig(S, { speak: true, flushDelayMs: 5 }));
  noteTurnTrigger(S, "$trigger-t");
  emit(stateEv(S, "working"));
  emit(chunk(S, "Almost the whole reply"));
  await settle(30);
  emit(chunk(S, " and more"));
  await settle(30);
  emit(chunk(S, ", done."));
  emit(stateEv(S, "idle"));
  await settle(30);
  expect(observed(["$text-1", "$text-2", "$text-3"])).toMatchInlineSnapshot(`
    {
      "attached": 1,
      "fleet": [],
      "kinds": [
        [
          "$text-1",
          null,
          null,
        ],
        [
          "$text-2",
          "quiet",
          null,
        ],
        [
          "$text-3",
          "quiet",
          null,
        ],
      ],
      "trace": [
        [
          "subscribe",
          "acps_char_timer",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          true,
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-t",
          "👀",
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": false,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 1,
            "session_id": "acps_char_timer",
            "text": "Almost the whole reply",
          },
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": true,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 2,
            "session_id": "acps_char_timer",
            "text": "Almost the whole reply",
          },
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "Almost the whole reply",
          null,
          {
            "quiet": 0,
          },
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": false,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 1,
            "session_id": "acps_char_timer",
            "text": " and more",
          },
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": true,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 2,
            "session_id": "acps_char_timer",
            "text": " and more",
          },
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "* Almost the whole reply and more",
          {
            "m.new_content": {
              "body": "Almost the whole reply and more",
              "msgtype": "m.text",
            },
            "m.relates_to": {
              "event_id": "$text-1",
              "rel_type": "m.replace",
            },
          },
          {
            "quiet": 1,
          },
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": false,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 1,
            "session_id": "acps_char_timer",
            "text": ", done.",
          },
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": true,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 2,
            "session_id": "acps_char_timer",
            "text": ", done.",
          },
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "* Almost the whole reply and more, done.",
          {
            "m.new_content": {
              "body": "Almost the whole reply and more, done.",
              "msgtype": "m.text",
            },
            "m.relates_to": {
              "event_id": "$text-1",
              "rel_type": "m.replace",
            },
          },
          {
            "quiet": 1,
          },
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          false,
        ],
        [
          "redact",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$reaction-👀",
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-t",
          "✅",
        ],
        [
          "speak",
          {
            "agentUser": "@agent_char:id.agentpod.dev",
            "roomId": "!char-room:id.agentpod.dev",
            "sessionId": "acps_char_timer",
            "text": "Almost the whole reply and more, done.",
            "textEventId": "$text-1",
            "voiceTriggered": false,
          },
        ],
      ],
    }
  `);
});

test("an edit that does not land sends the tail on its own", async () => {
  const S = "acps_char_timer_fail";
  attachRoomToSession(S, ROOM, AGENT, rig(S, { flushDelayMs: 5, failText: (b) => b.startsWith("* ") }));
  noteTurnTrigger(S, "$trigger-tf");
  emit(stateEv(S, "working"));
  emit(chunk(S, "Head"));
  await settle(30);
  emit(chunk(S, " tail"));
  emit(stateEv(S, "idle"));
  await settle(30);
  expect(observed(["$text-1", "$text-2"])).toMatchInlineSnapshot(`
    {
      "attached": 1,
      "fleet": [],
      "kinds": [
        [
          "$text-1",
          null,
          null,
        ],
        [
          "$text-2",
          null,
          null,
        ],
      ],
      "trace": [
        [
          "subscribe",
          "acps_char_timer_fail",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          true,
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-tf",
          "👀",
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": false,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 1,
            "session_id": "acps_char_timer_fail",
            "text": "Head",
          },
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": true,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 2,
            "session_id": "acps_char_timer_fail",
            "text": "Head",
          },
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "Head",
          null,
          {
            "quiet": 0,
          },
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": false,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 1,
            "session_id": "acps_char_timer_fail",
            "text": " tail",
          },
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": true,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 2,
            "session_id": "acps_char_timer_fail",
            "text": " tail",
          },
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "* Head tail",
          {
            "m.new_content": {
              "body": "Head tail",
              "msgtype": "m.text",
            },
            "m.relates_to": {
              "event_id": "$text-1",
              "rel_type": "m.replace",
            },
          },
          {
            "quiet": 1,
          },
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          " tail",
          null,
          {
            "quiet": 0,
          },
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          false,
        ],
        [
          "redact",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$reaction-👀",
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-tf",
          "✅",
        ],
      ],
    }
  `);
});

test("failing sends: text throws, the turn record and to-device reject — the room goes on", async () => {
  const S = "acps_char_fail";
  attachRoomToSession(
    S,
    ROOM,
    AGENT,
    rig(S, { failText: (b) => b.startsWith("Permission needed"), failCustom: (t) => t === "dev.agentpod.turn.activity.v1", failToDevice: true })
  );
  noteTurnTrigger(S, "$trigger-f");
  emit(stateEv(S, "working"));
  emit(ev(S, "agent-update", { sessionUpdate: "tool_call", toolCallId: "x", title: "Do", status: "completed" }));
  emit(
    ev(S, "permission-request", { toolCall: {}, options: [{ optionId: "ok", name: "OK" }] })
  );
  emit(stateEv(S, "waiting"));
  await settle(30);
  const pending = pendingPermissionFor(ROOM) ?? null;
  emit(stateEv(S, "working"));
  emit(chunk(S, "Still here."));
  emit(stateEv(S, "idle"));
  await settle(30);
  expect(observed(["$custom-dev.agentpod.permission.v1"], { pending })).toMatchInlineSnapshot(`
    {
      "attached": 1,
      "fleet": [],
      "kinds": [
        [
          "$custom-dev.agentpod.permission.v1",
          null,
          null,
        ],
      ],
      "pending": {
        "options": [
          {
            "name": "OK",
            "optionId": "ok",
          },
        ],
        "requestSeq": 3,
        "sessionId": "acps_char_fail",
      },
      "trace": [
        [
          "subscribe",
          "acps_char_fail",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          true,
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-f",
          "👀",
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.tool.update",
          {
            "locations": [],
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 1,
            "session_id": "acps_char_fail",
            "status": "completed",
            "title": "Do",
            "tool_call_id": "x",
          },
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          
    "Permission needed: an action

    1. OK

    Reply with the number, or the option's name."
    ,
          {
            "dev.agentpod.permission": {
              "options": [
                {
                  "name": "OK",
                  "option_id": "ok",
                },
              ],
              "request_seq": 3,
              "schema_version": 1,
              "session_id": "acps_char_fail",
              "title": "an action",
            },
          },
          {
            "quiet": 0,
          },
        ],
        [
          "sendCustomEvent",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "dev.agentpod.permission.v1",
          {
            "options": [
              {
                "name": "OK",
                "option_id": "ok",
              },
            ],
            "request_seq": 3,
            "schema_version": 1,
            "session_id": "acps_char_fail",
            "title": "an action",
          },
        ],
        [
          "sendCustomEvent",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "dev.agentpod.turn.v1",
          {
            "counts": {
              "failed": 0,
              "omitted": 0,
              "total": 1,
            },
            "schema_version": 1,
            "session_id": "acps_char_fail",
            "tools": [
              {
                "id": "x",
                "locations": [],
                "status": "completed",
                "title": "Do",
              },
            ],
          },
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          false,
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          true,
        ],
        [
          "redact",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$reaction-👀",
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-f",
          "👀",
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": false,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 1,
            "session_id": "acps_char_fail",
            "text": "Still here.",
          },
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": true,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 2,
            "session_id": "acps_char_fail",
            "text": "Still here.",
          },
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "Still here.",
          null,
          {
            "quiet": 0,
          },
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          false,
        ],
        [
          "redact",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$reaction-👀",
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-f",
          "✅",
        ],
      ],
    }
  `);
});

test("a permission request with no answerable option, on a client with no optional calls", async () => {
  const S = "acps_char_minimal";
  attachRoomToSession(S, ROOM, AGENT, rig(S, { noOptional: true }));
  noteTurnTrigger(S, "$trigger-m");
  emit(stateEv(S, "working"));
  emit(ev(S, "permission-request", { toolCall: { title: 7 }, options: [{ name: "no id" }] }));
  emit(ev(S, "permission-request", "not a record"));
  emit(stateEv(S, "waiting"));
  await settle(30);
  const pending = pendingPermissionFor(ROOM) ?? null;
  emit(chunk(S, "ok"));
  emit(stateEv(S, "idle"));
  await settle(30);
  expect(observed(["$text-1"], { pending })).toMatchInlineSnapshot(`
    {
      "attached": 1,
      "fleet": [],
      "kinds": [
        [
          "$text-1",
          "permission",
          null,
        ],
      ],
      "pending": null,
      "trace": [
        [
          "subscribe",
          "acps_char_minimal",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          true,
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "Permission needed: an action. There are no options to choose from — answer in the console.",
          null,
          {
            "quiet": 0,
          },
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          false,
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "ok",
          null,
          {
            "quiet": 0,
          },
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          false,
        ],
      ],
    }
  `);
});

test("a send that never returns: the next event waits its bound, then runs anyway", async () => {
  const S = "acps_char_hang";
  attachRoomToSession(S, ROOM, AGENT, rig(S, { eventOrderWaitMs: 20, hangText: (b) => b === "Hangs." }));
  noteTurnTrigger(S, "$trigger-h");
  emit(stateEv(S, "working"));
  emit(chunk(S, "Hangs."));
  emit(stateEv(S, "idle"));
  noteTurnTrigger(S, "$trigger-h2");
  emit(stateEv(S, "working"));
  await settle(10);
  const early = trace.length;
  await settle(60);
  expect(observed([], { early })).toMatchInlineSnapshot(`
    {
      "attached": 1,
      "early": 6,
      "fleet": [],
      "kinds": [],
      "trace": [
        [
          "subscribe",
          "acps_char_hang",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          true,
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-h",
          "👀",
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": false,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 1,
            "session_id": "acps_char_hang",
            "text": "Hangs.",
          },
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": true,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 2,
            "session_id": "acps_char_hang",
            "text": "Hangs.",
          },
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "Hangs.",
          null,
          {
            "quiet": 0,
          },
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          true,
        ],
        [
          "redact",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$reaction-👀",
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$trigger-h2",
          "👀",
        ],
      ],
    }
  `);
});

test("triggers: taken by the working that fans out, forgotten only by their own id, cleared by detach", async () => {
  const S = "acps_char_trig";
  attachRoomToSession(S, ROOM, AGENT, rig(S));
  attachRoomToSession(S, ROOM, AGENT, rig(S)); // a second attach is a no-op
  noteTurnTrigger(S, "$one");
  forgetTurnTrigger(S, "$other");
  noteTurnTrigger(S, "$two");
  forgetTurnTrigger(S, "$two");
  noteTurnTrigger(S, "$three");
  emit(stateEv(S, "working"));
  emit(chunk(S, "hi"));
  emit(stateEv(S, "idle"));
  await settle(30);
  noteTurnTrigger(S, "$four");
  detachRoom(S);
  detachRoom(S);
  // A fresh attachment after detach does not see the cleared trigger.
  attachRoomToSession(S, ROOM, AGENT, rig(S));
  emit(stateEv(S, "working"));
  emit(stateEv(S, "idle"));
  await settle(30);
  expect(observed()).toMatchInlineSnapshot(`
    {
      "attached": 1,
      "fleet": [],
      "kinds": [],
      "trace": [
        [
          "subscribe",
          "acps_char_trig",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          true,
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$three",
          "👀",
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": false,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 1,
            "session_id": "acps_char_trig",
            "text": "hi",
          },
        ],
        [
          "sendToDevice",
          "@agent_char:id.agentpod.dev",
          "@reader:id.agentpod.dev",
          "dev.agentpod.stream.delta",
          {
            "done": true,
            "room_id": "!char-room:id.agentpod.dev",
            "seq": 2,
            "session_id": "acps_char_trig",
            "text": "hi",
          },
        ],
        [
          "sendText",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "hi",
          null,
          {
            "quiet": 0,
          },
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          false,
        ],
        [
          "redact",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$reaction-👀",
        ],
        [
          "sendReaction",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          "$three",
          "✅",
        ],
        [
          "unsubscribe",
          "acps_char_trig",
        ],
        [
          "subscribe",
          "acps_char_trig",
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          true,
        ],
        [
          "sendTyping",
          "@agent_char:id.agentpod.dev",
          "!char-room:id.agentpod.dev",
          false,
        ],
      ],
    }
  `);
});
