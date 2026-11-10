/**
 * What became of a held approval, in the room (charter: "An approval may wait for its release time"
 * §7). SuperPipeline holds the approval and releases it in its sweep, or a person pulls it back;
 * either way it pushes what happened, and this hub replies to the gate card it posted, once:
 * "Released — it went ahead.", "Did not go ahead: <reason>." or "Pulled back by rakesh — returned
 * for changes: <comment>", each beside a structured event referencing the gate.
 *
 * **One tenant or nobody**, as for a quorum gate's progress (`gate-progress.ts`): a push carries no
 * tenant, and a board known to several tenants here has no single room to say it in.
 *
 * **A card this hub never posted is left alone**, and so is one whose card is not in its board's
 * room. Unlike progress, a settled gate is replied to: a held approval is settled (its outcome
 * receipt already said "goes ahead after …"), and this is what follows that receipt.
 *
 * **Once per gate and notice.** A push is at-least-once. Each is claimed (`matrix_gate_hold_notices`)
 * before anything is sent and given back when the send fails, so a redelivery posts nothing twice
 * and the board's retry of a failed one posts it.
 */
import { and, eq } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { matrixGateEvents, matrixGateHoldNotices } from "../../db/schema/matrix";
import { createLogger } from "../../utils/logger";
import type { DecisionPulledBackDelivery, DecisionReleasedDelivery } from "../bridge";
import { boardRoomOf, soleTenant } from "./decision-notices";
import {
  DECISION_PULLED_BACK_TYPE,
  DECISION_RELEASED_TYPE,
  isDecisionPulledBack,
  isDecisionReleased,
  pulledBackBody,
  pulledBackContent,
  releasedBody,
  releasedContent,
} from "./gate-release-wire";
import type { TenantsForBoard } from "./relay-scope";

const log = createLogger("matrix-gate-hold");

export interface GateHoldDeps {
  sendText(userId: string, roomId: string, body: string, extra?: Record<string, unknown>): Promise<string | null>;
  /** The structured half, beside the prose. Absent: only the prose is posted. */
  sendCustomEvent?(userId: string, roomId: string, eventType: string, content: Record<string, unknown>): Promise<string | null>;
  /** How to name the person who pulled an approval back: their handle, never an mxid. */
  displayNameFor?(principalId: string): Promise<string | null>;
  /** Every tenant that knows a board. Defaults to `tenantsForBoard`. */
  tenantsForBoard?: TenantsForBoard;
}

export type GateHoldOutcome =
  | { status: "sent" }
  | { status: "duplicate" | "unknown-card" | "no-room" | "unknown-board" | "ambiguous-board" | "malformed" };

type HoldNotice = "released" | "pulled_back";

const posted = (eventId: string | null | undefined): eventId is string => !!eventId && !eventId.startsWith("pending:");

/** Act on a `decision.released`. Throws on a send failure, so the push is retried. */
export async function handleDecisionReleased(d: DecisionReleasedDelivery, deps: GateHoldDeps): Promise<GateHoldOutcome> {
  // Checked by the route already; checked again so nothing below trusts the wire's spelling.
  if (!isDecisionReleased(d)) return { status: "malformed" };
  return replyToGate(d, "released", deps, async () => ({
    body: releasedBody(d),
    eventType: DECISION_RELEASED_TYPE,
    content: (gateEventId) => releasedContent(d, gateEventId),
  }));
}

/** Act on a `decision.pulled_back`. Throws on a send failure, so the push is retried. */
export async function handleDecisionPulledBack(d: DecisionPulledBackDelivery, deps: GateHoldDeps): Promise<GateHoldOutcome> {
  if (!isDecisionPulledBack(d)) return { status: "malformed" };
  return replyToGate(d, "pulled_back", deps, async () => {
    const who = await nameOf(d.pulledBackBy, deps);
    return {
      body: pulledBackBody({ who, comment: d.comment }),
      eventType: DECISION_PULLED_BACK_TYPE,
      content: (gateEventId) => pulledBackContent(d, who, gateEventId),
    };
  });
}

/** The shared half: find the card, claim the notice, reply, then the structured event. */
async function replyToGate(
  d: { boardId: string; cardId: string; gateId: string },
  notice: HoldNotice,
  deps: GateHoldDeps,
  compose: () => Promise<{ body: string; eventType: string; content: (gateEventId: string) => Record<string, unknown> }>,
): Promise<GateHoldOutcome> {
  const sole = await soleTenant(d.boardId, deps);
  if ("status" in sole) return sole;
  const { tenantId } = sole;

  const [gate] = await db.select().from(matrixGateEvents).where(eq(matrixGateEvents.gateId, d.gateId)).limit(1);
  if (!gate || gate.tenantId !== tenantId || gate.boardId !== d.boardId || gate.cardId !== d.cardId || !posted(gate.eventId)) {
    log.info("a held approval's notice names a gate this hub never posted; nothing to reply to", {
      boardId: d.boardId,
      gateId: d.gateId,
      notice,
    });
    return { status: "unknown-card" };
  }

  const room = await boardRoomOf(d.boardId, tenantId);
  if (!room || room.roomId !== gate.roomId) {
    log.warn("a held approval's card is not in its board's room; not replying", { boardId: d.boardId, gateId: d.gateId, notice });
    return { status: "no-room" };
  }

  const [claimed] = await db
    .insert(matrixGateHoldNotices)
    .values({ gateId: d.gateId, notice, tenantId })
    .onConflictDoNothing()
    .returning({ gateId: matrixGateHoldNotices.gateId });
  if (!claimed) return { status: "duplicate" };

  const claimKey = and(eq(matrixGateHoldNotices.gateId, d.gateId), eq(matrixGateHoldNotices.notice, notice));
  try {
    const said = await compose();
    const eventId = await deps.sendText(room.speakerMxid, room.roomId, said.body, {
      "m.relates_to": { "m.in_reply_to": { event_id: gate.proseEventId ?? gate.eventId } },
    });
    await db.update(matrixGateHoldNotices).set({ eventId }).where(claimKey);
    // The prose is in the room, so the claim stands from here: a failure of the structured half is
    // logged, not retried, or the board's retry would say it twice.
    try {
      await deps.sendCustomEvent?.(room.speakerMxid, room.roomId, said.eventType, said.content(gate.eventId));
    } catch (err) {
      log.warn("a held approval's notice was said but its structured half could not be sent", {
        gateId: d.gateId,
        notice,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    log.info("a held approval's notice posted", { boardId: d.boardId, gateId: d.gateId, notice });
    return { status: "sent" };
  } catch (err) {
    // Unclaimed, so the board's retry posts it.
    await db.delete(matrixGateHoldNotices).where(claimKey);
    throw err;
  }
}

/** Who pulled it back, by handle, or null when that cannot be had: the sentence leaves them out. */
async function nameOf(principalId: string, deps: GateHoldDeps): Promise<string | null> {
  try {
    return (await deps.displayNameFor?.(principalId)) ?? null;
  } catch (err) {
    log.warn("could not name who pulled a held approval back", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
