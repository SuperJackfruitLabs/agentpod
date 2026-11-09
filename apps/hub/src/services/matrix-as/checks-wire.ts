/**
 * The wire of a gate decided by checks (charter: "A gate may be decided by checks", 2026-11-09, §5
 * and §7).
 *
 * Five things cross it. The checks a gate.v2 carries once they have run: `checks [{ name, provider,
 * status, url? }]`, re-validated from the board's gate.pending. The two events the board pushes about
 * a check, `check.failed` and `check.overridden`, which this hub says in the board's room, each with a
 * structured half (`dev.agentpod.check.failed.v2`, `dev.agentpod.check.overridden.v2`). The card an
 * escalation of overdue checks posts, `dev.agentpod.checks.waiting.v2`, which carries what a client
 * needs to offer Override. And the override a person sends from chat,
 * `dev.superpipeline.check.override.v2`, which references that card.
 *
 * Pure; no database and no Matrix. Every field comes off the network, so each is re-checked here, and
 * a list of checks that is not well formed is not carried at all rather than carried in part: a card
 * that said "Checks: build ✓" while a garbled second check had failed would be saying something false.
 */

import type { CheckFailedDelivery, CheckOverriddenDelivery, CheckProvider, CheckStatus } from "../bridge";
import { isIsoTime } from "./decision-timeout-wire";
import { isHttpsUrl } from "./safe-url";

/** A person overriding a check from chat: an `m.room.message` carrying this marker. */
export const CHECK_OVERRIDE_V2_SUITE_TYPE = "dev.superpipeline.check.override.v2";
/** The structured half of a failed check's notice. */
export const CHECK_FAILED_TYPE = "dev.agentpod.check.failed.v2";
/** …and of an override's. */
export const CHECK_OVERRIDDEN_TYPE = "dev.agentpod.check.overridden.v2";
/** The card an escalation of overdue checks posts, so a client can offer Override. */
export const CHECKS_WAITING_TYPE = "dev.agentpod.checks.waiting.v2";

/** The board's own bounds (charter §1): at most 5 checks, a name of 1–40 characters without "/". */
export const CHECKS_MAX = 5;
export const CHECK_NAME_MAX = 40;
/** The board's own bound on an override comment (`INVALID_COMMENT` past it). */
export const CHECK_OVERRIDE_COMMENT_MAX_BYTES = 8_192;
/** A check's detail as carried; the board's are one short line. */
const DETAIL_MAX = 300;
/** How much of a comment the prose quotes; the structured half carries it whole. */
const PROSE_COMMENT_MAX = 500;
const TITLE_MAX = 120;
const STAGE_MAX = 80;
const ID_MAX = 200;
const URL_MAX = 2_048;

const PROVIDERS: readonly CheckProvider[] = ["ci", "verdict"];
const STATUSES: readonly CheckStatus[] = ["pending", "passed", "failed", "overridden"];

/** One check as it rides on the Matrix wire. */
export interface CheckV2 {
  name: string;
  provider: CheckProvider;
  status: CheckStatus;
  url?: string;
}

const field = (v: object, k: string): unknown => Reflect.get(v, k);
const isRecord = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);
const boundedId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= ID_MAX;
const isProvider = (v: unknown): v is CheckProvider => typeof v === "string" && (PROVIDERS as readonly string[]).includes(v);
const isStatus = (v: unknown): v is CheckStatus => typeof v === "string" && (STATUSES as readonly string[]).includes(v);
const cut = (v: string, max: number) => (v.length > max ? `${v.slice(0, max - 1)}…` : v);

/** A check name the board would accept: 1–40 characters, no surrounding spaces, no "/". */
export function isCheckName(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= CHECK_NAME_MAX && v.trim() === v && !v.includes("/");
}

/** A link worth carrying: https, with a host, and not absurdly long. Anything else is dropped. */
const safeUrl = (v: unknown): string | null => (typeof v === "string" && v.length <= URL_MAX && isHttpsUrl(v) ? v : null);

