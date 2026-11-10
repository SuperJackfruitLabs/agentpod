/**
 * A superpipeline gate on the fleet Live Activity: posted → a decision for
 * each of the board's humans; answered, or gone from the board's pending
 * list → cleared; still pending after a hub restart → shown again.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setFleetSink } from "../push/fleet/sink";
import { gateDecisionRecord, noteGatePosted, reconcileBoardGates } from "./fleet-gates";
import type { GatePendingDelivery } from "./gates";

const HUMAN = "@rakesh:id.agentpod.dev";

function gate(gateId: string, over: Partial<GatePendingDelivery> = {}): GatePendingDelivery {
  return {
    event: "gate.pending",
    boardId: "brd_0123456789abcdef",
    cardId: "card_1",
    gateId,
    stageKey: "review",
    returnStageKey: "build",
    cardTitle: "Ship the widget",
    producedBy: "lyra",
    options: [
      { id: "approve", label: "Approve" },
      { id: "request_changes", label: "Request changes" },
      { id: "reject", label: "Reject" },
    ],
    ts: "2026-09-29T10:00:00Z",
    ...over,
  };
}

let noted: Array<{ reader: string; event: any }> = [];
let cleared: Array<{ boardId: string; ids: string[] }> = [];
let known = new Set<string>();

beforeEach(() => {
  noted = [];
  cleared = [];
  known = new Set();
  setFleetSink({
    note: (reader, event) => noted.push({ reader, event }),
    clearDecision: () => {},
    reconcileGates: (boardId, ids) => cleared.push({ boardId, ids: [...ids].sort() }),
    knowsDecision: (key) => known.has(key),
  });
});
afterEach(() => setFleetSink(null));

describe("a gate as the fleet's decision", () => {
  test("asks the card's question, as its producer, answerable inline by approve or reject", () => {
    expect(gateDecisionRecord(gate("g1"), { roomId: "!board:hs", eventId: "$legacy", proseEventId: "$prose" }, 5)).toEqual({
      key: "gate:g1",
      roomId: "!board:hs",
      eventId: "$prose",
      agent: "lyra",
      kind: "gate",
      question: 'Approve "Ship the widget"?',
      options: [
        { id: "approve", label: "Approve", declines: false },
        { id: "reject", label: "Reject", declines: true },
      ],
      askedAt: 5,
      boardId: "brd_0123456789abcdef",
    });
  });

  test("falls back to the gate's own event when it has no prose", () => {
    expect(gateDecisionRecord(gate("g1"), { roomId: "!b:hs", eventId: "$legacy", proseEventId: null }, 5).eventId).toBe("$legacy");
  });

  test("posted → noted for every human the board names", async () => {
    await noteGatePosted(gate("g1"), { roomId: "!b:hs", eventId: "$e", proseEventId: "$p" }, {
      humansFor: async () => [HUMAN, "@other:id.agentpod.dev"],
    });
    expect(noted.map((n) => [n.reader, n.event.type, n.event.decision.key])).toEqual([
      [HUMAN, "decision-asked", "gate:g1"],
      ["@other:id.agentpod.dev", "decision-asked", "gate:g1"],
    ]);
  });
});

describe("a board sweep", () => {
  test("clears what the board no longer lists, and brings back what the hub forgot", async () => {
    known.add("gate:g1");
    const lookedUp: string[] = [];
    await reconcileBoardGates("brd_0123456789abcdef", [gate("g1"), gate("g2"), gate("g3")], {
      humansFor: async () => [HUMAN],
      projectionFor: async (gateId) => {
        lookedUp.push(gateId);
        return gateId === "g2" ? { roomId: "!b:hs", eventId: "$e2", proseEventId: "$p2" } : null;
      },
    });
    expect(cleared).toEqual([{ boardId: "brd_0123456789abcdef", ids: ["g1", "g2", "g3"] }]);
    // g1 is already shown; g3 this hub never posted, so there is no event to answer.
    expect(lookedUp).toEqual(["g2", "g3"]);
    expect(noted.map((n) => n.event.decision.key)).toEqual(["gate:g2"]);
  });

  test("does nothing at all when no sink is installed", async () => {
    setFleetSink(null);
    let asked = 0;
    await reconcileBoardGates("brd_0123456789abcdef", [gate("g1")], {
      humansFor: async () => (asked++, [HUMAN]),
      projectionFor: async () => (asked++, null),
    });
    expect(asked).toBe(0);
  });
});
