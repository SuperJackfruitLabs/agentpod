/**
 * The way back for delivery.v2: a `dev.superpipeline.delivery.answer.v2` becomes a recorded live
 * link, or a switch to automatic delivery, at the board — as the person who answered.
 *
 * charter → "The decision envelope covers questions and follow-ups" §3. Fails closed at every step,
 * as a gate decision does: attribution first and silently, then the answer judged against what
 * THIS follow-up offered when it was posted (`matrix_delivery_events`), refused with a reply when
 * it is wrong. The board judges it again on its own terms.
 */

import { createLogger } from "../../utils/logger";
import { IDENTITY_UNAVAILABLE_TEXT } from "../matrix";
import {
  DELIVERY_ANSWER_V2_SUITE_TYPE,
  RECORD_LIVE_URL,
  SWITCH_TO_AUTOMATIC,
  deliveryOutcomeContent,
  type DeliveryOutcomeDecision,
  inputRefusal,
  type InputRefusal,
} from "@superjackfruitlabs/treaty-matrix-events";
import { referenceOf } from "./question-answer";

const log = createLogger("matrix-deliveries");

const ID_MAX = 200;
/** Text past this is refused before anything else: no link the board takes is longer. */
const TEXT_READ_MAX = 16_000;

export interface ParsedDeliveryAnswer {
  gateId: string;
  optionId: string;
  /** Trimmed; null when absent or blank. For `record_live_url`, the live link. */
  text: string | null;
  referencedEventId: string | null;
}

/** Read a delivery.answer.v2 out of an `m.room.message`, or null when it is not one. */
export function parseDeliveryAnswer(content: unknown): ParsedDeliveryAnswer | null {
  if (typeof content !== "object" || content === null) return null;
  if (!("suite_event_type" in content) || content.suite_event_type !== DELIVERY_ANSWER_V2_SUITE_TYPE) return null;
  if (!("gate_id" in content) || !("option_id" in content)) return null;
  const { gate_id: gateId, option_id: optionId } = content;
  if (typeof gateId !== "string" || gateId.length === 0 || gateId.length > ID_MAX) return null;
  if (typeof optionId !== "string" || optionId.length === 0) return null;
  const text = "text" in content && typeof content.text === "string" && content.text.trim() !== "" ? content.text.trim() : null;
  return { gateId, optionId, text, referencedEventId: referenceOf(content) };
}

/** What this hub recorded when it posted a follow-up (`recordedDelivery`). */
export interface RecordedDelivery {
  boardId: string;
  roomId: string;
  /** The follow-up's prose message: the one event an answer may reference. */
  eventId: string;
  options: ReadonlyArray<{ id: string; input?: { kind: "text" | "url"; required: boolean; max_length: number } }>;
  /** Whether the subject's preview reached the room in full; anything but true refuses a switch. */
  subjectPreviewComplete: boolean | null;
}

/** Why a delivery.answer.v2 was not carried. Every value is a refusal. */
export type DeliveryAnswerRefusal =
  | "not-an-answer"
  | "unknown-follow-up"
  | "reference-mismatch"
  | "unlinked-sender"
  | "identity-unavailable"
  /** A linked principal that is not a person: a follow-up is a human's answer, like the gate it follows. */
  | "not-human"
  | "bad-option"
  | InputRefusal
  | "preview-incomplete";

export type DeliveryAnswerOutcome =
  | { status: "recorded"; change: "live-url" | "automatic" }
  | { status: "refused"; reason: DeliveryAnswerRefusal }
  | { status: "refused"; reason: "board-refused"; code: string };