/**
 * One check off the board, or null when it is not one: a name the board would accept, a known
 * provider and status. Its `url` is kept only when it is https; a link that is not is dropped and the
 * check kept, since a link decorates a check rather than deciding it.
 */
export function checkV2(raw: unknown): CheckV2 | null {
  if (!isRecord(raw)) return null;
  const name = field(raw, "name");
  const provider = field(raw, "provider");
  const status = field(raw, "status");
  if (!isCheckName(name) || !isProvider(provider) || !isStatus(status)) return null;
  const url = safeUrl(field(raw, "url"));
  return { name, provider, status, ...(url ? { url } : {}) };
}

/**
 * The board's checks, re-validated, or null when it sent none or a list this hub will not carry: not
 * an array, empty, more than 5, any entry malformed, or two with one name.
 */
export function checksV2(raw: unknown): CheckV2[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > CHECKS_MAX) return null;
  const out: CheckV2[] = [];
  const names = new Set<string>();
  for (const item of raw) {
    const c = checkV2(item);
    if (!c || names.has(c.name)) return null;
    names.add(c.name);
    out.push(c);
  }
  return out;
}

/** `{ checks }` to spread into a gate.v2, or nothing, so a gate on a stage without checks is byte-identical. */
export function checksField(raw: unknown): { checks?: CheckV2[] } {
  const checks = checksV2(raw);
  return checks ? { checks } : {};
}

const PROVIDER_WORD: Record<CheckProvider, string> = { ci: "CI", verdict: "verdict" };
const STATUS_WORD: Record<CheckStatus, string> = { passed: "✓", overridden: "overridden", failed: "failed", pending: "pending" };

/** One check as a person reads it in a list: "build (CI) ✓". */
const checkPhrase = (c: CheckV2) => `${c.name} (${PROVIDER_WORD[c.provider]}) ${STATUS_WORD[c.status]}`;

/** The line a gate.v2's prose adds for its checks: "Checks: build (CI) ✓, claims (verdict) overridden." */
export function checksSentence(checks: CheckV2[]): string {
  return `Checks: ${checks.map(checkPhrase).join(", ")}.`;
}

/** A check named in a sentence: "CI check “build”". */
const checkNamed = (c: { name: string; provider: CheckProvider }) =>
  `${c.provider === "ci" ? "CI" : "Verdict"} check “${c.name}”`;
const titled = (title: string | null) => (title ? ` on “${cut(title.trim(), TITLE_MAX)}”` : "");

// ── check.failed ─────────────────────────────────────────────────────────────

/**
 * Is this a `check.failed` this hub can act on? Used on the signed push, because authenticated is not
 * checked: the identifiers present, the check well formed and failed, its detail and link strings when
 * present, and `returnedTo` a stage or null.
 */
export function isCheckFailed(v: unknown): v is CheckFailedDelivery {
  if (!isRecord(v) || field(v, "event") !== "check.failed") return false;
  if (!boundedId(field(v, "boardId")) || !boundedId(field(v, "cardId")) || !boundedId(field(v, "stageKey"))) return false;
  const check = field(v, "check");
  if (!isRecord(check) || !isCheckName(field(check, "name")) || !isProvider(field(check, "provider"))) return false;
  if (field(check, "status") !== "failed") return false;
  const detail = field(check, "detail");
  const url = field(check, "url");
  if ((detail !== undefined && typeof detail !== "string") || (url !== undefined && typeof url !== "string")) return false;
  const returnedTo = field(v, "returnedTo");
  return returnedTo === null || boundedId(returnedTo);
}

/** A failed check's detail, trimmed and bounded, or null when there is none worth carrying. */
function detailOf(d: CheckFailedDelivery): string | null {
  const detail = typeof d.check.detail === "string" ? d.check.detail.trim() : "";
  return detail === "" ? null : cut(detail, DETAIL_MAX);
}

