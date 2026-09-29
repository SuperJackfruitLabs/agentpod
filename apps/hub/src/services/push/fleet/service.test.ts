/**
 * The shell around FleetState and the planner: tokens, APNs and timers,
 * all faked at their interfaces. What is proven here is what reaches Apple
 * and when — the pure rules have their own tests.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { ApnsOutcome, ApnsSendInput } from "../apns";
import { COALESCE_MS, LINGER_AFTER_FINISH_S } from "./planner";
import { createFleetService, type FleetService } from "./service";
import { ACTIVE_WITHIN_MS, inlinePermissionOptions } from "./state";
import { memoryLiveActivityTokenStore, type LiveActivityTokenStore } from "./tokens";

const READER = "@owner:id.agentpod.dev";
const ROOM = "!lyra:id.agentpod.dev";
const T0 = 1_790_670_000_000;
const START = "a".repeat(64);
const UPDATE = "b".repeat(64);

let now = T0;
let sends: ApnsSendInput[] = [];
let answer: (i: ApnsSendInput) => ApnsOutcome = () => ({ status: "sent" });
let timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
let tokens: LiveActivityTokenStore;
let fleet: FleetService;

function build() {
  return createFleetService({
    apns: {
      send: async (i) => {
        sends.push(i);
        return answer(i);
      },
    },
    tokens,
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  });
}

/** Move the clock, firing every timer that falls due, in order. */
async function advance(ms: number) {
  const until = now + ms;
  for (;;) {
    const due = timers.filter((t) => !t.cancelled && t.at <= until).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    due.cancelled = true;
    now = Math.max(now, due.at);
    due.fn();
    await fleet.settled();
  }
  now = until;
  await fleet.settled();
}

const events = () => sends.map((s) => (s.payload as any).aps.event as string);
const lastAps = () => (sends.at(-1)!.payload as any).aps;

async function registerStart() {
  await fleet.tokenRegistered({ userId: READER, deviceId: "D1", kind: "start", activityId: null, token: START, environment: "sandbox" });
}
async function registerUpdate(activityId = "act-1", token = UPDATE) {
  await fleet.tokenRegistered({ userId: READER, deviceId: "D1", kind: "update", activityId, token, environment: "sandbox" });
}

beforeEach(() => {
  now = T0;
  sends = [];
  timers = [];
  answer = () => ({ status: "sent" });
  tokens = memoryLiveActivityTokenStore();
  fleet = build();
});

describe("what reaches Apple", () => {
  test("a Live Activity push, to the token's environment, expiring in an hour", async () => {
    await registerStart();
    fleet.note(READER, { type: "turn-started", roomId: ROOM, name: "Lyra", at: now });
    await fleet.settled();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      pushType: "liveactivity",
      environment: "sandbox",
      deviceToken: START,
      priority: 10,
      expiration: Math.floor(T0 / 1000) + 3600,
    });
    expect(lastAps().event).toBe("start");
    expect(lastAps().attributes).toEqual({ readerId: READER });
  });

  test("nothing at all for a reader with no tokens", async () => {
    fleet.note(READER, { type: "turn-started", roomId: ROOM, name: "Lyra", at: now });
    await fleet.settled();
    expect(sends).toEqual([]);
  });
});

