/**
 * Reminding and escalating a decision nobody answered (charter: "Unanswered decisions remind, then
 * escalate" §2-3). SuperPipeline owns the clock; this hub replies to the card it posted.
 *
 * - **`decision.reminded`**: a short reply to the waiting card in its board room, once per decision.
 * - **`decision.escalated`**: the workspace's owners and admins with a linked Matrix identity are
 *   invited into the board room, then the escalation is posted as a reply to the card, once per
 *   decision. An admin invited is invited once per board (`matrix_escalation_invites`): somebody who
 *   leaves is not invited back by the next escalation.
 *
 * **One tenant or nobody.** A board known to several tenants here (`tenantsForBoard`, the relay's
 * rule in `relay-scope.ts`) has no single owner, so its decisions are neither reminded nor escalated,
 * and it is logged once. Otherwise only that tenant's admins, only into that tenant's board room.
 *
 * **A card this hub never posted is left alone.** A notice is a reply; with nothing to reply to
 * (posted before this hub, still being sent, or already settled) nothing is said and nobody invited.
 *
 * **Readable after joining.** A board room is encrypted to its joined members, so an invited admin
 * cannot read anything sent before they accept. When an escalation invitee's join is seen, the
 * board's still-open escalations are posted again (`repostEscalationsOnJoin`); the earlier card stays
 * unreadable to them, which is why the notice carries the card's link.
 */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { matrixBoardRooms } from "../../db/schema/board-rooms";
import {
  matrixAttentionEvents,
  matrixDecisionNotices,
  matrixDeliveryEvents,
  matrixElicitationEvents,
  matrixEscalationInvites,
  matrixGateEvents,
} from "../../db/schema/matrix";
import { createLogger } from "../../utils/logger";
import { DECISION_KINDS, type DecisionKind, type DecisionTimeoutDelivery } from "../bridge";
import { decisionNoticeContent, noticeAt } from "./decision-timeout-wire";
import { boardLink } from "./gate-wire";
import type { TenantsForBoard } from "./relay-scope";

const log = createLogger("matrix-decision-notices");
const warnedAmbiguous = new Set<string>();

export interface DecisionNoticeDeps {
  boardBaseUrl?: string;
  sendText(userId: string, roomId: string, body: string, extra?: Record<string, unknown>): Promise<string | null>;
  /** Invite somebody into a room. Absent: an escalation invites nobody (and says so). */
  invite?(asUserId: string, roomId: string, invitee: string): Promise<void>;
  /** The Matrix ids of a tenant's workspace owners and admins (`workspace-admins.ts`). */
  workspaceAdmins?(tenantId: string): Promise<string[]>;
  /** Every tenant that knows a board. Defaults to `tenantsForBoard`. */
  tenantsForBoard?: TenantsForBoard;
}

export type DecisionNoticeOutcome =
  | { status: "sent"; invited: number }
  | { status: "duplicate" | "unknown-card" | "settled" | "no-room" | "unknown-board" | "ambiguous-board" };

interface CardEvent {
  roomId: string;
  eventId: string;
  open: boolean;
}

const posted = (eventId: string | null | undefined): eventId is string => !!eventId && !eventId.startsWith("pending:");

/** The waiting card this hub posted for a decision, in this tenant, on this board and card; or null. */
async function cardEventFor(
  tenantId: string,
  boardId: string,
  cardId: string,
  kind: DecisionKind,
  decisionId: string,
): Promise<CardEvent | null> {
  const row = await (async () => {
    if (kind === "gate") {
      const [r] = await db.select().from(matrixGateEvents).where(eq(matrixGateEvents.gateId, decisionId)).limit(1);
      return r ? { ...r, eventId: r.proseEventId ?? r.eventId } : null;
    }
    if (kind === "question") {
      const [r] = await db.select().from(matrixElicitationEvents).where(eq(matrixElicitationEvents.elicitationId, decisionId)).limit(1);
      return r ?? null;
    }
    if (kind === "delivery") {
      const [r] = await db.select().from(matrixDeliveryEvents).where(eq(matrixDeliveryEvents.gateId, decisionId)).limit(1);
      return r ?? null;
    }
    const [r] = await db
      .select()
      .from(matrixAttentionEvents)
      .where(and(eq(matrixAttentionEvents.boardId, boardId), eq(matrixAttentionEvents.cardId, cardId), eq(matrixAttentionEvents.waitId, decisionId)))
      .limit(1);
    return r ?? null;
  })();
  if (!row || row.tenantId !== tenantId || row.boardId !== boardId || row.cardId !== cardId || !posted(row.eventId)) return null;
  return { roomId: row.roomId, eventId: row.eventId, open: row.outcomePostedAt === null };
}

