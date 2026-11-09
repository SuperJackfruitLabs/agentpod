/**
 * The wire of an approval that waits for its release time (charter: "An approval may wait for its
 * release time", 2026-11-09, §7).
 *
 * Four things cross it. The hold a gate.v2 carries before anyone approves: `release { hold_for_minutes?,
 * not_before? }`, from the board's camelCase `release`. The time a held approval's outcome receipt
 * names (`held_until`). The two events the board pushes afterwards, `decision.released` and
 * `decision.pulled_back`, which this hub posts as replies to the gate's card. And the pull-back a
 * person sends from chat, `dev.superpipeline.gate.pull_back.v2`.
 *
 * Pure; no database and no Matrix. Every field comes off the network, so each is re-checked here,
 * and a hold that is not well formed is not carried at all rather than carried in part: a card that
 * said "goes ahead after 09:00" while a garbled hold kept it longer would be saying something false.
 */

import type { DecisionPulledBackDelivery, DecisionReleasedDelivery } from "../bridge";
import { isIsoTime } from "./decision-timeout-wire";

/** A person pulling a held approval back from chat: an `m.room.message` carrying this marker. */
export const GATE_PULL_BACK_V2_SUITE_TYPE = "dev.superpipeline.gate.pull_back.v2";
/** The structured half of a release reply, so a client can mark the gate's card released or blocked. */
export const DECISION_RELEASED_TYPE = "dev.agentpod.decision.released.v2";
/** …and of a pull-back reply, so a client can mark the card returned for changes. */
export const DECISION_PULLED_BACK_TYPE = "dev.agentpod.decision.pulled_back.v2";

/** The board's own bounds on a stage's `holdFor`, in whole minutes (charter §2). */
export const HOLD_MIN_MINUTES = 5;
export const HOLD_MAX_MINUTES = 10_080;
/** The board's own bound on a pull-back comment (`INVALID_COMMENT` past it). */
export const PULL_BACK_COMMENT_MAX_BYTES = 8_192;
/** A blocked release's reason, as carried; the board's are one short sentence. */
const REASON_MAX = 300;
/** How much of a comment the prose line quotes; the structured half carries it whole. */
const PROSE_COMMENT_MAX = 500;
const ID_MAX = 200;

/** What would hold an approval of a gate, as it rides on the Matrix wire. */
export interface GateReleaseV2 {
  hold_for_minutes?: number;
  not_before?: string;
}

const field = (v: object, k: string): unknown => Reflect.get(v, k);
const isRecord = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);
const boundedId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= ID_MAX;

/**
 * The board's `{ holdForMinutes?, notBefore? }`, re-validated and carried snake_case, or null when it
 * sent none or one this hub will not carry: neither half present, `holdForMinutes` present but not a
 * whole number from 5 to 10080, or `notBefore` present but not an ISO time.
 */
export function releaseV2(raw: unknown): GateReleaseV2 | null {
  if (!isRecord(raw)) return null;
  const hold = field(raw, "holdForMinutes");
  const notBefore = field(raw, "notBefore");
  if (hold === undefined && notBefore === undefined) return null;
  if (
    hold !== undefined &&
    (typeof hold !== "number" || !Number.isInteger(hold) || hold < HOLD_MIN_MINUTES || hold > HOLD_MAX_MINUTES)
  ) {
    return null;
  }
  if (notBefore !== undefined && !isIsoTime(notBefore)) return null;
  return {
    ...(typeof hold === "number" ? { hold_for_minutes: hold } : {}),
    ...(typeof notBefore === "string" ? { not_before: notBefore } : {}),
  };
}

