/**
 * The wire of a stage's timeout (charter: "Unanswered decisions remind, then escalate").
 *
 * Two things cross it. The deadline a waiting decision carries on its envelope (§5): gate.v2,
 * question.v2, delivery.v2 and attention.v2 gain an optional `deadline { remind_at?, escalate_at? }`,
 * separate from `subject.expires_at`, which bounds a binding's validity rather than anyone's
 * patience. And the two events the board pushes when a deadline passes (§2), `decision.reminded` and
 * `decision.escalated`, which this hub posts as a reply to the card it already put in the room.
 *
 * Pure; no database and no Matrix. Every field comes off the network, so each is re-checked here.
 */

import { DECISION_KINDS, type DecisionKind, type DecisionTimeoutDelivery } from "../bridge";

/** The structured half of an escalation notice, so a client can render it (charter §3). */
export const DECISION_ESCALATED_SUITE_TYPE = "dev.superpipeline.decision.escalated.v1";
/** …and of a reminder. */
export const DECISION_REMINDED_SUITE_TYPE = "dev.superpipeline.decision.reminded.v1";

/** An envelope's deadline, as it rides on the Matrix wire. */
export interface DecisionDeadlineV2 {
  remind_at?: string;
  escalate_at?: string;
}

/** Longer than any ISO 8601 time the board writes, short enough that nothing else fits. */
const TIME_MAX = 40;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Is this an ISO 8601 time that names a real instant? */
export function isIsoTime(v: unknown): v is string {
  return typeof v === "string" && v.length <= TIME_MAX && ISO_TIME.test(v) && Number.isFinite(Date.parse(v));
}

/**
 * The board's `deadline: { remindAt?, escalateAt? }`, carried as `{ remind_at?, escalate_at? }`, or
 * undefined when it sent none or nothing usable. A malformed half is dropped and the other kept: a
 * client that shows "escalates in 3 h" should not lose that because the reminder time was garbled.
 */
export function deadlineV2(raw: unknown): DecisionDeadlineV2 | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const remind: unknown = Reflect.get(raw, "remindAt");
  const escalate: unknown = Reflect.get(raw, "escalateAt");
  const out: DecisionDeadlineV2 = {
    ...(isIsoTime(remind) ? { remind_at: remind } : {}),
    ...(isIsoTime(escalate) ? { escalate_at: escalate } : {}),
  };
  return out.remind_at || out.escalate_at ? out : undefined;
}

/** `{ deadline }` to spread into an envelope, or nothing, so an envelope without one is unchanged. */
export function deadlineField(raw: unknown): { deadline?: DecisionDeadlineV2 } {
  const deadline = deadlineV2(raw);
  return deadline ? { deadline } : {};
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const isDecisionKind = (v: unknown): v is DecisionKind =>
  typeof v === "string" && (DECISION_KINDS as readonly string[]).includes(v);

/**
 * Is this a `decision.reminded` or `decision.escalated` this hub can act on? Used on the signed push,
 * because authenticated is not checked: a board a version ahead must not have this hub reply to a
 * card with an empty title, or escalate a decision it cannot name.
 */
export function isDecisionTimeout(v: unknown): v is DecisionTimeoutDelivery {
  if (typeof v !== "object" || v === null) return false;
  const get = (k: string): unknown => Reflect.get(v, k);
  const event = get("event");
  if (event !== "decision.reminded" && event !== "decision.escalated") return false;
  return (
    nonEmpty(get("boardId")) &&
    nonEmpty(get("cardId")) &&
    nonEmpty(get("decisionId")) &&
    typeof get("cardTitle") === "string" &&
    typeof get("stageKey") === "string" &&
    isDecisionKind(get("decisionKind")) &&
    isIsoTime(get("waitingSince")) &&
    isIsoTime(get(event === "decision.reminded" ? "remindedAt" : "escalatedAt"))
  );
}

/** When this notice's deadline was acted on: `remindedAt` or `escalatedAt`. */
export function noticeAt(d: DecisionTimeoutDelivery): string {
  return (d.event === "decision.reminded" ? d.remindedAt : d.escalatedAt) ?? d.ts;
}

/** How long a decision has waited, as a person says it: "45 min", "3 h", "3 d". */
export function waitedFor(since: string, at: string): string {
  const minutes = Math.max(0, Math.floor((Date.parse(at) - Date.parse(since)) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

const WAITING_FOR: Record<DecisionKind, string> = {
  gate: "an approval",
  question: "an answer",
  delivery: "its live link",
  attention: "a person",
  checks: "its checks",
};

/** Cut to `max` characters, marking the cut. `gate-wire`'s, restated so that file can import this one. */
const cut = (max: number) => (v: string) => (v.length > max ? `${v.slice(0, max - 1)}…` : v);

const TITLE_MAX = 120;
const STAGE_MAX = 80;

/** The sentence a stock client sees. The link is markdown for the reason `gateProseBody` gives. */
function noticeBody(d: DecisionTimeoutDelivery, link?: string): string {
  const title = cut(TITLE_MAX)(d.cardTitle.replace(/"/g, "'"));
  const waited = waitedFor(d.waitingSince, noticeAt(d));
  const what = WAITING_FOR[d.decisionKind];
  if (d.event === "decision.reminded") return `Still waiting: "${title}" has waited ${waited} for ${what}.`;
  const stage = typeof d.stageName === "string" && d.stageName.trim() !== "" ? d.stageName.trim() : d.stageKey;
  const at = stage ? ` at ${cut(STAGE_MAX)(stage)}` : "";
  const tail = link ? ` [Open the card](${link})` : "";
  return `Escalated to workspace admins after ${waited}: "${title}" is still waiting for ${what}${at}.${tail}`;
}

/**
 * The notice: an `m.text` in reply to the waiting card's own message, with the `suite_event_type`
 * marker and the fields a client renders it from. Pinned by the shared fixture. `cardEventId` null:
 * there is no card to reply to (a reminder of overdue checks, charter 2026-11-09, a gate may be
 * decided by checks §4), and the notice stands alone.
 */
export function decisionNoticeContent(
  d: DecisionTimeoutDelivery,
  cardEventId: string | null,
  deepLink?: string,
): Record<string, unknown> {
  const escalated = d.event === "decision.escalated";
  return {
    msgtype: "m.text",
    body: noticeBody(d, escalated ? deepLink : undefined),
    suite_event_type: escalated ? DECISION_ESCALATED_SUITE_TYPE : DECISION_REMINDED_SUITE_TYPE,
    schema_version: 1,
    board_id: d.boardId,
    card_id: d.cardId,
    decision_kind: d.decisionKind,
    decision_id: d.decisionId,
    waiting_since: d.waitingSince,
    ...(escalated ? { escalated_at: noticeAt(d) } : { reminded_at: noticeAt(d) }),
    ...(escalated && deepLink ? { deep_link: deepLink } : {}),
    ...(cardEventId ? { "m.relates_to": { "m.in_reply_to": { event_id: cardEventId } } } : {}),
  };
}
