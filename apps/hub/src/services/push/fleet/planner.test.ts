/**
 * When the Lock Screen card is pushed, and what — pure: a reader's push state
 * and the fleet's content in, the push to make (if any) and when to look again out.
 */

import { describe, expect, test } from "bun:test";
import {
  LIVE_ACTIVITY_PAYLOAD_MAX_BYTES,
  LiveActivityPushPayload,
  type FleetContentState,
} from "@agentpod/contract";

import {
  COALESCE_MS,
  LINGER_AFTER_FINISH_S,
  STALE_AFTER_S,
  START_TOKEN_GRACE_MS,
  fitPayload,
  initialPlan,
  planForNewUpdateToken,
  planPush,
  planTokensGone,
  restoredPlan,
  type PlanInput,
  type ReaderPlan,
} from "./planner";

const T0 = 1_790_670_000_000;
const READER = "@owner:id.agentpod.dev";

function content(step: string, extra: Partial<FleetContentState> = {}): FleetContentState {
  return {
    agents: [{ roomId: "!a:hs", name: "Lyra", state: "working", step, since: 1_790_669_000 }],
    more: 0,
    needsYou: 0,
    working: 1,
    updatedAt: 0,
    ...extra,
  };
}

function input(over: Partial<PlanInput> = {}): PlanInput {
  const now = over.now ?? T0;
  return {
    readerId: READER,
    now,
    content: { ...content("Reading"), updatedAt: Math.floor(now / 1000) },
    active: true,
    change: "routine",
    endedOnFinish: false,
    expiryAt: null,
    tokens: { start: true, update: false },
    ...over,
  };
}

const live = (): ReaderPlan => ({ ...initialPlan(), phase: "live" });
const upd = { start: true, update: true };

describe("starting", () => {
  test("an active fleet with no live activity is started, on the reader's start tokens, at priority 10", () => {
    const r = planPush(initialPlan(), input({ content: content("Running the tests") }));
    expect(r.plan.phase).toBe("starting");
    expect(r.push).not.toBeNull();
    expect(r.push!.target).toBe("start-tokens");
    expect(r.push!.priority).toBe(10);
    const aps = r.push!.payload.aps;
    expect(aps.event).toBe("start");
    expect(aps["attributes-type"]).toBe("FleetActivityAttributes");
    expect(aps.attributes).toEqual({ readerId: READER });
    expect(aps.alert).toEqual({ title: "Lyra", body: "Running the tests" });
    expect(aps.timestamp).toBe(T0 / 1000);
    expect(aps["stale-date"]).toBe(T0 / 1000 + STALE_AFTER_S);
    expect(LiveActivityPushPayload.safeParse(r.push!.payload).success).toBe(true);
  });

  test("the start alert names the question when the first agent needs you", () => {
    const c = content("Waiting for you", {
      agents: [{ roomId: "!r:hs", name: "Ray", state: "needs_you", step: "Waiting for you", since: 1 }],
      decision: { roomId: "!r:hs", eventId: "$e", agent: "Ray", kind: "permission", question: "Run git push?", options: [] },
      needsYou: 1,
      working: 0,
    });
    expect(planPush(initialPlan(), input({ content: c })).push!.payload.aps.alert).toEqual({ title: "Ray", body: "Run git push?" });
  });

  test("with no start token there is nothing to start — until one arrives while still active", () => {
    const first = planPush(initialPlan(), input({ tokens: { start: false, update: false } }));
    expect(first.push).toBeNull();
    expect(first.plan.phase).toBe("idle");
    const later = planPush(first.plan, input({ now: T0 + 1_000, change: "none", tokens: { start: true, update: false } }));
    expect(later.push!.payload.aps.event).toBe("start");
  });

  test("a start is sent once: until its update token arrives, changes are held, not re-started", () => {
    const started = planPush(initialPlan(), input());
    const held = planPush(started.plan, input({ now: T0 + 10_000, content: content("Writing"), change: "important" }));
    expect(held.push).toBeNull();
    expect(held.plan.phase).toBe("starting");
  });

  test("a registered update token means an activity is already up: update it, never start another", () => {
    const r = planPush(initialPlan(), input({ tokens: upd }));
    expect(r.push!.payload.aps.event).toBe("update");
    expect(r.push!.target).toBe("update-tokens");
    expect(r.plan.phase).toBe("live");
  });
});

