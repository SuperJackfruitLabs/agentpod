/**
 * Translating one decision between two vocabularies.
 *
 * ACP's permission option is `{optionId, name, kind}`: `optionId` is what the
 * harness is answered with, `name` is what a human reads. superpipeline's option is
 * `{name, title}`, and its answer echoes back the chosen option's **`name`**
 * (`elicitation.answer.option`). So the mapping is forced:
 *
 *     ACP optionId  ⟷  superpipeline name     — the identity, round-tripped
 *     ACP name      →   superpipeline title   — the label, one-way
 *
 * Get that backwards and nothing throws. The board would echo back a human
 * label, the label would match no `optionId`, and the harness would be answered
 * with a guess — or, worse, with an option that happens to sort first. That is
 * how a command a human refused gets run. Every function here is written so the
 * failure mode is "no answer", never "some answer".
 *
 * superpipeline also accepts `{id, label}` and bare strings for an option; this
 * sends the canonical `{name, title}` and nothing else, because the other two
 * spellings exist for callers that already had those shapes and we do not.
 */

import {
  harnessPermissionSubject,
  permissionKindMeaning,
  requestedAt,
  type HarnessPermissionSubject,
  type PermissionMeaning,
  type PermissionPreviewBlock,
  type PermissionScope,
} from "../acp";

/** One option as a harness offers it over ACP. */
interface AcpOption {
  optionId: string;
  /** Human-readable label. Optional here: `optionId` is the only requirement. */
  name?: string;
  /** ACP's kind (`allow_once`, `reject_always`, …): what the option means. */
  kind?: string;
}

/** One option as superpipeline stores it, and as a human sees it on the card. */
export interface BoardOption {
  name: string;
  title: string;
}

/** What superpipeline returns once a human has answered. */
export interface BoardAnswer {
  /** The `name` of the chosen option, or null when the human only typed text. */
  option?: string | null;
  text?: string | null;
}

/**
 * The options that can actually be answered.
 *
 * An entry with no `optionId` is dropped rather than defaulted: ACP answers by
 * id, so an option without one cannot be selected, and inventing an id would
 * offer a human a choice the harness will not accept.
 */
function readOptions(raw: unknown): Array<{ optionId: string; label: string; kind?: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ optionId: string; label: string; kind?: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Partial<AcpOption>;
    const optionId = typeof o.optionId === "string" ? o.optionId.trim() : "";
    if (optionId === "") continue;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    out.push({ optionId, label: name === "" ? optionId : name, ...(typeof o.kind === "string" ? { kind: o.kind } : {}) });
  }
  return out;
}

/** ACP's options, in the shape superpipeline stores and shows to a human. */
export function toBoardOptions(raw: unknown): BoardOption[] {
  return readOptions(raw).map((o) => ({ name: o.optionId, title: o.label }));
}

/** A board option that says what it means (charter: strict decisions bind their subject §7). */
export interface MeaningfulBoardOption extends BoardOption {
  meaning: PermissionMeaning;
  scope?: PermissionScope;
}

/**
 * ACP's options with what each means and how far it reaches, from its kind: allow_once →
 * approve/once, allow_always → approve/always, reject_once → reject/once, reject_always →
 * reject/always, anything else a neutral choice. So a reject_always no longer looks like a neutral
 * choice on the board. A board that predates per-option meanings ignores the two extra keys.
 */
export function toMeaningfulBoardOptions(raw: unknown): MeaningfulBoardOption[] {
  return readOptions(raw).map((o) => {
    const mapped = permissionKindMeaning(o.kind);
    return { name: o.optionId, title: o.label, meaning: mapped.meaning, ...(mapped.scope ? { scope: mapped.scope } : {}) };
  });
}

/** What a board takes of a poster's preview: well under its refusal bounds (64 blocks, 16,000 characters). */
const BOARD_BLOCKS_MAX = 20;
const BOARD_TEXT_MAX = 4000;

const cutText = (v: string): string => (v.length > BOARD_TEXT_MAX ? `${v.slice(0, BOARD_TEXT_MAX - 1)}…` : v);

