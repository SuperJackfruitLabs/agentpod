/**
 * A quorum gate's progress in the room (charter: "A gate may need more than one approver" §7).
 * SuperPipeline counts the approvals; this hub replies to the gate card it posted, once per
 * approval: "Approved by rakesh — 1 of 2. Waiting for 1 more." The approval that reaches the
 * quorum resolves the gate and is settled as any approval is, so it never arrives here.
 *
 * **One tenant or nobody**, as for a reminder (`decision-notices.ts`): a push carries no tenant,
 * and a board known to several tenants here has no single room to say it in.
 *
 * **A card this hub never posted is left alone**, and so is one already settled: progress is a
 * reply, and a reply to a decided gate would read as though it were still open.
 *
 * **Once per approval.** A push is at-least-once. Each approval is claimed (`matrix_gate_approvals`)
 * before anything is sent and given back when the send fails, so a redelivery posts nothing twice
 * and the board's retry of a failed one posts it.
 */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { matrixGateApprovals, matrixGateEvents } from "../../db/schema/matrix";
import { createLogger } from "../../utils/logger";
import type { GateApprovalRecordedDelivery } from "../bridge";
import { boardRoomOf, soleTenant } from "./decision-notices";
import {
  GATE_PROGRESS_TYPE,
  approvalV2,
  approvalsCounted,
  gateProgressBody,
  gateProgressContent,
  quorumV2,
} from "@superjackfruitlabs/treaty-matrix-events";
import type { TenantsForBoard } from "./relay-scope";

const log = createLogger("matrix-gate-progress");

export interface GateProgressDeps {
  sendText(userId: string, roomId: string, body: string, extra?: Record<string, unknown>): Promise<string | null>;
  /** The structured half, beside the prose. Absent: only the prose is posted. */
  sendCustomEvent?(userId: string, roomId: string, eventType: string, content: Record<string, unknown>): Promise<string | null>;
  /** How to name the person who approved: their handle, never an mxid. */
  displayNameFor?(principalId: string): Promise<string | null>;
  /** Every tenant that knows a board. Defaults to `tenantsForBoard`. */
  tenantsForBoard?: TenantsForBoard;
}

export type GateProgressOutcome =
  | { status: "sent" }
  | { status: "duplicate" | "unknown-card" | "settled" | "no-room" | "unknown-board" | "ambiguous-board" | "malformed" };

const posted = (eventId: string | null | undefined): eventId is string => !!eventId && !eventId.startsWith("pending:");

/** Act on a `gate.approval_recorded`. Throws on a send failure, so the push is retried. */
export async function handleGateApprovalRecorded(
  d: GateApprovalRecordedDelivery,
  deps: GateProgressDeps,
): Promise<GateProgressOutcome> {
  // Checked by the route already; read again here so nothing below trusts the wire's spelling.
  const approval = approvalV2(d.approval);
  const quorum = quorumV2(d.quorum);
  if (!approval || !quorum) return { status: "malformed" };

  const sole = await soleTenant(d.boardId, deps);
  if ("status" in sole) return sole;
  const { tenantId } = sole;

  const [gate] = await db.select().from(matrixGateEvents).where(eq(matrixGateEvents.gateId, d.gateId)).limit(1);
  if (!gate || gate.tenantId !== tenantId || gate.boardId !== d.boardId || gate.cardId !== d.cardId || !posted(gate.eventId)) {
    log.info("an approval was recorded on a gate this hub never posted; nothing to reply to", {
      boardId: d.boardId,
      gateId: d.gateId,
    });
    return { status: "unknown-card" };
  }
  if (gate.outcomePostedAt !== null) return { status: "settled" };

  const room = await boardRoomOf(d.boardId, tenantId);
  if (!room || room.roomId !== gate.roomId) {
    log.warn("a quorum gate's card is not in its board's room; not replying", { boardId: d.boardId, gateId: d.gateId });
    return { status: "no-room" };
  }

  // The board's count, recorded first: an approving answer is judged against it. Never walked back
  // by a late redelivery of an earlier approval, which carries fewer.
  if ((gate.approvalQuorum?.approvals.length ?? -1) <= quorum.approvals.length) {
    await db
      .update(matrixGateEvents)
      .set({ approvalQuorum: quorum })
      .where(and(eq(matrixGateEvents.gateId, d.gateId), isNull(matrixGateEvents.outcomePostedAt)));
  }

  const [claimed] = await db
    .insert(matrixGateApprovals)
    .values({ gateId: d.gateId, principalId: approval.principal_id, tenantId, approvedAt: approval.at })
    .onConflictDoNothing()
    .returning({ gateId: matrixGateApprovals.gateId });
  if (!claimed) return { status: "duplicate" };

  const claimKey = and(eq(matrixGateApprovals.gateId, d.gateId), eq(matrixGateApprovals.principalId, approval.principal_id));
  try {
    const who = await nameOf(approval.principal_id, deps);
    const variantLabel = approval.variant_id
      ? (gate.approvalVariants?.find((v) => v.id === approval.variant_id)?.label ?? null)
      : null;
    const body = gateProgressBody({ who, variantLabel, count: approvalsCounted(quorum, approval), required: quorum.required });
    const eventId = await deps.sendText(room.speakerMxid, room.roomId, body, {
      "m.relates_to": { "m.in_reply_to": { event_id: gate.proseEventId ?? gate.eventId } },
    });
    await db.update(matrixGateApprovals).set({ eventId }).where(claimKey);
    // The prose is in the room, so the claim stands from here: a failure of the structured half is
    // logged, not retried, or the board's retry would say the approval twice.
    try {
      await deps.sendCustomEvent?.(
        room.speakerMxid,
        room.roomId,
        GATE_PROGRESS_TYPE,
        gateProgressContent({
          gateId: d.gateId,
          boardId: d.boardId,
          cardId: d.cardId,
          approval,
          quorum,
          approvedBy: who,
          variantLabel,
          gateEventId: gate.eventId,
        }),
      );
    } catch (err) {
      log.warn("a quorum gate's progress was said but its structured half could not be sent", {
        gateId: d.gateId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    log.info("a quorum gate's approval posted", { boardId: d.boardId, gateId: d.gateId, required: quorum.required });
    return { status: "sent" };
  } catch (err) {
    // Unclaimed, so the board's retry posts it.
    await db.delete(matrixGateApprovals).where(claimKey);
    throw err;
  }
}

/** The approver's handle, or null when it cannot be had: the sentence leaves them out. */
async function nameOf(principalId: string, deps: GateProgressDeps): Promise<string | null> {
  try {
    return (await deps.displayNameFor?.(principalId)) ?? null;
  } catch (err) {
    log.warn("could not name a quorum gate's approver", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
