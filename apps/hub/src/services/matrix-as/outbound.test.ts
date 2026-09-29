import {
  PERMISSION_REQUEST_CONTENT_KEY,
  PermissionRequestEvent,
  TURN_ERROR_CONTENT_KEY,
  TurnErrorCard,
} from "@agentpod/contract";
import { _resetHubEventsForTest, hubEventKind, hubEventTurn, quietSendsInFlight } from "../push/hub-events";
import { clearPendingPermission, matchPermissionAnswer, pendingPermissionFor } from "./permissions";
import { setFleetSink } from "../push/fleet/sink";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  attachRoomToSession,
  detachRoom,
  noteTurnTrigger,
  _attachedCountForTest,
} from "./outbound";

/**
 * The agent's answer, arriving in the room.
 *
 * The bridge is a second subscriber to the same in-process fan-out the console's
 * WebSocket already uses. What it must not do is forward that stream verbatim: a
 * Matrix event per token would buzz a phone forty times for one answer, hit rate
 * limits, and make the room unreadable.
 */

const ROOM = "!room:id.agentpod.dev";
const AGENT = "@agent_box_openclaw-krishna:id.agentpod.dev";
const SESSION = "acps_outbound_test";

let sent: Array<{ userId: string; roomId: string; body: string; extra?: Record<string, unknown> }> = [];
let typing: Array<{ roomId: string; on: boolean }> = [];
let listeners: Array<(e: any) => void> = [];
let reactions: Array<{ targetId: string; key: string }> = [];
let redacted: string[] = [];
let unsubscribed = 0;

function deps() {
  return {
    client: {
      sendText: async (userId: string, roomId: string, body: string, extra?: Record<string, unknown>) => {
        sent.push({ userId, roomId, body, ...(extra ? { extra } : {}) });
        return "$evt";
      },
      sendTyping: async (_userId: string, roomId: string, on: boolean) => {
        typing.push({ roomId, on });
      },
      sendReaction: async (_userId: string, _roomId: string, targetId: string, key: string) => {
        reactions.push({ targetId, key });
        return `$reaction-${reactions.length}`;
      },
      redact: async (_userId: string, _roomId: string, eventId: string) => {
        redacted.push(eventId);
      },
    },
    subscribe: (_sessionId: string, fn: (e: any) => void) => {
      listeners.push(fn);
      return () => {
        unsubscribed++;
        listeners = listeners.filter((l) => l !== fn);
      };
    },
    // Flush immediately in tests: the debounce is asserted separately by
    // counting messages, not by waiting for a timer.
    flushDelayMs: 0,
  };
}

function emit(e: unknown) {
  for (const l of [...listeners]) l(e);
}

const chunk = (text: string, seq = 1) => ({
  sessionId: SESSION,
  seq,
  type: "agent-update",
  payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  createdAt: new Date().toISOString(),
});

const thought = (text: string, seq = 1) => ({
  sessionId: SESSION,
  seq,
  type: "agent-update",
  payload: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } },
  createdAt: new Date().toISOString(),
});

const state = (status: string, seq = 9) => ({
  sessionId: SESSION,
  seq,
  type: "state",
  payload: { status },
  createdAt: new Date().toISOString(),
});

const permission = (seq = 5) => ({
  sessionId: SESSION,
  seq,
  type: "permission-request",
  payload: {
    toolCall: { title: "write /etc/hosts" },
    options: [
      { optionId: "allow", name: "Allow" },
      { optionId: "reject", name: "Reject" },
    ],
  },
  createdAt: new Date().toISOString(),
});

/** Let the flush microtask run. */
const settle = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  sent = [];
  typing = [];
  listeners = [];
  reactions = [];
  redacted = [];
  unsubscribed = 0;
  // The attachment map is module state — one per session, deliberately, so a
  // reconnect cannot double every message. Left attached, it would make the
  // next test's attach a no-op against a listener this one already dropped.
  detachRoom(SESSION);
  unsubscribed = 0;
});

