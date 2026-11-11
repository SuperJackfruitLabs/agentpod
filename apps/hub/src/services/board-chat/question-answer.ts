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
import { inputRefusal, QUESTION_ANSWER_V2_SUITE_TYPE } from "@superjackfruitlabs/treaty-matrix-events";

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
  /** The binding copied from the question the person saw; absent when the answer carries none. */
  subject?: { id: string; digest: string };
}

/** The longest subject id or digest read off an answer — the gate's bound. */
const SUBJECT_KEY_MAX = 512;

/**
 * An answer's `subject {id, digest}`, or null when it carries none or one that is not two
 * non-empty strings. Shared with the permission answer.
 */
export function bindingOf(content: object): { id: string; digest: string } | null {
  if (!("subject" in content)) return null;
  const s = content.subject;
  if (typeof s !== "object" || s === null || !("id" in s) || !("digest" in s)) return null;
  const { id, digest } = s;
  if (typeof id !== "string" || typeof digest !== "string") return null;
  if (id === "" || digest === "" || id.length > SUBJECT_KEY_MAX || digest.length > SUBJECT_KEY_MAX) return null;
  return { id, digest };
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
  const subject = bindingOf(content);
  return { elicitationId, optionId, text, referencedEventId: referenceOf(content), ...(subject ? { subject } : {}) };
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
  /**
   * A SuperToolkit approval request (`isApprovalRequest`, recorded when it was posted): answered by a
   * person only, and never approved without a recorded subject.
   */
  approvalRequest?: boolean;
  roomId: string;
  /** The question's prose message: the one event an answer may reference. */
  eventId: string;
  /** The options its question.v2 carried; null for a question posted before question.v2. */
  options: ReadonlyArray<{
    id: string;
    label: string;
    meaning?: string;
    input?: { kind: "text" | "url"; required: boolean; max_length: number };
  }> | null;
  /** Present when the question has no options and is answered by typing. */
  freeText: { max_length: number } | null;
  /** The subject its question.v2 carried; null or absent when it is bound to none. */
  subject?: RecordedSubject | null;
}

/** A subject's binding as this hub recorded it when it posted the question. */
export interface RecordedSubject {
  id: string;
  digest: string;
  /** False (or unknown) refuses an approving answer: the card could not show it all. */
  previewComplete: boolean;
  /** Null when the subject named no expiry this hub could read; the board still judges it. */
  expiresAt: Date | null;
}

/**
 * Why an answer to a subject-bound question must not be carried, or null. The order is the gate's
 * (`v2Refusal`): a binding first, then its match, then expiry, then the preview rule for approvals.
 * Shared by question.answer.v2 and a typed reply, so the two cannot come to disagree.
 */
export function subjectRefusal(
  recorded: RecordedSubject,
  binding: { id: string; digest: string } | null,
  meaning: string | undefined,
  now: Date,
): SubjectRefusal | null {
  if (!binding) return "subject-missing";
  if (binding.id !== recorded.id || binding.digest !== recorded.digest) return "subject-mismatch";
  if (recorded.expiresAt !== null && now.getTime() >= recorded.expiresAt.getTime()) return "expired";
  if (meaning === "approve" && !recorded.previewComplete) return "preview-incomplete";
  return null;
}

export type SubjectRefusal = "subject-missing" | "subject-mismatch" | "expired" | "preview-incomplete";

/** What the room is told for each, and the board's own codes for the same two situations. */
export const SUBJECT_REFUSAL_TEXT: Record<SubjectRefusal, string> = {
  "subject-missing": "That answer did not say which version it answers. Nothing has changed.",
  "subject-mismatch": "That answer was for a different version of this decision. Open the latest one and answer again. Nothing has changed.",
  expired: "This decision has expired, so it can no longer be answered. Nothing has changed.",
  "preview-incomplete":
    "The card could not show everything being approved, so it cannot be approved from here. Open it on the board. Nothing has changed.",
};

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
  | SubjectRefusal
  /** A linked principal that is not a person answering an approval request: the hub carries only a person's answer. */
  | "not-human"
  /** An approval of an approval request whose subject was never carried: nothing showed what it allows. */
  | "approval-unbound"
  /** The board refused it; `code` says why. */
  | "board-refused";

