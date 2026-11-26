import { describe, expect, test } from "bun:test";
import { CALL_MEMBER_TYPE, RTC_MEMBER_TYPE, RTC_SLOT_TYPE } from "./call-config";
import { CALL_POWER_EVENTS, createPowerLevelEnsurer, withCallPowerLevels } from "./call-power-levels";

/**
 * A room member must be able to publish their call membership: `org.matrix.msc3401.call.member`
 * (and the newer `org.matrix.msc4143.rtc.member` / `.rtc.slot`) at power level 0. A state event
 * defaults to `state_default` (50) otherwise, which no person in an agent room has.
 */

const ROOM = "!call:id.agentpod.dev";
const AGENT = "@agent_ada:id.agentpod.dev";

const EXISTING = {
  users: { [AGENT]: 100 },
  users_default: 0,
  events: { "m.room.name": 50, "m.room.power_levels": 100, "m.room.encryption": 100 },
  events_default: 0,
  state_default: 50,
  ban: 50,
  kick: 50,
  redact: 50,
  invite: 0,
};

describe("withCallPowerLevels", () => {
  test("the three call types at 0, and nothing else touched", () => {
    expect(CALL_POWER_EVENTS).toEqual([CALL_MEMBER_TYPE, RTC_MEMBER_TYPE, RTC_SLOT_TYPE]);
    const { content, changed } = withCallPowerLevels(EXISTING);
    expect(changed).toBe(true);
    expect(content).toEqual({
      ...EXISTING,
      events: { ...EXISTING.events, [CALL_MEMBER_TYPE]: 0, [RTC_MEMBER_TYPE]: 0, [RTC_SLOT_TYPE]: 0 },
    });
  });

  test("already there: unchanged", () => {
    const done = withCallPowerLevels(EXISTING).content;
    expect(withCallPowerLevels(done).changed).toBe(false);
  });

  test("a room with no events map gets one", () => {
    expect(withCallPowerLevels({ users: { [AGENT]: 100 } }).content.events).toEqual({
      [CALL_MEMBER_TYPE]: 0,
      [RTC_MEMBER_TYPE]: 0,
      [RTC_SLOT_TYPE]: 0,
    });
  });
});

function homeserver(current: Record<string, unknown>, putStatus = 200) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify(current), { status: 200 });
    return new Response(JSON.stringify({ event_id: "$pl" }), { status: putStatus });
  };
  return { calls, ensure: createPowerLevelEnsurer({ homeserverUrl: "http://hs.test", asToken: "as", fetch }) };
}
const STATE = "http://hs.test/_matrix/client/v3/rooms/%21call%3Aid.agentpod.dev/state/m.room.power_levels?user_id=%40agent_ada%3Aid.agentpod.dev";


describe("the power level ensurer", () => {
  test("reads the room's power levels as the agent, and writes them back with the call types", async () => {
    const hs = homeserver(EXISTING);
    expect(await hs.ensure(AGENT, ROOM)).toBe("updated");
    expect(hs.calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", STATE],
      ["PUT", STATE],
    ]);
    expect(hs.calls[1]?.body).toEqual(withCallPowerLevels(EXISTING).content);
  });

  test("a room that has them already is not written", async () => {
    const hs = homeserver(withCallPowerLevels(EXISTING).content);
    expect(await hs.ensure(AGENT, ROOM)).toBe("unchanged");
    expect(hs.calls).toHaveLength(1);
  });

  test("a dry run says what it would do and writes nothing", async () => {
    const hs = homeserver(EXISTING);
    expect(await hs.ensure(AGENT, ROOM, { apply: false })).toBe("would-update");
    expect(hs.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("a refused write throws, naming the status", async () => {
    await expect(homeserver(EXISTING, 403).ensure(AGENT, ROOM)).rejects.toThrow(/403/);
  });
});
