/**
 * The way back for attention.v2: a `dev.superpipeline.attention.answer.v2` becomes a resume or an
 * archive at the board — as the person who answered, naming the wait they were shown.
 *
 * charter → "Waiting cards and broker approvals reach chat" §2. Fails closed at every step, as a
 * delivery answer does: attribution first and silently, then the answer judged against what THIS
 * card offered when it was posted (`matrix_attention_events`), refused with a reply when it is
 * wrong. The board judges it again on its own terms — including who may work the board, which
 * only the board knows — and refuses a stale wait `WAIT_CHANGED`.
 */

import { createLogger } from "../../utils/logger";
import { IDENTITY_UNAVAILABLE_TEXT } from "../matrix";
import {
  ATTENTION_ANSWER_V2_SUITE_TYPE,
  ATTENTION_COMMENT_MAX,
  SETTLED_ELSEWHERE,
  attentionAction,
  attentionOutcomeContent,
  inputRefusal,
} from "@superjackfruitlabs/treaty-matrix-events";
import { referenceOf } from "./question-answer";
import type { WaitKey } from "./attention-projection";

const log = createLogger("matrix-attention");

const ID_MAX = 200;
/** Text past this is refused before anything else: no instruction the board takes is longer. */
const TEXT_READ_MAX = 16_000;

export interface ParsedAttentionAnswer extends WaitKey {
  optionId: string;
  /** Trimmed; null when absent or blank. For a resume, the instruction for the next attempt. */
  text: string | null;
  referencedEventId: string | null;
}

const idOk = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= ID_MAX;

/** Read an attention.answer.v2 out of an `m.room.message`, or null when it is not one. */
export function parseAttentionAnswer(content: unknown): ParsedAttentionAnswer | null {
  if (typeof content !== "object" || content === null) return null;
  if (!("suite_event_type" in content) || content.suite_event_type !== ATTENTION_ANSWER_V2_SUITE_TYPE) return null;
  const c = content as Record<string, unknown>;
  if (!idOk(c.board_id) || !idOk(c.card_id) || !idOk(c.wait_id) || !idOk(c.option_id)) return null;
  const text = typeof c.text === "string" && c.text.trim() !== "" ? c.text.trim() : null;
  return {
    boardId: c.board_id,
    cardId: c.card_id,
    waitId: c.wait_id,
    optionId: c.option_id,
    text,
    referencedEventId: referenceOf(content),
  };
}

/** What this hub recorded when it posted a waiting card (`recordedAttention`). */
export interface RecordedAttention extends WaitKey {
  roomId: string;
  /** The card's prose message: the one event an answer may reference. */
  eventId: string;
  options: ReadonlyArray<{ id: string; label: string; input?: { kind: "text" | "url"; required: boolean; max_length: number } }>;
}

/** Why an attention.answer.v2 was not carried. Every value is a refusal. */
export type AttentionAnswerRefusal =
  | "not-an-answer"
  | "unknown-card"
  | "reference-mismatch"
  | "unlinked-sender"
  | "identity-unavailable"
  /** A linked principal that is not a person: a waiting card is a person's to unblock. */
  | "not-human"
  | "bad-option"
  | "input-required"
  | "text-too-long";

export type AttentionAnswerOutcome =
  | { status: "done"; decision: string }
  | { status: "refused"; reason: AttentionAnswerRefusal }
  | { status: "refused"; reason: "board-refused"; code: string };

export type AttentionAction =
  | { kind: "resume"; toStageKey: string | null; comment: string }
  | { kind: "archive"; comment: string | null };

export interface AttentionAnswerDeps {
  principalForMatrixId(mxid: string): Promise<{ id: string; kind: "human" | "agent" | "service" } | null>;
  recordedAttention(k: WaitKey): Promise<RecordedAttention | null>;
  /** The board's resume or archive route, called as `principalId` (`answerAttentionAtSuperpipeline`). */
  answer(input: WaitKey & { action: AttentionAction; principalId: string; senderMxid: string }): Promise<
    { ok: true } | { ok: false; code: string }
  >;
  reply(roomId: string, body: string): Promise<unknown>;
  /** True exactly once per wait, so a repeated answer leaves one receipt. */
  claimOutcome(k: WaitKey): Promise<boolean>;
  /** How the receipt names the person who answered — their handle, not an mxid. */
  displayNameFor?(principalId: string): Promise<string | null>;
  /** Post the structured half of the receipt (`dev.superpipeline.attention.outcome.v1`) beside the prose. */
  sendOutcome?(roomId: string, content: Record<string, unknown>): Promise<unknown>;
  /** The card is off the fleet Live Activity once it is answered (`fleet-attention.ts`). */
  onClosed?(k: WaitKey): void;
}

