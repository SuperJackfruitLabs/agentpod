/**
 * attention.v2: a card waiting on a person — repeated failure, blocked, not authorised — in its
 * board room, with what chat may do about it.
 *
 * charter → "Waiting cards and broker approvals reach chat" §1–2. The board pushes
 * `attention.pending` when a card parks for a person for a reason other than a question or a
 * review (and lists it at `GET /v1/boards/:id/attention/pending` until that wait ends). The hub
 * posts it into the card's board room as one `m.room.message` / `m.text` with a real body and
 * `suite_event_type: dev.superpipeline.attention.v2` — the gate.v2 message shape. There is no v1
 * card to ride beside, so the prose stands alone for a client that has never heard of it.
 *
 * Pure; no database and no Matrix. Nothing is frozen, so there is no subject. Only the three
 * answers this hub can carry are offered: resume here, resume at an earlier stage, archive.
 * Forward moves are not: a move skips the stage's work and cancels its gates, which deserves the
 * board.
 */

import { z } from "zod";
import { deadlineField } from "./decision-timeout-wire";

import type { AttentionPendingDelivery } from "../bridge";
import {
  GATE_OPTION_MEANINGS,
  cut,
  cutToBytes,
  optionInputV2,
  type GateOptionMeaning,
  type OptionInputV2,
} from "./gate-wire";

export type { AttentionPendingDelivery };

export const ATTENTION_V2_SUITE_TYPE = "dev.superpipeline.attention.v2";
export const ATTENTION_ANSWER_V2_SUITE_TYPE = "dev.superpipeline.attention.answer.v2";
/**
 * The receipt that closes a waiting card. Its own type rather than `gate.outcome.v1`: that one is
 * keyed by `gate_id`, and a wait has no gate — borrowing the field would hand a client a gate id
 * that names nothing.
 */
export const ATTENTION_OUTCOME_TYPE = "dev.superpipeline.attention.outcome.v1";

export const RESUME_HERE = "resume_here";
export const RESUME_AT_PREFIX = "resume_at:";
export const ARCHIVE = "archive";

/**
 * The longest instruction the board takes, in characters: a comment is bounded at 8192 bytes, and
 * a character is at most three of them. Whatever a board advertises, never more.
 */
export const ATTENTION_COMMENT_MAX = 2730;

const LABEL_MAX = 200;
const OPTION_ID_MAX = 200;
const OPTIONS_MAX = 20;
const REASON_MAX = 64;
const CARD_TITLE_BYTES = 400;
const DETAIL_BYTES = 4_000;
const SUMMARY_BYTES = 1_000;

/** What an instruction asks for when the board did not say. */
const DEFAULT_INPUT_LABEL = "What should the next attempt do?";

/** One option of an attention.v2, as it rides on the Matrix wire. */
export interface AttentionOptionV2 {
  id: string;
  label: string;
  meaning: GateOptionMeaning;
  needs_comment: boolean;
  input?: OptionInputV2;
}

/**
 * Is this a waiting card this hub knows how to post? Used on both inbound paths — the signed push
 * and the sweep's read — for the reason `isGatePending` gives: "authenticated" is not "checked".
 * A card with no wait id has nothing an answer could name, so it is refused here.
 */
export function isAttentionPending(v: unknown): v is AttentionPendingDelivery {
  if (typeof v !== "object" || v === null) return false;
  if (!("event" in v) || v.event !== "attention.pending") return false;
  return (
    "boardId" in v &&
    typeof v.boardId === "string" &&
    v.boardId.length > 0 &&
    "cardId" in v &&
    typeof v.cardId === "string" &&
    v.cardId.length > 0 &&
    "cardTitle" in v &&
    typeof v.cardTitle === "string" &&
    "stageKey" in v &&
    typeof v.stageKey === "string" &&
    "waitId" in v &&
    typeof v.waitId === "string" &&
    v.waitId.length > 0 &&
    v.waitId.length <= OPTION_ID_MAX &&
    "reason" in v &&
    typeof v.reason === "string" &&
    v.reason.length > 0 &&
    "options" in v &&
    Array.isArray(v.options)
  );
}

const RawOption = z.object({
  id: z.string().min(1).max(OPTION_ID_MAX),
  label: z.string().min(1).transform(cut(LABEL_MAX)),
  meaning: z.enum(GATE_OPTION_MEANINGS).optional().catch(undefined),
  needsComment: z.boolean().optional().catch(undefined),
  input: z.unknown().optional(),
});

/** Which of the three answers an option id is, or null when it is none this hub can carry. */
export function attentionAction(
  id: string,
): { kind: "resume"; toStageKey: string | null } | { kind: "archive" } | null {
  if (id === RESUME_HERE) return { kind: "resume", toStageKey: null };
  if (id === ARCHIVE) return { kind: "archive" };
  if (id.startsWith(RESUME_AT_PREFIX) && id.length > RESUME_AT_PREFIX.length) {
    return { kind: "resume", toStageKey: id.slice(RESUME_AT_PREFIX.length) };
  }
  return null;
}

const DEFAULT_MEANING: Record<"here" | "at" | "archive", GateOptionMeaning> = {
  here: "approve",
  at: "choose",
  archive: "reject",
};

/**
 * The options a waiting card offers, for attention.v2, in the board's order.
 *
 * A resume always asks for a required text instruction, at most `ATTENTION_COMMENT_MAX`
 * characters, whatever an older board said about its input: the board refuses a resume without
 * one. Archive asks for nothing. Any other option is dropped — there is no call to make for it,
 * and a forward move is the board's to offer, not chat's.
 */
