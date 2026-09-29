/**
 * POST/DELETE /_supermessage/v1/live-activity/tokens — where the app registers
 * the tokens the fleet Live Activity is pushed to (spec A1).
 *
 * The homeserver's whoami is faked at the fetch; the fleet service is real,
 * over the in-memory token store and a fake APNs.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createLiveActivityRoutes, createWhoami, type Whoami } from "./live-activity";
import type { ApnsSendInput } from "../services/push/apns";
import { createFleetService, type FleetService } from "../services/push/fleet/service";
import { memoryLiveActivityTokenStore, type LiveActivityTokenStore } from "../services/push/fleet/tokens";

const HS = "http://127.0.0.1:6167";
const GOOD = "syt_good_token";
const USER = "@owner:id.agentpod.dev";
const TOKEN = "c".repeat(64);

let whoamiCalls: string[] = [];
let hsAnswer: () => Response | Promise<Response> = () =>
  Response.json({ user_id: USER, device_id: "DEV1" }, { status: 200 });
let tokens: LiveActivityTokenStore;
let fleet: FleetService;
let sends: ApnsSendInput[];
let clock = 1_790_670_000_000;

function whoami(ttlMs?: number): Whoami {
  return createWhoami({
    homeserverUrl: HS,
    ttlMs,
    now: () => clock,
    fetch: async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      whoamiCalls.push(`${url} ${auth}`);
      if (auth !== `Bearer ${GOOD}`) {
        return Response.json({ errcode: "M_UNKNOWN_TOKEN", error: "Unknown access token" }, { status: 401 });
      }
      return hsAnswer();
    },
  });
}

function app(opts: { fleet?: FleetService | null; whoami?: Whoami } = {}) {
  return new Hono().route(
    "/_supermessage/v1/live-activity",
    createLiveActivityRoutes({
      fleet: opts.fleet === undefined ? fleet : opts.fleet,
      whoami: opts.whoami ?? whoami(),
    })
  );
}

function call(a: Hono, method: "POST" | "DELETE", body: unknown, auth: string | null = `Bearer ${GOOD}`) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers.authorization = auth;
  return a.request("/_supermessage/v1/live-activity/tokens", {
    method,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const startBody = { kind: "start", token: TOKEN, environment: "production", device_id: "DEV1" };
const updateBody = { kind: "update", token: "d".repeat(64), environment: "sandbox", device_id: "DEV1", activity_id: "act-1" };

beforeEach(() => {
  whoamiCalls = [];
  hsAnswer = () => Response.json({ user_id: USER, device_id: "DEV1" }, { status: 200 });
  tokens = memoryLiveActivityTokenStore();
  sends = [];
  fleet = createFleetService({
    apns: { send: async (i) => (sends.push(i), { status: "sent" }) },
    tokens,
    setTimer: () => () => {},
  });
});

describe("auth", () => {
  test("no bearer is 401, and the homeserver is not asked", async () => {
    const res = await call(app(), "POST", startBody, null);
    expect(res.status).toBe(401);
    expect(whoamiCalls).toEqual([]);
  });

  test("a token the homeserver does not know is 401, and nothing is stored", async () => {
    const res = await call(app(), "POST", startBody, "Bearer syt_stolen");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ errcode: "M_UNKNOWN_TOKEN" });
    expect(await tokens.list(USER)).toEqual([]);
  });

  test("a whoami answer that names nobody is 401", async () => {
    hsAnswer = () => Response.json({}, { status: 200 });
    expect((await call(app(), "POST", startBody)).status).toBe(401);
  });

  test("an unreachable homeserver is 502, not a verdict on the token", async () => {
    hsAnswer = () => {
      throw new Error("connect ECONNREFUSED");
    };
    expect((await call(app(), "POST", startBody)).status).toBe(502);
  });

  test("the owner is whoever whoami says — never a user id in the body", async () => {
    const res = await call(app(), "POST", { ...startBody, user_id: "@someone-else:id.agentpod.dev" });
    expect(res.status).toBe(204);
    expect((await tokens.list(USER)).map((t) => t.userId)).toEqual([USER]);
    expect(await tokens.list("@someone-else:id.agentpod.dev")).toEqual([]);
  });

  test("whoami is asked once per access token, briefly cached", async () => {
    const w = whoami(60_000);
    const a = app({ whoami: w });
    await call(a, "POST", startBody);
    await call(a, "POST", updateBody);
    expect(whoamiCalls).toHaveLength(1);
    expect(whoamiCalls[0]).toBe(`${HS}/_matrix/client/v3/account/whoami Bearer ${GOOD}`);
    clock += 60_001;
    await call(a, "POST", startBody);
    expect(whoamiCalls).toHaveLength(2);
  });

  test("a refusal is not cached: a token that was just issued works on the next try", async () => {
    let known = false;
    const w = createWhoami({
      homeserverUrl: HS,
      now: () => clock,
      fetch: async () =>
        known
          ? Response.json({ user_id: USER }, { status: 200 })
          : Response.json({ errcode: "M_UNKNOWN_TOKEN" }, { status: 401 }),
    });
    const a = app({ whoami: w });
    expect((await call(a, "POST", startBody)).status).toBe(401);
    known = true;
    expect((await call(a, "POST", startBody)).status).toBe(204);
  });
});

describe("registering", () => {
  test("a start token is stored under the whoami user and the body's device", async () => {
    expect((await call(app(), "POST", startBody)).status).toBe(204);
    expect(await tokens.list(USER)).toEqual([
      { userId: USER, deviceId: "DEV1", kind: "start", activityId: null, token: TOKEN, environment: "production" },
    ]);
  });

  test("an update token needs its activity id", async () => {
    const { activity_id: _, ...noActivity } = updateBody;
    expect((await call(app(), "POST", noActivity)).status).toBe(400);
    expect((await call(app(), "POST", updateBody)).status).toBe(204);
    expect((await tokens.list(USER))[0]).toMatchObject({ kind: "update", activityId: "act-1", environment: "sandbox" });
  });

  test.each([
    ["not JSON", "{nope"],
    ["an unknown kind", { ...startBody, kind: "stop" }],
    ["a token that is not hex", { ...startBody, token: "zz".repeat(32) }],
    ["an unknown environment", { ...startBody, environment: "staging" }],
    ["no device", { ...startBody, device_id: "" }],
  ])("refuses %s with 400", async (_why, body) => {
    expect((await call(app(), "POST", body)).status).toBe(400);
    expect(await tokens.list(USER)).toEqual([]);
  });

  test("an update token arriving while the fleet is active is pushed the card at once", async () => {
    await call(app(), "POST", startBody);
    fleet.note(USER, { type: "turn-started", roomId: "!r:hs", name: "Lyra", at: Date.now() });
    await fleet.settled();
    expect(sends.map((s) => (s.payload as any).aps.event)).toEqual(["start"]);
    await call(app(), "POST", updateBody);
    await fleet.settled();
    expect(sends.map((s) => (s.payload as any).aps.event)).toEqual(["start", "update"]);
    expect(sends[1]!.deviceToken).toBe(updateBody.token);
  });
});

describe("deleting", () => {
  test("removes the device's token of that kind, and answers 204 even when there was none", async () => {
    await call(app(), "POST", startBody);
    await call(app(), "POST", updateBody);
    expect((await call(app(), "DELETE", { kind: "update", device_id: "DEV1", activity_id: "act-1" })).status).toBe(204);
    expect((await tokens.list(USER)).map((t) => t.kind)).toEqual(["start"]);
    expect((await call(app(), "DELETE", { kind: "start", device_id: "DEV1" })).status).toBe(204);
    expect(await tokens.list(USER)).toEqual([]);
    expect((await call(app(), "DELETE", { kind: "start", device_id: "DEV1" })).status).toBe(204);
  });

  test("needs auth like everything else", async () => {
    expect((await call(app(), "DELETE", { kind: "start", device_id: "DEV1" }, "Bearer nope")).status).toBe(401);
  });
});

describe("when the push gateway is off", () => {
  test("both verbs answer 503, before asking the homeserver anything", async () => {
    const a = app({ fleet: null });
    expect((await call(a, "POST", startBody)).status).toBe(503);
    expect((await call(a, "DELETE", { kind: "start", device_id: "DEV1" })).status).toBe(503);
    expect(whoamiCalls).toEqual([]);
  });
});
