import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { AcpEvent } from "@agentpod/contract";
import { CALL_MEMBER_TYPE, type SuperdialConfig } from "./call-config";
import type { CallJoin, CallReply, ReplyResult, SuperdialAgentClient } from "./call-agent-client";
import type { CallRoom } from "./call-members";
import { callTurnSession, resetCallTurnsForTest, noteCallTurns } from "./call-turns";
import { createCalls } from "./calls";
import { attachRoomToSession, detachRoom, forgetTurnTrigger, noteTurnTrigger } from "./outbound";

/**
 * The hub's calls, assembled: a person's membership becomes a join or a leave at superdial-agent,
 * with the agent's call device (never the appservice token); a cancel from superdial-agent stops
 * the turn it names, and only in the room it names.
 */

const DOMAIN = "id.agentpod.dev";
const PERSON = "@rakesh:id.agentpod.dev";
const AGENT = "@agent_ada:id.agentpod.dev";
const ROOM = "!call:id.agentpod.dev";
const TURN = "8d3b0a52-1c51-4c2b-9b55-2f1e0b4a6f10";
const CONFIG: SuperdialConfig = { agentUrl: "http://agent.test", agentToken: "loopback", membershipToken: "m", enabled: true };
const ROOM_ROW: CallRoom = { roomId: ROOM, stationId: "station_ada", stationUserId: "user_owner", identityMode: "bridge", agentUserId: AGENT };

function member(content: Record<string, unknown>) {
  return { type: CALL_MEMBER_TYPE, sender: PERSON, room_id: ROOM, state_key: `_${PERSON}_DESKTOP_m.call`, content };
}
const JOINED = { application: "m.call", call_id: "", scope: "m.room", device_id: "DESKTOP" };

function harness(
  opts: {
    voice?: () => Promise<string>;
    device?: () => Promise<{ deviceId: string; accessToken: string }>;
    join?: () => Promise<boolean>;
    reply?: ReplyResult;
    /** Each known session's room. */
    sessions?: Record<string, string>;
    /** Use the outbound path's own record of the running prompt, not `running`. */
    realLive?: boolean;
  } = {},
) {
  const joins: Array<{ roomId: string; body: CallJoin }> = [];
  const leaves: string[] = [];
  const replies: Array<{ roomId: string; turnId: string; body: CallReply }> = [];
  const cancels: Array<{ userId: string; sessionId: string }> = [];
  /** Per session, the spoken turns its running prompt answers (as the outbound path records it). */
  const running = new Map<string, string[]>();
  const agent: SuperdialAgentClient = {
    joinCall: async (roomId, body) => {
      joins.push({ roomId, body });
      return opts.join ? opts.join() : true;
    },
    leaveCall: async (roomId) => (leaves.push(roomId), true),
    reply: async (roomId, turnId, body) => (replies.push({ roomId, turnId, body }), opts.reply ?? "taken"),
  };
  const calls = createCalls({
    config: CONFIG,
    domain: DOMAIN,
    homeserverUrl: "http://hs.test",
    agent,
    callDeviceFor: opts.device ?? (async () => ({ deviceId: "SUPERDIAL", accessToken: "syt_call" })),
    voiceFor: opts.voice ?? (async () => "bf_emma"),
    roomFor: async (roomId) => (roomId === ROOM ? ROOM_ROW : null),
    sessionFor: async (sessionId) => {
      const roomId = (opts.sessions ?? { acps_1: ROOM })[sessionId];
      return roomId ? { userId: "user_owner", roomId } : null;
    },
    cancel: async (userId, sessionId) => void cancels.push({ userId, sessionId }),
    membershipOf: async () => "join",
    ...(opts.realLive ? {} : { liveCallTurns: (sessionId: string) => running.get(sessionId) ?? [] }),
  });
  return { calls, joins, leaves, replies, cancels, running };
}

beforeEach(() => resetCallTurnsForTest());

/** Let the room's event chain run. */
const settle = () => new Promise((r) => setTimeout(r, 5));