type JudgeRefusal = "bad-option" | "input-required" | "text-too-long";

const REFUSAL_TEXT: Record<Exclude<JudgeRefusal, "text-too-long">, string> = {
  "bad-option": "That is not one of this card's choices. Nothing has changed.",
  "input-required": "Resuming needs an instruction for the next attempt. Nothing has changed.",
};

/** The board call an answer asks for, or why it must not be carried. */
function judge(
  parsed: ParsedAttentionAnswer,
  recorded: RecordedAttention,
): { action: AttentionAction } | { refusal: JudgeRefusal; limit?: number } {
  const option = recorded.options.find((o) => o.id === parsed.optionId);
  const action = option ? attentionAction(option.id) : null;
  if (!option || !action) return { refusal: "bad-option" };
  if (parsed.text !== null && parsed.text.length > TEXT_READ_MAX) return { refusal: "text-too-long", limit: ATTENTION_COMMENT_MAX };
  if (action.kind === "archive") {
    // Archive asks for nothing; a remark the person added rides as the board's optional comment.
    if (parsed.text !== null && parsed.text.length > ATTENTION_COMMENT_MAX) return { refusal: "text-too-long", limit: ATTENTION_COMMENT_MAX };
    return { action: { kind: "archive", comment: parsed.text } };
  }
  // Whatever the recorded input says, a resume takes a required instruction, within the board's limit.
  const max = Math.min(option.input?.max_length ?? ATTENTION_COMMENT_MAX, ATTENTION_COMMENT_MAX);
  const refused = inputRefusal({ kind: "text", required: true, max_length: max }, parsed.text);
  if (refused === "text-too-long") return { refusal: "text-too-long", limit: max };
  if (refused || parsed.text === null) return { refusal: "input-required" };
  return { action: { kind: "resume", toStageKey: action.toStageKey, comment: parsed.text } };
}

/** Said when the board refuses a stale wait; the card is then closed as settled elsewhere. */
export const WAIT_CHANGED_TEXT =
  "This card is no longer waiting on that — it was resumed, archived or moved on the board, or it is waiting on something else now. Nothing has changed.";

/** What the board's refusal becomes in the room. */
function boardRefusalText(code: string): string {
  switch (code) {
    case "IDENTITY_UNAVAILABLE":
      return IDENTITY_UNAVAILABLE_TEXT;
    case "ASSERTION_REFUSED":
    case "ASSERTION_MISMATCH":
      return `That did not go through (${code}): the account service would not vouch for you. Nothing has changed.`;
    case "FORBIDDEN":
    case "HTTP_403":
      return "The board says you can't do that: it needs someone who may work this board. Nothing has changed.";
    case "QUESTION_PENDING":
      return "The card has a question waiting. Answer that first. Nothing has changed.";
    case "GATE_PENDING":
      return "The card has a review waiting. Decide that first. Nothing has changed.";
    case "INVALID_RESUME":
      return "The board can't resume the card there. Open it on the board. Nothing has changed.";
    case "UNREACHABLE":
      return "That did not reach the board. Try again in a moment. Nothing has changed.";
    default:
      return `That did not go through (${code}). Nothing has changed.`;
  }
}

/**
 * Act on an attention.answer.v2, or refuse and say why. Every branch that is not `done` leaves
 * the board untouched.
 */
