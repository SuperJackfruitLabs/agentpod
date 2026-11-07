/**
 * The way back for question.v2: a `dev.superpipeline.question.answer.v2` becomes an answer at the
 * board, as the person who gave it.
 *
 * charter → "The decision envelope covers questions and follow-ups" §2. Unlike a typed reply
 * (`handleElicitationAnswer`), which is matched against whatever question is open in the room, a
 * structured answer names its question and references the message that asked it — the way a gate
 * decision does, with the same attribution refusals. It is judged against the options RECORDED for
 * that question when it was posted (`matrix_elicitation_events.options_v2`), never a list; the
 * board judges it again on its own terms.
 */

import { createLogger } from "../../utils/logger";
import { IDENTITY_UNAVAILABLE_TEXT } from "../matrix";
import { reportAnswer, type ElicitationAnswerDeps } from "./elicitations";
import { inputRefusal } from "./gate-wire";
import { QUESTION_ANSWER_V2_SUITE_TYPE } from "./question-wire";

const log = createLogger("matrix-elicitations");

/** The longest id read off an answer; anything longer names nothing this hub posted. */
const ID_MAX = 200;
/** Text past this is refused whatever the question allows: no option or question takes more. */
const TEXT_READ_MAX = 16_000;

export interface ParsedQuestionAnswer {
  elicitationId: string;
  /** Null for a free-text answer. */
  optionId: string | null;
  /** Trimmed; null when absent or blank. */
  text: string | null;
  referencedEventId: string | null;
}

/**
 * Read a question.answer.v2 out of an `m.room.message`, or null when it is not one.
 *
 * `m.relates_to` must be an `m.reference`, for the reason a gate decision's must: `m.in_reply_to`
 * is set by every client that quotes, so accepting it would let a quoted reply answer a question.
 */
export function parseQuestionAnswer(content: unknown): ParsedQuestionAnswer | null {
  if (typeof content !== "object" || content === null) return null;
  if (!("suite_event_type" in content) || content.suite_event_type !== QUESTION_ANSWER_V2_SUITE_TYPE) return null;
  if (!("elicitation_id" in content)) return null;
  const elicitationId = content.elicitation_id;
  if (typeof elicitationId !== "string" || elicitationId.length === 0 || elicitationId.length > ID_MAX) return null;
  const optionId = "option_id" in content && typeof content.option_id === "string" && content.option_id !== "" ? content.option_id : null;
  const text = "text" in content && typeof content.text === "string" && content.text.trim() !== "" ? content.text.trim() : null;
  return { elicitationId, optionId, text, referencedEventId: referenceOf(content) };
}

/** The event an `m.reference` relation points at, or null. Shared with the delivery answer. */
export function referenceOf(content: object): string | null {
  if (!("m.relates_to" in content)) return null;
  const rel = content["m.relates_to"];
  if (typeof rel !== "object" || rel === null) return null;
  if (!("rel_type" in rel) || rel.rel_type !== "m.reference") return null;
  if (!("event_id" in rel) || typeof rel.event_id !== "string") return null;
  return rel.event_id;
}

/** What this hub recorded when it posted a question (`recordedQuestion`). */
export interface RecordedQuestion {
  boardId: string;
  roomId: string;
  /** The question's prose message: the one event an answer may reference. */
  eventId: string;
  /** The options its question.v2 carried; null for a question posted before question.v2. */
  options: ReadonlyArray<{
    id: string;
    label: string;
    input?: { kind: "text" | "url"; required: boolean; max_length: number };
  }> | null;
  /** Present when the question has no options and is answered by typing. */
  freeText: { max_length: number } | null;
}

/** Why a question.answer.v2 was not carried. Every value is a refusal. */
export type QuestionAnswerRefusal =
  | "not-an-answer"
  | "unknown-question"
  | "reference-mismatch"
  | "unlinked-sender"
  | "identity-unavailable"
  /** An option the question was not recorded as offering — or text alone on a question with options. */
  | "bad-option"
  | "input-required"
  | "text-too-long"
  | "url-invalid"
  /** The board refused it; `code` says why. */
  | "board-refused";

export interface QuestionAnswerDeps extends Pick<ElicitationAnswerDeps, "principalForMatrixId" | "reply" | "claimOutcome"> {
  recordedQuestion(elicitationId: string): Promise<RecordedQuestion | null>;
  /** The board's answer route as the person (`answerElicitationAtSuperpipeline`): an option, text, or both. */
  answer(input: {
    boardId: string;
    elicitationId: string;
    option?: string;
    text?: string;
    principalId: string;
    senderMxid: string;
  }): Promise<{ ok: true } | { ok: false; code: string }>;
}

export type QuestionAnswerOutcome =
  | { status: "answered"; elicitationId: string }
  | { status: "refused"; reason: Exclude<QuestionAnswerRefusal, "board-refused"> }
  | { status: "refused"; reason: "board-refused"; code: string };

