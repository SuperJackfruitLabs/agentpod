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
import { MAX_REPOST_ATTEMPTS, handleDecisionTimeout, repostEscalationsOnJoin, retryEscalationReposts, type DecisionNoticeDeps } from "../../src/services/matrix-as/decision-notices";
import { DECISION_ESCALATED_SUITE_TYPE } from "../../src/services/matrix-as/decision-timeout-wire";
import { workspaceAdminMatrixIds } from "../../src/services/matrix-as/workspace-admins";
import type { AttentionPendingDelivery, DecisionTimeoutDelivery, GatePendingDelivery } from "../../src/services/bridge";
import { MOVED_BELOW_TEXT, SETTLED_ABOVE_TEXT } from "../../src/services/matrix-as/decision-repost";
import { GATE_DECISION_SUITE_TYPE, GATE_V2_SUITE_TYPE, gateOptionsV2 } from "../../src/services/matrix-as/gate-wire";
import { attentionOptionsV2 } from "../../src/services/matrix-as/attention-wire";
import { handleGateDecision, type GateDecisionDeps } from "../../src/services/matrix-as/gate-decision";
import { projectionForGate } from "../../src/services/matrix-as/gate-reads";
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

  test("an admin already in the room counts as invited, so leaving later is not answered with another invite", async () => {
    await db.insert(matrixGateEvents).values({ gateId: "gate_notice02", tenantId: BOOTSTRAP_TENANT_ID, boardId: BOARD, cardId: CARD, roomId: ROOM, eventId: "$g2" });
    const member = fakeDeps({
      invite: async () => {
        throw new Error(`matrix invite failed: 403 M_FORBIDDEN ${ADMIN} is already in the room.`);
      },
    });
    await handleDecisionTimeout(escalated(), member.deps);
    const { deps, invited } = fakeDeps();
    await handleDecisionTimeout(escalated({ decisionId: "gate_notice02" }), deps);
    expect(invited).toHaveLength(0);
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

/** An admin's approval of the escalated gate, referencing the card at `eventId`. */
const answer = (eventId: string) => ({
  sender: ADMIN,
  content: { suite_event_type: GATE_DECISION_SUITE_TYPE, gate_id: GATE, option_id: "approve", "m.relates_to": { rel_type: "m.reference", event_id: eventId } },
});

describe("an escalated card moved below for an admin who joined", () => {
  const PENDING: GatePendingDelivery = {
    event: "gate.pending",
    boardId: BOARD,
    cardId: CARD,
    gateId: GATE,
    stageKey: "review",
    returnStageKey: "draft",
    cardTitle: "Launch post",
    producedBy: "agt_31d0",
    options: [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
    ],
    deadline: { escalateAt: "2026-11-08T18:00:00.000Z" },
    ts: "2026-11-08T12:00:00.000Z",
  };
  const recordedOptions = gateOptionsV2(PENDING);

  async function escalateThenJoin(over: Partial<DecisionNoticeDeps> = {}, joinedAt?: Date) {
    await db.update(matrixGateEvents).set({ options: recordedOptions }).where(eq(matrixGateEvents.gateId, GATE));
    const rig = fakeDeps({ pendingOnBoard: async () => [PENDING], ...over });
    await handleDecisionTimeout(escalated(), rig.deps);
    rig.sent.length = 0;
    const reposted = await repostEscalationsOnJoin(BOARD, ADMIN, rig.deps, joinedAt);
    return { ...rig, reposted };
  }
  const gateRow = async () => (await db.select().from(matrixGateEvents).where(eq(matrixGateEvents.gateId, GATE)))[0];

  test("the full current card is posted again, the record moves to it, the old card says so, and the notice replies to the new one", async () => {
    const { sent, reposted } = await escalateThenJoin();
    expect(reposted).toBe(1);

    const card = sent[0];
    expect(card?.extra).toMatchObject({ suite_event_type: GATE_V2_SUITE_TYPE, gate_id: GATE, deadline: { escalate_at: "2026-11-08T18:00:00.000Z" } });
    const row = await gateRow();
    expect(row?.proseEventId).toBe("$notice1");
    expect(row?.eventId).toBe("$notice1");
    expect(row?.options).toEqual(recordedOptions);

    expect(sent[1]).toMatchObject({ body: MOVED_BELOW_TEXT, extra: { "m.relates_to": { "m.in_reply_to": { event_id: CARD_EVENT } } } });
    expect(sent[2]?.extra).toMatchObject({ suite_event_type: DECISION_ESCALATED_SUITE_TYPE, "m.relates_to": { "m.in_reply_to": { event_id: "$notice1" } } });
  });

  test("an answer to the old card after the move is refused before it reaches the board", async () => {
    await escalateThenJoin();
    const resolved: unknown[] = [];
    const deps: GateDecisionDeps = {
      principalForMatrixId: async () => ({ id: "prn_admin", kind: "human" }),
      projectionFor: projectionForGate,
      resolveGate: async (input) => {
        resolved.push(input);
        return { ok: true };
      },
      reply: async () => null,
    };
    expect(await handleGateDecision(answer(CARD_EVENT), ROOM, deps)).toEqual({ status: "refused", reason: "reference-mismatch" });
    expect(await handleGateDecision(answer("$gate-legacy"), ROOM, deps)).toEqual({ status: "refused", reason: "reference-mismatch" });
    expect(resolved).toHaveLength(0);
  });

  test("a card the board now offers differently stays where it was", async () => {
    const changed = { ...PENDING, options: [{ id: "approve", label: "Approve" }] };
    const { sent, reposted } = await escalateThenJoin({ pendingOnBoard: async () => [changed] });
    expect(reposted).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.extra?.suite_event_type).toBe(DECISION_ESCALATED_SUITE_TYPE);
    expect((await gateRow())?.proseEventId).toBe(CARD_EVENT);
  });

  test("a card the board no longer lists, or a board that cannot be read, gets the notice alone", async () => {
    const gone = await escalateThenJoin({ pendingOnBoard: async () => [] });
    expect(gone.sent.map((s) => s.extra?.suite_event_type)).toEqual([DECISION_ESCALATED_SUITE_TYPE]);
    expect((await gateRow())?.proseEventId).toBe(CARD_EVENT);
  });

  test("a board read that fails gets the notice alone", async () => {
    const down = await escalateThenJoin({
      pendingOnBoard: async () => {
        throw new Error("board down");
      },
    });
    expect(down.sent.map((s) => s.extra?.suite_event_type)).toEqual([DECISION_ESCALATED_SUITE_TYPE]);
    expect((await gateRow())?.proseEventId).toBe(CARD_EVENT);
  });

  test("an answer that settles the card mid-move wins: the record stays, and the new card says so", async () => {
    const said: Array<{ body: string; replyTo?: unknown }> = [];
    let sends = 0;
    await escalateThenJoin({
      sendText: async (_u, _r, body, extra) => {
        if (extra?.suite_event_type === GATE_V2_SUITE_TYPE) {
          await db.update(matrixGateEvents).set({ outcomePostedAt: new Date() }).where(eq(matrixGateEvents.gateId, GATE));
        }
        said.push({ body, replyTo: extra?.["m.relates_to"] });
        return `$sent${++sends}`;
      },
    });
    const row = await gateRow();
    expect(row?.proseEventId).toBe(CARD_EVENT);
    const last = said.at(-1);
    expect(last?.body).toBe(SETTLED_ABOVE_TEXT);
    expect(last?.replyTo).toEqual({ "m.in_reply_to": { event_id: `$sent${sends - 1}` } });
    expect(said.map((x) => x.body)).not.toContain(MOVED_BELOW_TEXT);
  });

  test("a card another move took first is not taken back", async () => {
    await escalateThenJoin({
      sendText: async (_u, _r, _body, extra) => {
        if (extra?.suite_event_type === GATE_V2_SUITE_TYPE) {
          await db.update(matrixGateEvents).set({ eventId: "$other", proseEventId: "$other" }).where(eq(matrixGateEvents.gateId, GATE));
        }
        return "$mine";
      },
    });
    expect((await gateRow())?.proseEventId).toBe("$other");
  });

  test("the fleet Live Activity is pointed at the moved card, so a phone's answer references the one that counts", async () => {
    const noted: unknown[] = [];
    await escalateThenJoin({
      onPosted: async (d, posted) => {
        noted.push({ gateId: d.gateId, ...posted });
      },
    });
    expect(noted).toEqual([{ gateId: GATE, roomId: ROOM, eventId: "$notice1", proseEventId: "$notice1" }]);
  });

  test("a notice that fails to post is given back and finished by the sweep's retry, without moving the card twice", async () => {
    let failNotice = true;
    const sent: Array<{ body: string; extra?: Record<string, unknown> }> = [];
    const rig = fakeDeps({
      pendingOnBoard: async () => [PENDING],
      sendText: async (_u, _r, body, extra) => {
        if (failNotice && extra?.suite_event_type === DECISION_ESCALATED_SUITE_TYPE && sent.length > 1) throw new Error("homeserver down");
        sent.push({ body, ...(extra ? { extra } : {}) });
        return `$notice${sent.length}`;
      },
    });
    await db.update(matrixGateEvents).set({ options: recordedOptions }).where(eq(matrixGateEvents.gateId, GATE));
    await handleDecisionTimeout(escalated(), rig.deps);
    expect(await repostEscalationsOnJoin(BOARD, ADMIN, rig.deps)).toBe(0);
    const cardsPosted = () => sent.filter((x) => x.extra?.suite_event_type === GATE_V2_SUITE_TYPE).length;
    expect(cardsPosted()).toBe(1);

    failNotice = false;
    expect(await retryEscalationReposts(BOARD, rig.deps)).toBe(1);
    expect(cardsPosted()).toBe(1);
    expect(sent.at(-1)?.extra).toMatchObject({ suite_event_type: DECISION_ESCALATED_SUITE_TYPE, "m.relates_to": { "m.in_reply_to": { event_id: "$notice2" } } });
    // Done: nothing more is owed.
    expect(await retryEscalationReposts(BOARD, rig.deps)).toBe(0);
    expect(await repostEscalationsOnJoin(BOARD, ADMIN, rig.deps)).toBe(0);
  });

  test("a re-post that keeps failing stops being retried", async () => {
    const rig = fakeDeps();
    await handleDecisionTimeout(escalated(), rig.deps);
    rig.deps.sendText = async () => {
      throw new Error("homeserver down");
    };
    await repostEscalationsOnJoin(BOARD, ADMIN, rig.deps);
    for (let i = 0; i < 10; i++) await retryEscalationReposts(BOARD, rig.deps);
    const [invite] = await db.select().from(matrixEscalationInvites).where(eq(matrixEscalationInvites.mxid, ADMIN));
    expect(invite?.repostAttempts).toBe(MAX_REPOST_ATTEMPTS);
  });

  test("an admin who had already joined when the card moved can read it and gets nothing; one who joined after it gets another move", async () => {
    await db.insert(matrixEscalationInvites).values([
      { boardId: BOARD, mxid: "@late:test", tenantId: BOOTSTRAP_TENANT_ID, roomId: ROOM },
      { boardId: BOARD, mxid: "@early:test", tenantId: BOOTSTRAP_TENANT_ID, roomId: ROOM },
    ]);
    const { deps, sent } = await escalateThenJoin();
    sent.length = 0;
    expect(await repostEscalationsOnJoin(BOARD, "@early:test", deps, new Date(Date.now() - 60_000))).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await repostEscalationsOnJoin(BOARD, "@late:test", deps, new Date(Date.now() + 60_000))).toBe(1);
    expect(sent.map((s) => s.body)).toContain(MOVED_BELOW_TEXT);
  });

  test("a waiting card moves the same way, its wait id unchanged", async () => {
    const waiting: AttentionPendingDelivery = {
      event: "attention.pending", boardId: BOARD, cardId: CARD, cardTitle: "Launch post", stageKey: "draft", waitId: "wait_mv",
      reason: "blocked", options: [{ id: "archive", label: "Archive", meaning: "reject", needsComment: false }], ts: "2026-11-08T12:00:00.000Z",
    };
    await db.insert(matrixAttentionEvents).values({
      boardId: BOARD, cardId: CARD, waitId: "wait_mv", tenantId: BOOTSTRAP_TENANT_ID, roomId: ROOM, eventId: "$wait-card", options: attentionOptionsV2(waiting),
    });
    const noted: unknown[] = [];
    const rig = fakeDeps({
      pendingOnBoard: async () => [waiting],
      onAttentionPosted: async (d, posted) => {
        noted.push({ waitId: d.waitId, eventId: posted.eventId });
      },
    });
    await handleDecisionTimeout(escalated({ decisionKind: "attention", decisionId: "wait_mv" }), rig.deps);
    rig.sent.length = 0;
    expect(await repostEscalationsOnJoin(BOARD, ADMIN, rig.deps)).toBe(1);
    const [row] = await db.select().from(matrixAttentionEvents).where(eq(matrixAttentionEvents.waitId, "wait_mv"));
    expect(row?.eventId).toBe("$notice1");
    expect(rig.sent[1]).toMatchObject({ body: MOVED_BELOW_TEXT, extra: { "m.relates_to": { "m.in_reply_to": { event_id: "$wait-card" } } } });
    expect(noted).toEqual([{ waitId: "wait_mv", eventId: "$notice1" }]);
  });
});
