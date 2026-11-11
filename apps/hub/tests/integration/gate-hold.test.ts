/**
 * An approval may wait for its release time (charter: "An approval may wait for its release time"
 * §7), against the database: a held approval's release or pull-back becomes one reply to the gate's
 * card, in that tenant's board room only, and a redelivered push posts nothing twice.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { db } from "../../src/db/drizzle";
import { matrixBoardRooms } from "../../src/db/schema/board-rooms";
import { matrixGateEvents, matrixGateHoldNotices } from "../../src/db/schema/matrix";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import type { DecisionPulledBackDelivery, DecisionReleasedDelivery } from "../../src/services/bridge";
import { handleDecisionPulledBack, handleDecisionReleased, type GateHoldDeps } from "../../src/services/board-chat/gate-hold";
import { DECISION_PULLED_BACK_TYPE, DECISION_RELEASED_TYPE } from "@superjackfruitlabs/treaty-matrix-events";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const BOARD = "brd_hold000000000001";
const OTHER_BOARD = "brd_hold000000000002";
const ROOM = "!holdroom:test";
const SPEAKER = "@agent_superpipeline:test";
const CARD = "crd_hold01";
const GATE = "gate_hold01";
const GATE_EVENT = "$gate-legacy";
const PROSE_EVENT = "$gate-prose";
const BOARDS = [BOARD, OTHER_BOARD];

const released = (over: Partial<DecisionReleasedDelivery> = {}): DecisionReleasedDelivery => ({
  event: "decision.released",
  boardId: BOARD,
  cardId: CARD,
  gateId: GATE,
  decision: "approve",
  releaseAt: "2026-11-16T09:00:00.000Z",
  releasedAt: "2026-11-16T09:03:00.000Z",
  outcome: "released",
  ...over,
});

const pulled = (over: Partial<DecisionPulledBackDelivery> = {}): DecisionPulledBackDelivery => ({
  event: "decision.pulled_back",
  boardId: BOARD,
  cardId: CARD,
  gateId: GATE,
  pulledBackBy: "prn_rakesh",
  at: "2026-11-16T08:40:00.000Z",
  comment: "wrong image",
  ...over,
});

function fakeDeps(over: Partial<GateHoldDeps> = {}) {
  const texts: Array<{ userId: string; roomId: string; body: string; extra?: Record<string, unknown> }> = [];
  const events: Array<{ userId: string; roomId: string; type: string; content: Record<string, unknown> }> = [];
  const deps: GateHoldDeps = {
    sendText: async (userId, roomId, body, extra) => {
      texts.push({ userId, roomId, body, ...(extra ? { extra } : {}) });
      return `$hold${texts.length}`;
    },
    sendCustomEvent: async (userId, roomId, type, content) => {
      events.push({ userId, roomId, type, content });
      return `$hold-event${events.length}`;
    },
    displayNameFor: async (id) => (id === "prn_rakesh" ? "rakesh" : null),
    tenantsForBoard: async () => [BOOTSTRAP_TENANT_ID],
    ...over,
  };
  return { deps, texts, events };
}

async function clean() {
  await db.delete(matrixGateHoldNotices).where(inArray(matrixGateHoldNotices.gateId, [GATE, "gate_hold02"]));
  await db.delete(matrixGateEvents).where(inArray(matrixGateEvents.boardId, BOARDS));
  await db.delete(matrixBoardRooms).where(inArray(matrixBoardRooms.boardId, BOARDS));
}

beforeAll(async () => {
  await ensurePgMigrations();
});

beforeEach(async () => {
  await clean();
  await db.insert(matrixBoardRooms).values({ boardId: BOARD, roomId: ROOM, tenantId: BOOTSTRAP_TENANT_ID, speakerMxid: SPEAKER, alias: "agentpod_board_hold" });
  // A held approval's card: settled (its receipt said "goes ahead after …"), which is not a reason
  // to stay quiet here, unlike a quorum gate's progress.
  await db.insert(matrixGateEvents).values({
    gateId: GATE,
    tenantId: BOOTSTRAP_TENANT_ID,
    boardId: BOARD,
    cardId: CARD,
    roomId: ROOM,
    eventId: GATE_EVENT,
    proseEventId: PROSE_EVENT,
    outcomePostedAt: new Date(),
  });
});

afterAll(clean);

describe("a held approval released", () => {
  test("is one reply to the gate's card, and one structured event referencing the gate", async () => {
    const { deps, texts, events } = fakeDeps();
    expect(await handleDecisionReleased(released(), deps)).toEqual({ status: "sent" });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ userId: SPEAKER, roomId: ROOM, body: "Released — it went ahead." });
    expect(texts[0]?.extra?.["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: PROSE_EVENT } });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(DECISION_RELEASED_TYPE);
    expect(events[0]?.content).toEqual({
      suite_event_type: DECISION_RELEASED_TYPE,
      schema_version: 1,
      gate_id: GATE,
      board_id: BOARD,
      card_id: CARD,
      outcome: "released",
      released_at: "2026-11-16T09:03:00.000Z",
      "m.relates_to": { rel_type: "m.reference", event_id: GATE_EVENT },
    });
    const [row] = await db.select().from(matrixGateHoldNotices).where(eq(matrixGateHoldNotices.gateId, GATE));
    expect(row).toMatchObject({ notice: "released", tenantId: BOOTSTRAP_TENANT_ID, eventId: "$hold1" });
  });

  test("blocked, says why", async () => {
    const { deps, texts, events } = fakeDeps();
    await handleDecisionReleased(released({ outcome: "blocked", reason: "the approved subject expired" }), deps);
    expect(texts[0]?.body).toBe("Did not go ahead: the approved subject expired.");
    expect(events[0]?.content).toMatchObject({ outcome: "blocked", reason: "the approved subject expired" });
  });

  test("a redelivered push posts nothing twice", async () => {
    const { deps, texts, events } = fakeDeps();
    expect(await handleDecisionReleased(released(), deps)).toEqual({ status: "sent" });
    expect(await handleDecisionReleased(released(), deps)).toEqual({ status: "duplicate" });
    expect(texts).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  test("a send that fails gives the claim back, so the board's retry posts it", async () => {
    const failing = fakeDeps({
      sendText: async () => {
        throw new Error("homeserver down");
      },
    });
    await expect(handleDecisionReleased(released(), failing.deps)).rejects.toThrow("homeserver down");
    const { deps, texts } = fakeDeps();
    expect(await handleDecisionReleased(released(), deps)).toEqual({ status: "sent" });
    expect(texts).toHaveLength(1);
  });

  test("a structured half that fails keeps the claim: the prose is in the room", async () => {
    const { deps, texts } = fakeDeps({
      sendCustomEvent: async () => {
        throw new Error("nope");
      },
    });
    expect(await handleDecisionReleased(released(), deps)).toEqual({ status: "sent" });
    expect(await handleDecisionReleased(released(), fakeDeps().deps)).toEqual({ status: "duplicate" });
    expect(texts).toHaveLength(1);
  });
});

describe("a held approval pulled back", () => {
  test("is one reply naming who and why, and a structured event with their handle, never their id", async () => {
    const { deps, texts, events } = fakeDeps();
    expect(await handleDecisionPulledBack(pulled(), deps)).toEqual({ status: "sent" });
    expect(texts).toHaveLength(1);
    expect(texts[0]?.body).toBe("Pulled back by rakesh — returned for changes: wrong image");
    expect(texts[0]?.extra?.["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: PROSE_EVENT } });
    expect(events[0]?.type).toBe(DECISION_PULLED_BACK_TYPE);
    expect(events[0]?.content).toEqual({
      suite_event_type: DECISION_PULLED_BACK_TYPE,
      schema_version: 1,
      gate_id: GATE,
      board_id: BOARD,
      card_id: CARD,
      pulled_back_by: "rakesh",
      comment: "wrong image",
      at: "2026-11-16T08:40:00.000Z",
      "m.relates_to": { rel_type: "m.reference", event_id: GATE_EVENT },
    });
  });

  test("a person this hub cannot name is left out", async () => {
    const { deps, texts, events } = fakeDeps({ displayNameFor: async () => null });
    await handleDecisionPulledBack(pulled(), deps);
    expect(texts[0]?.body).toBe("Pulled back — returned for changes: wrong image");
    expect(events[0]?.content.pulled_back_by).toBeNull();
    expect(JSON.stringify(events[0]?.content)).not.toContain("prn_rakesh");
  });

  test("a redelivered push posts nothing twice, and is claimed apart from a release", async () => {
    const { deps, texts } = fakeDeps();
    expect(await handleDecisionPulledBack(pulled(), deps)).toEqual({ status: "sent" });
    expect(await handleDecisionPulledBack(pulled(), deps)).toEqual({ status: "duplicate" });
    expect(texts).toHaveLength(1);
    const rows = await db.select().from(matrixGateHoldNotices).where(eq(matrixGateHoldNotices.gateId, GATE));
    expect(rows.map((r) => r.notice)).toEqual(["pulled_back"]);
  });
});

describe("nothing is said", () => {
  test("for a gate this hub never posted", async () => {
    const { deps, texts } = fakeDeps();
    expect(await handleDecisionReleased(released({ gateId: "gate_hold02" }), deps)).toEqual({ status: "unknown-card" });
    expect(await handleDecisionPulledBack(pulled({ gateId: "gate_hold02" }), deps)).toEqual({ status: "unknown-card" });
    expect(texts).toHaveLength(0);
  });

  test("for a gate on another board or card than the push names", async () => {
    const { deps, texts } = fakeDeps();
    expect(await handleDecisionReleased(released({ boardId: OTHER_BOARD }), deps)).toEqual({ status: "unknown-card" });
    expect(await handleDecisionPulledBack(pulled({ cardId: "crd_other" }), deps)).toEqual({ status: "unknown-card" });
    expect(texts).toHaveLength(0);
  });

  test("for a board known to no tenant, or to several", async () => {
    const none = fakeDeps({ tenantsForBoard: async () => [] });
    expect(await handleDecisionReleased(released(), none.deps)).toEqual({ status: "unknown-board" });
    const two = fakeDeps({ tenantsForBoard: async () => [BOOTSTRAP_TENANT_ID, "fleet_other"] });
    expect(await handleDecisionPulledBack(pulled(), two.deps)).toEqual({ status: "ambiguous-board" });
    expect(none.texts).toHaveLength(0);
    expect(two.texts).toHaveLength(0);
  });

  test("for a gate this hub posted for another tenant than the board's", async () => {
    const { deps, texts } = fakeDeps({ tenantsForBoard: async () => ["fleet_other"] });
    expect(await handleDecisionReleased(released(), deps)).toEqual({ status: "unknown-card" });
    expect(await handleDecisionPulledBack(pulled(), deps)).toEqual({ status: "unknown-card" });
    expect(texts).toHaveLength(0);
  });

  test("for a gate whose card is still being sent", async () => {
    await db.update(matrixGateEvents).set({ eventId: `pending:${GATE}` }).where(eq(matrixGateEvents.gateId, GATE));
    const { deps, texts } = fakeDeps();
    expect(await handleDecisionReleased(released(), deps)).toEqual({ status: "unknown-card" });
    expect(texts).toHaveLength(0);
  });

  test("for a card that is not in its board's room", async () => {
    await db.update(matrixGateEvents).set({ roomId: "!elsewhere:test" }).where(eq(matrixGateEvents.gateId, GATE));
    const { deps, texts } = fakeDeps();
    expect(await handleDecisionReleased(released(), deps)).toEqual({ status: "no-room" });
    expect(await handleDecisionPulledBack(pulled(), deps)).toEqual({ status: "no-room" });
    expect(texts).toHaveLength(0);
  });

  test("for a push that is not well formed", async () => {
    const { deps, texts } = fakeDeps();
    expect(await handleDecisionReleased(released({ releasedAt: "soon" }), deps)).toEqual({ status: "malformed" });
    expect(await handleDecisionPulledBack(pulled({ comment: " " }), deps)).toEqual({ status: "malformed" });
    expect(texts).toHaveLength(0);
  });
});