/** `{ release }` to spread into a gate.v2, or nothing, so a gate nothing holds is byte-identical. */
export function releaseField(raw: unknown): { release?: GateReleaseV2 } {
  const release = releaseV2(raw);
  return release ? { release } : {};
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/**
 * A release time as a person reads it: "Mon 9 Nov, 09:00 UTC". In UTC and saying so, because this
 * hub knows no reader's time zone; a client that does renders `not_before` / `held_until` itself.
 */
export function releaseTimeText(iso: string): string {
  const d = new Date(iso);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** A hold as a person says it: "30 minutes", "2 hours", "7 days", "90 minutes". */
export function holdText(minutes: number): string {
  if (minutes % 1440 === 0) return plural(minutes / 1440, "day");
  if (minutes % 60 === 0) return plural(minutes / 60, "hour");
  return plural(minutes, "minute");
}

/** The sentence a gate.v2's prose adds when an approval of it would wait. */
export function releaseSentence(release: GateReleaseV2): string {
  const after = release.not_before ? releaseTimeText(release.not_before) : null;
  const hold = release.hold_for_minutes !== undefined ? holdText(release.hold_for_minutes) : null;
  if (after && hold) return `If approved, it goes ahead after ${after}, and no sooner than ${hold} after the approval.`;
  if (after) return `If approved, it goes ahead after ${after}.`;
  return `If approved, it waits ${hold ?? "a while"} before it goes ahead.`;
}

/** A resolved gate's `heldUntil`, when the board says the approval is held and the time is one. */
export function heldUntilOf(raw: unknown): string | null {
  return isIsoTime(raw) ? raw : null;
}

/** What the outcome receipt says after the verb and approver of a held approval. */
export function heldTail(heldUntil: string): string {
  return `goes ahead after ${releaseTimeText(heldUntil)} unless pulled back.`;
}

/** `v` cut to at most `max` UTF-8 bytes, on a character boundary. */
function cutBytes(v: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(v).length <= max) return v;
  let out = "";
  let used = 0;
  for (const ch of v) {
    const n = enc.encode(ch).length;
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

const cutChars = (v: string, max: number) => (v.length > max ? `${v.slice(0, max - 1)}…` : v);

/**
 * Is this a `decision.released` this hub can act on? Used on the signed push, because authenticated
 * is not checked: the identifiers present, both times real, the outcome one of the two, and a
 * reason, when present, a string.
 */
export function isDecisionReleased(v: unknown): v is DecisionReleasedDelivery {
  if (!isRecord(v) || field(v, "event") !== "decision.released") return false;
  if (!boundedId(field(v, "boardId")) || !boundedId(field(v, "cardId")) || !boundedId(field(v, "gateId"))) return false;
  if (!boundedId(field(v, "decision"))) return false;
  if (!isIsoTime(field(v, "releaseAt")) || !isIsoTime(field(v, "releasedAt"))) return false;
  const outcome = field(v, "outcome");
  if (outcome !== "released" && outcome !== "blocked") return false;
  const reason = field(v, "reason");
  return reason === undefined || typeof reason === "string";
}

/**
 * Is this a `decision.pulled_back` this hub can act on? The identifiers and who pulled it back
 * present, the time real, and the comment a non-blank string (the board requires one).
 */
export function isDecisionPulledBack(v: unknown): v is DecisionPulledBackDelivery {
  if (!isRecord(v) || field(v, "event") !== "decision.pulled_back") return false;
  if (!boundedId(field(v, "boardId")) || !boundedId(field(v, "cardId")) || !boundedId(field(v, "gateId"))) return false;
  if (!boundedId(field(v, "pulledBackBy")) || !isIsoTime(field(v, "at"))) return false;
  const comment = field(v, "comment");
  return typeof comment === "string" && comment.trim() !== "";
}

/** A blocked release's reason, trimmed and bounded, or null when there is none worth saying. */
function reasonOf(d: DecisionReleasedDelivery): string | null {
  if (d.outcome !== "blocked" || typeof d.reason !== "string") return null;
  const r = d.reason.trim().replace(/[.\s]+$/, "");
  return r === "" ? null : cutChars(r, REASON_MAX);
}

/** The sentence a stock client sees for a release: "Released — it went ahead." */
export function releasedBody(d: DecisionReleasedDelivery): string {
  if (d.outcome === "released") return "Released — it went ahead.";
  const reason = reasonOf(d);
  return reason ? `Did not go ahead: ${reason}.` : "Did not go ahead: it was blocked at its release time.";
}

/** The structured half of a release reply, referencing the gate's own event. Pinned by the fixture. */
export function releasedContent(d: DecisionReleasedDelivery, gateEventId: string): Record<string, unknown> {
  const reason = reasonOf(d);
  return {
    suite_event_type: DECISION_RELEASED_TYPE,
    schema_version: 1,
    gate_id: d.gateId,
    board_id: d.boardId,
    card_id: d.cardId,
    outcome: d.outcome,
    released_at: d.releasedAt,
    ...(reason ? { reason } : {}),
    "m.relates_to": { rel_type: "m.reference", event_id: gateEventId },
  };
}

/** A pull-back comment, trimmed and within the board's bound. */
const commentOf = (comment: string) => cutBytes(comment.trim(), PULL_BACK_COMMENT_MAX_BYTES);

/**
 * The sentence a stock client sees for a pull-back: "Pulled back by rakesh — returned for changes:
 * wrong image". Who is a handle, never an mxid or a principal id; a person this hub cannot name is
 * left out.
 */
export function pulledBackBody(input: { who: string | null; comment: string }): string {
  const by = input.who ? ` by ${input.who}` : "";
  return `Pulled back${by} — returned for changes: ${cutChars(commentOf(input.comment), PROSE_COMMENT_MAX)}`;
}

/** The structured half of a pull-back reply, referencing the gate's own event. Pinned by the fixture. */
export function pulledBackContent(
  d: DecisionPulledBackDelivery,
  who: string | null,
  gateEventId: string,
): Record<string, unknown> {
  return {
    suite_event_type: DECISION_PULLED_BACK_TYPE,
    schema_version: 1,
    gate_id: d.gateId,
    board_id: d.boardId,
    card_id: d.cardId,
    pulled_back_by: who,
    comment: commentOf(d.comment),
    at: d.at,
    "m.relates_to": { rel_type: "m.reference", event_id: gateEventId },
  };
}

/** A pull-back read out of an `m.room.message`. `comment` is null when absent or blank. */
export interface ParsedPullBack {
  gateId: string;
  comment: string | null;
  referencedEventId: string | null;
}

/**
 * Read a gate.pull_back.v2, or null when the content is not one. A missing comment still parses, so
 * the person can be told it needs one; `m.relates_to` must be an `m.reference`, as for a decision,
 * because `m.in_reply_to` is a quoting hint every client sets.
 */
export function parsePullBack(content: unknown): ParsedPullBack | null {
  if (!isRecord(content) || field(content, "suite_event_type") !== GATE_PULL_BACK_V2_SUITE_TYPE) return null;
  const gateId = field(content, "gate_id");
  if (!boundedId(gateId)) return null;
  const comment = field(content, "comment");
  const rel = field(content, "m.relates_to");
  const referencedEventId =
    isRecord(rel) && field(rel, "rel_type") === "m.reference" && typeof field(rel, "event_id") === "string"
      ? String(field(rel, "event_id"))
      : null;
  return {
    gateId,
    comment: typeof comment === "string" && comment.trim() !== "" ? comment.trim() : null,
    referencedEventId,
  };
}

/** Is this comment within what the board takes? */
export function pullBackCommentFits(comment: string): boolean {
  return new TextEncoder().encode(comment).length <= PULL_BACK_COMMENT_MAX_BYTES;
}
