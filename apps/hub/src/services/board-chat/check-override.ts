/**
 * Overriding a machine check from chat (charter: "A gate may be decided by checks" §5, §7): a
 * `dev.superpipeline.check.override.v2` becomes the board's override route, called as the person who
 * sent it, exactly as a pull-back or a decision is carried.
 *
 * Fails closed at every step, as a pull-back does: the message must reference a checks.waiting card
 * this hub posted, in this room, for the board and card it names; then attribution, silently for a
 * stranger or an agent; then the comment the board requires. The board judges who may override (a
 * workspace owner or admin, never the producer of the work) and whether the check is still open, and
 * its refusal is said in the room.
 *
 * Success says nothing here: the board pushes `check.overridden`, and `check-notices.ts` says it in
 * the room from that, once, however the override was made.
 */

import { createLogger } from "../../utils/logger";
import { IDENTITY_UNAVAILABLE_TEXT } from "../matrix";
import { CHECK_OVERRIDE_COMMENT_MAX_BYTES, checkOverrideCommentFits, parseCheckOverride } from "@superjackfruitlabs/treaty-matrix-events";
import type { RecordedChecksCard } from "./checks-waiting";
import { boardCallRefusalText } from "./gate-pull-back";

const log = createLogger("matrix-check-override");

/** Why an override was not carried. Every value is a refusal. */
export type CheckOverrideRefusal =
  | "not-an-override"
  | "unknown-card"
  | "reference-mismatch"
  | "unlinked-sender"
  | "identity-unavailable"
  /** A linked principal that is not a person: agents never override (charter §5). */
  | "not-human"
  | "comment-required"
  | "comment-too-long";

export type CheckOverrideOutcome =
  | { status: "overridden" }
  | { status: "refused"; reason: CheckOverrideRefusal }
  | { status: "refused"; reason: "board-refused"; code: string };

export interface CheckOverrideDeps {
  principalForMatrixId(mxid: string): Promise<{ id: string; kind: "human" | "agent" | "service" } | null>;
  /** The checks.waiting card this hub posted whose current event is this one, or null. */
  recordedChecksCard(eventId: string): Promise<RecordedChecksCard | null>;
  /** The board's override route, called **as `principalId`** (`overrideCheckAtSuperpipeline`), never as this service. */
  override(input: {
    tenantId: string;
    boardId: string;
    cardId: string;
    checkName: string;
    comment: string;
    principalId: string;
    senderMxid: string;
  }): Promise<{ ok: true } | { ok: false; code: string }>;
  reply(roomId: string, body: string): Promise<unknown>;
}

/** Said when the override carries no comment; the board would refuse it `INVALID_COMMENT`. */
export const CHECK_OVERRIDE_COMMENT_REQUIRED_TEXT = "Overriding a check needs a comment saying why. Nothing has changed.";

/** What the board's refusal of an override becomes in the room. Exported for the shared fixture's test. */
export function checkOverrideRefusalText(code: string): string {
  switch (code) {
    case "CHECK_OVERRIDE_NOT_ALLOWED":
      return "Only a workspace owner or admin can override a check. Nothing has changed.";
    case "SEPARATION_OF_DUTIES":
      return "You produced this work, so you can't override a check on it. Nothing has changed.";
    case "CHECK_NOT_OPEN":
      return "That check can't be overridden now: it already passed or was overridden, or the card has moved on. Nothing has changed.";
    case "CHECK_NOT_FOUND":
      return "There is no check by that name waiting on this card. Nothing has changed.";
    case "CARD_NOT_FOUND":
      return "That card is no longer on the board. Nothing has changed.";
    default:
      return boardCallRefusalText(code);
  }
}

/** Act on a check.override.v2, or refuse and say why. Every branch but `overridden` changes nothing. */
export async function handleCheckOverride(
  event: { sender: string; content: Record<string, unknown> },
  roomId: string,
  deps: CheckOverrideDeps,
): Promise<CheckOverrideOutcome> {
  const parsed = parseCheckOverride(event.content);
  if (!parsed) return { status: "refused", reason: "not-an-override" };

  // The reference is the only way to the card, so it must be one; then every identifier the message
  // names is checked against what this hub recorded, and the room against where it posted it:
  // trusting the message's ids alone would act on whatever card a sender named.
  const card = parsed.referencedEventId ? await deps.recordedChecksCard(parsed.referencedEventId) : null;
  if (!card) {
    log.warn("a check override references no checks card this hub posted", { boardId: parsed.boardId, cardId: parsed.cardId });
    return { status: "refused", reason: "unknown-card" };
  }
  if (card.roomId !== roomId || card.boardId !== parsed.boardId || card.cardId !== parsed.cardId) {
    log.warn("a check override's reference, room, board and card disagree", { boardId: parsed.boardId, cardId: parsed.cardId });
    return { status: "refused", reason: "reference-mismatch" };
  }

  let principal: Awaited<ReturnType<CheckOverrideDeps["principalForMatrixId"]>>;
  try {
    principal = await deps.principalForMatrixId(event.sender);
  } catch (error) {
    log.warn("could not resolve a check override's sender", {
      sender: event.sender,
      error: error instanceof Error ? error.message : String(error),
    });
    await deps.reply(roomId, IDENTITY_UNAVAILABLE_TEXT);
    return { status: "refused", reason: "identity-unavailable" };
  }
  if (!principal) {
    log.info("a check override from an unlinked sender, ignored", { sender: event.sender });
    return { status: "refused", reason: "unlinked-sender" };
  }
  if (principal.kind !== "human") {
    // An agent passing its own checks is the property a check exists to deny. Warned, so somebody
    // sees it.
    log.warn("a non-human principal tried to override a check", {
      sender: event.sender,
      principalId: principal.id,
      kind: principal.kind,
      boardId: parsed.boardId,
      cardId: parsed.cardId,
    });
    return { status: "refused", reason: "not-human" };
  }

  // After attribution, so a stranger or an agent cannot make this hub speak.
  if (parsed.comment === null) {
    await deps.reply(roomId, CHECK_OVERRIDE_COMMENT_REQUIRED_TEXT);
    return { status: "refused", reason: "comment-required" };
  }
  if (!checkOverrideCommentFits(parsed.comment)) {
    await deps.reply(
      roomId,
      `That comment is longer than the board takes (at most ${CHECK_OVERRIDE_COMMENT_MAX_BYTES} bytes). Nothing has changed.`,
    );
    return { status: "refused", reason: "comment-too-long" };
  }

  const result = await deps.override({
    tenantId: card.tenantId,
    boardId: card.boardId,
    cardId: card.cardId,
    checkName: parsed.checkName,
    comment: parsed.comment,
    principalId: principal.id,
    senderMxid: event.sender,
  });
  if (!result.ok) {
    log.warn("superpipeline refused a check override", { boardId: card.boardId, cardId: card.cardId, code: result.code });
    await deps.reply(roomId, checkOverrideRefusalText(result.code));
    return { status: "refused", reason: "board-refused", code: result.code };
  }
  log.info("a check was overridden from chat; the board's push says it", { boardId: card.boardId, cardId: card.cardId });
  return { status: "overridden" };
}
