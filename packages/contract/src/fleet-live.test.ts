import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  FLEET_AGENTS_MAX,
  FLEET_DECISION_OPTIONS_MAX,
  FLEET_QUESTION_MAX,
  FLEET_STEP_MAX,
  FleetContentState,
  LIVE_ACTIVITY_PAYLOAD_MAX_BYTES,
  LiveActivityPushPayload,
} from "./fleet-live";

/** The file the app decodes too — copied byte for byte into supermessage. */
const FIXTURE = join(import.meta.dir, "../fixtures/fleet-content-state.json");
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));

describe("FleetContentState — the Live Activity's content, shared with the app", () => {
  it("round-trips the shared fixture unchanged", () => {
    const parsed = FleetContentState.parse(fixture);
    expect(parsed).toEqual(fixture);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(fixture);
  });

  it("keeps the key order and spelling the app decodes (camelCase)", () => {
    expect(Object.keys(fixture)).toEqual(["agents", "more", "decision", "needsYou", "working", "updatedAt"]);
    expect(Object.keys(fixture.agents[1])).toEqual(["roomId", "name", "state", "step", "completed", "total", "since"]);
  });

  it("treats a missing optional key as none", () => {
    const bare = { agents: [{ roomId: "!r:hs", name: "Lyra", state: "active", since: 1 }], more: 0, needsYou: 0, working: 0, updatedAt: 2 };
    expect(FleetContentState.parse(bare)).toEqual(bare);
  });

  it("refuses what the hub must never send: out-of-bounds text, extra agents, extra options, unknown keys", () => {
    const agent = fixture.agents[1];
    const over = (patch: Record<string, unknown>) => FleetContentState.safeParse({ ...fixture, ...patch }).success;
    expect(over({ agents: [{ ...agent, step: "x".repeat(FLEET_STEP_MAX + 1) }] })).toBe(false);
    expect(over({ agents: Array.from({ length: FLEET_AGENTS_MAX + 1 }, () => agent) })).toBe(false);
    expect(over({ decision: { ...fixture.decision, question: "q".repeat(FLEET_QUESTION_MAX + 1) } })).toBe(false);
    expect(
      over({ decision: { ...fixture.decision, options: Array.from({ length: FLEET_DECISION_OPTIONS_MAX + 1 }, () => fixture.decision.options[0]) } })
    ).toBe(false);
    expect(over({ agents: [{ ...agent, state: "sleeping" }] })).toBe(false);
    expect(over({ secret: "x" })).toBe(false);
  });

  it("counts a bound in characters, not UTF-16 units", () => {
    const agent = { ...fixture.agents[1], step: "🔧".repeat(FLEET_STEP_MAX) };
    expect(FleetContentState.safeParse({ ...fixture, agents: [agent] }).success).toBe(true);
  });
});

describe("LiveActivityPushPayload — the three shapes APNs gets", () => {
  const cs = fixture;

  it("accepts start, update and end", () => {
    const start = {
      aps: {
        timestamp: 1790670123,
        event: "start",
        "attributes-type": "FleetActivityAttributes",
        attributes: { readerId: "@owner:hs" },
        "content-state": cs,
        alert: { title: "Research Ray", body: "Run git push origin main?" },
      },
    };
    const update = { aps: { timestamp: 1790670124, event: "update", "content-state": cs, "stale-date": 1790671024 } };
    const end = { aps: { timestamp: 1790670125, event: "end", "content-state": cs, "dismissal-date": 1790670245 } };
    for (const p of [start, update, end]) expect(LiveActivityPushPayload.parse(p)).toEqual(p as never);
  });

  it("refuses unknown fields", () => {
    expect(
      LiveActivityPushPayload.safeParse({ aps: { timestamp: 1, event: "update", "content-state": cs, sound: "default" } }).success
    ).toBe(false);
    expect(LiveActivityPushPayload.safeParse({ aps: { timestamp: 1, event: "update", "content-state": cs }, body: "x" }).success).toBe(
      false
    );
  });

  it("has a 4 KB ceiling", () => {
    expect(LIVE_ACTIVITY_PAYLOAD_MAX_BYTES).toBe(4096);
  });
});
