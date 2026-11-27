import { describe, expect, test } from "bun:test";
import type { CallRoom } from "./call-members";
import { checkCallMembership, createMembershipReader } from "./call-membership";

/**
 * C4: SuperExchange's token service asks "is this person joined to this room, and is it a bridge
 * agent's room?" before it mints a LiveKit token. The hub knows both; SuperExchange cannot see
 * agent rooms. Each refusal says which question failed, in the contract's words.
 */

const PERSON = "@rakesh:id.agentpod.dev";
const AGENT = "@agent_ada:id.agentpod.dev";
const ROOM = "!call:id.agentpod.dev";
const BRIDGE: CallRoom = { roomId: ROOM, stationId: "station_ada", stationUserId: "u", identityMode: "bridge", agentUserId: AGENT };

function check(opts: { enabled?: boolean; room?: CallRoom | null; membership?: string | null | Error } = {}) {
  const asked: Array<{ asUser: string; roomId: string; userId: string }> = [];
  const answer = checkCallMembership(
    { userId: PERSON, roomId: ROOM },
    {
      enabled: opts.enabled ?? true,
      roomFor: async () => (opts.room === undefined ? BRIDGE : opts.room),
      membershipOf: async (asUser, roomId, userId) => {
        asked.push({ asUser, roomId, userId });
        if (opts.membership instanceof Error) throw opts.membership;
        return opts.membership === undefined ? "join" : opts.membership;
      },
    },
  );
  return { answer, asked };
}

describe("the membership check", () => {
  test("a joined person in a bridge agent's room is allowed, with the agent and its station", async () => {
    const { answer, asked } = check();
    expect(await answer).toEqual({ allowed: true, agent_user_id: AGENT, station_id: "station_ada" });
    // Asked as the agent, a member of its own room: the appservice user may not be.
    expect(asked).toEqual([{ asUser: AGENT, roomId: ROOM, userId: PERSON }]);
  });

  test("calls off: calls_disabled, and nothing is looked up", async () => {
    const { answer, asked } = check({ enabled: false });
    expect(await answer).toEqual({ allowed: false, reason: "calls_disabled" });
    expect(asked).toEqual([]);
  });

  test("a room with no station, or no agent in it: not_agent_room", async () => {
    expect(await check({ room: null }).answer).toEqual({ allowed: false, reason: "not_agent_room" });
    expect(await check({ room: { ...BRIDGE, agentUserId: null } }).answer).toEqual({ allowed: false, reason: "not_agent_room" });
  });

  test("a harness-mode agent's room: harness_mode", async () => {
    expect(await check({ room: { ...BRIDGE, identityMode: "harness" } }).answer).toEqual({ allowed: false, reason: "harness_mode" });
  });

  test("invited, left, banned or never there: not_member", async () => {
    for (const membership of ["invite", "leave", "ban", "knock", null]) {
      expect(await check({ membership }).answer).toEqual({ allowed: false, reason: "not_member" });
    }
  });

  test("a homeserver that cannot answer is an error, never an answer", async () => {
    await expect(check({ membership: new Error("502") }).answer).rejects.toThrow("502");
  });
});

function homeserver(status: number, body: Record<string, unknown>) {
  const urls: string[] = [];
  const auths: Array<string | null> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    urls.push(url);
    auths.push(new Headers(init?.headers).get("Authorization"));
    return new Response(JSON.stringify(body), { status });
  };
  return { urls, auths, read: createMembershipReader({ homeserverUrl: "http://hs.test", asToken: "as", fetch }) };
}


describe("reading a membership from the homeserver", () => {
  test("the member state event, read as the agent", async () => {
    const hs = homeserver(200, { membership: "join", displayname: "Rakesh" });
    expect(await hs.read(AGENT, ROOM, PERSON)).toBe("join");
    expect(hs.urls).toEqual([
      "http://hs.test/_matrix/client/v3/rooms/%21call%3Aid.agentpod.dev/state/m.room.member/%40rakesh%3Aid.agentpod.dev?user_id=%40agent_ada%3Aid.agentpod.dev",
    ]);
    expect(hs.auths).toEqual(["Bearer as"]);
  });

  test("no member event is null; any other failure throws", async () => {
    expect(await homeserver(404, { errcode: "M_NOT_FOUND" }).read(AGENT, ROOM, PERSON)).toBeNull();
    await expect(homeserver(403, { errcode: "M_FORBIDDEN" }).read(AGENT, ROOM, PERSON)).rejects.toThrow(/403/);
    await expect(homeserver(502, {}).read(AGENT, ROOM, PERSON)).rejects.toThrow(/502/);
  });
});