export function attentionOptionsV2(d: AttentionPendingDelivery): AttentionOptionV2[] {
  const seen = new Set<string>();
  const out: AttentionOptionV2[] = [];
  for (const raw of d.options) {
    const parsed = RawOption.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const o = parsed.data;
    const action = attentionAction(o.id);
    if (!action) continue;
    seen.add(o.id);
    if (action.kind === "archive") {
      out.push({ id: o.id, label: o.label, meaning: o.meaning ?? DEFAULT_MEANING.archive, needs_comment: false });
    } else {
      const asked = optionInputV2(o.input);
      out.push({
        id: o.id,
        label: o.label,
        meaning: o.meaning ?? (action.toStageKey === null ? DEFAULT_MEANING.here : DEFAULT_MEANING.at),
        needs_comment: o.needsComment ?? false,
        input: {
          kind: "text",
          label: asked?.label ?? DEFAULT_INPUT_LABEL,
          required: true,
          max_length: Math.min(asked?.max_length ?? ATTENTION_COMMENT_MAX, ATTENTION_COMMENT_MAX),
        },
      });
    }
    if (out.length === OPTIONS_MAX) break;
  }
  return out;
}

/** A string field off the wire, bounded; null when it is absent, blank or not a string. */
function boundedText(v: unknown, bytes: number): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  return cutToBytes(v, bytes);
}

/** The failure count, when the board gave a sensible one. */
function failureCountOf(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v < 1_000_000 ? v : null;
}

/** The stage's name, or its key when the board sent none. */
function stageNameOf(d: AttentionPendingDelivery): string {
  return typeof d.stageName === "string" && d.stageName.trim() !== "" ? cut(LABEL_MAX)(d.stageName) : cut(LABEL_MAX)(d.stageKey);
}

/** What happened, in words, after "<card> at <stage>". */
function reasonWords(reason: string, failureCount: number | null): string {
  if (reason === "blocked") return "is blocked.";
  if (reason === "not-authorised") return "is not authorised to go on.";
  if (reason === "repeated-failure") return failureCount ? `has failed ${failureCount} times.` : "keeps failing.";
  return "needs a person.";
}

/** Fence a text so markdown keeps every character of it — an agent wrote it, not this hub. */
function fenced(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * The sentence a stock client sees. It has to stand alone — no older card rides beside it — so it
 * says what is wrong, what the agent said, the choices, and where they can be made.
 */
export function attentionProseBody(d: AttentionPendingDelivery, options: AttentionOptionV2[], link?: string): string {
  const failures = failureCountOf(d.failureCount);
  const title = cutToBytes(d.cardTitle, CARD_TITLE_BYTES);
  const head = `A card is waiting on you — "${title}" at ${stageNameOf(d)} ${reasonWords(d.reason, failures)}`;
  const summary = boundedText(d.summary, SUMMARY_BYTES);
  const detail = boundedText(d.detail, DETAIL_BYTES);
  const said = detail && detail !== summary ? fenced(detail) : "";
  const choices = options.length > 0 ? options.map((o) => `- ${o.label}`).join("\n") : "";
  const where = link
    ? `Choose in an updated app, or [open the card](${link}) on the board.`
    : "Choose in an updated app, or open the card on the board.";
  return [head, summary ?? "", said, choices, where].filter((part) => part !== "").join("\n\n");
}

/** The attention.v2 content. Pinned by the shared fixture. */
export function attentionV2Content(d: AttentionPendingDelivery, deepLink?: string): Record<string, unknown> {
  const options = attentionOptionsV2(d);
  return {
    msgtype: "m.text",
    body: attentionProseBody(d, options, deepLink),
    suite_event_type: ATTENTION_V2_SUITE_TYPE,
    schema_version: 1,
    board_id: d.boardId,
    card_id: d.cardId,
    card_title: cutToBytes(d.cardTitle, CARD_TITLE_BYTES),
    stage_key: d.stageKey,
    stage_name: stageNameOf(d),
    wait_id: d.waitId,
    reason: cut(REASON_MAX)(d.reason),
    detail: boundedText(d.detail, DETAIL_BYTES),
    summary: boundedText(d.summary, SUMMARY_BYTES),
    failure_count: failureCountOf(d.failureCount),
    options,
    ...deadlineField(d.deadline),
    ...(deepLink ? { deep_link: deepLink } : {}),
  };
}

/** How a waiting card was closed: one of its answers, or on the board itself. */
export type AttentionOutcomeDecision = string;

/** The decision a settled-on-the-board card records. */
export const SETTLED_ELSEWHERE = "settled_elsewhere";

/**
 * The structured half of a waiting card's receipt: which card, which wait, what was decided and by
 * whom (the person's label; null when it was settled on the board), pointing at the card's message
 * so a client knows which card to close.
 */
export function attentionOutcomeContent(
  card: { boardId: string; cardId: string; waitId: string; eventId: string },
  decision: AttentionOutcomeDecision,
  decidedBy: string | null,
): Record<string, unknown> {
  return {
    suite_event_type: ATTENTION_OUTCOME_TYPE,
    board_id: card.boardId,
    card_id: card.cardId,
    wait_id: card.waitId,
    decision,
    decided_by: decidedBy,
    "m.relates_to": { rel_type: "m.reference", event_id: card.eventId },
  };
}
