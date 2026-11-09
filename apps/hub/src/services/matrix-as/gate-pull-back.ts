/**
 * Pulling a held approval back from chat (charter: "An approval may wait for its release time" §4,
 * §7): a `dev.superpipeline.gate.pull_back.v2` becomes the board's pull-back route, called as the
 * person who sent it, exactly as a decision.v2 is carried.
 *
 * Fails closed at every step, as a decision does: the gate must be one this hub posted, in this
 * room, and the message must reference it; then attribution, silently for a stranger or an agent;
 * then the comment the board requires. The board judges who may pull back (a decider of the gate, or
 * an owner or admin) and whether the approval is still held, and its refusal is said in the room.
 *
 * Success says nothing here: the board pushes `decision.pulled_back`, and `gate-hold.ts` replies to
 * the gate's card from that, once, however the pull-back was made.
 */

import { createLogger } from "../../utils/logger";
import { IDENTITY_UNAVAILABLE_TEXT } from "../matrix";
import { PULL_BACK_COMMENT_MAX_BYTES, parsePullBack, pullBackCommentFits } from "./gate-release-wire";

const log = createLogger("matrix-gate-pull-back");

/** Why a pull-back was not carried. Every value is a refusal. */
export type PullBackRefusal =
  | "not-a-pull-back"
  | "unknown-gate"
  | "reference-mismatch"
  | "unlinked-sender"
  | "identity-unavailable"
  /** A linked principal that is not a person: pulling back is a person's decision, as approving is. */
  | "not-human"
  | "comment-required"
  | "comment-too-long";

export type PullBackOutcome =
  | { status: "pulled-back" }
  | { status: "refused"; reason: PullBackRefusal }
  | { status: "refused"; reason: "board-refused"; code: string };

/** What this hub recorded when it posted a gate's card. */
export interface RecordedGateCard {
  tenantId: string;
  boardId: string;
  roomId: string;
  /** The gate's own event. */
  eventId: string;
  /** The prose message carrying the gate, when it was recorded. Either may be referenced. */
  proseEventId: string | null;
}

export interface PullBackDeps {
  principalForMatrixId(mxid: string): Promise<{ id: string; kind: "human" | "agent" | "service" } | null>;
  /** The gate card this hub posted, or null when it never posted one. */
  recordedGate(gateId: string): Promise<RecordedGateCard | null>;
  /** The board's pull-back route, called **as `principalId`** (`pullBackAtSuperpipeline`), never as this service. */
  pullBack(input: {
    tenantId: string;
    boardId: string;
    gateId: string;
    comment: string;
    principalId: string;
    senderMxid: string;
  }): Promise<{ ok: true } | { ok: false; code: string }>;
  reply(roomId: string, body: string): Promise<unknown>;
}

/** Said when the pull-back carries no comment; the board would refuse it `INVALID_COMMENT`. */
export const PULL_BACK_COMMENT_REQUIRED_TEXT = "Pulling back an approval needs a comment saying why. Nothing has changed.";

/** What the board's refusal of a pull-back becomes in the room. Exported for the shared fixture's test. */
export function pullBackRefusalText(code: string): string {
  switch (code) {
    case "APPROVAL_RELEASED":
      return "Too late to pull back: this approval has already gone ahead. Nothing has changed.";
    case "GATE_NOT_HELD":
      return "There is nothing to pull back: this approval is not waiting for its release time. Nothing has changed.";
    case "APPROVAL_DECIDER_NOT_ALLOWED":
      return "Only someone who may decide this gate, or a workspace owner or admin, can pull it back. Nothing has changed.";
    case "SEPARATION_OF_DUTIES":
      return "You produced this work, so you can't pull back its approval. Nothing has changed.";
    case "INVALID_COMMENT":
      return "The board did not take that comment: it needs a short one saying why. Nothing has changed.";
    case "IDENTITY_UNAVAILABLE":
      return IDENTITY_UNAVAILABLE_TEXT;
    case "ASSERTION_REFUSED":
    case "ASSERTION_MISMATCH":
      return `That did not go through (${code}): the account service would not vouch for you. Nothing has changed.`;
    case "UNREACHABLE":
      return "That did not reach the board. Try again in a moment. Nothing has changed.";
    default:
      return `That did not go through (${code}). Nothing has changed.`;
  }
}

/** Act on a gate.pull_back.v2, or refuse and say why. Every branch but `pulled-back` changes nothing. */
export async function handleGatePullBack(
  event: { sender: string; content: Record<string, unknown> },
  roomId: string,
  deps: PullBackDeps,
): Promise<PullBackOutcome> {
  const parsed = parsePullBack(event.content);
  if (!parsed) return { status: "refused", reason: "not-a-pull-back" };

  const gate = await deps.recordedGate(parsed.gateId);
  if (!gate) {
    log.warn("a pull-back names a gate this hub never posted", { gateId: parsed.gateId });
    return { status: "refused", reason: "unknown-gate" };
  }
  // Both identifiers, checked against each other and against the room, as for a decision: trusting
  // the reference alone would act on whatever gate a sender pointed at.
  const referenced = parsed.referencedEventId;
  const matches = referenced !== null && (referenced === gate.eventId || (!!gate.proseEventId && referenced === gate.proseEventId));
  if (!matches || roomId !== gate.roomId) {
    log.warn("a pull-back's reference, room and gate disagree", { gateId: parsed.gateId, referenced });
    return { status: "refused", reason: "reference-mismatch" };
  }

  let principal: Awaited<ReturnType<PullBackDeps["principalForMatrixId"]>>;
  try {
    principal = await deps.principalForMatrixId(event.sender);
  } catch (error) {
    log.warn("could not resolve a pull-back's sender", {
      sender: event.sender,
      error: error instanceof Error ? error.message : String(error),
    });
    await deps.reply(roomId, IDENTITY_UNAVAILABLE_TEXT);
    return { status: "refused", reason: "identity-unavailable" };
  }
  if (!principal) {
    log.info("a pull-back from an unlinked sender, ignored", { sender: event.sender });
    return { status: "refused", reason: "unlinked-sender" };
  }
  if (principal.kind !== "human") {
    // An agent undoing a person's approval is the property a gate exists to deny. Warned, so
    // somebody sees it.
    log.warn("a non-human principal tried to pull back an approval", {
      sender: event.sender,
      principalId: principal.id,
      kind: principal.kind,
      gateId: parsed.gateId,
    });
    return { status: "refused", reason: "not-human" };
  }

  // After attribution, so a stranger or an agent cannot make this hub speak.
  if (parsed.comment === null) {
    await deps.reply(roomId, PULL_BACK_COMMENT_REQUIRED_TEXT);
    return { status: "refused", reason: "comment-required" };
  }
  if (!pullBackCommentFits(parsed.comment)) {
    await deps.reply(
      roomId,
      `That comment is longer than the board takes (at most ${PULL_BACK_COMMENT_MAX_BYTES} bytes). Nothing has changed.`,
    );
    return { status: "refused", reason: "comment-too-long" };
  }

  const result = await deps.pullBack({
    tenantId: gate.tenantId,
    boardId: gate.boardId,
    gateId: parsed.gateId,
    comment: parsed.comment,
    principalId: principal.id,
    senderMxid: event.sender,
  });
  if (!result.ok) {
    log.warn("superpipeline refused a pull-back", { gateId: parsed.gateId, code: result.code });
    await deps.reply(roomId, pullBackRefusalText(result.code));
    return { status: "refused", reason: "board-refused", code: result.code };
  }
  log.info("a held approval was pulled back from chat; the board's push replies", { gateId: parsed.gateId });
  return { status: "pulled-back" };
}
