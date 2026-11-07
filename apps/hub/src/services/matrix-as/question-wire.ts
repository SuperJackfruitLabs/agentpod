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
  type GateOptionMeaning,
  type OptionInputV2,
} from "./gate-wire";

export const QUESTION_V2_SUITE_TYPE = "dev.superpipeline.question.v2";
export const QUESTION_ANSWER_V2_SUITE_TYPE = "dev.superpipeline.question.answer.v2";

/** The longest typed answer a question takes: the board's own limit (`ELICITATION_TEXT_MAX`). */
export const QUESTION_TEXT_MAX = 2000;

/** One option of a question.v2, as it rides on the Matrix wire. */
export interface QuestionOptionV2 {
  id: string;
  label: string;
  meaning: GateOptionMeaning;
  needs_comment: boolean;
  input?: OptionInputV2;
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
});

/**
 * The options a question offers, for question.v2: every option the board sent, in its order.
 *
 * An option without a usable id is dropped and a repeated id keeps its first entry — answering is
 * by id. `meaning` and `needs_comment` are the board's; an older board sends neither, and a
 * question's option then means `choose` and asks for no comment.
 */
export function questionOptionsV2(d: ElicitationPendingDelivery): QuestionOptionV2[] {
  const seen = new Set<string>();
  const out: QuestionOptionV2[] = [];
  for (const raw of d.options) {
    const parsed = RawOption.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const o = parsed.data;
    seen.add(o.id);
    const input = optionInputV2(o.input);
    out.push({
      id: o.id,
      label: o.label,
      meaning: o.meaning ?? "choose",
      needs_comment: o.needsComment ?? false,
      ...(input ? { input } : {}),
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
export function questionV2Content(d: ElicitationPendingDelivery, deepLink?: string): Record<string, unknown> {
  const freeText = questionFreeTextV2(d);
  return {
    msgtype: "m.text",
    body: elicitationProseBody(d, deepLink),
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
    ...(deepLink ? { deep_link: deepLink } : {}),
  };
}
