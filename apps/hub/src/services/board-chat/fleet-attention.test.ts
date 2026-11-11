/**
 * A waiting card on the fleet Live Activity: posted → a decision for each of the board's humans,
 * with no inline options; answered, or gone from the board's waiting list → cleared; still waiting
 * after a hub restart → shown again.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setFleetSink } from "../push/fleet/sink";
import type { FleetEvent } from "../push/fleet/state";
import {
  attentionDecisionRecord,
  clearAttentionDecision,
  noteAttentionPosted,
  reconcileBoardAttention,
} from "./fleet-attention";
import type { AttentionPendingDelivery } from "@superjackfruitlabs/treaty-matrix-events";

const HUMAN = "@person:id.example";

function waiting(waitId: string, over: Partial<AttentionPendingDelivery> = {}): AttentionPendingDelivery {
  return {
    event: "attention.pending",
    boardId: "brd_1",
    boardName: "Release board",
    cardId: "crd_1",
    cardTitle: "Ship the release",
    stageKey: "build",
    stageName: "Build",
    waitId,
    reason: "blocked",
    options: [{ id: "archive", label: "Archive" }],
    ...over,
  };
}

let noted: Array<{ reader: string; event: FleetEvent }> = [];
let reconciled: Array<{ kind: string; boardId: string; keys: string[] }> = [];
let clearedKeys: string[] = [];
let known = new Set<string>();

beforeEach(() => {
  noted = [];
  reconciled = [];
  clearedKeys = [];
  known = new Set();
  setFleetSink({
    note: (reader, event) => noted.push({ reader, event }),
    clearDecision: (key) => clearedKeys.push(key),
    reconcileGates: () => {},
    reconcileBoardDecisions: (kind, boardId, keys) => reconciled.push({ kind, boardId, keys: [...keys].toSorted() }),
    knowsDecision: (key) => known.has(key),
  });
});
afterEach(() => setFleetSink(null));

describe("a waiting card as the fleet's decision", () => {
  test("says why the card waits, from its board, with no inline answers", () => {
    expect(attentionDecisionRecord(waiting("w1"), { roomId: "!b:hs", eventId: "$e" }, 5)).toEqual({
      key: "attn:brd_1:crd_1:w1",
      roomId: "!b:hs",
      eventId: "$e",
      agent: "Release board",
      kind: "attention",
      question: '"Ship the release" is blocked',
      options: [],
      askedAt: 5,
      boardId: "brd_1",
    });
    expect(attentionDecisionRecord(waiting("w1", { reason: "repeated-failure", boardName: null }), { roomId: "!b:hs", eventId: "$e" }, 5)).toMatchObject({
      agent: "Build",
      question: '"Ship the release" keeps failing',
    });
  });

  test("posted → noted for every human the board names; answered → cleared by its key", async () => {
    await noteAttentionPosted(waiting("w1"), { roomId: "!b:hs", eventId: "$e" }, { humansFor: async () => [HUMAN, "@other:id.example"] });
    expect(noted.map((n) => [n.reader, n.event.type, n.event.type === "decision-asked" ? n.event.decision.key : null])).toEqual([
      [HUMAN, "decision-asked", "attn:brd_1:crd_1:w1"],
      ["@other:id.example", "decision-asked", "attn:brd_1:crd_1:w1"],
    ]);
    clearAttentionDecision({ boardId: "brd_1", cardId: "crd_1", waitId: "w1" });
    expect(clearedKeys).toEqual(["attn:brd_1:crd_1:w1"]);
  });

  test("a sweep closes the waits the board no longer lists, and shows again the ones a restart forgot", async () => {
    known.add("attn:brd_1:crd_1:w1");
    await reconcileBoardAttention("brd_1", [waiting("w1"), waiting("w2", { cardId: "crd_2" }), waiting("w3", { cardId: "crd_3" })], {
      humansFor: async () => [HUMAN],
      postedFor: async (k) => (k.waitId === "w2" ? { roomId: "!b:hs", eventId: "$e2" } : null),
    });
    expect(reconciled).toEqual([{ kind: "attention", boardId: "brd_1", keys: ["attn:brd_1:crd_1:w1", "attn:brd_1:crd_2:w2", "attn:brd_1:crd_3:w3"] }]);
    expect(noted.map((n) => (n.event.type === "decision-asked" ? n.event.decision.key : null))).toEqual(["attn:brd_1:crd_2:w2"]);
  });

  test("with no fleet card installed, nothing is looked up", async () => {
    setFleetSink(null);
    let asked = false;
    await noteAttentionPosted(waiting("w1"), { roomId: "!b:hs", eventId: "$e" }, {
      humansFor: async () => {
        asked = true;
        return [];
      },
    });
    expect(asked).toBe(false);
  });
});
