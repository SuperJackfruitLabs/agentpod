/**
 * POST /_matrix/push/v1/notify — the Matrix push gateway.
 *
 * The APNs client is faked at its interface; `services/push/apns.test.ts`
 * covers the wire. What is proven here is what the homeserver sees and what
 * reaches Apple: the shape the route accepts, what it answers as `rejected`,
 * that no message content can ride along, and that the hub's own questions go
 * out tagged.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ApnsPushPayload } from "@agentpod/contract";

import { createMatrixPushRoutes, NOTIFY_BODY_MAX } from "./matrix-push";
import type { ApnsOutcome, ApnsSendInput } from "../services/push/apns";
import { parseAppIds, pushConfigFromEnv } from "../services/push/config";
import {
  createPushGateway,
  createPushkeyLimiter,
  pushkeyPrefix,
  QUIET_WAIT_MS,
  type PushDecision,
} from "../services/push/gateway";
import {
  _quietWaitersForTest,
  _resetHubEventsForTest,
  beginQuietSend,
  noteHubEvent,
} from "../services/push/hub-events";

const PROD = "a".repeat(64);
const SANDBOX = "b".repeat(64);
const EVENT = "$Eaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROOM = "!room:id.agentpod.dev";

let sends: ApnsSendInput[] = [];
let decisions: PushDecision[] = [];
let answer: (i: ApnsSendInput) => ApnsOutcome = () => ({ status: "sent" });

function app(opts: { configured?: boolean; limit?: number; quietWaitMs?: number } = {}) {
  const gateway =
    opts.configured === false
      ? null
      : createPushGateway({
          apns: {
            send: async (i: ApnsSendInput) => {
              sends.push(i);
              return answer(i);
            },
          },
          appIds: new Map([
            ["dev.supermessage.ios", "production"],
            ["dev.supermessage.ios.dev", "sandbox"],
          ]),
          limiter: createPushkeyLimiter(opts.limit ?? 60, 60_000),
          now: () => 1_790_000_000_000,
          quietWaitMs: opts.quietWaitMs,
          onDecision: (d) => decisions.push(d),
        });
  return new Hono().route("/_matrix/push/v1", createMatrixPushRoutes(gateway));
}

function notification(over: Record<string, unknown> = {}) {
  return {
    notification: {
      event_id: EVENT,
      room_id: ROOM,
      counts: { unread: 3 },
      prio: "high",
      devices: [{ app_id: "dev.supermessage.ios", pushkey: PROD, pushkey_ts: 1, data: {}, tweaks: {} }],
      ...over,
    },
  };
}

/** Until the push is parked waiting on ROOM — a barrier, not a sleep. */
async function untilWaiting() {
  for (let i = 0; i < 2_000 && _quietWaitersForTest(ROOM) === 0; i++) await Bun.sleep(1);
  expect(_quietWaitersForTest(ROOM)).toBe(1);
}

async function post(a: Hono, body: unknown) {
  return a.request("/_matrix/push/v1/notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  sends = [];
  decisions = [];
  answer = () => ({ status: "sent" });
  _resetHubEventsForTest();
});

describe("the route", () => {
  test("answers 404 when the gateway is not configured", async () => {
    const res = await post(app({ configured: false }), notification());
    expect(res.status).toBe(404);
  });

  test("pushes and answers {rejected: []}", async () => {
    const res = await post(app(), notification());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rejected: [] });
    expect(sends).toHaveLength(1);
  });

  test.each([
    ["not JSON", "{nope"],
    ["no notification", { devices: [] }],
    ["no devices", notification({ devices: [] })],
    ["a device with no pushkey", notification({ devices: [{ app_id: "dev.supermessage.ios" }] })],
    ["a numeric event id", notification({ event_id: 42 })],
    ["an unknown prio", notification({ prio: "urgent" })],
    ["a negative unread count", notification({ counts: { unread: -1 } })],
    ["too many devices", notification({ devices: Array.from({ length: 21 }, () => ({ app_id: "x", pushkey: PROD })) })],
  ])("refuses %s with 400 and pushes nothing", async (_why, body) => {
    const res = await post(app(), body);
    expect(res.status).toBe(400);
    expect(sends).toHaveLength(0);
  });

  test("refuses an oversized body with 413", async () => {
    const res = await post(app(), notification({ room_name: "x".repeat(NOTIFY_BODY_MAX) }));
    expect(res.status).toBe(413);
    expect(sends).toHaveLength(0);
  });

  test("routes each app id to its APNs environment, and drops one it does not serve", async () => {
    const res = await post(
      app(),
      notification({
        devices: [
          { app_id: "dev.supermessage.ios", pushkey: PROD },
          { app_id: "dev.supermessage.ios.dev", pushkey: SANDBOX },
          { app_id: "com.example.other", pushkey: "c".repeat(64) },
        ],
      })
    );
    // An unserved app id is not rejected: that would delete a pusher over
    // this hub's configuration.
    expect(await res.json()).toEqual({ rejected: [] });
    expect(sends.map((s) => [s.deviceToken, s.environment])).toEqual([
      [PROD, "production"],
      [SANDBOX, "sandbox"],
    ]);
  });

  test("rate-limits per pushkey — over the limit is dropped, not rejected", async () => {
    const a = app({ limit: 2 });
    for (let i = 0; i < 3; i++) expect(await (await post(a, notification())).json()).toEqual({ rejected: [] });
    expect(sends).toHaveLength(2);
    // Another device is not starved by the first.
    await post(a, notification({ devices: [{ app_id: "dev.supermessage.ios.dev", pushkey: SANDBOX }] }));
    expect(sends).toHaveLength(3);
  });
});