describe("the late update token", () => {
  test("gets the latest state the moment it arrives, however much changed in the gap", () => {
    const started = planPush(initialPlan(), input({ content: content("One") }));
    const gap = planPush(started.plan, input({ now: T0 + 2_000, content: content("Three") }));
    expect(gap.push).toBeNull();

    const r = planForNewUpdateToken(gap.plan, input({ now: T0 + 2_500, content: content("Three"), change: "none", tokens: upd }));
    expect(r.push).not.toBeNull();
    expect(r.push!.target).toBe("new-token");
    expect(r.push!.payload.aps.event).toBe("update");
    expect(r.push!.payload.aps["content-state"].agents[0]!.step).toBe("Three");
    expect(r.plan.phase).toBe("live");
  });

  test("…and when the fleet already went quiet, it ends the activity rather than updating it", () => {
    const started = planPush(initialPlan(), input());
    const r = planForNewUpdateToken(started.plan, input({ now: T0 + 5_000, active: false, tokens: upd }));
    expect(r.push!.payload.aps.event).toBe("end");
    expect(r.push!.target).toBe("new-token");
    expect(r.plan.phase).toBe("idle");
  });

  test("a turn finishing before the token comes holds the start, so the late token still gets the end, showing how it finished", () => {
    // Seen on a device, 2026-09-29: the finish reset the reader to idle, the
    // token then looked like a card the hub knew nothing of, and the card
    // stayed up saying "working".
    const started = planPush(initialPlan(), input());
    const quiet = planPush(started.plan, input({ now: T0 + 5_000, active: false, change: "important", endedOnFinish: true }));
    expect(quiet.push).toBeNull();
    expect(quiet.plan.phase).toBe("starting");
    expect(quiet.wakeAt).toBe(T0 + START_TOKEN_GRACE_MS);
    const done = content("Done", { agents: [{ roomId: "!a:hs", name: "Lyra", state: "done", completed: 3, total: 3, since: 1_790_669_000 }], working: 0 });
    const r = planForNewUpdateToken(
      quiet.plan,
      input({ now: T0 + 8_000, active: false, tokens: upd, endedOnFinish: true, content: done })
    );
    expect(r.push!.payload.aps.event).toBe("end");
    expect(r.push!.payload.aps["content-state"].agents[0]).toMatchObject({ state: "done", total: 3 });
    expect(r.push!.payload.aps["dismissal-date"]).toBe(r.push!.payload.aps.timestamp + LINGER_AFTER_FINISH_S);
  });

  test("…but only for the grace period: a token that never comes cannot stop the next card starting", () => {
    const started = planPush(initialPlan(), input());
    const quiet = planPush(started.plan, input({ now: T0 + 5_000, active: false }));
    const lapsed = planPush(quiet.plan, input({ now: quiet.wakeAt!, active: false, change: "none" }));
    expect(lapsed.plan.phase).toBe("idle");
    expect(planPush(lapsed.plan, input({ now: quiet.wakeAt! + 1 })).push!.payload.aps.event).toBe("start");
  });

  test("a card the hub knows nothing of, on a quiet fleet, is adopted and given the active window", () => {
    const r = planForNewUpdateToken(initialPlan(), input({ active: false, tokens: upd, change: "none" }));
    expect(r.push).toBeNull();
    expect(r.plan.phase).toBe("live");
    expect(r.wakeAt).toBe(T0 + 15 * 60_000 + 1);
    // …and ended at that wake if still quiet.
    expect(planPush(r.plan, input({ now: r.wakeAt!, active: false, tokens: upd })).push!.payload.aps.event).toBe("end");
  });

  test("a second device's token while live is brought up to date too", () => {
    const r = planForNewUpdateToken(live(), input({ tokens: upd, change: "none" }));
    expect(r.push!.target).toBe("new-token");
    expect(r.push!.payload.aps.event).toBe("update");
    expect(r.push!.priority).toBe(10);
  });
});

