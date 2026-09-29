/**
 * An agent's own report of its turn — for agents whose turns never pass
 * through the hub's ACP → Matrix bridge (a harness-mode Hermes with the
 * `agentpod-live` plugin). The node forwards the plugin's report; this is what
 * the hub does with it: who it is for, whether to believe it, and how it
 * reaches the same fleet Live Activity and the same answer push as a bridge
 * turn.
 *
 * Identity is faked at `resolve` (its database half is
 * `tests/integration/fleet-agent-reports.test.ts`); the fleet service, the
 * push gateway and the hub-event records are the real ones.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { FLEET_REPORT_MAX_AGE_MS, type FleetTurnReport } from "@agentpod/contract";

import type { ApnsSendInput } from "../apns";
import { createPushGateway, createPushkeyLimiter, type PushDecision } from "../gateway";
import { _quietWaitersForTest, _resetHubEventsForTest, hubEventTurn, quietSendsInFlight } from "../hub-events";
import { ANSWER_ANNOUNCE_MS, IDENTITY_CACHE_MS, createAgentReportRelay, type ReportingAgent } from "./agent-reports";
import { createFleetService, type FleetService } from "./service";
import type { FleetSink } from "./sink";
import type { FleetEvent } from "./state";
import { memoryLiveActivityTokenStore } from "./tokens";

const NODE = "node_guild";
const AGENT = "@agent_guild_echo:id.agentpod.dev";
const OWNER = "@rakesh:id.agentpod.dev";
const ROOM = "!echo:id.agentpod.dev";
const T0 = 1_790_670_000_000;

let now = T0;
let timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
let resolved: ReportingAgent | null;
let resolveCalls = 0;
let noted: Array<{ reader: string; event: FleetEvent }> = [];
let sink: FleetSink | null;

const recordingSink = (): FleetSink => ({
  note: (reader, event) => noted.push({ reader, event }),
  clearDecision: () => {},
  reconcileGates: () => {},
  knowsDecision: () => false,
});

function relay(over: { resolve?: (n: string, a: string, r: string) => Promise<ReportingAgent | null> } = {}) {
  return createAgentReportRelay({
    resolve:
      over.resolve ??
      (async () => {
        resolveCalls++;
        return resolved;
      }),
    sink: () => sink,
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

function advance(ms: number) {
  now += ms;
  for (const t of timers) {
    if (!t.cancelled && t.at <= now) {
      t.cancelled = true;
      t.fn();
    }
  }
}

function report(event: FleetTurnReport["event"], over: Partial<FleetTurnReport> = {}): FleetTurnReport {
  return { agent: AGENT, roomId: ROOM, reader: OWNER, at: now, event, ...over };
}

beforeEach(() => {
  now = T0;
  timers = [];
  resolved = { reader: OWNER, name: "Echo" };
  resolveCalls = 0;
  noted = [];
  sink = recordingSink();
  _resetHubEventsForTest();
});

describe("whether a report is believed", () => {
  test("a hub with no fleet Live Activity does nothing — not even the lookup", async () => {
    sink = null;
    expect(await relay().handle(NODE, report({ type: "turn-started" }))).toBe("off");
    expect(resolveCalls).toBe(0);
  });

  test("a report for an agent this node does not host is dropped", async () => {
    resolved = null;
    expect(await relay().handle(NODE, report({ type: "turn-started" }))).toBe("unknown-agent");
    expect(noted).toHaveLength(0);
  });

  test("the reader is the station's owner — a report naming anyone else is dropped, never redirected", async () => {
    const r = relay();
    expect(await r.handle(NODE, report({ type: "turn-started" }, { reader: "@someone-else:id.agentpod.dev" }))).toBe(
      "not-owner"
    );
    expect(noted).toHaveLength(0);
    expect(await r.handle(NODE, report({ type: "turn-started" }))).toBe("applied");
    expect(noted.map((n) => n.reader)).toEqual([OWNER]);
  });

  test("the lookup is asked with the authenticated node, the agent and the room", async () => {
    const asked: string[][] = [];
    await relay({
      resolve: async (n, a, r) => {
        asked.push([n, a, r]);
        return resolved;
      },
    }).handle(NODE, report({ type: "turn-started" }));
    expect(asked).toEqual([[NODE, AGENT, ROOM]]);
  });

  test("a stale report — queued through a hub outage — is history, not news", async () => {
    const r = relay();
    expect(await r.handle(NODE, report({ type: "turn-started" }, { at: now - FLEET_REPORT_MAX_AGE_MS - 1 }))).toBe(
      "stale"
    );
    expect(await r.handle(NODE, report({ type: "turn-started" }, { at: now + FLEET_REPORT_MAX_AGE_MS + 1 }))).toBe(
      "stale"
    );
    expect(noted).toHaveLength(0);
    expect(resolveCalls).toBe(0);
  });

  test("who an agent is is looked up once a minute, not once a step", async () => {
    const r = relay();
    for (let i = 0; i < 5; i++) await r.handle(NODE, report({ type: "turn-started" }));
    expect(resolveCalls).toBe(1);
    advance(IDENTITY_CACHE_MS + 1);
    await r.handle(NODE, report({ type: "turn-started" }));
    expect(resolveCalls).toBe(2);
  });

  test("a lookup that fails is not remembered as an answer", async () => {
    let fail = true;
    const r = relay({
      resolve: async () => {
        resolveCalls++;
        if (fail) throw new Error("db down");
        return resolved;
      },
    });
    expect(await r.handle(NODE, report({ type: "turn-started" }))).toBe("unknown-agent");
    fail = false;
    expect(await r.handle(NODE, report({ type: "turn-started" }))).toBe("applied");
    expect(resolveCalls).toBe(2);
  });

  test("one agent's reports apply in the order they came, however long the first lookup took", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const r = relay({
      resolve: async () => {
        if (first) {
          first = false;
          await gate;
        }
        return resolved;
      },
    });
    const a = r.handle(NODE, report({ type: "turn-started" }));
    const b = r.handle(NODE, report({ type: "step", title: "Read notes", completed: 0, total: 1 }));
    release();
    await Promise.all([a, b]);
    expect(noted.map((n) => n.event.type)).toEqual(["turn-started", "step"]);
  });
});

describe("what a report becomes — the bridge's own fleet events", () => {
  test("each event, in the agent's room, as the agent (its mxid keys the avatar), under the station's name, at the hub's time", async () => {
    const r = relay();
    await r.handle(NODE, report({ type: "turn-started" }, { at: now - 5_000 }));
    await r.handle(NODE, report({ type: "step", title: "Read notes", completed: 0, total: 1 }));
    await r.handle(NODE, report({ type: "turn-finished", total: 3, failed: 1, failedAt: 2 }));
    await r.handle(NODE, report({ type: "turn-finished", total: 0, failed: 0, errored: true }));
    expect(noted.map((n) => n.event)).toEqual([
      { type: "turn-started", roomId: ROOM, mxid: AGENT, name: "Echo", at: T0 },
      { type: "step", roomId: ROOM, mxid: AGENT, name: "Echo", title: "Read notes", completed: 0, total: 1, at: T0 },
      { type: "turn-finished", roomId: ROOM, mxid: AGENT, name: "Echo", total: 3, failed: 1, failedAt: 2, at: T0 },
      { type: "turn-finished", roomId: ROOM, mxid: AGENT, name: "Echo", total: 0, failed: 0, errored: true, at: T0 },
    ]);
  });

  test("an approval is the room's permission decision, answered in the room (no inline buttons)", async () => {
    const r = relay();
    await r.handle(NODE, report({ type: "decision-asked", eventId: "$prompt", question: "Run rm -rf build?" }));
    await r.handle(NODE, report({ type: "decision-cleared" }));
    expect(noted.map((n) => n.event)).toEqual([
      {
        type: "decision-asked",
        decision: {
          key: `perm:${ROOM}`,
          roomId: ROOM,
          eventId: "$prompt",
          agent: "Echo",
          kind: "permission",
          question: "Run rm -rf build?",
          options: [],
          askedAt: T0,
        },
      },
      { type: "decision-cleared", key: `perm:${ROOM}` },
    ]);
  });

  test("an answer is not a card event: it only tags its push", async () => {
    await relay().handle(NODE, report({ type: "answer", eventId: "$answer", total: 4, failed: 0 }));
    expect(noted).toHaveLength(0);
    expect(hubEventTurn("$answer")).toEqual({ total: 4, failed: 0 });
  });
});

// ─── The real fleet service behind the sink ──────────────────────────────────

describe("on the card — a plugin agent and a bridge agent, one reader", () => {
  const START = "a".repeat(64);
  let sends: ApnsSendInput[];
  let fleet: FleetService;

  beforeEach(async () => {
    sends = [];
    fleet = createFleetService({
      apns: {
        send: async (i) => {
          sends.push(i);
          return { status: "sent" };
        },
      },
      tokens: memoryLiveActivityTokenStore(),
      now: () => now,
      setTimer: () => () => {},
    });
    sink = fleet;
    await fleet.tokenRegistered({
      userId: OWNER,
      deviceId: "D1",
      kind: "start",
      activityId: null,
      token: START,
      environment: "sandbox",
    });
  });

  const content = () => (sends.at(-1)!.payload as any).aps["content-state"];

  test("a plugin turn starts the card, works through its steps, and ends done", async () => {
    const r = relay();
    await r.handle(NODE, report({ type: "turn-started" }));
    await fleet.settled();
    expect(sends).toHaveLength(1);
    expect((sends[0]!.payload as any).aps.event).toBe("start");
    expect(content().agents).toEqual([
      { roomId: ROOM, mxid: AGENT, name: "Echo", state: "working", phase: "thinking", since: Math.floor(T0 / 1000) },
    ]);

    await r.handle(NODE, report({ type: "step", title: "Read notes", completed: 0, total: 1 }));
    advance(42_000);
    await r.handle(NODE, report({ type: "turn-finished", total: 1, failed: 0 }));
    await fleet.settled();
    // Nothing is pushed to a started card until its update token arrives — the
    // planner's rule, unchanged; the state behind it is what this proves.
    await fleet.tokenRegistered({
      userId: OWNER,
      deviceId: "D1",
      kind: "update",
      activityId: "act-1",
      token: "b".repeat(64),
      environment: "sandbox",
    });
    await fleet.settled();
    expect(content().agents).toEqual([
      {
        roomId: ROOM,
        mxid: AGENT,
        name: "Echo",
        state: "done",
        completed: 1,
        total: 1,
        since: Math.floor(T0 / 1000),
        endedAt: Math.floor(T0 / 1000) + 42,
      },
    ]);
  });

  test("a plugin turn with a failed step ends failed, at that step", async () => {
    const r = relay();
    await r.handle(NODE, report({ type: "turn-started" }));
    await r.handle(NODE, report({ type: "turn-finished", total: 3, failed: 1, failedAt: 2 }));
    await fleet.settled();
    await fleet.tokenRegistered({
      userId: OWNER,
      deviceId: "D1",
      kind: "update",
      activityId: "act-1",
      token: "b".repeat(64),
      environment: "sandbox",
    });
    await fleet.settled();
    expect(content().agents[0]).toMatchObject({ state: "failed", step: "Failed at step 2 of 3", completed: 2, total: 3 });
  });

  test("bridge and plugin agents share the reader's one card", async () => {
    const BRIDGE_ROOM = "!lyra:id.agentpod.dev";
    // What outbound.ts does for a bridge turn: the same sink, the same reader.
    fleet.note(OWNER, { type: "turn-started", roomId: BRIDGE_ROOM, name: "Lyra", at: now });
    now += 1_000;
    await relay().handle(NODE, report({ type: "turn-started" }));
    await relay().handle(NODE, report({ type: "decision-asked", eventId: "$prompt", question: "Push to main?" }));
    await fleet.settled();
    await fleet.tokenRegistered({
      userId: OWNER,
      deviceId: "D1",
      kind: "update",
      activityId: "act-1",
      token: "b".repeat(64),
      environment: "sandbox",
    });
    await fleet.settled();
    const c = content();
    expect(c.agents.map((a: { name: string; state: string }) => [a.name, a.state])).toEqual([
      ["Echo", "needs_you"],
      ["Lyra", "working"],
    ]);
    expect(c.decision).toMatchObject({ roomId: ROOM, eventId: "$prompt", kind: "permission", question: "Push to main?", options: [] });
    expect(c.working).toBe(1);
    expect(c.needsYou).toBe(1);
  });
});

// ─── A5: the turn's counts on its answer's push ──────────────────────────────

describe("the answer's push carries the turn's counts, whichever arrives first", () => {
  const ANSWER = "$answer:id.agentpod.dev";
  let apnsSends: ApnsSendInput[];
  let decisions: PushDecision[];

  const gateway = () =>
    createPushGateway({
      apns: {
        send: async (i) => {
          apnsSends.push(i);
          return { status: "sent" };
        },
      },
      appIds: new Map([["dev.supermessage.ios", "production"]]),
      limiter: createPushkeyLimiter(60, 60_000),
      quietWaitMs: 2_000,
      onDecision: (d) => decisions.push(d),
    });

  const push = (eventId = ANSWER) =>
    gateway().notify({
      event_id: eventId,
      room_id: ROOM,
      devices: [{ app_id: "dev.supermessage.ios", pushkey: "c".repeat(64) }],
    });

  const turnOf = (i: number) => (apnsSends[i]!.payload as Record<string, unknown>).turn;

  async function untilWaiting() {
    for (let i = 0; i < 2_000 && _quietWaitersForTest(ROOM) === 0; i++) await Bun.sleep(1);
    expect(_quietWaitersForTest(ROOM)).toBe(1);
  }

  beforeEach(() => {
    apnsSends = [];
    decisions = [];
  });

  test("finish reported, then the push, then the answer's id: the push waits for it", async () => {
    const r = relay();
    await r.handle(NODE, report({ type: "turn-finished", total: 2, failed: 0 }));
    const pushed = push();
    await untilWaiting();
    await r.handle(NODE, report({ type: "answer", eventId: ANSWER, total: 2, failed: 0 }));
    await pushed;
    expect(turnOf(0)).toEqual({ total: 2, failed: 0 });
    expect(decisions[0]!.timing).toBe("known-after-wait");
    expect(quietSendsInFlight(ROOM)).toBe(0);
  });

  test("the answer's id reported before its push: attached at once", async () => {
    const r = relay();
    await r.handle(NODE, report({ type: "turn-finished", total: 5, failed: 2, failedAt: 1 }));
    await r.handle(NODE, report({ type: "answer", eventId: ANSWER, total: 5, failed: 2 }));
    await push();
    expect(turnOf(0)).toEqual({ total: 5, failed: 2 });
    expect(decisions[0]).toMatchObject({ timing: "known-before", waitedMs: 0 });
  });

  test("a push before any report goes at once, without counts — nothing is held on a guess", async () => {
    await push();
    expect(turnOf(0)).toBeUndefined();
    expect(decisions[0]).toMatchObject({ timing: "unknown", waitedMs: 0 });
  });

  test("a turn that ran no tools announces nothing, so its room's pushes are never held", async () => {
    await relay().handle(NODE, report({ type: "turn-finished", total: 0, failed: 0 }));
    expect(quietSendsInFlight(ROOM)).toBe(0);
  });

  test("an answer that is never reported stops holding the room's pushes after a while", async () => {
    await relay().handle(NODE, report({ type: "turn-finished", total: 2, failed: 0 }));
    expect(quietSendsInFlight(ROOM)).toBe(1);
    advance(ANSWER_ANNOUNCE_MS - 1);
    expect(quietSendsInFlight(ROOM)).toBe(1);
    advance(1);
    expect(quietSendsInFlight(ROOM)).toBe(0);
  });

  test("a second finished turn replaces the first's announcement rather than stacking on it", async () => {
    const r = relay();
    await r.handle(NODE, report({ type: "turn-finished", total: 2, failed: 0 }));
    await r.handle(NODE, report({ type: "turn-finished", total: 3, failed: 0 }));
    expect(quietSendsInFlight(ROOM)).toBe(1);
    await r.handle(NODE, report({ type: "answer", eventId: ANSWER, total: 3, failed: 0 }));
    expect(quietSendsInFlight(ROOM)).toBe(0);
  });

  test("an answer from someone else's report tags nothing", async () => {
    resolved = null;
    await relay().handle(NODE, report({ type: "answer", eventId: ANSWER, total: 3, failed: 0 }));
    expect(hubEventTurn(ANSWER)).toBeUndefined();
  });
});