describe("the start and the late update token", () => {
  test("start, hold what changes in the gap, send the latest the moment the token lands", async () => {
    await registerStart();
    fleet.note(READER, { type: "turn-started", roomId: ROOM, name: "Lyra", at: now });
    await fleet.settled();
    await advance(500);
    fleet.note(READER, { type: "step", roomId: ROOM, name: "Lyra", title: "Running the tests", completed: 1, total: 2, at: now });
    await advance(5_000);
    expect(events()).toEqual(["start"]);

    await registerUpdate();
    expect(events()).toEqual(["start", "update"]);
    expect(sends[1]!.deviceToken).toBe(UPDATE);
    expect(lastAps()["content-state"].agents[0].step).toBe("Running the tests");

    // …and from then on, updates go to the update token, never another start.
    await advance(COALESCE_MS);
    fleet.note(READER, { type: "step", roomId: ROOM, name: "Lyra", title: "Fixing", completed: 2, total: 3, at: now });
    await fleet.settled();
    expect(events()).toEqual(["start", "update", "update"]);
    expect(sends[2]!.deviceToken).toBe(UPDATE);
  });

  test("a start token arriving while the fleet is already active starts it then", async () => {
    fleet.note(READER, { type: "turn-started", roomId: ROOM, name: "Lyra", at: now });
    await fleet.settled();
    expect(sends).toEqual([]);
    await registerStart();
    expect(events()).toEqual(["start"]);
  });

  test("with an update token already registered (an activity is up), it is updated, not started", async () => {
    await registerStart();
    await registerUpdate();
    expect(sends).toEqual([]); // nothing active yet
    fleet.note(READER, { type: "turn-started", roomId: ROOM, name: "Lyra", at: now });
    await fleet.settled();
    expect(events()).toEqual(["update"]);
    expect(sends[0]!.deviceToken).toBe(UPDATE);
  });
});

describe("coalescing, through real timers", () => {
  test("routine steps inside 3 s become one update with the latest step; a decision goes at once, at 10", async () => {
    await registerUpdate();
    fleet.note(READER, { type: "turn-started", roomId: ROOM, name: "Lyra", at: now });
    await fleet.settled();
    expect(sends).toHaveLength(1);

    await advance(1_000);
    fleet.note(READER, { type: "step", roomId: ROOM, name: "Lyra", title: "A", completed: 0, total: 1, at: now });
    await advance(500);
    fleet.note(READER, { type: "step", roomId: ROOM, name: "Lyra", title: "B", completed: 1, total: 2, at: now });
    await fleet.settled();
    expect(sends).toHaveLength(1);

    await advance(COALESCE_MS);
    expect(sends).toHaveLength(2);
    expect(lastAps()["content-state"].agents[0].step).toBe("B");
    expect(sends[1]!.priority).toBe(5);

    await advance(100);
    fleet.note(READER, {
      type: "decision-asked",
      decision: {
        key: `perm:${ROOM}`,
        roomId: ROOM,
        eventId: "$q",
        agent: "Lyra",
        kind: "permission",
        question: "Push to main?",
        options: inlinePermissionOptions([{ optionId: "a", name: "Allow once" }]),
        askedAt: now,
      },
    });
    await fleet.settled();
    expect(sends).toHaveLength(3);
    expect(sends[2]!.priority).toBe(10);
    expect(lastAps().alert).toBeUndefined();
    expect(lastAps()["content-state"].decision.question).toBe("Push to main?");

    fleet.clearDecision(`perm:${ROOM}`);
    await fleet.settled();
    expect(sends).toHaveLength(4);
    expect(sends[3]!.priority).toBe(5);
    expect(lastAps()["content-state"].decision).toBeUndefined();
  });
});

describe("quiet → end", () => {
  test("15 minutes after the last turn finished, the card ends, lingering two minutes, and its token is spent", async () => {
    await registerUpdate();
    fleet.note(READER, { type: "turn-started", roomId: ROOM, name: "Lyra", at: now });
    await advance(10_000);
    fleet.note(READER, { type: "turn-finished", roomId: ROOM, name: "Lyra", total: 3, failed: 0, at: now });
    await fleet.settled();
    const finishedAt = now;
    expect(sends.at(-1)!.priority).toBe(10);

    await advance(ACTIVE_WITHIN_MS);
    expect(events().at(-1)).toBe("update");
    await advance(1);
    expect(events().at(-1)).toBe("end");
    const aps = lastAps();
    expect(aps["dismissal-date"]).toBe(aps.timestamp + LINGER_AFTER_FINISH_S);
    expect(aps["content-state"].agents[0]).toMatchObject({ state: "done", total: 3 });
    expect(Math.floor(finishedAt / 1000) + ACTIVE_WITHIN_MS / 1000).toBeLessThanOrEqual(aps.timestamp);
    expect((await tokens.list(READER)).filter((t) => t.kind === "update")).toEqual([]);

    // The next piece of work starts a new card.
    await registerStart();
    fleet.note(READER, { type: "turn-started", roomId: ROOM, name: "Lyra", at: now });
    await fleet.settled();
    expect(events().at(-1)).toBe("start");
  });
});