export async function handleAttentionAnswer(
  event: { sender: string; content: Record<string, unknown> },
  roomId: string,
  deps: AttentionAnswerDeps,
): Promise<AttentionAnswerOutcome> {
  const parsed = parseAttentionAnswer(event.content);
  if (!parsed) return { status: "refused", reason: "not-an-answer" };
  const key: WaitKey = { boardId: parsed.boardId, cardId: parsed.cardId, waitId: parsed.waitId };

  const recorded = await deps.recordedAttention(key);
  if (!recorded) {
    log.warn("an answer names a waiting card this hub never posted", { ...key });
    return { status: "refused", reason: "unknown-card" };
  }
  if (parsed.referencedEventId !== recorded.eventId || roomId !== recorded.roomId) {
    log.warn("a waiting card answer's reference and wait disagree", { ...key, referenced: parsed.referencedEventId });
    return { status: "refused", reason: "reference-mismatch" };
  }

  let principal: Awaited<ReturnType<AttentionAnswerDeps["principalForMatrixId"]>>;
  try {
    principal = await deps.principalForMatrixId(event.sender);
  } catch (error) {
    log.warn("could not resolve a waiting card answer's sender", {
      sender: event.sender,
      error: error instanceof Error ? error.message : String(error),
    });
    await deps.reply(roomId, IDENTITY_UNAVAILABLE_TEXT);
    return { status: "refused", reason: "identity-unavailable" };
  }
  if (!principal) {
    log.info("a waiting card answer from an unlinked sender, ignored", { sender: event.sender });
    return { status: "refused", reason: "unlinked-sender" };
  }
  if (principal.kind !== "human") {
    // An agent unblocking a card — its own or another's — is the property a waiting card exists
    // to deny. Warned, so somebody sees it.
    log.warn("a non-human principal tried to answer a waiting card", {
      sender: event.sender,
      principalId: principal.id,
      kind: principal.kind,
      ...key,
    });
    return { status: "refused", reason: "not-human" };
  }

  const verdict = judge(parsed, recorded);
  if ("refusal" in verdict) {
    log.warn("an attention.answer.v2 was refused before it reached the board", {
      ...key,
      optionId: parsed.optionId,
      reason: verdict.refusal,
    });
    await deps.reply(
      roomId,
      verdict.refusal === "text-too-long"
        ? `That is longer than the board takes (at most ${verdict.limit ?? ATTENTION_COMMENT_MAX} characters). Nothing has changed.`
        : REFUSAL_TEXT[verdict.refusal],
    );
    return { status: "refused", reason: verdict.refusal };
  }

  const result = await deps.answer({ ...key, action: verdict.action, principalId: principal.id, senderMxid: event.sender });
  if (!result.ok) {
    log.warn("superpipeline refused a waiting card answer", { ...key, code: result.code });
    if (result.code === "WAIT_CHANGED") {
      // The wait the person was shown has ended (or the card waits on something new, which is its
      // own card). Said in words, and the card closed with the structured outcome only.
      await deps.reply(roomId, WAIT_CHANGED_TEXT);
      await settleAttentionOutcome(recorded, SETTLED_ELSEWHERE, null, roomId, deps, { prose: false });
      return { status: "refused", reason: "board-refused", code: result.code };
    }
    await deps.reply(roomId, boardRefusalText(result.code));
    return { status: "refused", reason: "board-refused", code: result.code };
  }

  await settleAttentionOutcome(recorded, parsed.optionId, principal.id, roomId, deps);
  return { status: "done", decision: parsed.optionId };
}

/** The receipt's words for a decision, given the card's options. */
function receiptWords(decision: string, options: RecordedAttention["options"]): string {
  if (decision === SETTLED_ELSEWHERE) return "This card is no longer waiting — it was settled on the board";
  const action = attentionAction(decision);
  if (action?.kind === "archive") return "Archived";
  if (action?.kind === "resume" && action.toStageKey !== null) {
    const label = options.find((o) => o.id === decision)?.label;
    return label ? `Resumed (${label})` : `Resumed at ${action.toStageKey}`;
  }
  return "Resumed";
}

/**
 * The receipt that closes a waiting card: the prose line and the structured
 * `dev.superpipeline.attention.outcome.v1`, posted once — claimed before it is said, so an answer
 * delivered twice, or the sweep racing an answer, leaves one. Shared by an answer from the room
 * and by the sweep, for a wait that ended elsewhere (`settled_elsewhere`, naming nobody).
 * Best-effort: the board has the change by now. True when THIS call claimed it.
 */
export async function settleAttentionOutcome(
  card: RecordedAttention,
  decision: string,
  principalId: string | null,
  roomId: string,
  deps: Pick<AttentionAnswerDeps, "claimOutcome" | "displayNameFor" | "reply" | "sendOutcome" | "onClosed">,
  opts: { prose?: boolean } = {},
): Promise<boolean> {
  const key: WaitKey = { boardId: card.boardId, cardId: card.cardId, waitId: card.waitId };
  try {
    if (!(await deps.claimOutcome(key))) return false;
    deps.onClosed?.(key);
    const who = principalId ? ((await deps.displayNameFor?.(principalId)) ?? null) : null;
    if (opts.prose !== false) {
      const what = receiptWords(decision, card.options);
      await deps.reply(roomId, who ? `${what} by ${who} — the board has it.` : `${what}.`);
    }
    await deps.sendOutcome?.(roomId, attentionOutcomeContent(card, decision, who));
    return true;
  } catch (err) {
    log.warn("waiting card settled but its receipt could not be posted", {
      ...key,
      roomId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