export interface DeliveryAnswerDeps {
  principalForMatrixId(mxid: string): Promise<{ id: string; kind: "human" | "agent" | "service" } | null>;
  recordedDelivery(gateId: string): Promise<RecordedDelivery | null>;
  /** The board's delivery route, called as `principalId` (`updateDeliveryAtSuperpipeline`). */
  updateDelivery(input: {
    boardId: string;
    gateId: string;
    change: { liveUrl: string } | { mode: "automatic" };
    principalId: string;
    senderMxid: string;
  }): Promise<{ ok: true } | { ok: false; code: string }>;
  reply(roomId: string, body: string): Promise<unknown>;
  /** True exactly once per follow-up, so a repeated answer leaves one receipt. */
  claimOutcome(gateId: string): Promise<boolean>;
  /** How the receipt names the person who answered — their handle, not an mxid. */
  displayNameFor?(principalId: string): Promise<string | null>;
  /** Post the structured half of the receipt (`dev.superpipeline.gate.outcome.v1`) beside the prose. */
  sendOutcome?(roomId: string, content: Record<string, unknown>): Promise<unknown>;
}

const REFUSAL_TEXT: Record<Exclude<DeliveryAnswerRefusal, "not-an-answer" | "unknown-follow-up" | "reference-mismatch" | "unlinked-sender" | "identity-unavailable" | "not-human">, string> = {
  "bad-option": "That is not one of this follow-up's choices. Nothing has changed.",
  "input-required": "That needs the post's live link. Nothing has changed.",
  "text-too-long": "That link is too long. Nothing has changed.",
  "url-invalid": "That needs an https:// link to the live post. Nothing has changed.",
  "preview-incomplete":
    "The card could not show everything that would be posted, so automatic delivery cannot be turned on from here. Open the card on the board. Nothing has changed.",
};

/** The board change an answer asks for, or why it must not be carried. */
function judge(
  parsed: ParsedDeliveryAnswer,
  recorded: RecordedDelivery,
): { change: { liveUrl: string } | { mode: "automatic" } } | { refusal: keyof typeof REFUSAL_TEXT } {
  const option = recorded.options.find((o) => o.id === parsed.optionId);
  if (!option) return { refusal: "bad-option" };
  if (option.id === SWITCH_TO_AUTOMATIC) {
    // Recorded as offered only on a complete preview, and checked again here: an answer must
    // not turn on posting what the card could not show, whatever a client offered.
    if (recorded.subjectPreviewComplete !== true) return { refusal: "preview-incomplete" };
    return { change: { mode: "automatic" } };
  }
  if (option.id !== RECORD_LIVE_URL) return { refusal: "bad-option" };
  if (parsed.text !== null && parsed.text.length > TEXT_READ_MAX) return { refusal: "text-too-long" };
  // Whatever the recorded input says, a live link is a required https:// address.
  const refused = inputRefusal(
    { kind: "url", required: true, max_length: option.input?.max_length ?? TEXT_READ_MAX },
    parsed.text,
  );
  if (refused || parsed.text === null) return { refusal: refused ?? "input-required" };
  return { change: { liveUrl: parsed.text } };
}

/** What the board's refusal becomes in the room. */
function boardRefusalText(code: string): string {
  if (code === "IDENTITY_UNAVAILABLE") return IDENTITY_UNAVAILABLE_TEXT;
  if (code === "ASSERTION_REFUSED" || code === "ASSERTION_MISMATCH") {
    return `That did not go through (${code}): the account service would not vouch for you. Nothing has changed.`;
  }
  return `That did not go through (${code}). Nothing has changed.`;
}

/**
 * Act on a delivery.answer.v2, or refuse and say why. Every branch that is not `recorded` leaves
 * the board untouched.
 */
