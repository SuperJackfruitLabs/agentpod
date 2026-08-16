import { beforeEach, describe, expect, test } from "bun:test";
import { createMatrixClient } from "./client";

/**
 * Speaking to a homeserver *as* a station.
 *
 * `?user_id=` is the whole mechanism. Without it every agent's message arrives
 * from `@ai-bridge` and a room full of agents becomes one voice pretending to be
 * many — which is worse than no bridge, because it looks like it works.
 */

const AS_TOKEN = "test-as-token-client";
const HS = "http://homeserver.test";
const USER = "@agent_box__pi_x:id.agentpod.dev";
const ROOM = "!room:id.agentpod.dev";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[] = [];
let replies: Array<{ status: number; body: unknown }> = [];

function client() {
  return createMatrixClient({
    homeserverUrl: HS,
    asToken: AS_TOKEN,
    domain: "id.agentpod.dev",
    fetch: (async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ? JSON.parse(init.body as string) : null,
      });
      const reply = replies.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as unknown as typeof fetch,
  });
}

beforeEach(() => {
  calls = [];
  replies = [];
});

describe("acting as a station", () => {
  test("sends with ?user_id=, which is what makes the message the agent's", async () => {
    await client().sendText(USER, ROOM, "hello");

    expect(calls[0]!.url).toContain(`user_id=${encodeURIComponent(USER)}`);
  });

  test("carries the as_token, never anything else", async () => {
    // as_token authenticates the bridge TO the homeserver. The hs_token points
    // the other way, and swapping them fails as a 403 that reads like a
    // permissions bug rather than a configuration one.
    await client().sendText(USER, ROOM, "hello");

    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${AS_TOKEN}`);
  });

  test("gives every send a transaction id, so a retry cannot double-send", async () => {
    await client().sendText(USER, ROOM, "hello");
    await client().sendText(USER, ROOM, "hello");

    const ids = calls.map((c) => c.url.match(/\/send\/m\.room\.message\/([^?]+)/)?.[1]);
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  });

  test("treats M_USER_IN_USE on register as success", async () => {
    // ensureUser runs on every provision and every boot. A second call must be
    // a no-op, not an error that stops an agent existing.
    replies = [{ status: 400, body: { errcode: "M_USER_IN_USE" } }];

    await client().ensureUser("agent_box__pi_x", "x (pi @ box)");
  });

  test("sets the display name even when the user already existed", async () => {
    // A station that was renamed must stop introducing itself by its old name.
    // Setting the name only on creation would mean the rename never lands,
    // because the user is created exactly once and provisioning runs forever.
    replies = [{ status: 400, body: { errcode: "M_USER_IN_USE" } }];

    await client().ensureUser("agent_box__pi_x", "renamed (pi @ box)");

    const profile = calls.find((c) => c.url.includes("/displayname"));
    expect(profile).toBeTruthy();
    expect(profile!.body).toEqual({ displayname: "renamed (pi @ box)" });
  });

  test("treats M_ROOM_IN_USE on create as success", async () => {
    replies = [{ status: 400, body: { errcode: "M_ROOM_IN_USE" } }];

    const roomId = await client().ensureRoom("#agentpod_box__pi_x:id.agentpod.dev", {
      creator: USER,
      name: "x",
      topic: "pi @ box",
    });

    // Nothing was created, and the caller is told so rather than being handed a
    // room id that does not exist.
    expect(roomId).toBeNull();
  });

  test("a real failure is not swallowed", async () => {
    // Only the two "already done" cases are success. A 403 from a namespace we
    // do not own must surface, or provisioning silently produces nothing.
    replies = [{ status: 403, body: { errcode: "M_FORBIDDEN", error: "not in namespace" } }];

    await expect(client().ensureUser("agent_nope", "nope")).rejects.toThrow(/M_FORBIDDEN|namespace/);
  });

  test("typing is sent as the agent, so the room shows the agent thinking", async () => {
    await client().sendTyping(USER, ROOM, true);

    expect(calls[0]!.url).toContain("/typing/");
    expect(calls[0]!.url).toContain(`user_id=${encodeURIComponent(USER)}`);
    expect(calls[0]!.body).toMatchObject({ typing: true });
  });

  test("a typing stop carries no timeout, because it is not a duration", async () => {
    await client().sendTyping(USER, ROOM, false);
    expect(calls[0]!.body).toEqual({ typing: false });
  });

  test("display name is set as the user itself", async () => {
    await client().setDisplayName(USER, "x (pi @ box)");

    expect(calls[0]!.url).toContain("/profile/");
    expect(calls[0]!.url).toContain(`user_id=${encodeURIComponent(USER)}`);
    expect(calls[0]!.body).toEqual({ displayname: "x (pi @ box)" });
  });

  test("an invite is sent by the room's agent, not by the bridge bot", async () => {
    await client().invite(USER, ROOM, "@rakesh:id.agentpod.dev");

    expect(calls[0]!.url).toContain(`user_id=${encodeURIComponent(USER)}`);
    expect(calls[0]!.body).toEqual({ user_id: "@rakesh:id.agentpod.dev" });
  });
});