describe("streaming an answer into a room", () => {
  test("sends the agent's text as the agent", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, deps());

    emit(chunk("Working on it."));
    emit(state("idle"));
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ userId: AGENT, roomId: ROOM, body: "Working on it." });
  });

  test("coalesces a stream of chunks into one message", async () => {
    // One Matrix event per token would be unreadable, would hit rate limits, and
    // would make a phone buzz forty times for one answer.
    attachRoomToSession(SESSION, ROOM, AGENT, deps());

    for (const c of ["Hel", "lo ", "there"]) emit(chunk(c));
    emit(state("idle"));
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe("Hello there");
  });

  test("does not split one answer because the agent paused mid-sentence", async () => {
    // Observed in production: the console showed one message and the room showed
    // two — "Hello! Analyst Echo" and " here, ready to turn your data into
    // insights…". A debounce short enough to chunk on a pause is a debounce that
    // cuts sentences in half, because an agent thinking mid-answer is ordinary.
    // The turn's end is the flush; the timer is only a safety net for a turn
    // that never ends.
    attachRoomToSession(SESSION, ROOM, AGENT, { ...deps(), flushDelayMs: undefined });

    emit(chunk("Hello! Analyst Echo"));
    await new Promise((r) => setTimeout(r, 900));
    emit(chunk(" here, ready to help."));
    emit(state("idle"));
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe("Hello! Analyst Echo here, ready to help.");
  }, 10_000);

  test("does not send an empty message when a turn produced no text", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, deps());

    emit(state("working"));
    emit(state("idle"));
    await settle();

    expect(sent).toHaveLength(0);
  });

  test("keeps the agent's thinking out of the room", async () => {
    // Reasoning chunks are for the console's transcript. Putting them in a room
    // that people share would turn one answer into a monologue.
    attachRoomToSession(SESSION, ROOM, AGENT, deps());

    emit(thought("maybe I should check the disk"));
    emit(chunk("Disk is fine."));
    emit(state("idle"));
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe("Disk is fine.");
  });

  test("shows typing while the turn is in flight, and stops at the end", async () => {
    // Without this the room looks dead for the ten seconds an agent is thinking.
    attachRoomToSession(SESSION, ROOM, AGENT, deps());

    emit(state("working"));
    await settle();
    expect(typing.at(-1)).toMatchObject({ roomId: ROOM, on: true });

    emit(chunk("done"));
    emit(state("idle"));
    await settle();
    expect(typing.at(-1)).toMatchObject({ roomId: ROOM, on: false });
  });

  test("puts a permission request in the room, with its options", async () => {
    // An agent blocked on a permission prompt with nobody watching the console
    // has silently stopped. In the room it is a question somebody can see.
    attachRoomToSession(SESSION, ROOM, AGENT, deps());

    emit(permission());
    await settle();

    const body = sent.at(-1)!.body;
    expect(body).toMatch(/permission/i);
    expect(body).toContain("write /etc/hosts");
    expect(body).toContain("Allow");
    expect(body).toContain("Reject");
  });

  test("reports an error into the room rather than leaving it silent", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, deps());

    emit({
      sessionId: SESSION,
      seq: 3,
      type: "error",
      payload: { message: "harness exited" },
      createdAt: new Date().toISOString(),
    });
    await settle();

    expect(sent.at(-1)!.body).toMatch(/harness exited/);
  });

  test("flushes what it has when the session ends", async () => {
    // A turn interrupted by an ended session must not swallow the words the
    // agent already produced.
    attachRoomToSession(SESSION, ROOM, AGENT, deps());

    emit(chunk("half a sen"));
    emit(state("ended"));
    await settle();

    expect(sent.at(-1)!.body).toBe("half a sen");
  });

  test("stops listening when the session ends, and leaks nothing", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, deps());
    expect(_attachedCountForTest()).toBe(1);

    emit(state("ended"));
    await settle();

    expect(unsubscribed).toBe(1);
    expect(_attachedCountForTest()).toBe(0);
  });

  test("ignores events that arrive after the session ended", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, deps());

    emit(state("ended"));
    await settle();
    const after = sent.length;

    emit(chunk("late"));
    await settle();

    expect(sent).toHaveLength(after);
  });

  test("attaching twice does not double every message", async () => {
    // Provisioning and a reconnect both attach. Two subscribers on one session
    // would say everything twice, which reads as an agent repeating itself.
    const d = deps();
    attachRoomToSession(SESSION, ROOM, AGENT, d);
    attachRoomToSession(SESSION, ROOM, AGENT, d);

    emit(chunk("once"));
    emit(state("idle"));
    await settle();

    expect(sent).toHaveLength(1);
    expect(_attachedCountForTest()).toBe(1);
  });

  test("detaching stops the stream and unsubscribes", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, deps());

    detachRoom(SESSION);

    expect(unsubscribed).toBe(1);
    expect(_attachedCountForTest()).toBe(0);
  });

  test("a send that fails does not kill the subscription", async () => {
    // A homeserver hiccup must not silently detach the room; the next turn
    // should still arrive.
    let failNext = true;
    const d = {
      ...deps(),
      client: {
        sendText: async (userId: string, roomId: string, body: string) => {
          if (failNext) {
            failNext = false;
            throw new Error("homeserver 502");
          }
          sent.push({ userId, roomId, body });
          return "$evt";
        },
        sendTyping: async () => {},
      },
    };
    attachRoomToSession(SESSION, ROOM, AGENT, d);

    emit(chunk("first"));
    emit(state("idle"));
    await settle();

    emit(chunk("second"));
    emit(state("idle"));
    await settle();

    expect(sent.map((s) => s.body)).toEqual(["second"]);
    expect(_attachedCountForTest()).toBe(1);
    detachRoom(SESSION);
  });
});

describe("live feedback, so a room is not a black box", () => {
  test("stops typing when the agent is waiting on a permission answer", async () => {
    // The bug an operator saw: typing stayed on long after the answer arrived.
    // `waiting` is not `idle`, and a permission request the room cannot answer
    // could sit there for hours with the agent apparently still typing.
    attachRoomToSession(SESSION, ROOM, AGENT, deps());

    emit(state("working"));
    await settle();
    expect(typing.at(-1)!.on).toBe(true);

    emit(state("waiting"));
    await settle();

    expect(typing.at(-1)!.on).toBe(false);
  });

  test("keeps typing alive through a turn longer than the homeserver's timeout", async () => {
    // A typing notice expires after ~30s. A three-minute turn would show typing
    // for the first thirty seconds and then look abandoned.
    attachRoomToSession(SESSION, ROOM, AGENT, { ...deps(), typingRefreshMs: 30 });

    emit(state("working"));
    await new Promise((r) => setTimeout(r, 120));

    expect(typing.filter((t) => t.on).length).toBeGreaterThan(1);

    emit(state("idle"));
    await settle();
    expect(typing.at(-1)!.on).toBe(false);
  }, 10_000);

  test("stops refreshing typing once the turn ends", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, { ...deps(), typingRefreshMs: 30 });
    emit(state("working"));
    await new Promise((r) => setTimeout(r, 80));

    emit(state("idle"));
    await settle();
    const after = typing.length;
    await new Promise((r) => setTimeout(r, 120));

    expect(typing).toHaveLength(after);
  }, 10_000);

  test("marks the message it is working on, and clears the mark when done", async () => {
    // The vocabulary hermes's own Matrix plugin used: 👀 while working, ✅ when
    // finished. It answers "did it even hear me" without a message.
    noteTurnTrigger(SESSION, "$user-msg-1");
    attachRoomToSession(SESSION, ROOM, AGENT, deps());

    emit(state("working"));
    await settle();
    expect(reactions.at(-1)).toEqual({ targetId: "$user-msg-1", key: "👀" });

    emit(chunk("4."));
    emit(state("idle"));
    await settle();

    // The eyes are redacted rather than left beside the tick: two marks on one
    // message reads as two states at once.
    expect(redacted).toContain("$reaction-1");
    expect(reactions.at(-1)).toEqual({ targetId: "$user-msg-1", key: "✅" });
  });

  test("marks a failed turn with a cross, not a tick", async () => {
    noteTurnTrigger(SESSION, "$user-msg-2");
    attachRoomToSession(SESSION, ROOM, AGENT, deps());

    emit(state("working"));
    await settle();
    emit({
      sessionId: SESSION,
      seq: 4,
      type: "error",
      payload: { message: "harness exited" },
      createdAt: new Date().toISOString(),
    });
    // Held until the turn ends: a harness may retry after an error (#583).
    emit(state("idle"));
    await settle();

    expect(reactions.at(-1)).toEqual({ targetId: "$user-msg-2", key: "❌" });
  });

  test("an error the harness recovers from is not reported: the answer after it wins", async () => {
    // Krishna, 2026-09-26: Kimi's quota error, then the fallback's answer. The
    // room showed the error and a ❌, then the answer underneath (#583).
    noteTurnTrigger(SESSION, "$user-msg-recovered");
    attachRoomToSession(SESSION, ROOM, AGENT, deps());

    emit(state("working"));
    emit({
      sessionId: SESSION,
      seq: 3,
      type: "error",
      payload: { message: "You've reached your weekly (7-day) usage limit." },
      createdAt: new Date().toISOString(),
    });
    emit(chunk("Hey Rakesh. I'm here."));
    emit(state("idle"));
    await settle();

    expect(sent.some((m) => /reported an error/.test(m.body))).toBe(false);
    expect(reactions.at(-1)).toEqual({ targetId: "$user-msg-recovered", key: "✅" });
  });

  test("an error after part of an answer, with nothing after it, is still reported", async () => {
    noteTurnTrigger(SESSION, "$user-msg-cut");
    attachRoomToSession(SESSION, ROOM, AGENT, deps());

    emit(state("working"));
    emit(chunk("Let me check"));
    emit({
      sessionId: SESSION,
      seq: 4,
      type: "error",
      payload: { message: "harness exited" },
      createdAt: new Date().toISOString(),
    });
    emit(state("idle"));
    await settle();

    expect(sent.some((m) => /reported an error: harness exited/.test(m.body))).toBe(true);
    expect(reactions.at(-1)).toEqual({ targetId: "$user-msg-cut", key: "❌" });
  });

  test("an error outside a turn has no end to wait for, so it is said at once", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, deps());
    emit({
      sessionId: SESSION,
      seq: 5,
      type: "error",
      payload: { message: "node went away" },
      createdAt: new Date().toISOString(),
    });
    await settle();

    expect(sent.some((m) => /reported an error: node went away/.test(m.body))).toBe(true);
  });

  test("reacts to the message that started THIS turn, not the previous one", async () => {
    // A room is a conversation. Marking the wrong message would tell somebody
    // their old question was being worked on.
    noteTurnTrigger(SESSION, "$first");
    attachRoomToSession(SESSION, ROOM, AGENT, deps());
    emit(state("working"));
    emit(state("idle"));
    await settle();

    noteTurnTrigger(SESSION, "$second");
    emit(state("working"));
    await settle();

    expect(reactions.at(-1)!.targetId).toBe("$second");
  });

  test("says nothing with reactions when there is no message to mark", async () => {
    // An unprompted turn — a cron job speaking — has no user message to react to.
    attachRoomToSession(SESSION, ROOM, AGENT, deps());

    emit(state("working"));
    await settle();

    expect(reactions).toHaveLength(0);
  });
});

