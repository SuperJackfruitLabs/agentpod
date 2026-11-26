import { beforeEach, describe, expect, test } from "bun:test";
import { CALL_MEMBER_TYPE, type SuperdialConfig } from "./call-config";
import type { CallJoin, CallReply, SuperdialAgentClient } from "./call-agent-client";
import type { CallRoom } from "./call-members";
import { resetCallTurnsForTest, noteCallTurns } from "./call-turns";
import { createCalls } from "./calls";

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

function harness(opts: { voice?: () => Promise<string>; device?: () => Promise<{ deviceId: string; accessToken: string }> } = {}) {
  const joins: Array<{ roomId: string; body: CallJoin }> = [];
  const leaves: string[] = [];
  const replies: Array<{ roomId: string; turnId: string; body: CallReply }> = [];
  const cancels: Array<{ userId: string; sessionId: string }> = [];
  const agent: SuperdialAgentClient = {
    joinCall: async (roomId, body) => (joins.push({ roomId, body }), true),
    leaveCall: async (roomId) => (leaves.push(roomId), true),
    reply: async (roomId, turnId, body) => (replies.push({ roomId, turnId, body }), true),
  };
  const calls = createCalls({
    config: CONFIG,
    domain: DOMAIN,
    homeserverUrl: "http://hs.test",
    agent,
    callDeviceFor: opts.device ?? (async () => ({ deviceId: "SUPERDIAL", accessToken: "syt_call" })),
    voiceFor: opts.voice ?? (async () => "bf_emma"),
    roomFor: async (roomId) => (roomId === ROOM ? ROOM_ROW : null),
    sessionFor: async (sessionId) => (sessionId === "acps_1" ? { userId: "user_owner", roomId: ROOM } : null),
    cancel: async (userId, sessionId) => void cancels.push({ userId, sessionId }),
  });
  return { calls, joins, leaves, replies, cancels };
}

beforeEach(() => resetCallTurnsForTest());

describe("joining and leaving a call", () => {
  test("a person joining asks superdial-agent to join as the agent's call device", async () => {
    const { calls, joins } = harness();
    await calls.onCallMember(member(JOINED));
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
    expect(joins[0]?.body.voice).toBe("af_heart");
  });

  test("a call device that cannot be minted joins nothing, and does not throw", async () => {
    const { calls, joins } = harness({
      device: async () => {
        throw new Error("could not mint a call device: 403 M_FORBIDDEN");
      },
    });
    await calls.onCallMember(member(JOINED));
    expect(joins).toEqual([]);
  });

  test("the last person leaving asks superdial-agent to leave", async () => {
    const { calls, leaves } = harness();
    await calls.onCallMember(member(JOINED));
    await calls.onCallMember(member({}));
    expect(leaves).toEqual([ROOM]);
  });

  test("a leave after a restart forgot the join still leaves (idempotent at superdial-agent)", async () => {
    const { calls, leaves } = harness();
    await calls.onCallMember(member({}));
    expect(leaves).toEqual([ROOM]);
  });
});

describe("a cancel from superdial-agent", () => {
  test("stops the turn it names, as the session's owner", async () => {
    const { calls, cancels } = harness();
    noteCallTurns("acps_1", [TURN]);
    await calls.cancelTurn(TURN, ROOM);
    expect(cancels).toEqual([{ userId: "user_owner", sessionId: "acps_1" }]);
  });

  test("a turn in another room, or one the hub does not know, stops nothing", async () => {
    const { calls, cancels } = harness();
    noteCallTurns("acps_1", [TURN]);
    await calls.cancelTurn(TURN, "!elsewhere:id.agentpod.dev");
    await calls.cancelTurn("6f1b2c3d-0000-4000-8000-000000000000", ROOM);
    expect(cancels).toEqual([]);
  });
});
