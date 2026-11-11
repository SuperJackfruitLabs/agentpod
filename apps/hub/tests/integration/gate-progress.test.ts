/**
 * A gate may need more than one approver (charter: "A gate may need more than one approver" §7),
 * against the database: each approval short of the quorum becomes one progress reply to the gate's
 * card, in that tenant's board room only, the stored quorum follows the board, a redelivered push
 * posts nothing twice, and a gate projected with a quorum is not reported passed by an approval the
 * board only recorded.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { db } from "../../src/db/drizzle";
import { matrixBoardRooms } from "../../src/db/schema/board-rooms";
import { matrixGateApprovals, matrixGateEvents } from "../../src/db/schema/matrix";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import type { GateApprovalRecordedDelivery, GatePendingDelivery } from "../../src/services/bridge";
import { handleGateApprovalRecorded, type GateProgressDeps } from "../../src/services/board-chat/gate-progress";
import { GATE_PROGRESS_TYPE } from "@superjackfruitlabs/treaty-matrix-events";
import { projectGate } from "../../src/services/board-chat/gate-projection";
import { projectionForGate } from "../../src/services/board-chat/gate-reads";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const BOARD = "brd_quorum0000000001";
const OTHER_BOARD = "brd_quorum0000000002";
const ROOM = "!quorumroom:test";
const SPEAKER = "@agent_superpipeline:test";
const CARD = "crd_quorum01";
const GATE = "gate_quorum01";
const GATE_EVENT = "$gate-legacy";
const PROSE_EVENT = "$gate-prose";
const BOARDS = [BOARD, OTHER_BOARD];
const AT1 = "2026-11-09T10:00:00.000Z";
const AT2 = "2026-11-09T10:05:00.000Z";

const recorded = (over: Partial<GateApprovalRecordedDelivery> = {}): GateApprovalRecordedDelivery => ({
  event: "gate.approval_recorded",
  boardId: BOARD,
  cardId: CARD,
  gateId: GATE,
  approval: { principalId: "prn_first", at: AT1 },
  quorum: { required: 3, from: "admins", approvals: [{ principalId: "prn_first", at: AT1 }] },
  ...over,
});

function fakeDeps(over: Partial<GateProgressDeps> = {}) {
  const texts: Array<{ userId: string; roomId: string; body: string; extra?: Record<string, unknown> }> = [];
  const events: Array<{ userId: string; roomId: string; type: string; content: Record<string, unknown> }> = [];
  const deps: GateProgressDeps = {
    sendText: async (userId, roomId, body, extra) => {
      texts.push({ userId, roomId, body, ...(extra ? { extra } : {}) });
      return `$progress${texts.length}`;
    },
    sendCustomEvent: async (userId, roomId, type, content) => {
      events.push({ userId, roomId, type, content });
      return `$progress-event${events.length}`;
    },
    displayNameFor: async (id) => (id === "prn_first" ? "rakesh" : id === "prn_second" ? "asha" : null),
    tenantsForBoard: async () => [BOOTSTRAP_TENANT_ID],
    ...over,
  };
  return { deps, texts, events };
}

async function clean() {
  await db.delete(matrixGateApprovals).where(inArray(matrixGateApprovals.gateId, [GATE, "gate_quorum02"]));
  await db.delete(matrixGateEvents).where(inArray(matrixGateEvents.boardId, BOARDS));
  await db.delete(matrixBoardRooms).where(inArray(matrixBoardRooms.boardId, BOARDS));
}

beforeAll(async () => {
  await ensurePgMigrations();
});

beforeEach(async () => {
  await clean();
  await db.insert(matrixBoardRooms).values({ boardId: BOARD, roomId: ROOM, tenantId: BOOTSTRAP_TENANT_ID, speakerMxid: SPEAKER, alias: "agentpod_board_quorum" });
  await db.insert(matrixGateEvents).values({
    gateId: GATE,
    tenantId: BOOTSTRAP_TENANT_ID,
    boardId: BOARD,
    cardId: CARD,
    roomId: ROOM,
    eventId: GATE_EVENT,
    proseEventId: PROSE_EVENT,
    approvalQuorum: { required: 3, from: "admins", approvals: [] },
  });
});

afterAll(clean);

const storedQuorum = async () =>
  (await db.select({ q: matrixGateEvents.approvalQuorum }).from(matrixGateEvents).where(eq(matrixGateEvents.gateId, GATE)))[0]?.q;

describe("an approval short of the quorum", () => {
  test("is one reply to the gate's card, and one progress event referencing the gate", async () => {
    const { deps, texts, events } = fakeDeps();
    expect(await handleGateApprovalRecorded(recorded(), deps)).toEqual({ status: "sent" });

    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ userId: SPEAKER, roomId: ROOM, body: "Approved by rakesh — 1 of 3. Waiting for 2 more." });
    expect(texts[0]?.extra?.["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: PROSE_EVENT } });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(GATE_PROGRESS_TYPE);
    expect(events[0]?.content).toMatchObject({
      suite_event_type: GATE_PROGRESS_TYPE,
      gate_id: GATE,
      board_id: BOARD,
      approved_by: "rakesh",
      quorum: { required: 3, from: "admins", approvals: [{ principal_id: "prn_first", at: AT1 }] },
      "m.relates_to": { rel_type: "m.reference", event_id: GATE_EVENT },
    });
  });

  test("updates the stored quorum to what the board reported", async () => {
    const { deps } = fakeDeps();
    await handleGateApprovalRecorded(recorded(), deps);
    expect(await storedQuorum()).toEqual({ required: 3, from: "admins", approvals: [{ principal_id: "prn_first", at: AT1 }] });

    // A late redelivery of the first approval does not walk the record back past the second.
    const second = recorded({
      approval: { principalId: "prn_second", at: AT2 },
      quorum: { required: 3, from: "admins", approvals: [{ principalId: "prn_first", at: AT1 }, { principalId: "prn_second", at: AT2 }] },
    });
    await handleGateApprovalRecorded(second, deps);
    await handleGateApprovalRecorded(recorded(), deps);
    expect((await storedQuorum())?.approvals).toHaveLength(2);
  });

  test("a redelivered push posts nothing twice", async () => {
    const { deps, texts, events } = fakeDeps();
    expect(await handleGateApprovalRecorded(recorded(), deps)).toEqual({ status: "sent" });
    expect(await handleGateApprovalRecorded(recorded(), deps)).toEqual({ status: "duplicate" });
    expect(texts).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  test("a send that fails gives the claim back, so the board's retry posts it", async () => {
    const failing = fakeDeps({
      sendText: async () => {
        throw new Error("homeserver down");
      },
    });
    await expect(handleGateApprovalRecorded(recorded(), failing.deps)).rejects.toThrow("homeserver down");
    const { deps, texts } = fakeDeps();
    expect(await handleGateApprovalRecorded(recorded(), deps)).toEqual({ status: "sent" });
    expect(texts).toHaveLength(1);
  });

  test("names the variant chosen on a variant gate, counting only that variant", async () => {
    await db
      .update(matrixGateEvents)
      .set({
        approvalVariants: [
          { id: "short", label: "Short", subject_id: "aps_1", digest: "sha256:1", preview_complete: true, expires_at: null },
          { id: "long", label: "Long form", subject_id: "aps_2", digest: "sha256:2", preview_complete: true, expires_at: null },
        ],
      })
      .where(eq(matrixGateEvents.gateId, GATE));
    const { deps, texts, events } = fakeDeps();
    const push = recorded({
      approval: { principalId: "prn_second", at: AT2, variantId: "long" },
      quorum: {
        required: 2,
        from: "deciders",
        approvals: [
          { principalId: "prn_first", at: AT1, variantId: "short" },
          { principalId: "prn_second", at: AT2, variantId: "long" },
        ],
      },
    });
    expect(await handleGateApprovalRecorded(push, deps)).toEqual({ status: "sent" });
    expect(texts[0]?.body).toBe('Approved "Long form" by asha — 1 of 2. Waiting for 1 more.');
    expect(events[0]?.content).toMatchObject({ chosen_variant: { id: "long", label: "Long form" } });
  });
});

describe("nothing is said", () => {
  test("for a gate this hub never posted", async () => {
    const { deps, texts } = fakeDeps();
    expect(await handleGateApprovalRecorded(recorded({ gateId: "gate_quorum02" }), deps)).toEqual({ status: "unknown-card" });
    expect(texts).toHaveLength(0);
  });

  test("for a gate on another board or card than the push names", async () => {
    const { deps, texts } = fakeDeps();
    expect(await handleGateApprovalRecorded(recorded({ boardId: OTHER_BOARD }), deps)).toEqual({ status: "unknown-card" });
    expect(await handleGateApprovalRecorded(recorded({ cardId: "crd_other" }), deps)).toEqual({ status: "unknown-card" });
    expect(texts).toHaveLength(0);
  });

  test("for a gate already settled", async () => {
    await db.update(matrixGateEvents).set({ outcomePostedAt: new Date() }).where(eq(matrixGateEvents.gateId, GATE));
    const { deps, texts } = fakeDeps();
    expect(await handleGateApprovalRecorded(recorded(), deps)).toEqual({ status: "settled" });
    expect(texts).toHaveLength(0);
  });

  test("for a board known to no tenant, or to several", async () => {
    const none = fakeDeps({ tenantsForBoard: async () => [] });
    expect(await handleGateApprovalRecorded(recorded(), none.deps)).toEqual({ status: "unknown-board" });
    const two = fakeDeps({ tenantsForBoard: async () => [BOOTSTRAP_TENANT_ID, "fleet_other"] });
    expect(await handleGateApprovalRecorded(recorded(), two.deps)).toEqual({ status: "ambiguous-board" });
    expect(none.texts).toHaveLength(0);
    expect(two.texts).toHaveLength(0);
  });

  test("for a gate whose card is still being sent", async () => {
    await db.update(matrixGateEvents).set({ eventId: `pending:${GATE}` }).where(eq(matrixGateEvents.gateId, GATE));
    const { deps, texts } = fakeDeps();
    expect(await handleGateApprovalRecorded(recorded(), deps)).toEqual({ status: "unknown-card" });
    expect(texts).toHaveLength(0);
  });
});

describe("a quorum gate projected", () => {
  test("records its quorum, which the decision path reads back", async () => {
    await db.delete(matrixGateEvents).where(eq(matrixGateEvents.gateId, GATE));
    const d: GatePendingDelivery = {
      event: "gate.pending",
      boardId: BOARD,
      cardId: CARD,
      gateId: GATE,
      stageKey: "release",
      returnStageKey: "build",
      cardTitle: "Ship the release",
      producedBy: "agt_31d0",
      options: [{ id: "approve", label: "Approve", meaning: "approve", needsComment: false }],
      quorum: { required: 2, from: "deciders", approvals: [] },
      ts: AT1,
    };
    const outcome = await projectGate(BOOTSTRAP_TENANT_ID, d, {
      domain: "test",
      boardRoom: async () => ({ roomId: ROOM, speakerMxid: SPEAKER }),
      sendText: async () => "$prose-q",
      sendCustomEvent: async () => "$event-q",
    });
    expect(outcome.status).toBe("sent");
    expect((await projectionForGate(GATE))?.quorum).toEqual({ required: 2, from: "deciders", approvals: [] });
  });

  test("without a quorum records none", async () => {
    await db.delete(matrixGateEvents).where(eq(matrixGateEvents.gateId, GATE));
    const d: GatePendingDelivery = {
      event: "gate.pending",
      boardId: BOARD,
      cardId: CARD,
      gateId: GATE,
      stageKey: "release",
      returnStageKey: "build",
      cardTitle: "Ship the release",
      producedBy: "agt_31d0",
      options: [{ id: "approve", label: "Approve" }],
      ts: AT1,
    };
    await projectGate(BOOTSTRAP_TENANT_ID, d, {
      domain: "test",
      boardRoom: async () => ({ roomId: ROOM, speakerMxid: SPEAKER }),
      sendText: async () => "$prose-n",
      sendCustomEvent: async () => "$event-n",
    });
    expect((await projectionForGate(GATE))?.quorum).toBeNull();
  });
});