/**
 * The sentence a stock client sees: "CI check “build” failed on “Ship it” — returned for changes."
 * A card that could not go back says it waits for a person; a title this hub does not know is left
 * out; a https link to the result is added as markdown, for the reason `gateProseBody` gives.
 */
export function checkFailedBody(d: CheckFailedDelivery, cardTitle: string | null): string {
  const outcome = d.returnedTo === null ? "it could not go back and waits for a person." : "returned for changes.";
  const url = safeUrl(d.check.url);
  return `${checkNamed(d.check)} failed${titled(cardTitle)} — ${outcome}${url ? ` [Open the result](${url})` : ""}`;
}

/** The structured half of a failed check's notice. Pinned by the shared fixture. */
export function checkFailedContent(d: CheckFailedDelivery, cardTitle: string | null, replyTo?: string): Record<string, unknown> {
  const detail = detailOf(d);
  const url = safeUrl(d.check.url);
  return {
    suite_event_type: CHECK_FAILED_TYPE,
    schema_version: 1,
    board_id: d.boardId,
    card_id: d.cardId,
    ...(cardTitle ? { card_title: cut(cardTitle.trim(), TITLE_MAX) } : {}),
    stage_key: d.stageKey,
    check: {
      name: d.check.name,
      provider: d.check.provider,
      status: "failed",
      ...(detail ? { detail } : {}),
      ...(url ? { url } : {}),
    },
    returned_to: d.returnedTo,
    ...(replyTo ? { "m.relates_to": { rel_type: "m.reference", event_id: replyTo } } : {}),
  };
}

// ── check.overridden ─────────────────────────────────────────────────────────

/**
 * Is this a `check.overridden` this hub can act on? The identifiers and who overrode it present, the
 * check well formed and overridden, the time real, and the comment a non-blank string.
 */
