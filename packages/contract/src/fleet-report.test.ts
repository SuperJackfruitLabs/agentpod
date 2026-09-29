import { describe, expect, it } from "bun:test";
import { GatewayClientMessage } from "./gateway";
import { FLEET_REPORT_MAX_AGE_MS, FleetReportMsg, FleetTurnReport } from "./fleet-report";
import { FLEET_QUESTION_MAX, FLEET_STEP_MAX } from "./fleet-live";
import { NodeCapabilityList } from "./posture";

/**
 * What an agent's own plugin (Hermes `agentpod-live`) tells its node about a
 * turn, so the hub's fleet Live Activity can show agents whose turns never
 * pass through the hub's ACP bridge.
 */
describe("FleetTurnReport — what a plugin writes to its node's fleet socket", () => {
  const base = {
    agent: "@agent_analyst-echo:id.agentpod.dev",
    roomId: "!abc:id.agentpod.dev",
    reader: "@rakesh:id.agentpod.dev",
    at: 1_790_000_000_000,
  };

  const events = [
    { type: "turn-started" },
    { type: "step", title: "Read notes.md", completed: 1, total: 2 },
    { type: "turn-finished", total: 7, failed: 1, failedAt: 4 },
    { type: "turn-finished", total: 0, failed: 0, errored: true },
    { type: "answer", eventId: "$answer:id.agentpod.dev", total: 7, failed: 1 },
    { type: "decision-asked", eventId: "$prompt", question: "Run rm -rf build?" },
    { type: "decision-cleared" },
  ];

  for (const event of events) {
    it(`parses ${event.type}${"errored" in event ? " (errored)" : ""}`, () => {
      const r = { ...base, event };
      expect(FleetTurnReport.parse(r)).toEqual(r);
    });
  }

  it("carries no more text than the card shows: a step title is at most the card's step", () => {
    const ok = { ...base, event: { type: "step", title: "x".repeat(FLEET_STEP_MAX), completed: 0, total: 1 } };
    expect(FleetTurnReport.safeParse(ok).success).toBe(true);
    const long = { ...base, event: { ...ok.event, title: "x".repeat(FLEET_STEP_MAX + 1) } };
    expect(FleetTurnReport.safeParse(long).success).toBe(false);
  });

  it("and a question at most the card's question", () => {
    const long = { ...base, event: { type: "decision-asked", eventId: "$e", question: "q".repeat(FLEET_QUESTION_MAX + 1) } };
    expect(FleetTurnReport.safeParse(long).success).toBe(false);
  });

  it("refuses anything it does not list — a report is not a place to carry more", () => {
    expect(FleetTurnReport.safeParse({ ...base, event: { type: "turn-started" }, text: "the answer" }).success).toBe(false);
    expect(FleetTurnReport.safeParse({ ...base, event: { type: "turn-started", text: "hi" } }).success).toBe(false);
    expect(FleetTurnReport.safeParse({ ...base, event: { type: "spoke" } }).success).toBe(false);
  });

  it("refuses ids that are not Matrix ids", () => {
    const e = { type: "turn-started" };
    expect(FleetTurnReport.safeParse({ ...base, agent: "agent", event: e }).success).toBe(false);
    expect(FleetTurnReport.safeParse({ ...base, reader: "rakesh", event: e }).success).toBe(false);
    expect(FleetTurnReport.safeParse({ ...base, roomId: "#alias:hs", event: e }).success).toBe(false);
    expect(
      FleetTurnReport.safeParse({ ...base, event: { type: "answer", eventId: "answer", total: 1, failed: 0 } }).success
    ).toBe(false);
  });

  it("bounds the counts", () => {
    const e = (total: number, failed: number) => ({ ...base, event: { type: "turn-finished", total, failed } });
    expect(FleetTurnReport.safeParse(e(-1, 0)).success).toBe(false);
    expect(FleetTurnReport.safeParse(e(1.5, 0)).success).toBe(false);
    expect(FleetTurnReport.safeParse(e(100_000, 0)).success).toBe(false);
  });

  it("is stale after two minutes — a report queued through a hub outage is history, not news", () => {
    expect(FLEET_REPORT_MAX_AGE_MS).toBe(120_000);
  });
});

describe("FleetReportMsg — the frame the node wraps a report in", () => {
  const report = {
    agent: "@agent_x:hs",
    roomId: "!r:hs",
    reader: "@me:hs",
    at: 1,
    event: { type: "turn-started" },
  };

  it("is a client message the hub's gateway parses", () => {
    const msg = { type: "fleet.report", report };
    expect(FleetReportMsg.parse(msg)).toEqual(msg);
    expect(GatewayClientMessage.parse(msg)).toEqual(msg);
  });

  it("is refused whole when the report is malformed, so the gateway drops it", () => {
    expect(GatewayClientMessage.safeParse({ type: "fleet.report", report: { ...report, agent: "" } }).success).toBe(false);
  });

  it("is advertised by a node as the fleet.reports capability", () => {
    expect(NodeCapabilityList.parse(["fleet.reports", "turn.errors"])).toEqual(["fleet.reports", "turn.errors"]);
  });
});