describe("tokens APNs refuses", () => {
  test("are deleted, and the next push starts over", async () => {
    await registerStart();
    await registerUpdate();
    answer = (i) => (i.deviceToken === UPDATE ? { status: "rejected", reason: "BadDeviceToken" } : { status: "sent" });
    fleet.note(READER, { type: "turn-started", roomId: ROOM, name: "Lyra", at: now });
    await fleet.settled();
    expect((await tokens.list(READER)).map((t) => t.kind)).toEqual(["start"]);

    await advance(COALESCE_MS);
    fleet.note(READER, { type: "turn-finished", roomId: ROOM, name: "Lyra", total: 1, failed: 0, at: now });
    await fleet.settled();
    expect(events().at(-1)).toBe("start");
  });
});

describe("the app ending its activity", () => {
  test("the card is not pushed back while the fleet stays active", async () => {
    await registerStart();
    await registerUpdate();
    fleet.note(READER, { type: "turn-started", roomId: ROOM, name: "Lyra", at: now });
    await fleet.settled();
    await fleet.tokensRemoved(READER, { kind: "update", deviceId: "D1", activityId: "act-1" });
    await advance(COALESCE_MS);
    fleet.note(READER, { type: "turn-finished", roomId: ROOM, name: "Lyra", total: 1, failed: 0, at: now });
    await fleet.settled();
    expect(events()).toEqual(["update"]);
  });
});

describe("gates", () => {
  const gate = (id: string, boardId = "brd_1") => ({
    type: "decision-asked" as const,
    decision: {
      key: `gate:${id}`,
      roomId: "!board:hs",
      eventId: `$${id}`,
      agent: "lyra",
      kind: "gate" as const,
      question: "Approve?",
      options: [],
      askedAt: now,
      boardId,
    },
  });

  test("a board sweep clears the gates it no longer lists, and only that board's", async () => {
    await registerUpdate();
    fleet.note(READER, gate("g1"));
    fleet.note(READER, gate("g2"));
    fleet.note(READER, gate("g3", "brd_2"));
    await fleet.settled();
    expect(lastAps()["content-state"].needsYou).toBe(3);

    fleet.reconcileGates("brd_1", new Set(["g2"]));
    await fleet.settled();
    expect(lastAps()["content-state"].needsYou).toBe(2);
    expect(fleet.knowsDecision("gate:g1")).toBe(false);
    expect(fleet.knowsDecision("gate:g2")).toBe(true);
    expect(fleet.knowsDecision("gate:g3")).toBe(true);
  });
});

describe("a hub restart", () => {
  test("an activity left up is ended if nothing happens within the active window", async () => {
    await tokens.upsert({ userId: READER, deviceId: "D1", kind: "update", activityId: "act-1", token: UPDATE, environment: "sandbox" });
    fleet = build();
    await fleet.restore();
    await advance(ACTIVE_WITHIN_MS - 1);
    expect(sends).toEqual([]);
    await advance(2);
    expect(events()).toEqual(["end"]);
    expect(lastAps()["dismissal-date"]).toBe(lastAps().timestamp);
  });

  test("…and updated, not re-started, if work arrives first", async () => {
    await tokens.upsert({ userId: READER, deviceId: "D1", kind: "update", activityId: "act-1", token: UPDATE, environment: "sandbox" });
    await tokens.upsert({ userId: READER, deviceId: "D1", kind: "start", activityId: null, token: START, environment: "sandbox" });
    fleet = build();
    await fleet.restore();
    fleet.note(READER, { type: "turn-started", roomId: ROOM, name: "Lyra", at: now });
    await fleet.settled();
    expect(events()).toEqual(["update"]);
  });
});