describe("joining and leaving a call", () => {
  test("a person joining asks superdial-agent to join as the agent's call device", async () => {
    const { calls, joins } = harness();
    await calls.onCallMember(member(JOINED));
    await calls.settled();
    expect(joins).toEqual([
      {
        roomId: ROOM,
        body: {
          agent_user_id: AGENT,
          homeserver_url: "http://hs.test",
          device: { device_id: "SUPERDIAL", access_token: "syt_call" },
          voice: "bf_emma",
          stt_language: null,
        },
      },
    ]);
  });

  test("a voice that cannot be read is af_heart, and the call still joins", async () => {
    const { calls, joins } = harness({
      voice: async () => {
        throw new Error("settings unreadable");
      },
    });
    await calls.onCallMember(member(JOINED));
    await calls.settled();
    expect(joins[0]?.body.voice).toBe("af_heart");
  });

  test("a call device that cannot be minted joins nothing, and does not throw", async () => {
    const { calls, joins } = harness({
      device: async () => {
        throw new Error("could not mint a call device: 403 M_FORBIDDEN");
      },
    });
    await calls.onCallMember(member(JOINED));
    await calls.settled();
    expect(joins).toEqual([]);
  });

  test("the last person leaving asks superdial-agent to leave", async () => {
    const { calls, leaves } = harness();
    await calls.onCallMember(member(JOINED));
    await calls.onCallMember(member({}));
    await calls.settled();
    expect(leaves).toEqual([ROOM]);
  });

  test("a leave after a restart forgot the join still leaves (idempotent at superdial-agent)", async () => {
    const { calls, leaves } = harness();
    await calls.onCallMember(member({}));
    await calls.settled();
    expect(leaves).toEqual([ROOM]);
  });

  /**
   * The appservice transaction that carries a person's call membership waits for its handler.
   * Awaited there, a superdial-agent (or a homeserver login) that never answered held every later
   * transaction: every message to every agent on this hub.
   */
  test("a superdial-agent that never answers does not hold the transaction", async () => {
    const { calls, joins } = harness({ join: () => new Promise<boolean>(() => {}) });
    const outcome = await Promise.race([
      calls.onCallMember(member(JOINED)).then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("held"), 200)),
    ]);
    expect(outcome).toBe("returned");
    await new Promise((r) => setTimeout(r, 5));
    expect(joins).toHaveLength(1);
  });

  test("a call device that never mints does not hold the transaction", async () => {
    const { calls } = harness({ device: () => new Promise(() => {}) });
    const outcome = await Promise.race([
      calls.onCallMember(member(JOINED)).then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("held"), 200)),
    ]);
    expect(outcome).toBe("returned");
  });

  test("a room's join and leave still reach superdial-agent in order", async () => {
    // Not waited for, they are queued per room: a leave must not overtake the join it ends.
    let release: ((joined: boolean) => void) | undefined;
    const { calls, joins, leaves } = harness({ join: () => new Promise<boolean>((resolve) => (release = resolve)) });
    await calls.onCallMember(member(JOINED));
    await calls.onCallMember(member({}));
    await new Promise((r) => setTimeout(r, 5));
    expect(joins).toHaveLength(1);
    expect(leaves).toEqual([]);
    release?.(true);
    await calls.settled();
    expect(leaves).toEqual([ROOM]);
  });
});

describe("a cancel from superdial-agent", () => {
  test("stops the turn it names, as the session's owner", async () => {
    const { calls, cancels, running } = harness();
    noteCallTurns(ROOM, "acps_1", [TURN]);
    running.set("acps_1", [TURN]);
    await calls.cancelTurn(TURN, ROOM);
    expect(cancels).toEqual([{ userId: "user_owner", sessionId: "acps_1" }]);
  });

  test("a turn in another room, or one the hub does not know, stops nothing", async () => {
    const { calls, cancels, running } = harness();
    noteCallTurns(ROOM, "acps_1", [TURN]);
    running.set("acps_1", [TURN]);
    await calls.cancelTurn(TURN, "!elsewhere:id.agentpod.dev");
    await calls.cancelTurn("6f1b2c3d-0000-4000-8000-000000000000", ROOM);
    expect(cancels).toEqual([]);
  });

  test("a turn id reused in another room neither takes over nor cancels the first room's turn", async () => {
    // Another room's member copies a live turn id into a marker there. Keyed by turn id alone,
    // the copy re-pointed the id at the second room's session: the real caller's hang-up then
    // named a room its turn was "not in", and stopped nothing.
    const OTHER = "!other:id.agentpod.dev";
    const { calls, cancels, running } = harness({
      sessions: { acps_1: ROOM, acps_2: OTHER },
    });
    noteCallTurns(ROOM, "acps_1", [TURN]);
    noteCallTurns(OTHER, "acps_2", [TURN]);
    running.set("acps_1", [TURN]);
    running.set("acps_2", [TURN]);
    await calls.cancelTurn(TURN, ROOM);
    expect(cancels).toEqual([{ userId: "user_owner", sessionId: "acps_1" }]);
    expect(calls.cancelledByCaller(ROOM, [TURN])).toBe(true);
    expect(calls.cancelledByCaller(OTHER, [TURN])).toBe(false);
  });
});

