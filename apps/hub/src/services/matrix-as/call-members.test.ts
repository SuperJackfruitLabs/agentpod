import { describe, expect, test } from "bun:test";
import { CALL_MEMBER_TYPE } from "./call-config";
import { createCallWatcher, parseCallMember, type CallRoom } from "./call-members";

/**
 * A person's call membership, noticed.
 *
 * The hub's appservice is sent every event in its agents' rooms, state included. A person
 * publishing `org.matrix.msc3401.call.member` in a bridge agent's room starts a call with that
 * agent; the same state emptied ends it. Everything else — harness rooms, rooms the hub does not
 * own, agents' own memberships, state keys naming somebody else — is not a call.
 */

const DOMAIN = "id.agentpod.dev";
const PERSON = "@rakesh:id.agentpod.dev";
const AGENT = "@agent_ada:id.agentpod.dev";
const ROOM = "!call:id.agentpod.dev";

const BRIDGE_ROOM: CallRoom = {
  roomId: ROOM,
  stationId: "station_call",
  stationUserId: "user_owner",
  identityMode: "bridge",
  agentUserId: AGENT,
};

function member(opts: { sender?: string; device?: string; content?: Record<string, unknown>; stateKey?: string; room?: string } = {}) {
  const sender = opts.sender ?? PERSON;
  const device = opts.device ?? "DESKTOP";
  return {
    type: CALL_MEMBER_TYPE,
    sender,
    room_id: opts.room ?? ROOM,
    event_id: `$${Math.random().toString(36).slice(2)}`,
    state_key: opts.stateKey ?? `_${sender}_${device}_m.call`,
    content:
      opts.content ??
      ({
        application: "m.call",
        call_id: "",
        scope: "m.room",
        device_id: device,
        focus_active: { type: "livekit", focus_selection: "oldest_membership" },
        foci_preferred: [{ type: "livekit", livekit_service_url: "https://lk.example" }],
      } as Record<string, unknown>),
  };
}

function watcher(room: CallRoom | null = BRIDGE_ROOM) {
  const joins: CallRoom[] = [];
  const leaves: string[] = [];
  const w = createCallWatcher({
    domain: DOMAIN,
    roomFor: async () => room,
    onJoin: async (r) => void joins.push(r),
    onLeave: async (roomId) => void leaves.push(roomId),
  });
  return { w, joins, leaves };
}

describe("parseCallMember", () => {
  test("a published membership is a join, an emptied one a leave", () => {
    expect(parseCallMember(member(), DOMAIN)).toEqual({
      roomId: ROOM,
      sender: PERSON,
      stateKey: `_${PERSON}_DESKTOP_m.call`,
      joined: true,
    });
    expect(parseCallMember(member({ content: {} }), DOMAIN)?.joined).toBe(false);
  });

  test("not a call: another type, no state key, no room", () => {
    expect(parseCallMember({ ...member(), type: "m.room.message" }, DOMAIN)).toBeNull();
    expect(parseCallMember({ ...member(), state_key: undefined }, DOMAIN)).toBeNull();
    expect(parseCallMember({ ...member(), room_id: undefined }, DOMAIN)).toBeNull();
  });

  test("a state key naming somebody other than its sender is not a call", () => {
    expect(parseCallMember(member({ stateKey: `_@someone-else:id.agentpod.dev_DEV_m.call` }), DOMAIN)).toBeNull();
    // A prefix of the sender's id is not the sender.
    expect(parseCallMember(member({ stateKey: `_@rakesh:id.agentpod.devx_DEV_m.call` }), DOMAIN)).toBeNull();
    expect(parseCallMember(member({ stateKey: PERSON }), DOMAIN)).toBeNull();
  });

  test("an agent's own membership is never a call it is being asked to join", () => {
    expect(parseCallMember(member({ sender: AGENT, device: "SUPERDIAL" }), DOMAIN)).toBeNull();
  });
});

describe("the call watcher", () => {
  test("a person joining a bridge agent's room starts a call", async () => {
    const { w, joins, leaves } = watcher();
    await w.handle(member());
    expect(joins).toEqual([BRIDGE_ROOM]);
    expect(leaves).toEqual([]);
  });

  test("the call ends when the last person's membership is emptied, not before", async () => {
    const { w, leaves } = watcher();
    await w.handle(member({ device: "DESKTOP" }));
    await w.handle(member({ device: "LAPTOP" }));
    await w.handle(member({ device: "DESKTOP", content: {} }));
    expect(leaves).toEqual([]);
    await w.handle(member({ device: "LAPTOP", content: {} }));
    expect(leaves).toEqual([ROOM]);
  });

  test("a leave the hub has no record of still ends the call (a restart forgot the join)", async () => {
    const { w, leaves } = watcher();
    await w.handle(member({ content: {} }));
    expect(leaves).toEqual([ROOM]);
  });

  test("a harness-mode room is ignored", async () => {
    const { w, joins, leaves } = watcher({ ...BRIDGE_ROOM, identityMode: "harness" });
    await w.handle(member());
    await w.handle(member({ content: {} }));
    expect(joins).toEqual([]);
    expect(leaves).toEqual([]);
  });

  test("a room the hub does not own, or one with no agent, is ignored", async () => {
    for (const room of [null, { ...BRIDGE_ROOM, agentUserId: null }]) {
      const { w, joins, leaves } = watcher(room);
      await w.handle(member());
      await w.handle(member({ content: {} }));
      expect(joins).toEqual([]);
      expect(leaves).toEqual([]);
    }
  });

  test("a membership naming another user, or an agent's own, does nothing", async () => {
    const { w, joins } = watcher();
    await w.handle(member({ stateKey: `_@someone-else:id.agentpod.dev_DEV_m.call` }));
    await w.handle(member({ sender: AGENT, device: "SUPERDIAL" }));
    expect(joins).toEqual([]);
  });
});