export interface QuestionAnswerDeps extends Pick<ElicitationAnswerDeps, "principalForMatrixId" | "reply" | "claimOutcome"> {
  recordedQuestion(elicitationId: string): Promise<RecordedQuestion | null>;
  /**
   * The board's answer route as the person (`answerElicitationAtSuperpipeline`): an option, text,
   * or both — and the subject binding, on a question bound to one.
   */
  answer(input: {
    boardId: string;
    elicitationId: string;
    option?: string;
    text?: string;
    subject?: { id: string; digest: string };
    principalId: string;
    senderMxid: string;
  }): Promise<{ ok: true } | { ok: false; code: string }>;
  /** The clock expiry is judged by. Absent: the real one. */
  now?(): Date;
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

type Verdict =
  | { option?: string; text?: string; subject?: { id: string; digest: string }; label: string | null }
  | { refusal: "bad-option" | "input-required" | "text-too-long" | "url-invalid" | "approval-unbound" | SubjectRefusal; limit?: number };

/** Said when an approval request whose subject was never carried is asked to allow. */
export const APPROVAL_UNBOUND_TEXT =
  "This request could not be shown here, so it cannot be allowed from this room. Nothing has changed.";

/**
 * What the answer would pass to the board, or why it must not: checked against what THIS
 * question offered when it was posted — and, on a question bound to a subject, against the binding
 * recorded then (charter: strict decisions and harness permissions bind their subject §4).
 */
function judge(parsed: ParsedQuestionAnswer, q: RecordedQuestion, now: Date): Verdict {
  const verdict = judgeOption(parsed, q);
  if ("refusal" in verdict) return verdict;
  if (!q.subject) {
    // Fail closed: an approval request with no recorded subject is never approved from here,
    // whatever its recorded options say. Only an explicit decline goes on.
    const meaning = q.options?.find((o) => o.id === verdict.option)?.meaning;
    if (q.approvalRequest === true && meaning !== "reject") return { refusal: "approval-unbound" };
    return verdict;
  }
  const meaning = q.options?.find((o) => o.id === verdict.option)?.meaning;
  const refused = subjectRefusal(q.subject, parsed.subject ?? null, meaning, now);
  if (refused) return { refusal: refused };
  return { ...verdict, subject: { id: q.subject.id, digest: q.subject.digest } };
}

function judgeOption(
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

function refusalText(r: "bad-option" | "input-required" | "url-invalid" | "approval-unbound" | SubjectRefusal): string {
  if (r === "approval-unbound") return APPROVAL_UNBOUND_TEXT;
  return r === "bad-option" || r === "input-required" || r === "url-invalid" ? REFUSAL_TEXT[r] : SUBJECT_REFUSAL_TEXT[r];
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
  if (q.approvalRequest === true && identity.kind !== "human") {
    // Charter §5: the hub only carries a person's answer to an approval request. Another agent in
    // the room — the board stops only the requester — must not decide it, not even to deny.
    log.warn("a non-human principal tried to answer an approval request", {
      sender: event.sender,
      principalId: identity.id,
      kind: identity.kind,
      elicitationId: parsed.elicitationId,
    });
    return { status: "refused", reason: "not-human" };
  }

  const verdict = judge(parsed, q, deps.now?.() ?? new Date());
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
        : refusalText(verdict.refusal),
    );
    return { status: "refused", reason: verdict.refusal };
  }

  const result = await deps.answer({
    boardId: q.boardId,
    elicitationId: parsed.elicitationId,
    ...(verdict.option !== undefined ? { option: verdict.option } : {}),
    ...(verdict.text !== undefined ? { text: verdict.text } : {}),
    ...(verdict.subject ? { subject: verdict.subject } : {}),
    principalId: identity.id,
    senderMxid: event.sender,
  });
  const reported = await reportAnswer(result, parsed.elicitationId, verdict.label, roomId, deps, {
    approvalRequest: q.approvalRequest === true,
  });
  return reported.status === "answered" ? reported : { status: "refused", reason: "board-refused", code: reported.code };
}