function cutBlock(b: PermissionPreviewBlock): PermissionPreviewBlock {
  return b.type === "text"
    ? { type: "text", ...(b.label !== undefined ? { label: cutText(b.label) } : {}), text: cutText(b.text) }
    : { type: "field", label: cutText(b.label), value: cutText(b.value) };
}

const blockCut = (b: PermissionPreviewBlock): boolean =>
  b.type === "text" ? b.text.length > BOARD_TEXT_MAX || (b.label?.length ?? 0) > BOARD_TEXT_MAX : b.value.length > BOARD_TEXT_MAX || b.label.length > BOARD_TEXT_MAX;

/**
 * The `harness-permission/v1` subject a board-dispatched permission is posted with: the same id,
 * digest and expiry as the station room's permission.v2, its preview cut to fit what a board takes
 * (anything cut makes it incomplete, and the board withholds approval on an incomplete preview).
 */
export function boardPermissionSubject(sessionId: string, requestSeq: number, payload: unknown, createdAt: unknown): HarnessPermissionSubject {
  const { subject } = harnessPermissionSubject(sessionId, requestSeq, payload, requestedAt(createdAt));
  const kept = subject.preview.slice(0, BOARD_BLOCKS_MAX);
  const complete = subject.preview_complete && kept.length === subject.preview.length && !kept.some(blockCut);
  return { ...subject, preview: kept.map(cutBlock), preview_complete: complete };
}

/**
 * The same elicitation with every option that could approve removed, and no envelope: only the
 * options that reject, as `{name, title}`. Null for any activity that carried no envelope.
 *
 * Used once, when a board that understands the envelope refuses it (`isEnvelopeRefusal`). Reposting
 * the whole question unbound would let the board accept an approval bound to nothing — exactly what
 * the subject exists to prevent — so the person is still asked, but can only decline from the board;
 * an approval goes through the room or the console, where the request is shown in full.
 */
export function withoutApprovals<A extends { type: string; parameter?: unknown }>(activity: A): (Omit<A, "parameter"> & { parameter: unknown }) | null {
  if (activity.type !== "elicitation") return null;
  const p = activity.parameter;
  if (typeof p !== "object" || p === null || !("subject" in p) || !("options" in p) || !Array.isArray(p.options)) return null;
  const options: BoardOption[] = [];
  for (const o of p.options) {
    if (typeof o !== "object" || o === null || !("meaning" in o) || o.meaning !== "reject") continue;
    if ("name" in o && typeof o.name === "string" && "title" in o && typeof o.title === "string") options.push({ name: o.name, title: o.title });
  }
  const requestSeq = "requestSeq" in p ? p.requestSeq : undefined;
  return { ...activity, parameter: { requestSeq, options } };
}

/**
 * The human's answer, as an ACP `optionId` — or null when it is not one.
 *
 * Null is a real outcome and the caller must treat it as "no decision was
 * made", not as a default. It happens when the human typed free text and chose
 * nothing, and it would happen if a board ever echoed something that was never
 * offered. Both are cases where the only safe move is to stop.
 */
export function selectedOptionId(raw: unknown, answer: BoardAnswer | null | undefined): string | null {
  const chosen = typeof answer?.option === "string" ? answer.option.trim() : "";
  if (chosen === "") return null;
  // Matched against the OFFER, not against the answer's own claim: this is the
  // check that keeps a board's reply from selecting something the harness never
  // put on the table.
  const match = readOptions(raw).find((o) => o.optionId === chosen);
  return match ? match.optionId : null;
}

/** The question a human reads on the card. */
export function permissionQuestion(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const toolCall = (p.toolCall ?? {}) as Record<string, unknown>;
  const title = firstString(p.title, toolCall.title, toolCall.kind);
  return title
    ? `The agent is asking for permission: ${title}`
    : "The agent needs permission to continue.";
}

/**
 * Did the hub already answer this itself?
 *
 * `handlePermissionRequest` persists a `permission-request` event even when it
 * auto-allows — which `full-auto` does for everything and `accept-edits` does
 * for edits. Those are not questions: nothing is parked waiting for a reply, so
 * raising an elicitation for one would move the card to `input-required` for a
 * decision that was made microseconds earlier and can never be answered.
 */
export function isAutoAnswered(payload: unknown): boolean {
  return (payload as { auto?: unknown } | null)?.auto === true;
}

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}