describe("rejected", () => {
  test("carries exactly the pushkeys APNs said are dead", async () => {
    answer = (i) =>
      i.deviceToken === SANDBOX ? { status: "rejected", reason: "Unregistered" } : { status: "sent" };
    const res = await post(
      app(),
      notification({
        devices: [
          { app_id: "dev.supermessage.ios", pushkey: PROD },
          { app_id: "dev.supermessage.ios.dev", pushkey: SANDBOX },
        ],
      })
    );
    expect(await res.json()).toEqual({ rejected: [SANDBOX] });
  });

  test("a failed push is not a dead device", async () => {
    answer = () => ({ status: "failed", reason: "InternalServerError" });
    expect(await (await post(app(), notification())).json()).toEqual({ rejected: [] });
  });

  test("a pushkey that is not an APNs token is rejected without calling Apple", async () => {
    const res = await post(app(), notification({ devices: [{ app_id: "dev.supermessage.ios", pushkey: "NOT-HEX" }] }));
    expect(await res.json()).toEqual({ rejected: ["NOT-HEX"] });
    expect(sends).toHaveLength(0);
  });
});

describe("the payload", () => {
  test("is the fixed alert, the ids and the count — and the headers follow the notification", async () => {
    await post(app(), notification());
    const s = sends[0]!;
    expect(s.payload).toEqual({
      aps: {
        alert: { title: "supermessage", body: "New message" },
        "mutable-content": 1,
        sound: "default",
        badge: 3,
        "thread-id": ROOM,
      },
      room_id: ROOM,
      event_id: EVENT,
      unread_count: 3,
    });
    expect(s.priority).toBe(10);
    expect(s.collapseId).toBe(EVENT);
    expect(s.expiration).toBe(1_790_000_000 + 24 * 60 * 60);
  });

  test("never carries message content, even when the homeserver sends some", async () => {
    const secret = "the launch codes are 0000";
    await post(
      app(),
      notification({
        type: "m.room.message",
        sender: "@rakesh:id.agentpod.dev",
        sender_display_name: `Rakesh ${secret}`,
        room_name: `Room ${secret}`,
        room_alias: "#r:id.agentpod.dev",
        content: { msgtype: "m.text", body: secret },
      })
    );
    const wire = JSON.stringify(sends[0]!.payload);
    expect(wire).not.toContain(secret);
    expect(wire).not.toContain("@rakesh");
    expect(wire).not.toContain("#r:");
    expect(ApnsPushPayload.safeParse(sends[0]!.payload).success).toBe(true);
  });

  test("a low-priority notification goes at APNs priority 5", async () => {
    await post(app(), notification({ prio: "low" }));
    expect(sends[0]!.priority).toBe(5);
  });

  test("no badge when the homeserver sent no count", async () => {
    await post(app(), notification({ counts: undefined }));
    const p = sends[0]!.payload as { aps: Record<string, unknown>; unread_count?: number };
    expect(p.aps.badge).toBeUndefined();
    expect(p.unread_count).toBeUndefined();
  });
});

describe("the hub's own questions", () => {
  test("a permission request goes out as PERMISSION, time-sensitive", async () => {
    noteHubEvent(EVENT, "permission");
    await post(app(), notification());
    const aps = (sends[0]!.payload as { aps: Record<string, unknown> }).aps;
    expect(aps.category).toBe("PERMISSION");
    expect(aps["interruption-level"]).toBe("time-sensitive");
  });

  test("a gate goes out as GATE", async () => {
    noteHubEvent(EVENT, "gate");
    await post(app(), notification());
    expect((sends[0]!.payload as { aps: Record<string, unknown> }).aps.category).toBe("GATE");
  });

  test("an ordinary message carries no category", async () => {
    noteHubEvent("$other", "permission");
    await post(app(), notification());
    const aps = (sends[0]!.payload as { aps: Record<string, unknown> }).aps;
    expect(aps.category).toBeUndefined();
    expect(aps["interruption-level"]).toBeUndefined();
  });

  test("the legacy event beside a question does not buzz a second time", async () => {
    noteHubEvent(EVENT, "companion");
    expect(await (await post(app(), notification())).json()).toEqual({ rejected: [] });
    expect(sends).toHaveLength(0);
  });
});