async function defaultTenantsForBoard(boardId: string): Promise<string[]> {
  const { tenantsForBoard } = await import("./gate-reads");
  return tenantsForBoard(boardId);
}

/** The one tenant a board belongs to here, or why there is none. */
async function soleTenant(
  boardId: string,
  deps: DecisionNoticeDeps,
): Promise<{ tenantId: string } | { status: "unknown-board" | "ambiguous-board" }> {
  const tenants = await (deps.tenantsForBoard ?? defaultTenantsForBoard)(boardId);
  if (tenants.length === 1 && tenants[0]) return { tenantId: tenants[0] };
  if (tenants.length === 0) return { status: "unknown-board" };
  if (!warnedAmbiguous.has(boardId)) {
    warnedAmbiguous.add(boardId);
    log.warn("a board known to several tenants is never reminded or escalated; nobody is invited", { boardId, tenants: tenants.length });
  }
  return { status: "ambiguous-board" };
}

async function boardRoomOf(boardId: string, tenantId: string) {
  const [room] = await db.select().from(matrixBoardRooms).where(eq(matrixBoardRooms.boardId, boardId)).limit(1);
  return room && room.tenantId === tenantId ? room : null;
}

/**
 * Invite each admin not yet invited to this board, recorded first so a second escalation does not
 * invite again. An invite the homeserver refuses is forgotten, so the next escalation tries again.
 */