describe("streaming a turn to the reader's own devices", () => {
  /**
   * The deps above plus a to-device sink and a reader. Kept separate from
   * `deps()` so every existing test goes on proving the no-streaming case:
   * without `sendToDevice` the room is identical, which is the property that
   * makes this safe to turn on against a live fleet.
   */
  function streamingDeps() {
    const base = deps();
    const deltas: Array<{ to: string; type: string; content: any }> = [];
    return {
      deltas,
      deps: {
        ...base,
        client: {
          ...base.client,
          sendToDevice: async (
            _userId: string,
            targetUserId: string,
            eventType: string,
            content: Record<string, unknown>
          ) => {
            deltas.push({ to: targetUserId, type: eventType, content });
          },
        },
        readerFor: async () => "@rakesh:x.org",
      },
    };
  }

  test("pushes the answer as it arrives, and the room still gets one message", async () => {
    const { deltas, deps } = streamingDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, deps as any);

    // Two finished sentences, each long enough to be worth sending.
    // Emitted back-to-back, like the coalescing test above: `flushDelayMs` is
    // 0 here, so settling between chunks would end the turn between them and
    // the second sentence would belong to a different answer.
    emit(chunk("I looked at the node and it is online. "));
    emit(chunk("Nothing else needs doing right now."));
    await settle();
    emit(state("idle"));
    await settle();

    // The live view moved more than once...
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.every((d) => d.to === "@rakesh:x.org")).toBe(true);
    expect(deltas.every((d) => d.type === "dev.agentpod.stream.delta")).toBe(true);

    // ...while the room received exactly one message, unchanged by any of it.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe(
      "I looked at the node and it is online. Nothing else needs doing right now."
    );
  });

  test("carries the whole answer each time, so a dropped delta cannot corrupt it", async () => {
    const { deltas, deps } = streamingDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, deps as any);

    emit(chunk("First sentence, long enough to send. "));
    emit(chunk("Second sentence, also long enough."));
    await settle();
    emit(state("idle"));
    await settle();

    const texts = deltas.map((d) => d.content.text as string);
    // Each delta is a prefix of the next: cumulative, never an increment.
    for (let i = 1; i < texts.length; i++) {
      expect(texts[i]!.startsWith(texts[i - 1]!)).toBe(true);
    }
    expect(texts.at(-1)).toBe("First sentence, long enough to send. Second sentence, also long enough.");
  });

  test("marks the last delta done, and numbers each turn from one", async () => {
    const { deltas, deps } = streamingDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, deps as any);

    emit(chunk("A complete first answer, long enough to stream."));
    await settle();
    emit(state("idle"));
    await settle();

    expect(deltas.at(-1)!.content.done).toBe(true);
    expect(deltas.map((d) => d.content.seq)).toEqual(
      deltas.map((_, i) => i + 1)
    );

    // A second turn starts its own sequence, so a reader can tell a new answer
    // from more of the last one.
    const before = deltas.length;
    emit(chunk("A second answer, also long enough to stream."));
    await settle();
    emit(state("idle"));
    await settle();

    expect(deltas[before]!.content.seq).toBe(1);
  });

  test("says nothing to a room with nobody to show it to", async () => {
    const { deltas, deps } = streamingDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, { ...deps, readerFor: async () => null } as any);

    emit(chunk("An answer nobody is watching for, long enough to stream."));
    await settle();
    emit(state("idle"));
    await settle();

    expect(deltas).toHaveLength(0);
    // ...and the room is unaffected.
    expect(sent).toHaveLength(1);
  });
});

