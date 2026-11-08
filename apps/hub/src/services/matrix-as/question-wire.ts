/**
 * question.v2: an agent's question in the decision envelope.
 *
 * charter → "The decision envelope covers questions and follow-ups" §2. The question's prose
 * message keeps the v1 card it has always carried (`dev.superpipeline.elicitation`, which today's
 * clients read) and also carries `suite_event_type: dev.superpipeline.question.v2`: options that
 * say what they mean, an option's input, and `free_text` on a question with no options. The same
 * pattern as gate.v2 (`gate-wire.ts`), whose bounding helpers this reuses.
 *
 * Pure; no database and no Matrix.
 */

import { z } from "zod";

import { elicitationProseBody, type ElicitationPendingDelivery } from "./elicitation-card";
import {
  GATE_OPTION_MEANINGS,
  cut,
  cutToBytes,
  optionInputV2,
  previewMarkdown,
  subjectV2,
  type GateOptionMeaning,
  type GateSubjectV2,
  type OptionInputV2,
} from "./gate-wire";

export const QUESTION_V2_SUITE_TYPE = "dev.superpipeline.question.v2";
export const QUESTION_ANSWER_V2_SUITE_TYPE = "dev.superpipeline.question.answer.v2";

/** The longest typed answer a question takes: the board's own limit (`ELICITATION_TEXT_MAX`). */
export const QUESTION_TEXT_MAX = 2000;

/**
 * How far an option reaches, and who may take it (charter: "Strict decisions and harness
 * permissions bind their subject" §2). A client shows them; the producer judges both.
 */
export const OPTION_SCOPES = ["once", "run", "always"] as const;
export type OptionScope = (typeof OPTION_SCOPES)[number];
export const OPTION_REQUIRES = ["workspace-admin"] as const;
export type OptionRequires = (typeof OPTION_REQUIRES)[number];

/** One option of a question.v2, as it rides on the Matrix wire. */
export interface QuestionOptionV2 {
  id: string;
  label: string;
  meaning: GateOptionMeaning;
  needs_comment: boolean;
  input?: OptionInputV2;
  scope?: OptionScope;
  requires?: OptionRequires;
}

/**
 * Bounds. A question rides three times in its prose message (the body, the v1 card's `prompt`,
 * question.v2's `question`) and its options twice or three times, and Matrix refuses an event over
 * 64 KiB before Megolm's base64 adds a third in an encrypted board room. Measured as JSON-encoded
 * UTF-8 bytes, the measure that fills an event, like the gate's preview budget.
 */
const QUESTION_BYTES = 3_000;
const CARD_TITLE_BYTES = 400;
const LABEL_BYTES = 400;
const OPTIONS_BYTES = 6_000;
const OPTIONS_LISTED_MAX = 50;
const OPTIONS_V2_MAX = 20;
const OPTION_ID_MAX = 200;
const LABEL_MAX = 200;

const utf8 = new TextEncoder();
const jsonBytes = (v: string): number => utf8.encode(JSON.stringify(v)).length;

/** What one option costs against `OPTIONS_BYTES`: its id, its label and any input's label. */
function optionBytes(o: ElicitationPendingDelivery["options"][number]): number {
  const input = optionInputV2(o.input);
  return jsonBytes(o.id) + jsonBytes(o.label) + (input ? jsonBytes(input.label) : 0);
}

/**
 * The question, bounded so its prose message fits one event — everything the room is shown is
 * derived from this, so the v1 card, the prose and question.v2 all show the same options, and a
 * reply by number is matched against exactly what was listed.
 *
 * An ordinary question comes back unchanged. A title, question or label past its budget is cut
 * and marked; an option with an id too long to answer by is dropped, and options past the total
 * budget are not listed (the card's link still reaches them on the board).
 */
export function boundedQuestion(d: ElicitationPendingDelivery): ElicitationPendingDelivery {
  const options: ElicitationPendingDelivery["options"] = [];
  let used = 0;
  for (const raw of d.options) {
    if (raw.id.length > OPTION_ID_MAX) continue;
    const label = cutToBytes(raw.label, LABEL_BYTES);
    const o = label === raw.label ? raw : { ...raw, label };
    const cost = optionBytes(o);
    if (used + cost > OPTIONS_BYTES || options.length === OPTIONS_LISTED_MAX) break;
    used += cost;
    options.push(o);
  }
  const cardTitle = cutToBytes(d.cardTitle, CARD_TITLE_BYTES);
  const question = cutToBytes(d.question, QUESTION_BYTES);
  const same = options.length === d.options.length && options.every((o, i) => o === d.options[i]);
  if (same && cardTitle === d.cardTitle && question === d.question) return d;
  return { ...d, cardTitle, question, options };
}

const RawOption = z.object({
  id: z.string().min(1).max(OPTION_ID_MAX),
  label: z.string().transform(cut(LABEL_MAX)),
  meaning: z.enum(GATE_OPTION_MEANINGS).optional().catch(undefined),
  needsComment: z.boolean().optional().catch(undefined),
  input: z.unknown().optional(),
  scope: z.enum(OPTION_SCOPES).optional().catch(undefined),
  requires: z.enum(OPTION_REQUIRES).optional().catch(undefined),
});

/**
 * The subject a question is bound to — a strict decision's operation or a board-dispatched harness
 * permission — re-validated and re-bounded exactly like a gate's (`subjectV2`), or null when it is
 * bound to none or sent something this hub cannot carry. The digest is opaque here: compared byte
 * for byte, never computed.
 */
export function questionSubjectV2(d: ElicitationPendingDelivery): GateSubjectV2 | null {
  return d.approvalSubject == null ? null : subjectV2(d.approvalSubject);
}