describe("the hub's quiet events — its reactions and turn records", () => {
  test("never reach Apple, and the device is answered as delivered", async () => {
    noteHubEvent(EVENT, "quiet");
    const res = await post(
      app(),
      notification({
        devices: [
          { app_id: "dev.supermessage.ios", pushkey: PROD },
          { app_id: "dev.supermessage.ios.dev", pushkey: SANDBOX },
        ],
      })
    );
    // Not rejected: that would make the homeserver delete the pusher.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rejected: [] });
    expect(sends).toHaveLength(0);
    expect(decisions).toEqual([{ eventId: EVENT, kind: "quiet", timing: "known-before", waitedMs: 0 }]);
  });

  test("a push that beats the send's response waits for its id, then is dropped", async () => {
    // The homeserver pushes before the hub's PUT has returned the event id.
    const end = beginQuietSend(ROOM);
    const pushed = post(app(), notification());
    await untilWaiting();
    noteHubEvent(EVENT, "quiet");
    end();
    expect(await (await pushed).json()).toEqual({ rejected: [] });
    expect(sends).toHaveLength(0);
    expect(decisions[0]!.timing).toBe("known-after-wait");
    expect(decisions[0]!.kind).toBe("quiet");
  });

  test("a message beside a quiet send in its room goes out once that send returns", async () => {
    const end = beginQuietSend(ROOM);
    const pushed = post(app(), notification());
    await untilWaiting();
    noteHubEvent("$the-reaction", "quiet");
    end();
    await pushed;
    expect(sends).toHaveLength(1);
    expect(decisions[0]!.timing).toBe("unknown");
    expect(decisions[0]!.waitedMs).toBeLessThan(QUIET_WAIT_MS);
  });

  test("a message is held no longer than the wait, even if a quiet send never returns", async () => {
    beginQuietSend(ROOM); // hangs
    const t = performance.now();
    await post(app({ quietWaitMs: 80 }), notification());
    const took = performance.now() - t;
    expect(sends).toHaveLength(1);
    expect(took).toBeGreaterThanOrEqual(75);
    expect(took).toBeLessThan(1_000);
    expect(decisions[0]!.timing).toBe("unknown");
  });

  test("a message in a room with nothing in flight is not held at all", async () => {
    beginQuietSend("!another-room:id.agentpod.dev"); // hangs, elsewhere
    const t = performance.now();
    await post(app({ quietWaitMs: 5_000 }), notification());
    expect(performance.now() - t).toBeLessThan(1_000);
    expect(sends).toHaveLength(1);
    expect(decisions[0]).toEqual({ eventId: EVENT, kind: undefined, timing: "unknown", waitedMs: 0 });
  });

  test("the wait is bounded by default", () => {
    expect(QUIET_WAIT_MS).toBeGreaterThan(0);
    expect(QUIET_WAIT_MS).toBeLessThanOrEqual(800);
  });
});

describe("a counts-only notice", () => {
  test("is not a push — tuwunel's badge refresh names no event", async () => {
    const res = await post(app(), notification({ event_id: undefined, room_id: undefined }));
    expect(await res.json()).toEqual({ rejected: [] });
    expect(sends).toHaveLength(0);
  });
});

describe("configuration", () => {
  const full = {
    APNS_KEY_PATH: "/etc/agentpod/apns/AuthKey_8R6R2N4MM8.p8",
    APNS_KEY_ID: "8R6R2N4MM8",
    APNS_TEAM_ID: "N2QQPW2BRJ",
    APNS_TOPIC: "dev.supermessage.ios",
    PUSH_APP_IDS: "dev.supermessage.ios:production,dev.supermessage.ios.dev:sandbox",
  };

  test("reads the documented env lines", () => {
    const r = pushConfigFromEnv(full);
    expect(r.status).toBe("on");
    if (r.status !== "on") return;
    expect([...r.config.appIds]).toEqual([
      ["dev.supermessage.ios", "production"],
      ["dev.supermessage.ios.dev", "sandbox"],
    ]);
  });

  test("nothing set is off; half set is invalid, not on", () => {
    expect(pushConfigFromEnv({}).status).toBe("off");
    expect(pushConfigFromEnv({ ...full, APNS_TEAM_ID: "" }).status).toBe("invalid");
    expect(parseAppIds("dev.supermessage.ios:staging").problems).toHaveLength(1);
  });

  test("a pushkey is logged by prefix only", () => {
    expect(pushkeyPrefix(PROD)).toBe("aaaaaaaa…");
  });
});
