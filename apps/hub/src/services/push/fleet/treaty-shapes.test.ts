/**
 * The fleet Live Activity, held to treaty (treaty phase 2, ruling 7): `agentpod.live-activity`,
 * which this hub produces. The content state comes from the hub's own reducer (`state.ts`) over the
 * turns and decisions that change its shape, the payload from its planner (`planner.ts`) for each
 * kind of push, and each must validate against `schemas/agentpod/fleet-content-state.v1.json` and
 * `schemas/agentpod/live-activity-payload.v1.json` as the pinned treaty release publishes them.
 * The hub never validates either at runtime; this is where a drift from the contract shows.
 */
import { describe, expect, test } from "bun:test";
import type { FleetContentState } from "@agentpod/contract";
import { validatorFor } from "@superjackfruitlabs/treaty-contracts";
import { loadInstalledBundle } from "@superjackfruitlabs/treaty-contracts/node";

import { fitPayload, initialPlan, planPush, type PlanInput, type ReaderPlan } from "./planner";
import {
  applyFleetEvent,
  contentState,
  emptyFleet,
  inlineGateOptions,
  inlinePermissionOptions,
  type FleetEvent,
  type FleetState,
} from "./state";

const bundle = loadInstalledBundle();
const contentSchema = validatorFor(bundle, "schemas/agentpod/fleet-content-state.v1.json");
const payloadSchema = validatorFor(bundle, "schemas/agentpod/live-activity-payload.v1.json");

const T0 = 1_790_670_000_000;
const READER = "@owner:id.agentpod.dev";

function run(events: FleetEvent[]): FleetState {
  let state = emptyFleet();
  for (const e of events) state = applyFleetEvent(state, e).state;
  return state;
}

const started = (roomId: string, name: string, at: number): FleetEvent => ({ type: "turn-started", roomId, mxid: `@${name.toLowerCase()}:hs`, name, at });
const step = (roomId: string, name: string, title: string, completed: number, total: number, at: number): FleetEvent => ({
  type: "step",
  roomId,
  name,
  title,
  completed,
  total,
  at,
});

/** The fleets whose cards differ in shape, by what they show. */
const FLEETS: Record<string, FleetState> = {
  "a quiet fleet": emptyFleet(),
  "one agent starting a turn": run([started("!a:hs", "Lyra", T0)]),
  "one agent mid-turn with tool counts": run([started("!a:hs", "Lyra", T0), step("!a:hs", "Lyra", "Running the tests", 2, 5, T0 + 1_000)]),
  "a thinking agent with no tools yet": run([{ type: "thinking", roomId: "!a:hs", name: "Lyra", at: T0 }]),
  "a finished turn": run([started("!a:hs", "Lyra", T0), { type: "turn-finished", roomId: "!a:hs", name: "Lyra", total: 3, failed: 0, at: T0 + 5_000 }]),
  "a failed turn": run([
    started("!a:hs", "Lyra", T0),
    { type: "turn-finished", roomId: "!a:hs", name: "Lyra", total: 3, failed: 1, failedAt: 2, errored: true, at: T0 + 5_000 },
  ]),
  "a permission waiting on you": run([
    started("!r:hs", "Ray", T0),
    {
      type: "decision-asked",
      decision: {
        key: "perm:!r:hs",
        roomId: "!r:hs",
        eventId: "$perm",
        agent: "Ray",
        kind: "permission",
        question: "Run git push origin main?",
        options: inlinePermissionOptions([
          { optionId: "allow_once", name: "Allow once" },
          { optionId: "allow_always", name: "Allow always" },
          { optionId: "reject_once", name: "Reject" },
        ]),
        askedAt: T0 + 1_000,
      },
    },
  ]),
  "a gate waiting on you": run([
    {
      type: "decision-asked",
      decision: {
        key: "gate:gate_1",
        roomId: "!board:hs",
        eventId: "$gate",
        agent: "Release board",
        kind: "gate",
        question: "Approve the release notes?",
        options: inlineGateOptions([
          { id: "approve", label: "Approve" },
          { id: "request_changes", label: "Request changes with a much longer label than fits" },
        ]),
        askedAt: T0,
        boardId: "brd_1",
      },
    },
  ]),
  "a card waiting on a person, with no options": run([
    {
      type: "decision-asked",
      decision: {
        key: "attn:brd_1:crd_1:wait_1",
        roomId: "!board:hs",
        eventId: "$attn",
        agent: "Release board",
        kind: "attention",
        question: "The staging database is down",
        options: [],
        askedAt: T0,
        boardId: "brd_1",
      },
    },
  ]),
  "more agents than the card lists, with long names and steps": run(
    Array.from({ length: 9 }, (_, i) => [
      started(`!a${i}:hs`, `Agent number ${i} with a name far longer than the card allows`, T0 + i),
      step(`!a${i}:hs`, `Agent ${i}`, "s".repeat(200), i, 9, T0 + 100 + i),
    ]).flat(),
  ),
};

function input(content: FleetContentState, over: Partial<PlanInput> = {}): PlanInput {
  return {
    readerId: READER,
    now: T0 + 10_000,
    content,
    active: true,
    change: "important",
    endedOnFinish: false,
    expiryAt: null,
    tokens: { start: true, update: true },
    ...over,
  };
}

function expectValid(what: string, check: typeof contentSchema, body: unknown) {
  const result = check(body);
  expect({ what, errors: result.errors }).toEqual({ what, errors: [] });
}

describe("FleetContentState, as the hub's reducer builds it", () => {
  for (const [name, fleet] of Object.entries(FLEETS)) {
    test(name, () => {
      expectValid(name, contentSchema, contentState(fleet, T0 + 10_000));
    });
  }
});

const live = (): ReaderPlan => ({ ...initialPlan(), phase: "live" });

describe("the aps payload, for each push the planner makes", () => {
  for (const [name, fleet] of Object.entries(FLEETS)) {
    const content = contentState(fleet, T0 + 10_000);
    test(`${name}: start, update and end`, () => {
      const start = planPush(initialPlan(), input(content, { tokens: { start: true, update: false } })).push;
      const update = planPush(live(), input(content)).push;
      const end = planPush(live(), input(content, { active: false, endedOnFinish: true })).push;
      const pushes = [start, update, end].filter((p) => p !== null);
      expect(pushes.map((p) => p?.payload.aps.event)).toEqual(
        expect.arrayContaining(content.agents.length > 0 || content.decision ? ["update", "end"] : ["end"]),
      );
      for (const p of pushes) expectValid(`${name} ${p?.payload.aps.event}`, payloadSchema, p?.payload);
    });
  }

  test("a payload cut down to Apple's 4 KB is still the contract's", () => {
    const content = contentState(FLEETS["a permission waiting on you"] ?? emptyFleet(), T0 + 10_000);
    const huge = {
      ...content,
      decision: content.decision ? { ...content.decision, question: "q".repeat(5_000) } : undefined,
    } as FleetContentState;
    const fitted = fitPayload({ aps: { timestamp: 1, event: "update", "content-state": huge, "stale-date": 2 } });
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(4096);
    expectValid("fitted update", payloadSchema, fitted);
  });
});