/**
 * The options a question offers, for question.v2: every option the board sent, in its order.
 *
 * An option without a usable id is dropped and a repeated id keeps its first entry — answering is
 * by id. `meaning` and `needs_comment` are the board's; an older board sends neither, and a
 * question's option then means `choose` and asks for no comment.
 */
export function questionOptionsV2(d: ElicitationPendingDelivery): QuestionOptionV2[] {
  // The board said this question is bound to a subject and the hub could not carry it: nothing
  // here could show what an approval approves, so no approving option is offered (the gate rule).
  const subjectShowable = d.approvalSubject == null || questionSubjectV2(d) !== null;
  const seen = new Set<string>();
  const out: QuestionOptionV2[] = [];
  for (const raw of d.options) {
    const parsed = RawOption.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const o = parsed.data;
    const meaning = o.meaning ?? "choose";
    if (!subjectShowable && meaning === "approve") continue;
    seen.add(o.id);
    const input = optionInputV2(o.input);
    out.push({
      id: o.id,
      label: o.label,
      meaning,
      needs_comment: o.needsComment ?? false,
      ...(input ? { input } : {}),
      ...(o.scope ? { scope: o.scope } : {}),
      ...(o.requires ? { requires: o.requires } : {}),
    });
    if (out.length === OPTIONS_V2_MAX) break;
  }
  return out;
}

const RawFreeText = z.object({ maxLength: z.number().int().positive() });

/**
 * A question with no options is answered by typing: at most the board's `freeText.maxLength`,
 * never past `QUESTION_TEXT_MAX`. An older board that says nothing still takes text on its answer
 * route, so it gets the limit too. Null when the question has options.
 */
export function questionFreeTextV2(d: ElicitationPendingDelivery): { max_length: number } | null {
  if (d.options.length > 0) return null;
  const parsed = RawFreeText.safeParse(d.freeText);
  const max = parsed.success ? Math.min(parsed.data.maxLength, QUESTION_TEXT_MAX) : QUESTION_TEXT_MAX;
  return { max_length: max };
}

/**
 * The question.v2 content: an `m.room.message` / `m.text` with the question's real prose body and
 * the `suite_event_type` marker. The v1 card rides beside it under its own key, unchanged.
 * Expects a `boundedQuestion`.
 */
/**
 * What a stock client reads under a question bound to a subject. A typed reply cannot approve one
 * (`handleElicitationAnswer`): the person never saw what it approves, which only question.v2's
 * preview shows.
 */
export const SUBJECT_QUESTION_NOTE =
  "This approves an exact operation. Approve it in an updated app, which shows what it does, or on the board. A reply here can only decline it.";

/**
 * Is this a SuperToolkit approval request hosted on the board (charter: "Waiting cards and broker
 * approvals reach chat" §3)? It belongs to no card, run or stage: the board sends them empty, and
 * names the request in `approvalRequestId`. Either is enough here — a question with no card can
 * be described only by what it asks, never as a card at a stage.
 */
export function isApprovalRequest(d: Pick<ElicitationPendingDelivery, "cardId" | "approvalRequestId">): boolean {
  return d.cardId === "" || (typeof d.approvalRequestId === "string" && d.approvalRequestId !== "");
}

/** What a stock client reads under an approval request, after its choices. */
export const APPROVAL_REQUEST_NOTE =
  "Only workspace owners and admins can allow this. Allow it in an updated app, which shows exactly what it does. A reply here can only deny it.";

/**
 * An approval request's prose: what is asked, the exact request (the subject's preview, fenced as a
 * gate's is), the numbered choices, and who may allow it. No card and no link: there is none.
 */
function approvalRequestProse(d: ElicitationPendingDelivery): string {
  const subject = questionSubjectV2(d);
  const head = "A SuperToolkit approval request is waiting on a workspace owner or admin.";
  const asked = d.question.trim();
  const preview = subject ? previewMarkdown(subject.preview) : "";
  const shown =
    subject && !subject.preview_complete ? "The request could not be shown in full here, so it cannot be allowed from this room." : "";
  const numbered = d.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
  return [head, asked, preview, shown, numbered, APPROVAL_REQUEST_NOTE].filter((part) => part !== "").join("\n\n");
}

/** The question's prose: as before, with the note above when it is bound to a subject. */
export function questionProseBody(d: ElicitationPendingDelivery, deepLink?: string): string {
  if (isApprovalRequest(d)) return approvalRequestProse(d);
  const prose = elicitationProseBody(d, deepLink);
  return d.approvalSubject == null || d.options.length === 0 ? prose : `${prose}\n\n${SUBJECT_QUESTION_NOTE}`;
}

export function questionV2Content(d: ElicitationPendingDelivery, deepLink?: string): Record<string, unknown> {
  const freeText = questionFreeTextV2(d);
  const subject = questionSubjectV2(d);
  return {
    msgtype: "m.text",
    body: questionProseBody(d, deepLink),
    suite_event_type: QUESTION_V2_SUITE_TYPE,
    schema_version: 1,
    elicitation_id: d.elicitationId,
    board_id: d.boardId,
    card_id: d.cardId,
    run_id: d.runId,
    stage_key: d.stageKey,
    card_title: d.cardTitle,
    asked_by: d.agentId,
    question: d.question,
    options: questionOptionsV2(d),
    ...(freeText ? { free_text: freeText } : {}),
    ...(subject ? { subject } : {}),
    ...(typeof d.approvalRequestId === "string" && d.approvalRequestId !== "" ? { approval_request_id: d.approvalRequestId } : {}),
    ...(deepLink ? { deep_link: deepLink } : {}),
  };
}