describe("a spoken turn's reply", () => {
  test("goes to the call once, final, with the whole text", async () => {
    const { calls, replies } = harness();
    noteCallTurns(ROOM, "acps_1", [TURN]);
    await calls.replyToCall({ roomId: ROOM, turnIds: [TURN], text: "It is ten past four.", errored: false });
    expect(replies).toEqual([
      { roomId: ROOM, turnId: TURN, body: { seq: 0, text: "It is ten past four.", final: true, outcome: "ok" } },
    ]);
  });

  test("a turn the caller cancelled at hang-up gets no reply; an error turn is answered error", async () => {
    // The cancel came from superdial-agent as it left the call: there is no call to answer, and
    // E1 (2026-11-27) saw the reply answered 404.
    const { calls, replies, running } = harness();
    noteCallTurns(ROOM, "acps_1", ["t-cancelled", "t-error"]);
    running.set("acps_1", ["t-cancelled"]);
    await calls.cancelTurn("t-cancelled", ROOM);
    await calls.replyToCall({ roomId: ROOM, turnIds: ["t-cancelled"], text: "Partial", errored: false });
    await calls.replyToCall({ roomId: ROOM, turnIds: ["t-error"], text: "", errored: true });
    expect(replies.map((r) => [r.turnId, r.body.outcome])).toEqual([["t-error", "error"]]);
  });

  test("whether the caller cancelled a turn is known until its end is handled, then forgotten", async () => {
    const { calls, running } = harness();
    noteCallTurns(ROOM, "acps_1", ["t-1", "t-2"]);
    running.set("acps_1", ["t-1", "t-2"]);
    expect(calls.cancelledByCaller(ROOM, ["t-1", "t-2"])).toBe(false);
    await calls.cancelTurn("t-2", ROOM);
    expect(calls.cancelledByCaller(ROOM, ["t-1", "t-2"])).toBe(true);
    await calls.replyToCall({ roomId: ROOM, turnIds: ["t-1", "t-2"], text: "", errored: false });
    expect(calls.cancelledByCaller(ROOM, ["t-1", "t-2"])).toBe(false);
  });

  test("a reply superdial-agent answers 404 (the call is gone) is not warned about", async () => {
    const warns: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warns.push(args);
    try {
      const { calls } = harness({ reply: "gone" });
      noteCallTurns(ROOM, "acps_1", [TURN]);
      await calls.replyToCall({ roomId: ROOM, turnIds: [TURN], text: "Late.", errored: false });
    } finally {
      console.warn = original;
    }
    expect(warns).toEqual([]);
  });

  test("merged spoken turns: the last is answered, the earlier ones are closed as cancelled with no text", async () => {
    // One answer, spoken once. Each earlier turn still hears back, or superdial-agent waits for ever.
    const { calls, replies } = harness();
    noteCallTurns(ROOM, "acps_1", ["t-1", "t-2"]);
    await calls.replyToCall({ roomId: ROOM, turnIds: ["t-1", "t-2"], text: "Both, briefly.", errored: false });
    expect(replies).toEqual([
      { roomId: ROOM, turnId: "t-1", body: { seq: 0, text: "", final: true, outcome: "cancelled" } },
      { roomId: ROOM, turnId: "t-2", body: { seq: 0, text: "Both, briefly.", final: true, outcome: "ok" } },
    ]);
  });

  test("a turn that never reached the agent is answered error, with no text", async () => {
    const { calls, replies } = harness();
    await calls.replyUnanswered(ROOM, [TURN]);
    expect(replies).toEqual([{ roomId: ROOM, turnId: TURN, body: { seq: 0, text: "", final: true, outcome: "error" } }]);
  });

  test("once answered, a turn can no longer be cancelled", async () => {
    const { calls, cancels, running } = harness();
    noteCallTurns(ROOM, "acps_1", [TURN]);
    running.set("acps_1", [TURN]);
    await calls.replyToCall({ roomId: ROOM, turnIds: [TURN], text: "Done.", errored: false });
    await calls.cancelTurn(TURN, ROOM);
    expect(cancels).toEqual([]);
  });
});

/**
 * A cancel stops the session's prompt, whatever it is now: so it may stop one only while that prompt
 * is still the spoken turn it names. The turn's entry outlives its prompt: its reply to the call is
 * still being sent when the room's next message is prompted, and a prompt that lost the busy race
 * was noted before it was refused.
 */