describe("coalescing", () => {
  test("at most one routine update every 3 s; the latest state wins — and it goes at priority 10", () => {
    // Seen on a device, 2026-09-29: a 10 s OpenClaw turn's three step updates
    // went at priority 5, which Apple delivers when it chooses; only the
    // priority-10 start and end ever showed. Every update that is sent changes
    // what the card says (`sameCard` drops clock-only ones), so each goes at 10;
    // the 3 s window is what bounds the rate.
    const a = planPush(live(), input({ tokens: upd, content: content("A") }));
    expect(a.push!.priority).toBe(10);

    const b = planPush(a.plan, input({ now: T0 + 1_000, tokens: upd, content: content("B") }));
    expect(b.push).toBeNull();
    expect(b.wakeAt).toBe(T0 + COALESCE_MS);

    const c = planPush(b.plan, input({ now: T0 + 2_000, tokens: upd, content: content("C") }));
    expect(c.push).toBeNull();
    expect(c.wakeAt).toBe(T0 + COALESCE_MS);

    const tick = planPush(c.plan, input({ now: T0 + COALESCE_MS, tokens: upd, content: content("C"), change: "none" }));
    expect(tick.push!.payload.aps["content-state"].agents[0]!.step).toBe("C");
    expect(tick.plan.dueAt).toBeNull();
  });

  test("a decision arriving or a turn finishing goes at once, at priority 10", () => {
    const a = planPush(live(), input({ tokens: upd, content: content("A") }));
    const b = planPush(a.plan, input({ now: T0 + 500, tokens: upd, content: content("B"), change: "important" }));
    expect(b.push!.priority).toBe(10);
    expect(b.plan.dueAt).toBeNull();
  });

  test("a decision clearing goes at once, at priority 10, so its buttons leave the card promptly", () => {
    const a = planPush(live(), input({ tokens: upd, content: content("A") }));
    const b = planPush(a.plan, input({ now: T0 + 500, tokens: upd, content: content("B"), change: "flush" }));
    expect(b.push!.priority).toBe(10);
  });

  test("nothing visible changed, nothing is sent — even past the window", () => {
    const a = planPush(live(), input({ tokens: upd }));
    const b = planPush(a.plan, input({ now: T0 + 10_000, tokens: upd }));
    expect(b.push).toBeNull();
    expect(b.plan.dueAt).toBeNull();
  });

  test("timestamps only move forward, even for two pushes in one second", () => {
    const a = planPush(live(), input({ tokens: upd, content: content("A") }));
    const b = planPush(a.plan, input({ now: T0 + 200, tokens: upd, content: content("B"), change: "important" }));
    expect(b.push!.payload.aps.timestamp).toBeGreaterThan(a.push!.payload.aps.timestamp);
  });

  test("an update never alerts — a decision arriving changes the card at priority 10; its message notification does the buzzing", () => {
    const decided = content("Waiting for you", {
      decision: { roomId: "!a:hs", eventId: "$e", agent: "Lyra", kind: "permission", question: "Delete the branch?", options: [] },
      needsYou: 1,
    });
    const quiet = planPush(live(), input({ tokens: upd, change: "important" }));
    expect(quiet.push!.payload.aps.alert).toBeUndefined();
    const loud = planPush(quiet.plan, input({ now: T0 + 100, tokens: upd, content: decided, change: "important" }));
    expect(loud.push!.priority).toBe(10);
    expect(loud.push!.payload.aps.alert).toBeUndefined();
    expect(loud.push!.payload.aps["content-state"].decision!.question).toBe("Delete the branch?");
    expect(loud.push!.payload.aps["stale-date"]).toBe(loud.push!.payload.aps.timestamp + STALE_AFTER_S);
  });

  test("the next look is the sooner of a held update and the fleet's own next change", () => {
    const a = planPush(live(), input({ tokens: upd, expiryAt: T0 + 60_000 }));
    expect(a.wakeAt).toBe(T0 + 60_000);
    const b = planPush(a.plan, input({ now: T0 + 1_000, tokens: upd, content: content("B"), expiryAt: T0 + 60_000 }));
    expect(b.wakeAt).toBe(T0 + COALESCE_MS);
  });
});

