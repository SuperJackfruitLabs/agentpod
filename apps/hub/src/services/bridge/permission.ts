/**
 * Translating one decision between two vocabularies.
 *
 * ACP's permission option is `{optionId, name, kind}`: `optionId` is what the
 * harness is answered with, `name` is what a human reads. kaambaan's option is
 * `{name, title}`, and its answer echoes back the chosen option's **`name`**
 * (`elicitation.answer.option`). So the mapping is forced:
 *
 *     ACP optionId  ⟷  kaambaan name     — the identity, round-tripped
 *     ACP name      →   kaambaan title   — the label, one-way
 *
 * Get that backwards and nothing throws. The board would echo back a human
 * label, the label would match no `optionId`, and the harness would be answered
 * with a guess — or, worse, with an option that happens to sort first. That is
 * how a command a human refused gets run. Every function here is written so the
 * failure mode is "no answer", never "some answer".
 *
 * kaambaan also accepts `{id, label}` and bare strings for an option; this
 * sends the canonical `{name, title}` and nothing else, because the other two
 * spellings exist for callers that already had those shapes and we do not.
 */

/** One option as a harness offers it over ACP. */
interface AcpOption {
  optionId: string;
  /** Human-readable label. Optional here: `optionId` is the only requirement. */
  name?: string;
}

/** One option as kaambaan stores it, and as a human sees it on the card. */
export interface BoardOption {
  name: string;
  title: string;
}

/** What kaambaan returns once a human has answered. */
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
function readOptions(raw: unknown): Array<{ optionId: string; label: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ optionId: string; label: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Partial<AcpOption>;
    const optionId = typeof o.optionId === "string" ? o.optionId.trim() : "";
    if (optionId === "") continue;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    out.push({ optionId, label: name === "" ? optionId : name });
  }
  return out;
}

/** ACP's options, in the shape kaambaan stores and shows to a human. */
export function toBoardOptions(raw: unknown): BoardOption[] {
  return readOptions(raw).map((o) => ({ name: o.optionId, title: o.label }));
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