async function inviteAdmins(
  admins: string[],
  room: { boardId: string; roomId: string; tenantId: string; speakerMxid: string },
  deps: DecisionNoticeDeps,
): Promise<number> {
  if (!deps.invite) {
    if (admins.length > 0) log.warn("an escalation could not invite anyone: no invite is wired", { boardId: room.boardId });
    return 0;
  }
  let invited = 0;
  for (const mxid of admins) {
    if (mxid === room.speakerMxid) continue;
    const [claimed] = await db
      .insert(matrixEscalationInvites)
      .values({ boardId: room.boardId, mxid, tenantId: room.tenantId, roomId: room.roomId })
      .onConflictDoNothing()
      .returning({ mxid: matrixEscalationInvites.mxid });
    if (!claimed) continue;
    try {
      await deps.invite(room.speakerMxid, room.roomId, mxid);
      invited++;
    } catch (err) {
      await db
        .delete(matrixEscalationInvites)
        .where(and(eq(matrixEscalationInvites.boardId, room.boardId), eq(matrixEscalationInvites.mxid, mxid)));
      log.warn("an escalation could not invite a workspace admin", {
        boardId: room.boardId,
        mxid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return invited;
}

/** Act on a `decision.reminded` or `decision.escalated`. Throws on a send failure, so the push is retried. */
export async function handleDecisionTimeout(d: DecisionTimeoutDelivery, deps: DecisionNoticeDeps): Promise<DecisionNoticeOutcome> {
  const sole = await soleTenant(d.boardId, deps);
  if ("status" in sole) return sole;
  const { tenantId } = sole;

  const card = await cardEventFor(tenantId, d.boardId, d.cardId, d.decisionKind, d.decisionId);
  if (!card) {
    log.info("a decision timed out on a card this hub never posted; nothing to reply to", {
      event: d.event,
      boardId: d.boardId,
      decisionKind: d.decisionKind,
      decisionId: d.decisionId,
    });
    return { status: "unknown-card" };
  }
  if (!card.open) return { status: "settled" };

  const room = await boardRoomOf(d.boardId, tenantId);
  if (!room || room.roomId !== card.roomId) {
    log.warn("a timed-out decision's card is not in its board's room; not replying", { boardId: d.boardId, decisionId: d.decisionId });
    return { status: "no-room" };
  }

  const escalated = d.event === "decision.escalated";
  // Read before anything is claimed: a plane that cannot be read throws, and the retried push
  // finds nothing claimed.
  const admins = escalated ? ((await deps.workspaceAdmins?.(tenantId)) ?? []) : [];

  const notice = escalated ? "escalated" : "reminded";
  const [claimed] = await db
    .insert(matrixDecisionNotices)
    .values({
      boardId: d.boardId,
      decisionKind: d.decisionKind,
      decisionId: d.decisionId,
      notice,
      tenantId,
      cardId: d.cardId,
      cardTitle: d.cardTitle,
      stageKey: d.stageKey,
      stageName: typeof d.stageName === "string" ? d.stageName : null,
      roomId: room.roomId,
      cardEventId: card.eventId,
      waitingSince: d.waitingSince,
      noticedAt: noticeAt(d),
    })
    .onConflictDoNothing()
    .returning({ boardId: matrixDecisionNotices.boardId });
  if (!claimed) return { status: "duplicate" };

  const noticeKey = and(
    eq(matrixDecisionNotices.boardId, d.boardId),
    eq(matrixDecisionNotices.decisionKind, d.decisionKind),
    eq(matrixDecisionNotices.decisionId, d.decisionId),
    eq(matrixDecisionNotices.notice, notice),
  );
  try {
    const invited = escalated ? await inviteAdmins(admins, room, deps) : 0;
    const eventId = await sendNotice(d, card.eventId, room, deps);
    await db.update(matrixDecisionNotices).set({ eventId }).where(noticeKey);
    log.info(escalated ? "a decision escalated to the workspace admins" : "a decision reminded", {
      boardId: d.boardId,
      decisionKind: d.decisionKind,
      decisionId: d.decisionId,
      ...(escalated ? { admins: admins.length, invited } : {}),
    });
    return { status: "sent", invited };
  } catch (err) {
    // Unclaimed, so the board's retry posts it.
    await db.delete(matrixDecisionNotices).where(noticeKey);
    throw err;
  }
}

async function sendNotice(
  d: DecisionTimeoutDelivery,
  cardEventId: string,
  room: { roomId: string; speakerMxid: string },
  deps: DecisionNoticeDeps,
): Promise<string | null> {
  const { body, ...extra } = decisionNoticeContent(d, cardEventId, boardLink(deps.boardBaseUrl, d.boardId, d.cardId));
  return deps.sendText(room.speakerMxid, room.roomId, String(body), extra);
}

/**
 * An admin an escalation invited has joined the board room: post the board's still-open escalations
 * again, which they could not read before. Once per invitee (the join claims `joined_at`). The count
 * posted.
 */
export async function repostEscalationsOnJoin(boardId: string, mxid: string, deps: DecisionNoticeDeps): Promise<number> {
  const [invite] = await db
    .update(matrixEscalationInvites)
    .set({ joinedAt: new Date() })
    .where(and(eq(matrixEscalationInvites.boardId, boardId), eq(matrixEscalationInvites.mxid, mxid), isNull(matrixEscalationInvites.joinedAt)))
    .returning();
  if (!invite) return 0;
  const room = await boardRoomOf(boardId, invite.tenantId);
  if (!room) return 0;

  const notices = await db
    .select()
    .from(matrixDecisionNotices)
    .where(
      and(
        eq(matrixDecisionNotices.boardId, boardId),
        eq(matrixDecisionNotices.tenantId, invite.tenantId),
        eq(matrixDecisionNotices.notice, "escalated"),
      ),
    );
  let reposted = 0;
  for (const n of notices) {
    const kind = DECISION_KINDS.find((k) => k === n.decisionKind);
    if (!kind) continue;
    const card = await cardEventFor(n.tenantId, n.boardId, n.cardId, kind, n.decisionId);
    if (!card?.open || card.roomId !== room.roomId) continue;
    const d: DecisionTimeoutDelivery = {
      event: "decision.escalated",
      boardId: n.boardId,
      cardId: n.cardId,
      cardTitle: n.cardTitle,
      stageKey: n.stageKey,
      stageName: n.stageName,
      decisionKind: kind,
      decisionId: n.decisionId,
      waitingSince: n.waitingSince,
      escalatedAt: n.noticedAt,
      ts: n.noticedAt,
    };
    await sendNotice(d, card.eventId, room, deps);
    reposted++;
  }
  if (reposted > 0) log.info("re-posted open escalations for a workspace admin who joined", { boardId, reposted });
  return reposted;
}
