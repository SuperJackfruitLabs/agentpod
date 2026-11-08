/**
 * Reminding and escalating a decision nobody answered (charter: "Unanswered decisions remind, then
 * escalate" §2-3), against the database: once per decision, a reply to the card this hub posted,
 * only that tenant's admins invited into only that tenant's board room, and an escalation posted
 * again for an admin once they have joined.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { db } from "../../src/db/drizzle";
import { matrixBoardRooms } from "../../src/db/schema/board-rooms";
import {
  matrixAttentionEvents,
  matrixDecisionNotices,
  matrixEscalationInvites,
  matrixGateEvents,
} from "../../src/db/schema/matrix";
import { BOOTSTRAP_TENANT_ID, tenants } from "../../src/db/schema/tenants";
import { tenantForOrg } from "../../src/auth/org-plane/tenant";
import { handleDecisionTimeout, repostEscalationsOnJoin, type DecisionNoticeDeps } from "../../src/services/matrix-as/decision-notices";
import { DECISION_ESCALATED_SUITE_TYPE } from "../../src/services/matrix-as/decision-timeout-wire";
import { workspaceAdminMatrixIds } from "../../src/services/matrix-as/workspace-admins";
import type { DecisionTimeoutDelivery } from "../../src/services/bridge";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { fakePlane, TEST_ORG } from "../helpers/fake-plane";

const BOARD = "brd_notice0000000001";
const OTHER_BOARD = "brd_notice0000000002";
const ROOM = "!noticeroom:test";
const SPEAKER = "@agent_superpipeline:test";
const CARD = "crd_notice01";
const GATE = "gate_notice01";
const CARD_EVENT = "$gate-prose";
const ADMIN = "@admin:test";
const BOARDS = [BOARD, OTHER_BOARD];

const escalated = (over: Partial<DecisionTimeoutDelivery> = {}): DecisionTimeoutDelivery => ({
  event: "decision.escalated",
  boardId: BOARD,
  cardId: CARD,
  cardTitle: "Launch post",
  stageKey: "review",
  stageName: "Review",
  decisionKind: "gate",
  decisionId: GATE,
  waitingSince: "2026-11-08T12:00:00.000Z",
  escalatedAt: "2026-11-08T18:00:00.000Z",
  ts: "2026-11-08T18:00:00.000Z",
  ...over,
});
const reminded = (over: Partial<DecisionTimeoutDelivery> = {}): DecisionTimeoutDelivery => ({
  ...escalated(over),
  event: "decision.reminded",
  escalatedAt: undefined,
  remindedAt: "2026-11-08T15:00:00.000Z",
  ...over,
});

function fakeDeps(over: Partial<DecisionNoticeDeps> = {}) {
  const sent: Array<{ userId: string; roomId: string; body: string; extra?: Record<string, unknown> }> = [];
  const invited: Array<{ as: string; roomId: string; who: string }> = [];
  const deps: DecisionNoticeDeps = {
    boardBaseUrl: "https://board.test",
    sendText: async (userId, roomId, body, extra) => {
      sent.push({ userId, roomId, body, ...(extra ? { extra } : {}) });
      return `$notice${sent.length}`;
    },
    invite: async (as, roomId, who) => {
      invited.push({ as, roomId, who });
    },
    workspaceAdmins: async () => [ADMIN],
    tenantsForBoard: async () => [BOOTSTRAP_TENANT_ID],
    ...over,
  };
  return { deps, sent, invited };
}

async function clean() {
  await db.delete(matrixDecisionNotices).where(inArray(matrixDecisionNotices.boardId, BOARDS));
  await db.delete(matrixEscalationInvites).where(inArray(matrixEscalationInvites.boardId, BOARDS));
  await db.delete(matrixGateEvents).where(inArray(matrixGateEvents.boardId, BOARDS));
  await db.delete(matrixAttentionEvents).where(inArray(matrixAttentionEvents.boardId, BOARDS));
  await db.delete(matrixBoardRooms).where(inArray(matrixBoardRooms.boardId, BOARDS));
}

beforeAll(async () => {
  await ensurePgMigrations();
});

beforeEach(async () => {
  await clean();
  await db.insert(matrixBoardRooms).values({ boardId: BOARD, roomId: ROOM, tenantId: BOOTSTRAP_TENANT_ID, speakerMxid: SPEAKER, alias: "agentpod_board_notice" });
  await db.insert(matrixGateEvents).values({
    gateId: GATE,
    tenantId: BOOTSTRAP_TENANT_ID,
    boardId: BOARD,
    cardId: CARD,
    roomId: ROOM,
    eventId: "$gate-legacy",
    proseEventId: CARD_EVENT,
  });
});

afterAll(clean);

describe("a reminder", () => {
  test("is a reply to the card the hub posted, once per decision", async () => {
    const { deps, sent, invited } = fakeDeps();
    expect(await handleDecisionTimeout(reminded(), deps)).toEqual({ status: "sent", invited: 0 });
    expect(await handleDecisionTimeout(reminded(), deps)).toEqual({ status: "duplicate" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ userId: SPEAKER, roomId: ROOM, body: 'Still waiting: "Launch post" has waited 3 h for an approval.' });
    expect(sent[0]?.extra?.["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: CARD_EVENT } });
    expect(invited).toHaveLength(0);
  });

  test("on a card the hub never posted, says nothing", async () => {
    const { deps, sent } = fakeDeps();
    expect(await handleDecisionTimeout(reminded({ decisionId: "gate_never" }), deps)).toEqual({ status: "unknown-card" });
    expect(sent).toHaveLength(0);
  });

  test("on a card still being sent, says nothing", async () => {
    await db.insert(matrixAttentionEvents).values({
      boardId: BOARD, cardId: CARD, waitId: "wait_1", tenantId: BOOTSTRAP_TENANT_ID, roomId: ROOM, eventId: "pending:wait_1", options: [],
    });
    const { deps, sent } = fakeDeps();
    expect(await handleDecisionTimeout(reminded({ decisionKind: "attention", decisionId: "wait_1" }), deps)).toEqual({ status: "unknown-card" });
    expect(sent).toHaveLength(0);
  });

  test("on a card already settled in the room, says nothing", async () => {
    await db.update(matrixGateEvents).set({ outcomePostedAt: new Date() }).where(inArray(matrixGateEvents.gateId, [GATE]));
    const { deps, sent } = fakeDeps();
    expect(await handleDecisionTimeout(reminded(), deps)).toEqual({ status: "settled" });
    expect(sent).toHaveLength(0);
  });

  test("a card recorded under another tenant is not this tenant's to reply to", async () => {
    const { deps, sent } = fakeDeps({ tenantsForBoard: async () => ["fleet_someone_else"] });
    expect(await handleDecisionTimeout(reminded(), deps)).toEqual({ status: "unknown-card" });
    expect(sent).toHaveLength(0);
  });

  test("a send that fails is not claimed, so the board's retry posts it", async () => {
    const failing = fakeDeps({
      sendText: async () => {
        throw new Error("homeserver down");
      },
    });
    await expect(handleDecisionTimeout(reminded(), failing.deps)).rejects.toThrow("homeserver down");
    const { deps, sent } = fakeDeps();
    expect((await handleDecisionTimeout(reminded(), deps)).status).toBe("sent");
    expect(sent).toHaveLength(1);
  });
});

describe("an escalation", () => {
  test("invites the workspace admins into the board room, then replies to the card with the structured notice", async () => {
    const { deps, sent, invited } = fakeDeps();
    expect(await handleDecisionTimeout(escalated(), deps)).toEqual({ status: "sent", invited: 1 });

    expect(invited).toEqual([{ as: SPEAKER, roomId: ROOM, who: ADMIN }]);
    expect(sent[0]?.body).toContain("Escalated to workspace admins after 6 h");
    expect(sent[0]?.extra).toMatchObject({
      suite_event_type: DECISION_ESCALATED_SUITE_TYPE,
      board_id: BOARD,
      card_id: CARD,
      decision_kind: "gate",
      decision_id: GATE,
      waiting_since: "2026-11-08T12:00:00.000Z",
      escalated_at: "2026-11-08T18:00:00.000Z",
      "m.relates_to": { "m.in_reply_to": { event_id: CARD_EVENT } },
    });
  });

  test("an admin is invited to a board once: the next escalation, after they left, does not invite them again", async () => {
    await db.insert(matrixGateEvents).values({ gateId: "gate_notice02", tenantId: BOOTSTRAP_TENANT_ID, boardId: BOARD, cardId: CARD, roomId: ROOM, eventId: "$g2" });
    const { deps, invited, sent } = fakeDeps();
    await handleDecisionTimeout(escalated(), deps);
    expect(await handleDecisionTimeout(escalated({ decisionId: "gate_notice02" }), deps)).toEqual({ status: "sent", invited: 0 });
    expect(invited).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });

  test("an invite the homeserver refuses is tried again on the next escalation", async () => {
    await db.insert(matrixGateEvents).values({ gateId: "gate_notice02", tenantId: BOOTSTRAP_TENANT_ID, boardId: BOARD, cardId: CARD, roomId: ROOM, eventId: "$g2" });
    const refusing = fakeDeps({
      invite: async () => {
        throw new Error("M_FORBIDDEN");
      },
    });
    expect(await handleDecisionTimeout(escalated(), refusing.deps)).toEqual({ status: "sent", invited: 0 });
    const { deps, invited } = fakeDeps();
    await handleDecisionTimeout(escalated({ decisionId: "gate_notice02" }), deps);
    expect(invited).toHaveLength(1);
  });

  test("a board known to several tenants escalates to nobody", async () => {
    const { deps, sent, invited } = fakeDeps({ tenantsForBoard: async () => [BOOTSTRAP_TENANT_ID, "fleet_other"] });
    expect(await handleDecisionTimeout(escalated(), deps)).toEqual({ status: "ambiguous-board" });
    expect(sent).toHaveLength(0);
    expect(invited).toHaveLength(0);
  });

  test("a board whose room is another tenant's escalates to nobody", async () => {
    await db.update(matrixBoardRooms).set({ roomId: "!elsewhere:test" }).where(inArray(matrixBoardRooms.boardId, [BOARD]));
    const { deps, sent, invited } = fakeDeps();
    expect(await handleDecisionTimeout(escalated(), deps)).toEqual({ status: "no-room" });
    expect(sent).toHaveLength(0);
    expect(invited).toHaveLength(0);
  });

  test("an admin directory that cannot be read claims nothing, so the retry escalates", async () => {
    const down = fakeDeps({
      workspaceAdmins: async () => {
        throw new Error("org plane unavailable");
      },
    });
    await expect(handleDecisionTimeout(escalated(), down.deps)).rejects.toThrow("org plane unavailable");
    const { deps, invited } = fakeDeps();
    expect((await handleDecisionTimeout(escalated(), deps)).status).toBe("sent");
    expect(invited).toHaveLength(1);
  });

  test("an invited admin who joins gets the open escalations again, once", async () => {
    const { deps, sent } = fakeDeps();
    await handleDecisionTimeout(escalated(), deps);
    expect(await repostEscalationsOnJoin(BOARD, ADMIN, deps)).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.extra?.suite_event_type).toBe(DECISION_ESCALATED_SUITE_TYPE);
    expect(await repostEscalationsOnJoin(BOARD, ADMIN, deps)).toBe(0);
    // Somebody the escalation did not invite gets nothing re-posted.
    expect(await repostEscalationsOnJoin(BOARD, "@someone:test", deps)).toBe(0);
  });

  test("an escalation settled before the admin joined is not re-posted", async () => {
    const { deps, sent } = fakeDeps();
    await handleDecisionTimeout(escalated(), deps);
    await db.update(matrixGateEvents).set({ outcomePostedAt: new Date() }).where(inArray(matrixGateEvents.gateId, [GATE]));
    expect(await repostEscalationsOnJoin(BOARD, ADMIN, deps)).toBe(0);
    expect(sent).toHaveLength(1);
  });
});

describe("the workspace admins, as Accounts knows them", () => {
  test("owners and admins of the tenant's organization with a linked Matrix id; not members, not the suspended, not the unlinked", async () => {
    const tenant = await tenantForOrg({ org: TEST_ORG, ent: ["agentpod"] });
    if (!tenant.ok) throw new Error("no tenant");
    fakePlane.addHuman({ role: "admin", matrixId: "@esc-admin:test" });
    fakePlane.addHuman({ role: "owner", matrixId: "@esc-owner:test" });
    fakePlane.addHuman({ role: "owner" });
    fakePlane.addHuman({ role: "member", matrixId: "@esc-member:test" });
    fakePlane.addHuman({ role: "admin", matrixId: "@esc-suspended:test", suspended: true });

    const mxids = await workspaceAdminMatrixIds(tenant.tenantId);
    expect(mxids).toContain("@esc-admin:test");
    expect(mxids).toContain("@esc-owner:test");
    expect(mxids).not.toContain("@esc-member:test");
    expect(mxids).not.toContain("@esc-suspended:test");
  });

  test("a tenant that is no organization's has nobody to escalate to", async () => {
    await db.insert(tenants).values({ id: "fleet_no_org_escalation", name: "no org" }).onConflictDoNothing();
    expect(await workspaceAdminMatrixIds("fleet_no_org_escalation")).toEqual([]);
    await db.delete(tenants).where(eq(tenants.id, "fleet_no_org_escalation"));
  });
});