export async function handleDeliveryAnswer(
  event: { sender: string; content: Record<string, unknown> },
  roomId: string,
  deps: DeliveryAnswerDeps,
): Promise<DeliveryAnswerOutcome> {
  const parsed = parseDeliveryAnswer(event.content);
  if (!parsed) return { status: "refused", reason: "not-an-answer" };

  const recorded = await deps.recordedDelivery(parsed.gateId);
  if (!recorded) {
    log.warn("an answer names a follow-up this hub never posted", { gateId: parsed.gateId });
    return { status: "refused", reason: "unknown-follow-up" };
  }
  if (parsed.referencedEventId !== recorded.eventId || roomId !== recorded.roomId) {
    log.warn("a follow-up answer's reference and gate disagree", {
      gateId: parsed.gateId,
      referenced: parsed.referencedEventId,
    });
    return { status: "refused", reason: "reference-mismatch" };
  }

  let principal: Awaited<ReturnType<DeliveryAnswerDeps["principalForMatrixId"]>>;
  try {
    principal = await deps.principalForMatrixId(event.sender);
  } catch (error) {
    log.warn("could not resolve a follow-up answer's sender", {
      sender: event.sender,
      error: error instanceof Error ? error.message : String(error),
    });
    await deps.reply(roomId, IDENTITY_UNAVAILABLE_TEXT);
    return { status: "refused", reason: "identity-unavailable" };
  }
  if (!principal) {
    log.info("a follow-up answer from an unlinked sender, ignored", { sender: event.sender });
    return { status: "refused", reason: "unlinked-sender" };
  }
  if (principal.kind !== "human") {
    log.warn("a non-human principal tried to answer a delivery follow-up", {
      sender: event.sender,
      principalId: principal.id,
      kind: principal.kind,
      gateId: parsed.gateId,
    });
    return { status: "refused", reason: "not-human" };
  }

  const verdict = judge(parsed, recorded);
  if ("refusal" in verdict) {
    log.warn("a delivery.answer.v2 was refused before it reached the board", {
      gateId: parsed.gateId,
      optionId: parsed.optionId,
      reason: verdict.refusal,
    });
    await deps.reply(roomId, REFUSAL_TEXT[verdict.refusal]);
    return { status: "refused", reason: verdict.refusal };
  }

  const result = await deps.updateDelivery({
    boardId: recorded.boardId,
    gateId: parsed.gateId,
    change: verdict.change,
    principalId: principal.id,
    senderMxid: event.sender,
  });
  if (!result.ok) {
    log.warn("superpipeline refused a delivery follow-up answer", { gateId: parsed.gateId, code: result.code });
    await deps.reply(roomId, boardRefusalText(result.code));
    return { status: "refused", reason: "board-refused", code: result.code };
  }

  const change = "liveUrl" in verdict.change ? "live-url" : "automatic";
  await settleDeliveryOutcome(
    parsed.gateId,
    change === "live-url" ? RECORD_LIVE_URL : SWITCH_TO_AUTOMATIC,
    principal.id,
    roomId,
    recorded,
    deps,
  );
  return { status: "recorded", change };
}

const RECEIPT_WORDS: Record<DeliveryOutcomeDecision, string> = {
  record_live_url: "Live link recorded",
  switch_to_automatic: "Switched to automatic delivery",
  settled_elsewhere: "Settled on the board",
};

/**
 * The receipt that settles a follow-up: the prose line and the gate's structured outcome, posted
 * once — claimed before it is said, so an answer delivered twice, or the sweep racing an answer,
 * leaves one. Shared by an answer from the room and by the sweep, for a follow-up settled on the
 * board (`settled_elsewhere`, naming nobody). Best-effort: the board has the change by now, and a
 * receipt that cannot be posted must not turn it into a failure. True when THIS call claimed it.
 */
export async function settleDeliveryOutcome(
  gateId: string,
  decision: DeliveryOutcomeDecision,
  principalId: string | null,
  roomId: string,
  followUp: { boardId: string; eventId: string },
  deps: Pick<DeliveryAnswerDeps, "claimOutcome" | "displayNameFor" | "reply" | "sendOutcome">,
): Promise<boolean> {
  try {
    if (!(await deps.claimOutcome(gateId))) return false;
    const who = principalId ? ((await deps.displayNameFor?.(principalId)) ?? null) : null;
    const what = RECEIPT_WORDS[decision];
    await deps.reply(roomId, who ? `${what} by ${who} — the board has it.` : `${what} — the board has it.`);
    await deps.sendOutcome?.(roomId, deliveryOutcomeContent(gateId, followUp, decision, who));
    return true;
  } catch (err) {
    log.warn("delivery follow-up settled but its receipt could not be posted", {
      gateId,
      roomId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
