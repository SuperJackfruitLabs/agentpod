import { beforeEach, describe, expect, test } from "bun:test";
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

let sent: Array<{ userId: string; roomId: string; body: string }> = [];
let typing: Array<{ roomId: string; on: boolean }> = [];
let listeners: Array<(e: any) => void> = [];
let reactions: Array<{ targetId: string; key: string }> = [];
let redacted: string[] = [];
let unsubscribed = 0;

function deps() {
  return {
    client: {
      sendText: async (userId: string, roomId: string, body: string) => {
        sent.push({ userId, roomId, body });
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
    await settle();

    expect(reactions.at(-1)).toEqual({ targetId: "$user-msg-2", key: "❌" });
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