describe("a cancel for a spoken turn that is no longer running", () => {
  const SESSION = "acps_1";
  const TURN_A = "1a2b3c4d-0000-4000-8000-00000000000a";
  const TURN_B = "1a2b3c4d-0000-4000-8000-00000000000b";

  let listeners: Array<(e: AcpEvent) => void> = [];
  const emit = (e: AcpEvent) => {
    for (const l of listeners) l(e);
  };
  const state = (status: string, seq: number): AcpEvent => ({
    sessionId: SESSION,
    seq,
    type: "state",
    payload: { status },
    createdAt: new Date().toISOString(),
  });
  /** The room's real outbound attachment, its call reply still in flight when asked to hold it. */
  function attach(opts: { replyHangs?: boolean } = {}) {
    attachRoomToSession(SESSION, ROOM, AGENT, {
      client: { sendText: async () => "$evt", sendTyping: async () => {} },
      subscribe: (_sessionId, fn) => {
        listeners.push(fn);
        return () => (listeners = listeners.filter((l) => l !== fn));
      },
      flushDelayMs: 0,
      callReply: () => (opts.replyHangs ? new Promise<void>(() => {}) : Promise.resolve()),
    });
  }

  beforeEach(() => {
    listeners = [];
    detachRoom(SESSION);
  });
  afterAll(() => detachRoom(SESSION));

  test("turn A finished and is still being answered, typed B is running: A's cancel leaves B alone", async () => {
    const { calls, cancels } = harness({ realLive: true });
    attach({ replyHangs: true });
    noteTurnTrigger(SESSION, "$a", { callTurns: [TURN_A] });
    noteCallTurns(ROOM, SESSION, [TURN_A]);
    emit(state("working", 1));
    emit(state("idle", 2));
    await settle();
    // The room's next message, typed, is prompted while A's reply to the call is in flight.
    noteTurnTrigger(SESSION, "$b");
    emit(state("working", 3));
    await settle();

    await calls.cancelTurn(TURN_A, ROOM);
    expect(cancels).toEqual([]);
    // B is not ended as a hang-up either.
    expect(calls.cancelledByCaller(ROOM, [TURN_A])).toBe(false);
  });

  test("a spoken turn that is the running prompt is still stopped", async () => {
    const { calls, cancels } = harness({ realLive: true });
    attach();
    noteTurnTrigger(SESSION, "$b", { callTurns: [TURN_B] });
    noteCallTurns(ROOM, SESSION, [TURN_B]);
    emit(state("working", 1));
    await settle();
    await calls.cancelTurn(TURN_B, ROOM);
    expect(cancels).toEqual([{ userId: "user_owner", sessionId: SESSION }]);
  });

  test("a spoken turn prompted but not yet working is stopped too", async () => {
    // Between the prompt going out and the session saying `working`, the noted trigger is the
    // prompt.
    const { calls, cancels } = harness({ realLive: true });
    attach();
    noteTurnTrigger(SESSION, "$b", { callTurns: [TURN_B] });
    noteCallTurns(ROOM, SESSION, [TURN_B]);
    await calls.cancelTurn(TURN_B, ROOM);
    expect(cancels).toEqual([{ userId: "user_owner", sessionId: SESSION }]);
  });

  test("a spoken turn that lost the busy race does not stop the typed turn that won it", async () => {
    const { calls, cancels } = harness({ realLive: true });
    attach();
    noteTurnTrigger(SESSION, "$typed");
    emit(state("working", 1));
    await settle();
    // Noted, then refused SESSION_BUSY: the inbound path takes the trigger back.
    noteTurnTrigger(SESSION, "$spoken", { callTurns: [TURN_A] });
    noteCallTurns(ROOM, SESSION, [TURN_A]);
    forgetTurnTrigger(SESSION, "$spoken");
    await calls.cancelTurn(TURN_A, ROOM);
    expect(cancels).toEqual([]);
  });

  test("a turn's entry is gone before its reply to the call is sent", async () => {
    // Forgotten only after the replies went out, a slow superdial-agent left the entry standing
    // while the next prompt ran.
    const { calls, replies } = harness();
    noteCallTurns(ROOM, SESSION, [TURN_A]);
    const replying = calls.replyToCall({ roomId: ROOM, turnIds: [TURN_A], text: "Done.", errored: false });
    // The reply is still on its way to superdial-agent here.
    expect(callTurnSession(ROOM, TURN_A)).toBeUndefined();
    await replying;
    expect(replies.map((r) => r.turnId)).toEqual([TURN_A]);
  });
});
