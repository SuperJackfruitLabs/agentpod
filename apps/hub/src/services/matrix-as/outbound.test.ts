import { beforeEach, describe, expect, test } from "bun:test";
import { attachRoomToSession, detachRoom, _attachedCountForTest } from "./outbound";

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
