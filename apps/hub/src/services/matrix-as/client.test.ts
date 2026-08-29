import { beforeEach, describe, expect, test } from "bun:test";
import { createMatrixClient, isMatrixUserInUse } from "./client";

/**
 * Speaking to a homeserver *as* a station.
 *
 * `?user_id=` is the whole mechanism. Without it every agent's message arrives
 * from `@ai-bridge` and a room full of agents becomes one voice pretending to be
 * many — which is worse than no bridge, because it looks like it works.
 */

const AS_TOKEN = "test-as-token-client";
const HS = "http://homeserver.test";
const USER = "@agent_box_pi-x:id.agentpod.dev";
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

    await client().ensureUser("agent_box_pi-x", "x (pi @ box)");
  });

  test("sets the display name even when the user already existed", async () => {
    // A station that was renamed must stop introducing itself by its old name.
    // Setting the name only on creation would mean the rename never lands,
    // because the user is created exactly once and provisioning runs forever.
    replies = [{ status: 400, body: { errcode: "M_USER_IN_USE" } }];

    await client().ensureUser("agent_box_pi-x", "renamed (pi @ box)");

    const profile = calls.find((c) => c.url.includes("/displayname"));
    expect(profile).toBeTruthy();
    expect(profile!.body).toEqual({ displayname: "renamed (pi @ box)" });
  });

  test("treats M_ROOM_IN_USE on create as success", async () => {
    replies = [{ status: 400, body: { errcode: "M_ROOM_IN_USE" } }];

    const roomId = await client().ensureRoom("#agentpod_box_pi-x:id.agentpod.dev", {
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

describe("an alias that is already taken", () => {
  const ALIAS = "#agentpod_box_pi-x:id.agentpod.dev";
  const OLD = "!old:id.agentpod.dev";
  const NEW = "!new:id.agentpod.dev";

  const inUse = { status: 409, body: { errcode: "M_ROOM_IN_USE" } };

  test("hands back the existing room when the agent is still in it", async () => {
    // The ordinary restart. Returning null here — what shipped — made
    // provisioning create nothing and call it success.
    replies = [
      inUse,
      { status: 200, body: { room_id: OLD } }, // directory lookup
      { status: 200, body: { joined_rooms: [OLD] } }, // still a member
    ];

    const roomId = await client().ensureRoom(ALIAS, {
      creator: USER,
      name: "pi-x",
      topic: "t",
    });

    expect(roomId).toBe(OLD);
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "GET"]);
  });

  test("reclaims the alias when the agent has left that room, and creates a fresh one", async () => {
    // After a clean slate: the room is emptied and forgotten, but the alias
    // still points at it, so `createRoom` fails forever and nothing else will
    // ever release it. This is the case that made a rebuild produce 0 rooms
    // while reporting 32 provisioned.
    replies = [
      inUse,
      { status: 200, body: { room_id: OLD } },
      { status: 200, body: { joined_rooms: [] } }, // no longer in it
      { status: 200, body: {} }, // alias deleted
      { status: 200, body: { room_id: NEW } }, // created at last
    ];

    const roomId = await client().ensureRoom(ALIAS, {
      creator: USER,
      name: "pi-x",
      topic: "t",
    });

    expect(roomId).toBe(NEW);
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toContain("/directory/room/");
    // As the agent that owns the alias — the bridge's own token is refused
    // with a 403, which is what the live homeserver answered.
    expect(del.url).toContain(`user_id=${encodeURIComponent(USER)}`);
  });

  test("gives up rather than pretending when the alias cannot be released", async () => {
    replies = [
      inUse,
      { status: 200, body: { room_id: OLD } },
      { status: 200, body: { joined_rooms: [] } },
      { status: 403, body: { errcode: "M_FORBIDDEN" } }, // delete refused
    ];

    const roomId = await client().ensureRoom(ALIAS, {
      creator: USER,
      name: "pi-x",
      topic: "t",
    });

    expect(roomId).toBeNull();
  });
});

describe("rotateCredentials", () => {
  test("invalidates every existing token before issuing a new one", async () => {
    replies = [
      { status: 200, body: {} },
      {
        status: 200,
        body: {
          user_id: "@agent_box_pi-x:id.agentpod.dev",
          access_token: "syt_new",
          device_id: "DEV2",
        },
      },
    ];

    const out = await client().rotateCredentials("agent_box_pi-x");

    expect(calls).toHaveLength(2);
    // logout/all first, or rotation accumulates devices forever.
    expect(calls[0]!.url).toContain("/_matrix/client/v3/logout/all");
    expect(calls[1]!.url).toContain("/_matrix/client/v3/login");
    expect(out).toEqual({
      userId: "@agent_box_pi-x:id.agentpod.dev",
      accessToken: "syt_new",
      deviceId: "DEV2",
    });
  });

  test("impersonates for logout/all and does not for login", async () => {
    replies = [
      { status: 200, body: {} },
      { status: 200, body: { access_token: "syt_new", device_id: "DEV2" } },
    ];

    await client().rotateCredentials("agent_box_pi-x");

    // The appservice acts AS the user to clear its sessions...
    expect(calls[0]!.url).toContain("user_id=%40agent_box_pi-x%3Aid.agentpod.dev");
    // ...but the login body names the user, and impersonating there is rejected.
    expect(calls[1]!.url).not.toContain("user_id=");
    expect(calls[1]!.body).toEqual({
      type: "m.login.application_service",
      identifier: { type: "m.id.user", user: "agent_box_pi-x" },
    });
  });

  test("does not issue credentials when the old ones could not be cleared", async () => {
    replies = [{ status: 403, body: { errcode: "M_FORBIDDEN" } }];

    await expect(client().rotateCredentials("agent_box_pi-x")).rejects.toThrow(
      /logout\/all/
    );
    // Crucially it stopped: a login here would have added a device to an
    // identity whose existing tokens are still live.
    expect(calls).toHaveLength(1);
  });

  test("refuses a login that comes back without a token", async () => {
    replies = [
      { status: 200, body: {} },
      { status: 200, body: { user_id: "@agent_box_pi-x:id.agentpod.dev" } },
    ];

    await expect(client().rotateCredentials("agent_box_pi-x")).rejects.toThrow(
      /no access_token/
    );
  });
});

describe("registerWithCredentials", () => {
  test("throws a typed error when the identity already exists", async () => {
    replies = [{ status: 400, body: { errcode: "M_USER_IN_USE" } }];

    const err = await client()
      .registerWithCredentials("agent_box_pi-x")
      .catch((e: unknown) => e);

    // Typed, so the caller can branch on it without matching a message.
    expect(isMatrixUserInUse(err)).toBe(true);
  });

  test("any other failure stays an ordinary error", async () => {
    replies = [{ status: 403, body: { errcode: "M_FORBIDDEN" } }];

    const err = await client()
      .registerWithCredentials("agent_box_pi-x")
      .catch((e: unknown) => e);

    expect(isMatrixUserInUse(err)).toBe(false);
    expect(String(err)).toContain("M_FORBIDDEN");
  });
});