export function isCheckOverridden(v: unknown): v is CheckOverriddenDelivery {
  if (!isRecord(v) || field(v, "event") !== "check.overridden") return false;
  if (!boundedId(field(v, "boardId")) || !boundedId(field(v, "cardId")) || !boundedId(field(v, "stageKey"))) return false;
  const check = field(v, "check");
  if (!isRecord(check) || !isCheckName(field(check, "name")) || !isProvider(field(check, "provider"))) return false;
  if (field(check, "status") !== "overridden") return false;
  if (!boundedId(field(v, "by")) || !isIsoTime(field(v, "at"))) return false;
  const comment = field(v, "comment");
  return typeof comment === "string" && comment.trim() !== "";
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

const commentOf = (comment: string) => cutBytes(comment.trim(), CHECK_OVERRIDE_COMMENT_MAX_BYTES);

/**
 * The sentence a stock client sees: "CI check “build” on “Ship it” overridden by rakesh: flaky
 * runner". Who is a handle, never an mxid or a principal id; a person this hub cannot name is left out.
 */
export function checkOverriddenBody(d: CheckOverriddenDelivery, who: string | null, cardTitle: string | null): string {
  const by = who ? ` by ${who}` : "";
  return `${checkNamed(d.check)}${titled(cardTitle)} overridden${by}: ${cut(commentOf(d.comment), PROSE_COMMENT_MAX)}`;
}

/** The structured half of an override's notice. Pinned by the shared fixture. */
export function checkOverriddenContent(
  d: CheckOverriddenDelivery,
  who: string | null,
  cardTitle: string | null,
  replyTo?: string,
): Record<string, unknown> {
  return {
    suite_event_type: CHECK_OVERRIDDEN_TYPE,
    schema_version: 1,
    board_id: d.boardId,
    card_id: d.cardId,
    ...(cardTitle ? { card_title: cut(cardTitle.trim(), TITLE_MAX) } : {}),
    stage_key: d.stageKey,
    check: { name: d.check.name, provider: d.check.provider, status: "overridden" },
    overridden_by: who,
    comment: commentOf(d.comment),
    at: d.at,
    ...(replyTo ? { "m.relates_to": { rel_type: "m.reference", event_id: replyTo } } : {}),
  };
}

// ── checks.waiting ───────────────────────────────────────────────────────────

/** What an escalation of overdue checks needs to post its card. */
export interface ChecksWaitingInput {
  boardId: string;
  cardId: string;
  cardTitle: string;
  stageKey: string;
  stageName?: string | null;
  checks: CheckV2[];
}

/**
 * The sentence a stock client sees: "Checks overdue on “Ship it” at Review: build (CI) pending,
 * quality (verdict) ✓. A workspace owner or admin may override a check, with a comment."
 */
export function checksWaitingBody(input: ChecksWaitingInput, link?: string): string {
  const stage = typeof input.stageName === "string" && input.stageName.trim() !== "" ? input.stageName.trim() : input.stageKey;
  const at = stage ? ` at ${cut(stage, STAGE_MAX)}` : "";
  const tail = link ? ` [Open the card](${link})` : "";
  return (
    `Checks overdue${titled(input.cardTitle)}${at}: ${input.checks.map(checkPhrase).join(", ")}. ` +
    `A workspace owner or admin may override a check, with a comment.${tail}`
  );
}

/**
 * The checks.waiting card: an `m.room.message` / `m.text` with a real `body` and the
 * `suite_event_type` marker, so a stock client reads the sentence and a suite client offers Override
 * on each pending or failed check. An override references this event. Pinned by the shared fixture.
 */
export function checksWaitingContent(input: ChecksWaitingInput, deepLink?: string): Record<string, unknown> {
  return {
    msgtype: "m.text",
    body: checksWaitingBody(input, deepLink),
    suite_event_type: CHECKS_WAITING_TYPE,
    schema_version: 1,
    board_id: input.boardId,
    card_id: input.cardId,
    card_title: cut(input.cardTitle.trim(), TITLE_MAX),
    stage_key: input.stageKey,
    checks: input.checks,
    ...(deepLink ? { deep_link: deepLink } : {}),
  };
}

// ── check.override from chat ─────────────────────────────────────────────────

/** An override read out of an `m.room.message`. `comment` is null when absent or blank. */
export interface ParsedCheckOverride {
  boardId: string;
  cardId: string;
  checkName: string;
  comment: string | null;
  referencedEventId: string | null;
}

/**
 * Read a check.override.v2, or null when the content is not one. A missing comment still parses, so
 * the person can be told it needs one; `m.relates_to` must be an `m.reference`, as for a decision,
 * because `m.in_reply_to` is a quoting hint every client sets.
 */
export function parseCheckOverride(content: unknown): ParsedCheckOverride | null {
  if (!isRecord(content) || field(content, "suite_event_type") !== CHECK_OVERRIDE_V2_SUITE_TYPE) return null;
  const boardId = field(content, "board_id");
  const cardId = field(content, "card_id");
  const checkName = field(content, "check_name");
  if (!boundedId(boardId) || !boundedId(cardId) || !isCheckName(checkName)) return null;
  const comment = field(content, "comment");
  const rel = field(content, "m.relates_to");
  const referencedEventId =
    isRecord(rel) && field(rel, "rel_type") === "m.reference" && typeof field(rel, "event_id") === "string"
      ? String(field(rel, "event_id"))
      : null;
  return {
    boardId,
    cardId,
    checkName,
    comment: typeof comment === "string" && comment.trim() !== "" ? comment.trim() : null,
    referencedEventId,
  };
}

/** Is this comment within what the board takes? */
export function checkOverrideCommentFits(comment: string): boolean {
  return new TextEncoder().encode(comment).length <= CHECK_OVERRIDE_COMMENT_MAX_BYTES;
}