describe("quiet → end", () => {
  test("ends a live activity, keeping what it last showed, dismissed two minutes on after a finished turn", () => {
    const a = planPush(live(), input({ tokens: upd, content: content("Last step") }));
    const later = T0 + 20 * 60_000;
    const end = planPush(a.plan, input({ now: later, tokens: upd, active: false, endedOnFinish: true, content: content("", { agents: [] }) }));
    expect(end.push!.target).toBe("update-tokens");
    const aps = end.push!.payload.aps;
    expect(aps.event).toBe("end");
    expect(aps["content-state"].agents[0]!.step).toBe("Last step");
    expect(aps["content-state"].updatedAt).toBe(later / 1000);
    expect(aps["dismissal-date"]).toBe(later / 1000 + LINGER_AFTER_FINISH_S);
    expect(end.plan.phase).toBe("idle");
    expect(end.wakeAt).toBeNull();
    expect(LiveActivityPushPayload.safeParse(end.push!.payload).success).toBe(true);
  });

  test("otherwise dismissed now", () => {
    const end = planPush(live(), input({ tokens: upd, active: false, endedOnFinish: false }));
    expect(end.push!.payload.aps["dismissal-date"]).toBe(end.push!.payload.aps.timestamp);
  });

  test("a start never answered with a token has nothing to end", () => {
    const started = planPush(initialPlan(), input());
    const end = planPush(started.plan, input({ now: T0 + 60_000, active: false }));
    expect(end.push).toBeNull();
    expect(end.plan.phase).toBe("idle");
  });

  test("an idle reader with a quiet fleet sends nothing", () => {
    expect(planPush(initialPlan(), input({ active: false })).push).toBeNull();
  });

  test("a restored activity (after a hub restart) is ended if the fleet stays quiet", () => {
    const end = planPush(restoredPlan(), input({ tokens: upd, active: false }));
    expect(end.push!.payload.aps.event).toBe("end");
  });
});

describe("the app ending its activity", () => {
  test("while the fleet is active, the card stays down until the fleet goes quiet", () => {
    const gone = planTokensGone(live(), true);
    expect(gone.phase).toBe("dismissed");
    expect(planPush(gone, input({ tokens: { start: true, update: false }, change: "important" })).push).toBeNull();
    const quiet = planPush(gone, input({ active: false, tokens: { start: true, update: false } }));
    expect(quiet.plan.phase).toBe("idle");
    expect(planPush(quiet.plan, input({ now: T0 + 1, tokens: { start: true, update: false } })).push!.payload.aps.event).toBe("start");
  });

  test("when the fleet is quiet anyway, the reader is simply idle", () => {
    expect(planTokensGone(live(), false).phase).toBe("idle");
  });
});

describe("fitting in 4 KB", () => {
  test("the worst case is cut down to fit, dropping rows into `more` first", () => {
    const long = (n: number, c = "x") => c.repeat(n);
    const agent = (i: number) => ({
      roomId: `!${long(250)}${i}:hs`,
      name: long(40, "é"),
      state: "working" as const,
      step: long(60, "🔧"),
      completed: 99,
      total: 999,
      since: 1_790_000_000,
    });
    const huge: FleetContentState = {
      agents: [agent(0), agent(1), agent(2)],
      more: 7,
      decision: {
        roomId: `!${long(250)}:hs`,
        eventId: `$${long(250)}`,
        agent: long(40, "é"),
        kind: "permission",
        question: long(120, "🔧"),
        options: [
          { id: long(64), label: long(24, "é"), declines: false },
          { id: long(64, "y"), label: long(24, "é"), declines: true },
        ],
      },
      needsYou: 3,
      working: 10,
      updatedAt: 1_790_000_000,
    };
    const payload = {
      aps: {
        timestamp: 1_790_000_000,
        event: "start" as const,
        "attributes-type": "FleetActivityAttributes" as const,
        attributes: { readerId: `@${long(250)}:hs` },
        "content-state": huge,
        alert: { title: long(40, "é"), body: long(120, "🔧") },
        "stale-date": 1_790_000_900,
      },
    };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(LIVE_ACTIVITY_PAYLOAD_MAX_BYTES);
    const fitted = fitPayload(payload);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(LIVE_ACTIVITY_PAYLOAD_MAX_BYTES);
    const cs = fitted.aps["content-state"];
    // Rows go before the decision: the decision is the one thing on the card that is owed.
    expect(cs.decision).toBeDefined();
    expect(cs.agents.length + cs.more).toBe(10);
    expect(LiveActivityPushPayload.safeParse(fitted).success).toBe(true);
  });

  test("a payload that fits is left alone", () => {
    const p = planPush(initialPlan(), input()).push!.payload;
    expect(fitPayload(p)).toEqual(p);
  });
});