const REFUSAL_TEXT: Record<"bad-option" | "input-required" | "url-invalid", string> = {
  "bad-option": "That is not one of this question's options. Nothing has changed.",
  "input-required": "That answer needs some text. Nothing has changed.",
  "url-invalid": "That answer needs an https:// link. Nothing has changed.",
};

/**
 * What the answer would pass to the board, or why it must not: checked against what THIS
 * question offered when it was posted.
 */
function judge(
  parsed: ParsedQuestionAnswer,
  q: RecordedQuestion,
): { option?: string; text?: string; label: string | null } | { refusal: "bad-option" | "input-required" | "text-too-long" | "url-invalid"; limit?: number } {
  if (parsed.text !== null && parsed.text.length > TEXT_READ_MAX) return { refusal: "text-too-long", limit: TEXT_READ_MAX };
  if (parsed.optionId === null) {
    // Text alone answers only a question with nothing to choose.
    if (!q.freeText) return { refusal: "bad-option" };
    const refused = inputRefusal({ kind: "text", required: true, max_length: q.freeText.max_length }, parsed.text);
    if (refused) return { refusal: refused, limit: q.freeText.max_length };
    return { text: parsed.text ?? "", label: null };
  }
  const option = q.options?.find((o) => o.id === parsed.optionId);
  if (!option) return { refusal: "bad-option" };
  if (!option.input) return { option: option.id, label: option.label };
  const refused = inputRefusal(option.input, parsed.text);
  if (refused) return { refusal: refused, limit: option.input.max_length };
  return { option: option.id, ...(parsed.text !== null ? { text: parsed.text } : {}), label: option.label };
}

/**
 * Act on a question.answer.v2, or refuse and say why.
 *
 * Attribution first, and silently, as for a gate: a stranger, an unlinked sender or an answer
 * pointing at a message that is not the question's must not make this hub speak. Only then the
 * answer itself, refused with a reply when it is wrong.
 */
export async function handleQuestionAnswer(
  event: { sender: string; content: Record<string, unknown> },
  roomId: string,
  deps: QuestionAnswerDeps,
): Promise<QuestionAnswerOutcome> {
  const parsed = parseQuestionAnswer(event.content);
  if (!parsed) return { status: "refused", reason: "not-an-answer" };

  const q = await deps.recordedQuestion(parsed.elicitationId);
  if (!q) {
    log.warn("an answer names a question this hub never posted", { elicitationId: parsed.elicitationId });
    return { status: "refused", reason: "unknown-question" };
  }
  // Both the id and the reference, checked against each other — and the room, so an answer
  // sent elsewhere cannot reach a question by naming its message.
  if (parsed.referencedEventId !== q.eventId || roomId !== q.roomId) {
    log.warn("an answer's reference and question disagree", {
      elicitationId: parsed.elicitationId,
      referenced: parsed.referencedEventId,
    });
    return { status: "refused", reason: "reference-mismatch" };
  }

  let identity: Awaited<ReturnType<QuestionAnswerDeps["principalForMatrixId"]>>;
  try {
    identity = await deps.principalForMatrixId(event.sender);
  } catch (error) {
    log.warn("could not resolve an answer's sender", {
      sender: event.sender,
      error: error instanceof Error ? error.message : String(error),
    });
    await deps.reply(roomId, IDENTITY_UNAVAILABLE_TEXT);
    return { status: "refused", reason: "identity-unavailable" };
  }
  if (!identity) {
    log.info("an answer from an unlinked sender, ignored", { sender: event.sender });
    return { status: "refused", reason: "unlinked-sender" };
  }

  const verdict = judge(parsed, q);
  if ("refusal" in verdict) {
    log.warn("a question.answer.v2 was refused before it reached the board", {
      elicitationId: parsed.elicitationId,
      optionId: parsed.optionId,
      reason: verdict.refusal,
    });
    await deps.reply(
      roomId,
      verdict.refusal === "text-too-long"
        ? `That answer is longer than this question takes (at most ${verdict.limit ?? 0} characters). Nothing has changed.`
        : REFUSAL_TEXT[verdict.refusal],
    );
    return { status: "refused", reason: verdict.refusal };
  }

  const result = await deps.answer({
    boardId: q.boardId,
    elicitationId: parsed.elicitationId,
    ...(verdict.option !== undefined ? { option: verdict.option } : {}),
    ...(verdict.text !== undefined ? { text: verdict.text } : {}),
    principalId: identity.id,
    senderMxid: event.sender,
  });
  const reported = await reportAnswer(result, parsed.elicitationId, verdict.label, roomId, deps);
  return reported.status === "answered" ? reported : { status: "refused", reason: "board-refused", code: reported.code };
}