describe("an agent's thinking and tool use", () => {
  /** The same shape as `streamingDeps` above, with its own sink. */
  function activityDeps() {
    const base = deps();
    const events: Array<{ type: string; content: any }> = [];
    return {
      events,
      deps: {
        ...base,
        client: {
          ...base.client,
          sendToDevice: async (
            _userId: string,
            _targetUserId: string,
            eventType: string,
            content: Record<string, unknown>
          ) => {
            events.push({ type: eventType, content });
          },
        },
        readerFor: async () => "@rakesh:x.org",
      },
    };
  }

  const toolCall = (payload: Record<string, unknown>, seq = 2) => ({
    sessionId: SESSION,
    seq,
    type: "agent-update",
    payload,
    createdAt: new Date().toISOString(),
  });

  test("reasoning reaches the reader's devices and never the room", async () => {
    // The decision this defends is older than this test: reasoning "belongs in
    // the console's transcript, not in a room people share, where it would turn
    // one answer into a monologue". 202 thought chunks in one observed Hermes
    // turn is the number behind that sentence. Watchable, never permanent.
    const { events, deps: d } = activityDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, d as any);

    emit(thought("Weighing whether the node is really down. "));
    await settle();
    emit(state("idle"));
    await settle();

    expect(events.filter((e) => e.type === "dev.agentpod.thought.delta").length).toBeGreaterThan(0);
    expect(sent).toHaveLength(0);
  });

  test("reasoning keeps its own sequence, so it cannot be read as the answer", async () => {
    const { events, deps: d } = activityDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, d as any);

    emit(chunk("The answer, long enough to be worth sending. "));
    emit(thought("The reasoning, also long enough to send. "));
    await settle();

    const answer = events.find((e) => e.type === "dev.agentpod.stream.delta");
    const reasoning = events.find((e) => e.type === "dev.agentpod.thought.delta");
    expect(answer!.content.seq).toBe(1);
    expect(reasoning!.content.seq).toBe(1);
    expect(answer!.content.text).toBe("The answer, long enough to be worth sending. ");
    expect(reasoning!.content.text).toBe("The reasoning, also long enough to send. ");
  });

  test("a tool call reaches the devices and not the room", async () => {
    const { events, deps: d } = activityDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, d as any);

    emit(
      toolCall({
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "Read src/main.ts",
        kind: "read",
        status: "in_progress",
        locations: [{ path: "src/main.ts" }],
      })
    );
    await settle();

    const update = events.find((e) => e.type === "dev.agentpod.tool.update");
    expect(update!.content).toMatchObject({
      tool_call_id: "c1",
      title: "Read src/main.ts",
      kind: "read",
      status: "in_progress",
      locations: ["src/main.ts"],
    });
    expect(sent).toHaveLength(0);
  });

  test("an update to a tool call carries the title the call was given", async () => {
    const { events, deps: d } = activityDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, d as any);

    emit(toolCall({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Run tests" }, 2));
    emit(toolCall({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" }, 3));
    await settle();

    const updates = events.filter((e) => e.type === "dev.agentpod.tool.update");
    expect(updates).toHaveLength(2);
    expect(updates[1]!.content).toMatchObject({
      tool_call_id: "c1",
      title: "Run tests",
      status: "failed",
    });
  });

  test("a tool call with no id is ignored, since nothing could merge onto it", async () => {
    const { events, deps: d } = activityDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, d as any);

    emit(toolCall({ sessionUpdate: "tool_call", title: "Nameless" }));
    await settle();

    expect(events.filter((e) => e.type === "dev.agentpod.tool.update")).toHaveLength(0);
  });

  test("a room with no reader sends nothing anywhere, and still says the answer", async () => {
    // The property that makes this safe against a live fleet: every activity
    // channel is best-effort and none of them touches the room.
    const base = deps();
    const events: Array<{ type: string }> = [];
    attachRoomToSession(SESSION, ROOM, AGENT, {
      ...base,
      client: {
        ...base.client,
        sendToDevice: async (_u: string, _t: string, type: string) => {
          events.push({ type });
        },
      },
      readerFor: async () => null,
    } as any);

    emit(thought("Thinking about it. "));
    emit(toolCall({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read a file" }));
    emit(chunk("Here is the answer."));
    await settle();
    emit(state("idle"));
    await settle();

    expect(events).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe("Here is the answer.");
  });
});

describe("the durable record of a turn", () => {
  /** Deps with a custom-event sink, and a shared clock so order is assertable. */
  function recordingDeps() {
    const base = deps();
    let tick = 0;
    const custom: Array<{ type: string; content: any; at: number }> = [];
    const said: Array<{ body: string; at: number }> = [];
    return {
      custom,
      said,
      deps: {
        ...base,
        client: {
          ...base.client,
          sendText: async (_userId: string, _roomId: string, body: string) => {
            said.push({ body, at: tick++ });
            return `$msg-${said.length}`;
          },
          sendCustomEvent: async (
            _userId: string,
            _roomId: string,
            eventType: string,
            content: Record<string, unknown>
          ) => {
            custom.push({ type: eventType, content, at: tick++ });
            return `$custom-${custom.length}`;
          },
        },
      },
    };
  }

  const tool = (payload: Record<string, unknown>, seq = 2) => ({
    sessionId: SESSION,
    seq,
    type: "agent-update",
    payload,
    createdAt: new Date().toISOString(),
  });

  test("records one card per turn, before the answer", async () => {
    // Reading order is the point: did these things, then said this.
    const { custom, said, deps: d } = recordingDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, d as any);

    emit(tool({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read a", status: "completed" }));
    emit(chunk("Done."));
    await settle();
    emit(state("idle"));
    await settle();

    expect(custom).toHaveLength(1);
    expect(custom[0]!.type).toBe("dev.agentpod.turn.v1");
    expect(custom[0]!.content.tools[0]).toMatchObject({ id: "c1", title: "Read a" });
    expect(said).toHaveLength(1);
    expect(custom[0]!.at).toBeLessThan(said[0]!.at);
  });

  test("says nothing extra for a turn that used no tools", async () => {
    const { custom, said, deps: d } = recordingDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, d as any);

    emit(chunk("Just talking."));
    await settle();
    emit(state("idle"));
    await settle();

    expect(custom).toHaveLength(0);
    expect(said).toHaveLength(1);
  });

  test("records a turn that worked and said nothing", async () => {
    // The empty-text guard sits after the card on purpose: an agent that did
    // things and reported none of them is exactly when the record matters.
    const { custom, said, deps: d } = recordingDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, d as any);

    emit(tool({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Tidy up", status: "completed" }));
    await settle();
    emit(state("idle"));
    await settle();

    expect(custom).toHaveLength(1);
    expect(said).toHaveLength(0);
  });

  test("does not report the previous turn's work on the next turn", async () => {
    const { custom, deps: d } = recordingDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, d as any);

    emit(tool({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read a", status: "completed" }));
    await settle();
    emit(state("idle"));
    await settle();

    emit(chunk("Second turn, no tools."));
    await settle();
    emit(state("idle"));
    await settle();

    expect(custom).toHaveLength(1);
  });

  test("notes the answer as the turn's outcome, with its counts, for the push gateway", async () => {
    _resetHubEventsForTest();
    const { said, deps: d } = recordingDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, d as any);

    emit(tool({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read a", status: "completed" }));
    emit(tool({ sessionUpdate: "tool_call", toolCallId: "c2", title: "Run tests", status: "failed" }, 3));
    emit(tool({ sessionUpdate: "tool_call", toolCallId: "c3", title: "Fix", status: "completed" }, 4));
    emit(chunk("Two of three."));
    await settle();
    emit(state("idle"));
    await settle();

    expect(said).toHaveLength(1);
    expect(hubEventKind("$msg-1")).toBe("answer");
    expect(hubEventTurn("$msg-1")).toEqual({ total: 3, failed: 1 });
    // Announced while in flight, so a push that beats the send waits for it —
    // and nothing is left in flight afterwards.
    expect(quietSendsInFlight(ROOM)).toBe(0);
  });

  test("an answer to a turn with no tools is not noted — there is no outcome to carry", async () => {
    _resetHubEventsForTest();
    const { said, deps: d } = recordingDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, d as any);

    emit(chunk("Just talking."));
    await settle();
    emit(state("idle"));
    await settle();

    expect(said).toHaveLength(1);
    expect(hubEventKind("$msg-1")).toBeUndefined();
  });

  test("a deployment without sendCustomEvent still says the answer", async () => {
    // The property that makes this safe to roll out: the card is additive, and
    // its absence changes nothing else.
    const base = deps();
    attachRoomToSession(SESSION, ROOM, AGENT, base as any);

    emit(tool({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read a" }));
    emit(chunk("Answer regardless."));
    await settle();
    emit(state("idle"));
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe("Answer regardless.");
  });
});

describe("a permission request a client can render", () => {
  function recordingDeps() {
    const base = deps();
    const custom: Array<{ type: string; content: any }> = [];
    return {
      custom,
      deps: {
        ...base,
        client: {
          ...base.client,
          sendCustomEvent: async (
            _userId: string,
            _roomId: string,
            eventType: string,
            content: Record<string, unknown>
          ) => {
            custom.push({ type: eventType, content });
            return "$custom-1";
          },
        },
      },
    };
  }

  test("sends the structured event beside the prose, never instead of it", async () => {
    // The regression that matters: a client that cannot read the custom event
    // must be exactly as able to approve as it was before.
    const { custom, deps: d } = recordingDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, d as any);

    emit(permission());
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Permission needed: write /etc/hosts");
    expect(sent[0]!.body).toContain("1. Allow");
    expect(sent[0]!.body).toContain("Reply with the number, or the option's name.");

    expect(custom).toHaveLength(1);
    expect(custom[0]!.type).toBe("dev.agentpod.permission.v1");
    expect(custom[0]!.content.options).toEqual([
      { option_id: "allow", name: "Allow" },
      { option_id: "reject", name: "Reject" },
    ]);
  });

  test("the structured request rides inside the prose, under dev.agentpod.permission", async () => {
    // One question, one event, one push: the key is what lets a phone's
    // extension classify the push, in an encrypted room or not.
    const { deps: d } = recordingDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, d as any);

    emit(permission(7));
    await settle();

    expect(sent).toHaveLength(1);
    const embedded = PermissionRequestEvent.parse(sent[0]!.extra?.[PERMISSION_REQUEST_CONTENT_KEY]);
    expect(embedded).toEqual({
      schema_version: 1,
      session_id: SESSION,
      request_seq: 7,
      title: "write /etc/hosts",
      options: [
        { option_id: "allow", name: "Allow" },
        { option_id: "reject", name: "Reject" },
      ],
    });
  });

  test("the legacy event carries the same payload, and its push is marked as a companion", async () => {
    _resetHubEventsForTest();
    const { custom, deps: d } = recordingDeps();
    attachRoomToSession(SESSION, ROOM, AGENT, d as any);

    emit(permission(7));
    await settle();

    expect(custom[0]!.content).toEqual(sent[0]!.extra?.[PERMISSION_REQUEST_CONTENT_KEY]);
    // `$evt` is the prose (the recording sendText's id), `$custom-1` the legacy event.
    expect(hubEventKind("$evt")).toBe("permission");
    expect(hubEventKind("$custom-1")).toBe("companion");
  });

  test("with the legacy flag off, only the prose is sent — and the answer still matches", async () => {
    const before = process.env.AGENTPOD_LEGACY_PERMISSION_EVENTS;
    process.env.AGENTPOD_LEGACY_PERMISSION_EVENTS = "false";
    try {
      const { custom, deps: d } = recordingDeps();
      attachRoomToSession(SESSION, ROOM, AGENT, d as any);

      emit(permission(7));
      await settle();

      expect(custom).toHaveLength(0);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.extra?.[PERMISSION_REQUEST_CONTENT_KEY]).toBeDefined();
      // Answering is keyed on the request the hub holds for the room, not on
      // an event id — so dropping the legacy event cannot strand an answer.
      const pending = pendingPermissionFor(ROOM)!;
      expect(pending.requestSeq).toBe(7);
      expect(matchPermissionAnswer("2", pending.options)).toBe("reject");
    } finally {
      if (before === undefined) delete process.env.AGENTPOD_LEGACY_PERMISSION_EVENTS;
      else process.env.AGENTPOD_LEGACY_PERMISSION_EVENTS = before;
    }
  });

  test("a prose send that failed leaves the legacy event pushable", async () => {
    _resetHubEventsForTest();
    const { deps: d } = recordingDeps();
    const failing = { ...d, client: { ...d.client, sendText: async () => { throw new Error("homeserver down"); } } };
    attachRoomToSession(SESSION, ROOM, AGENT, failing as any);

    emit(permission(7));
    await settle();

    expect(hubEventKind("$custom-1")).toBeUndefined();
  });

  test("a deployment without sendCustomEvent still asks in words", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, deps() as any);

    emit(permission());
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Permission needed");
  });
});

describe("a turn that ends without saying anything", () => {
  test("does not mark it done, and says what happened", async () => {
    // Measured in production on 2026-08-17: a provider quota was exhausted,
    // every model in the failover chain failed, and openclaw ended the turn
    // `idle` without emitting an ACP error. The room put a ✅ on the reader's
    // message and showed nothing else. They asked twice — "Hi", then "No
    // reply?" — and got a green tick both times.
    //
    // The hub cannot know *why* nothing came back. It can know that nothing
    // did, and refuse to call that success.
    attachRoomToSession(SESSION, ROOM, AGENT, deps() as any);
    noteTurnTrigger(SESSION, "$user-msg-silent");

    emit(state("working"));
    await settle();
    emit(state("idle"));
    await settle();

    expect(reactions.at(-1)).toEqual({ targetId: "$user-msg-silent", key: "❌" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatch(/without a reply/i);
  });

  test("still marks a turn done when the agent actually said something", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, deps() as any);
    noteTurnTrigger(SESSION, "$user-msg-answered");

    emit(state("working"));
    emit(chunk("Here you go."));
    await settle();
    emit(state("idle"));
    await settle();

    expect(reactions.at(-1)).toEqual({ targetId: "$user-msg-answered", key: "✅" });
    expect(sent.some((m) => /without a reply/i.test(m.body))).toBe(false);
  });

  test("counts tool work as having happened, even with nothing said", async () => {
    // An agent that tidied up and reported nothing did something. The turn
    // card records it, and a ❌ would be wrong.
    attachRoomToSession(SESSION, ROOM, AGENT, deps() as any);
    noteTurnTrigger(SESSION, "$user-msg-tools");

    emit(state("working"));
    emit({
      sessionId: SESSION,
      seq: 2,
      type: "agent-update",
      payload: { sessionUpdate: "tool_call", toolCallId: "c1", title: "Tidy up", status: "completed" },
      createdAt: new Date().toISOString(),
    });
    await settle();
    emit(state("idle"));
    await settle();

    expect(reactions.at(-1)).toEqual({ targetId: "$user-msg-tools", key: "✅" });
    expect(sent.some((m) => /without a reply/i.test(m.body))).toBe(false);
  });

  test("leaves a reported error to the error path, which already explains itself", async () => {
    // The `error` event says what went wrong. Adding "ended without a reply"
    // underneath it would be the same news twice, and less specific.
    attachRoomToSession(SESSION, ROOM, AGENT, deps() as any);
    noteTurnTrigger(SESSION, "$user-msg-error");

    emit(state("working"));
    emit({
      sessionId: SESSION,
      seq: 2,
      type: "error",
      payload: { message: "harness exited" },
      createdAt: new Date().toISOString(),
    });
    await settle();
    emit(state("idle"));
    await settle();

    expect(sent.some((m) => /without a reply/i.test(m.body))).toBe(false);
    expect(sent.some((m) => /harness exited/.test(m.body))).toBe(true);
  });

  test("says nothing about a turn nobody in the room started", async () => {
    // A cron job speaking has no reader waiting on it, and no message to mark.
    attachRoomToSession(SESSION, ROOM, AGENT, deps() as any);

    emit(state("working"));
    await settle();
    emit(state("idle"));
    await settle();

    expect(sent).toHaveLength(0);
  });

  test("a session ending between turns does not fail the last, answered message", async () => {
    // krishna, 2026-09-24 10:21: a turn answered at 08:48 (✅). The node then
    // dropped, the session went `waiting` ("node offline") and a minute later
    // `ended` ("Couldn't reach the node."). The room put ❌ on the 08:48
    // message and said it had ended without a reply — about a turn that had
    // replied, and was over, 90 minutes earlier.
    attachRoomToSession(SESSION, ROOM, AGENT, deps() as any);
    noteTurnTrigger(SESSION, "$user-msg-answered");

    emit(state("working"));
    emit(chunk("Here you go."));
    await settle();
    emit(state("idle"));
    await settle();
    const before = { reactions: reactions.length, sent: sent.length };

    emit({ ...state("waiting"), payload: { status: "waiting", reason: "node offline" } });
    await settle();
    emit({ ...state("ended"), payload: { status: "ended", reason: "Couldn't reach the node." } });
    await settle();

    expect(reactions.slice(before.reactions).some((r) => r.key === "❌")).toBe(false);
    expect(sent.length).toBe(before.sent);
  });

  test("a turn after an unprompted one does not reuse the previous reader's message", async () => {
    // The trigger belongs to the turn that consumed it. A later turn nobody in
    // the room asked for (a cron job) must not mark the earlier message.
    attachRoomToSession(SESSION, ROOM, AGENT, deps() as any);
    noteTurnTrigger(SESSION, "$user-msg-first");

    emit(state("working"));
    emit(chunk("Answered."));
    await settle();
    emit(state("idle"));
    await settle();
    const before = reactions.length;

    emit(state("working"));
    await settle();
    emit(state("idle"));
    await settle();

    expect(reactions.slice(before)).toEqual([]);
    expect(sent.some((m) => /without a reply/i.test(m.body))).toBe(false);
  });

  test("a turn that pauses for permission keeps the message that started it", async () => {
    // working → waiting → working is still one turn. Its second `working` has
    // no fresh trigger, and must not lose the one it already has.
    attachRoomToSession(SESSION, ROOM, AGENT, deps() as any);
    noteTurnTrigger(SESSION, "$user-msg-asks");

    emit(state("working"));
    await settle();
    emit(permission());
    emit(state("waiting"));
    await settle();
    emit(state("working"));
    emit(chunk("Done, with your say-so."));
    await settle();
    emit(state("idle"));
    await settle();

    expect(reactions.at(-1)).toEqual({ targetId: "$user-msg-asks", key: "✅" });
  });

  test("a turn cut off by its session ending says why, not just that it was silent", async () => {
    // The hub knows this one: the state carries the reason. "Its own logs will
    // say why" sends the reader looking for something the hub already had.
    attachRoomToSession(SESSION, ROOM, AGENT, deps() as any);
    noteTurnTrigger(SESSION, "$user-msg-cut");

    emit(state("working"));
    await settle();
    emit({ ...state("ended"), payload: { status: "ended", reason: "Couldn't reach the node." } });
    await settle();

    expect(reactions.at(-1)).toEqual({ targetId: "$user-msg-cut", key: "❌" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Couldn't reach the node.");
  });
});


describe("a failed turn a client can draw", () => {
  const krishna = {
    message: "You've reached your weekly (7-day) usage limit.",
    kind: "quota",
    harness: "openclaw",
    provider: "kimi-coding",
    model: "k2p6",
    retryable: false,
    source: "plugin",
    providerErrorType: "permission_error",
    attempts: [
      { provider: "kimi-coding", model: "k2p6", kind: "quota", message: "You've reached your weekly (7-day) usage limit.", providerErrorType: "permission_error" },
      { provider: "opencode-go", model: "hy3-preview", kind: "bad_request", message: "Request is missing x-opencode-session", httpStatus: 400 },
    ],
  };

  test("the error notice carries the card under its key, beside the readable body", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, deps() as any);
    noteTurnTrigger(SESSION, "$user-msg-card");
    emit(state("working"));
    emit({ sessionId: SESSION, seq: 2, type: "error", payload: krishna, createdAt: new Date().toISOString() });
    emit(state("idle"));
    await settle();

    const notice = sent.find((m) => /reported an error/.test(m.body))!;
    expect(notice.body).toContain("weekly (7-day) usage limit");
    const card = TurnErrorCard.parse(notice.extra?.[TURN_ERROR_CONTENT_KEY]);
    expect(card).toMatchObject({ schema_version: 1, kind: "quota", provider: "kimi-coding", model: "k2p6", harness: "openclaw" });
    expect(card.attempts!.map((a) => a.provider)).toEqual(["kimi-coding", "opencode-go"]);
    // What a reader does not need stays out of the room.
    expect(JSON.stringify(card)).not.toContain("permission_error");
    expect(JSON.stringify(card)).not.toContain("plugin");
  });

  test("an error with only words, from before the shape existed, is sent as words alone", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, deps() as any);
    noteTurnTrigger(SESSION, "$user-msg-old");
    emit(state("working"));
    emit({ sessionId: SESSION, seq: 2, type: "error", payload: { message: "harness exited" }, createdAt: new Date().toISOString() });
    emit(state("idle"));
    await settle();
    const notice = sent.find((m) => /harness exited/.test(m.body))!;
    expect(notice.extra).toBeUndefined();
  });

  test("an oversized error is bounded, not dropped: the card still parses", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, deps() as any);
    noteTurnTrigger(SESSION, "$user-msg-big");
    emit(state("working"));
    const huge = {
      ...krishna,
      message: "x".repeat(20_000),
      attempts: Array.from({ length: 40 }, () => ({ ...krishna.attempts[1], message: "y".repeat(9_000) })),
    };
    emit({ sessionId: SESSION, seq: 2, type: "error", payload: huge, createdAt: new Date().toISOString() });
    emit(state("idle"));
    await settle();
    const notice = sent.find((m) => /reported an error/.test(m.body))!;
    const card = TurnErrorCard.parse(notice.extra?.[TURN_ERROR_CONTENT_KEY]);
    expect(card.attempts!.length).toBe(16);
  });
});

describe("a turn that chose silence", () => {
  test("is marked done, with no notice: the agent decided to say nothing", async () => {
    // OpenClaw's NO_REPLY (krishna, 2026-09-26 08:56, to "Okay."). The hub
    // marks such a turn's idle state `silent`; it is not a failed turn.
    attachRoomToSession(SESSION, ROOM, AGENT, deps() as any);
    noteTurnTrigger(SESSION, "$user-msg-okay");
    emit(state("working"));
    await settle();
    emit({ ...state("idle"), payload: { status: "idle", silent: true } });
    await settle();

    expect(reactions.at(-1)).toEqual({ targetId: "$user-msg-okay", key: "✅" });
    expect(sent).toHaveLength(0);
  });
});

describe("the fleet Live Activity", () => {
  type Noted = { reader: string; event: any };
  let noted: Noted[] = [];
  let cleared: string[] = [];
  let nameLookups = 0;

  const sink = {
    note: (reader: string, event: any) => noted.push({ reader, event }),
    clearDecision: (key: string) => cleared.push(key),
    reconcileGates: () => {},
    knowsDecision: () => false,
  };

  function fleetDeps(over: Record<string, unknown> = {}) {
    const base = deps();
    return {
      ...base,
      client: {
        ...base.client,
        sendCustomEvent: async () => "$turn-record",
      },
      readerFor: async () => "@owner:id.agentpod.dev",
      nameFor: async () => {
        nameLookups++;
        return "Krishna";
      },
      ...over,
    } as any;
  }

  const tool = (payload: Record<string, unknown>, seq = 2) => ({
    sessionId: SESSION,
    seq,
    type: "agent-update",
    payload,
    createdAt: new Date().toISOString(),
  });

  beforeEach(() => {
    noted = [];
    cleared = [];
    nameLookups = 0;
    setFleetSink(sink);
  });
  afterEach(() => setFleetSink(null));

  test("a turn is reported as it runs: started, each step with its counts, finished with the record's counts", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, fleetDeps());
    emit(state("working", 1));
    await settle();
    emit(tool({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read a", status: "in_progress" }));
    emit(tool({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" }, 3));
    emit(tool({ sessionUpdate: "tool_call", toolCallId: "c2", title: "Run tests", status: "failed" }, 4));
    emit(chunk("One failed.", 5));
    await settle();
    emit(state("idle", 6));
    await settle();

    const types = noted.map((n) => n.event.type);
    expect(noted.every((n) => n.reader === "@owner:id.agentpod.dev")).toBe(true);
    expect(noted.every((n) => n.event.roomId === ROOM && n.event.name === "Krishna")).toBe(true);
    expect(types[0]).toBe("turn-started");
    expect(noted.filter((n) => n.event.type === "step").map((n) => [n.event.title, n.event.completed, n.event.total])).toEqual([
      ["Read a", 0, 1],
      ["Read a", 1, 1],
      ["Run tests", 2, 2],
    ]);
    expect(types).toContain("spoke");
    expect(noted.at(-1)!.event).toMatchObject({ type: "turn-finished", total: 2, failed: 1, failedAt: 2, errored: false });
    // Looked up once for the room, not once per event.
    expect(nameLookups).toBe(1);
  });

  test("a turn that errored with nothing after it finishes as failed", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, fleetDeps());
    emit(state("working", 1));
    await settle();
    emit({ sessionId: SESSION, seq: 2, type: "error", payload: { message: "quota" }, createdAt: new Date().toISOString() });
    await settle();
    emit(state("idle", 3));
    await settle();
    expect(noted.at(-1)!.event).toMatchObject({ type: "turn-finished", total: 0, failed: 0, errored: true });
  });

  test("an idle with no turn behind it (a session ending between turns) finishes nothing", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, fleetDeps());
    emit(state("ended", 1));
    await settle();
    expect(noted.map((n) => n.event.type)).not.toContain("turn-finished");
  });

  test("a permission request becomes the fleet's decision, with its inline options; the turn moving on clears it", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, fleetDeps());
    emit(state("working", 1));
    await settle();
    emit({
      sessionId: SESSION,
      seq: 5,
      type: "permission-request",
      payload: {
        toolCall: { title: "git push origin main" },
        options: [
          { optionId: "allow_once", name: "Allow once" },
          { optionId: "allow_always", name: "Allow always" },
          { optionId: "reject_once", name: "Reject" },
        ],
      },
      createdAt: new Date().toISOString(),
    });
    await settle();
    const asked = noted.find((n) => n.event.type === "decision-asked")!.event.decision;
    expect(asked).toMatchObject({
      key: `perm:${ROOM}`,
      roomId: ROOM,
      eventId: "$evt",
      agent: "Krishna",
      kind: "permission",
      question: "git push origin main",
      options: [
        { id: "Allow once", label: "Allow once", declines: false },
        { id: "Reject", label: "Reject", declines: true },
      ],
    });

    emit(state("working", 6));
    await settle();
    emit(state("idle", 7));
    await settle();
    expect(cleared).toContain(`perm:${ROOM}`);
  });

  test("a question answered before its send returned is not shown as pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = fleetDeps();
    d.client.sendText = async () => {
      await gate;
      return "$late";
    };
    attachRoomToSession(SESSION, ROOM, AGENT, d);
    emit({
      sessionId: SESSION,
      seq: 5,
      type: "permission-request",
      payload: { toolCall: { title: "x" }, options: [{ optionId: "a", name: "Allow once" }] },
      createdAt: new Date().toISOString(),
    });
    await settle();
    clearPendingPermission(ROOM); // answered in the console meanwhile
    release();
    await settle();
    expect(noted.map((n) => n.event.type)).not.toContain("decision-asked");
  });

  test("with no sink installed (no push gateway), nothing is looked up", async () => {
    setFleetSink(null);
    attachRoomToSession(SESSION, ROOM, AGENT, fleetDeps());
    emit(state("working", 1));
    emit(chunk("hi"));
    await settle();
    emit(state("idle", 2));
    await settle();
    expect(nameLookups).toBe(0);
    expect(noted).toEqual([]);
  });
});

describe("a turn's end hands its text to the voice replier", () => {
  let spoken: Array<Record<string, unknown>> = [];
  /** How many text messages were in the room when each speak was asked. */
  let sentAtSpeak: number[] = [];

  function speakingDeps(speak?: (turn: any) => Promise<unknown>) {
    let n = 0;
    const base = deps();
    return {
      ...base,
      client: {
        ...base.client,
        sendText: async (userId: string, roomId: string, body: string, extra?: Record<string, unknown>) => {
          sent.push({ userId, roomId, body, ...(extra ? { extra } : {}) });
          n += 1;
          return `$text${n}`;
        },
      },
      speak:
        speak ??
        (async (turn: any) => {
          sentAtSpeak.push(sent.length);
          spoken.push(turn);
        }),
    };
  }

  beforeEach(() => {
    spoken = [];
    sentAtSpeak = [];
  });

  test("a turn a voice note started: the posted text, its event, and voiceTriggered", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, speakingDeps());
    noteTurnTrigger(SESSION, "$user-voice", { voice: true });
    emit(state("working", 1));
    emit(chunk("The build "));
    emit(chunk("is green."));
    emit(state("idle", 2));
    await settle();
    expect(spoken).toEqual([
      {
        roomId: ROOM,
        agentUser: AGENT,
        sessionId: SESSION,
        text: "The build is green.",
        textEventId: "$text1",
        voiceTriggered: true,
      },
    ]);
    // The text was in the room before speech was asked for.
    expect(sentAtSpeak).toEqual([1]);
  });

  test("a typed message: voiceTriggered is false, and a voice turn does not leak into the next", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, speakingDeps());
    noteTurnTrigger(SESSION, "$v", { voice: true });
    emit(state("working", 1));
    emit(chunk("one"));
    emit(state("idle", 2));
    await settle();
    noteTurnTrigger(SESSION, "$typed");
    emit(state("working", 3));
    emit(chunk("two"));
    emit(state("idle", 4));
    await settle();
    expect(spoken.map((t) => t.voiceTriggered)).toEqual([true, false]);
  });

  test("a turn flushed in parts (a permission pause) is spoken whole, after its last text", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, speakingDeps());
    noteTurnTrigger(SESSION, "$v", { voice: true });
    emit(state("working", 1));
    emit(chunk("Before the question."));
    emit(state("waiting", 2));
    await settle();
    emit(state("working", 3));
    emit(chunk("After the answer."));
    emit(state("idle", 4));
    await settle();
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({
      text: "Before the question.\n\nAfter the answer.",
      textEventId: "$text2",
      voiceTriggered: true,
    });
  });

  test("an error turn is not spoken", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, speakingDeps());
    noteTurnTrigger(SESSION, "$v", { voice: true });
    emit(state("working", 1));
    emit(chunk("Partial answer"));
    emit({ sessionId: SESSION, seq: 2, type: "error", payload: { message: "quota" }, createdAt: new Date().toISOString() });
    emit(state("idle", 3));
    await settle();
    expect(sent.at(-1)!.body).toMatch(/quota/);
    expect(spoken).toEqual([]);
  });

  test("an empty turn is not spoken", async () => {
    attachRoomToSession(SESSION, ROOM, AGENT, speakingDeps());
    noteTurnTrigger(SESSION, "$v", { voice: true });
    emit(state("working", 1));
    emit(state("idle", 2));
    await settle();
    expect(spoken).toEqual([]);
  });

  test("once per turn, and a failing replier costs the room nothing", async () => {
    let calls = 0;
    attachRoomToSession(
      SESSION,
      ROOM,
      AGENT,
      speakingDeps(async () => {
        calls += 1;
        throw new Error("speech down");
      })
    );
    noteTurnTrigger(SESSION, "$v", { voice: true });
    emit(state("working", 1));
    emit(chunk("Answer."));
    emit(state("idle", 2));
    await settle();
    emit(state("working", 3));
    emit(chunk("Next."));
    emit(state("idle", 4));
    await settle();
    expect(calls).toBe(2);
    expect(sent.map((m) => m.body)).toEqual(["Answer.", "Next."]);
  });
});
