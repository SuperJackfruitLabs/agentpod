/**
 * `withQuietNotes`: every reaction and turn record the hub sends is noted
 * `quiet` for the push gateway, and announced for its room while in flight.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { MatrixClient } from "./client";
import { TURN_ACTIVITY_TYPE } from "./activity";
import { withQuietNotes } from "./push-quiet";
import { _resetHubEventsForTest, hubEventKind, quietSendsInFlight, quietSendsSettled } from "../push/hub-events";

const ROOM = "!room:id.agentpod.dev";
const AGENT = "@agent_a:id.agentpod.dev";

/** A client whose sends return `$<n>` and record what was in flight while they ran. */
function fakeClient(opts: { fail?: boolean } = {}) {
  let n = 0;
  const inFlightDuring: number[] = [];
  const sent: string[] = [];
  const send = async (what: string) => {
    inFlightDuring.push(quietSendsInFlight(ROOM));
    sent.push(what);
    if (opts.fail) throw new Error("homeserver said no");
    return `$${++n}`;
  };
  const client = {
    sendText: async () => send("text"),
    sendCustomEvent: async (_u: string, _r: string, type: string) => send(type),
    sendReaction: async (_u: string, _r: string, _t: string, key: string) => send(`reaction ${key}`),
    redact: async () => {},
  } as unknown as MatrixClient;
  return { client, inFlightDuring, sent };
}

beforeEach(() => _resetHubEventsForTest());

describe("withQuietNotes", () => {
  test("a reaction is quiet, and is announced for its room while it is sent", async () => {
    const f = fakeClient();
    const id = await withQuietNotes(f.client).sendReaction(AGENT, ROOM, "$trigger", "👀");
    expect(id).toBe("$1");
    expect(hubEventKind("$1")).toBe("quiet");
    expect(f.inFlightDuring).toEqual([1]);
    expect(quietSendsInFlight(ROOM)).toBe(0);
  });

  test("a turn record is quiet", async () => {
    const f = fakeClient();
    await withQuietNotes(f.client).sendCustomEvent(AGENT, ROOM, TURN_ACTIVITY_TYPE, { tools: [] });
    expect(f.sent).toEqual([TURN_ACTIVITY_TYPE]);
    expect(hubEventKind("$1")).toBe("quiet");
    expect(f.inFlightDuring).toEqual([1]);
  });

  test("a message, and any other custom event, is not — and is not announced", async () => {
    const f = fakeClient();
    const c = withQuietNotes(f.client);
    await c.sendText(AGENT, ROOM, "the answer");
    await c.sendCustomEvent(AGENT, ROOM, "dev.agentpod.permission.v1", {});
    await c.sendCustomEvent(AGENT, ROOM, "m.room.message", { msgtype: "m.text", body: "hi" });
    expect([hubEventKind("$1"), hubEventKind("$2"), hubEventKind("$3")]).toEqual([undefined, undefined, undefined]);
    expect(f.inFlightDuring).toEqual([0, 0, 0]);
  });

  test("a failed quiet send ends its announcement and notes nothing", async () => {
    const f = fakeClient({ fail: true });
    await expect(withQuietNotes(f.client).sendReaction(AGENT, ROOM, "$t", "✅")).rejects.toThrow("homeserver said no");
    expect(quietSendsInFlight(ROOM)).toBe(0);
  });

  test("the id is noted before the announcement ends, so a waiting push sees it", async () => {
    const f = fakeClient();
    const c = withQuietNotes(f.client);
    // What a waiting push would observe at the moment the room stops being in flight.
    const pending = c.sendReaction(AGENT, ROOM, "$t", "✅");
    await quietSendsSettled(ROOM, "$1", 1_000);
    expect(hubEventKind("$1")).toBe("quiet");
    await pending;
  });
});
