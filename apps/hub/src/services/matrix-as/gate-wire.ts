/**
 * A gate's wire: the event types and option ids superpipeline owns, the predicate for a gate
 * this hub can post, and the content of the prose message and the custom event.
 *
 * Pure; no database and no Matrix. Split out of `gates.ts`, which re-exports it.
 */

import { type GateRequestCard } from "@agentpod/contract";
import { z } from "zod";
import type { GatePendingDelivery } from "../bridge";

export const GATE_EVENT_TYPE = "dev.superpipeline.gate.v1";
export const GATE_DECISION_SUITE_TYPE = "dev.superpipeline.gate.decision.v1";

/**
 * gate.v2: the `suite_event_type` marker on the prose message, and the answer's.
 *
 * charter → `decisions/2026-11-07-gate-v2-is-the-decision-envelope.md`. A second suite type
 * beside v1, not a change to it: v1 clients keep reading the legacy event and the embedded
 * card exactly as before.
 */
export const GATE_V2_SUITE_TYPE = "dev.superpipeline.gate.v2";
export const GATE_DECISION_V2_SUITE_TYPE = "dev.superpipeline.gate.decision.v2";

/**
 * What the board did with an answer, said back in the room.
 *
 * On a successful resolve this service used to say nothing at all, while saying
 * something on a DUPLICATE tap ("That was already decided"). So a room heard about
 * a redundant answer and never about an accepted one, and a person scrolling back
 * could not tell a resolved gate from a live one (agentpod#614).
 *
 * **Not the same fact as the decision event the reader's client already sent.** That
 * one says a person tapped and it was delivered. This says superpipeline accepted
 * it. They came apart in production on 2026-09-28: decision events landed in the
 * room for hours while every resolve was refused `HTTP_401`, so a client rendering
 * "answered" from the decision alone would have told the reader their approval had
 * worked when nothing had happened.
 */
export const GATE_OUTCOME_TYPE = "dev.superpipeline.gate.outcome.v1";

/**
 * The only option ids superpipeline resolves against — its `GateDecision`.
 *
 * Mirrored here rather than imported because the two products share no runtime.
 * Pinned by `fixtures/ecosystem-identity/matrix_gate_events.json`, which both
 * repos validate against.
 */
export const GATE_OPTION_IDS = ["approve", "request_changes", "reject"] as const;
export type GateOptionId = (typeof GATE_OPTION_IDS)[number];

export const isGateOptionId = (v: unknown): v is GateOptionId =>
  typeof v === "string" && (GATE_OPTION_IDS as readonly string[]).includes(v);

/**
 * Is this a gate this hub knows how to post?
 *
 * Used on both inbound paths — the signed push and the sweep's read — because
 * "authenticated" is not "checked". A board a version ahead, or behind, would
 * otherwise have this hub posting a card with an empty title and no buttons
 * into somebody's room. One predicate rather than two so the two paths cannot
 * come to disagree about what a gate is.
 */
export function isGatePending(v: unknown): v is GatePendingDelivery {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    d.event === "gate.pending" &&
    typeof d.boardId === "string" &&
    typeof d.cardId === "string" &&
    typeof d.gateId === "string" &&
    d.gateId.length > 0 &&
    typeof d.stageKey === "string" &&
    typeof d.cardTitle === "string" &&
    Array.isArray(d.options)
  );
}

/**
 * The sentence a stock client sees.
 *
 * The link is written as **markdown**, not as a bare URL, and that is the whole
 * reason it is tappable. supermessage parses a plain `body` with
 * `blocks_from_markdown` when the event carries no `formatted_body`
 * (`item_view.rs`), and pulldown-cmark does not autolink bare URLs — so
 * `https://…` sitting in prose renders as characters to retype. It looks like a
 * link and is not, which is worse than omitting it.
 */
export function gateProseBody(d: GatePendingDelivery, link?: string): string {
  const where = `at stage \`${d.stageKey}\``;
  const tail = link ? ` [Open the card](${link})` : "";
  return `Approval needed — "${d.cardTitle}" ${where}. Approve, request changes, or reject.${tail}`;
}

/**
 * Where the card's link goes.
 *
 * `…/b/<board>/c/<card>` — the address superpipeline#34 assumed and superpipeline did
 * not have. This projected that shape for a day and it returned 404, because
 * the board app had no routing at all: one page, no `$page`, no
 * `searchParams`, no card route. It was briefly changed to the app root, and
 * is now back to the card because superpipeline/#47 made cards addressable.
 *
 * Worth keeping the history in view: the field was in the schema and in the
 * tests for a day before anyone tapped it. A test that asserts a link is
 * *present* proves nothing about whether it *resolves*, which is why the
 * superpipeline side is covered by end-to-end tests that follow it.
 */
export function boardLink(baseUrl: string | undefined, boardId: string, cardId: string): string | undefined {
  if (!baseUrl) return undefined;
  return `${baseUrl.replace(/\/+$/, "")}/b/${encodeURIComponent(boardId)}/c/${encodeURIComponent(cardId)}`;
}

/** The custom event's content. Pinned by the shared fixture. */
export function gateEventContent(
  d: GatePendingDelivery,
  deepLink?: string
): Record<string, unknown> {
  // `{id, label}` and nothing else: a board that speaks gate.v2 sends more on each option,
  // and the v1 payload stays exactly what v1 clients have always read.
  const options = d.options
    .filter((o) => isGateOptionId(o.id))
    .map((o) => ({ id: o.id, label: o.label }));
  return {
    body: gateProseBody(d, deepLink),
    schema_version: 2,
    board_id: d.boardId,
    card_id: d.cardId,
    gate_id: d.gateId,
    stage_key: d.stageKey,
    return_stage_key: d.returnStageKey,
    card_title: d.cardTitle,
    produced_by: d.producedBy,
    prompt: `Approve "${d.cardTitle}"?`,
    // supermessage#37: without this the card asks a reviewer to approve work
    // it does not show them. Additive, so `schema_version` moves rather than
    // the type — a renderer written against v1 ignores it and still draws the
    // buttons.
    // Bounded for the same reason as a preview (`HANDOFF_SUMMARY_BYTES`): a subject-bound gate's
    // summary is its preview text joined, and this card rides inside the prose message.
    ...(d.handoffSummary ? { handoff_summary: cutToBytes(d.handoffSummary, HANDOFF_SUMMARY_BYTES) } : {}),
    options,
    ...(deepLink ? { deep_link: deepLink } : {}),
  };
}

/**
 * The gate as it rides inside the prose message, under
 * `GATE_REQUEST_CONTENT_KEY`: the custom event's content without its `body`,
 * which the carrying message already has.
 */
export function gateRequestCard(d: GatePendingDelivery, deepLink?: string): GateRequestCard {
  const { body: _body, ...card } = gateEventContent(d, deepLink);
  return card as GateRequestCard;
}

// ── gate.v2 ──────────────────────────────────────────────────────────────────
//
// Options come from the gate: this carrier keeps no list of valid ids, and superpipeline
// refuses an id the gate did not offer. Everything below is about carrying what the board
// sent faithfully and boundedly — content from the network is untrusted, so each field is
// re-checked here even though the board bounds it too.

export const GATE_OPTION_MEANINGS = ["approve", "reject", "revise", "choose", "defer"] as const;
export type GateOptionMeaning = (typeof GATE_OPTION_MEANINGS)[number];

/** One option of a gate.v2, as it rides on the Matrix wire. */
export interface GateOptionV2 {
  id: string;
  label: string;
  meaning: GateOptionMeaning;
  needs_comment: boolean;
  delivery?: "automatic" | "manual";
}

/** Bounds, the same as the board's (`boundedPreview` in superpipeline). */
const PREVIEW_TEXT_MAX = 4000;
const PREVIEW_FIELD_MAX = 200;
const PREVIEW_BLOCKS_MAX = 20;
const OPTION_ID_MAX = 200;
const OPTIONS_MAX = 20;
const SUBJECT_KEY_MAX = 512;
/**
 * The whole preview's budget, in UTF-8 bytes of its JSON-encoded strings — the measure that
 * actually fills an event. The preview rides twice in the prose message (fenced in the body and
 * in `subject.preview`) and a handoff summary twice more (v2 and the v1 card), and Matrix refuses
 * an event over 64 KiB — before Megolm's base64 adds a third in an encrypted board room. Without
 * a total, twenty blocks at their per-block limits made an event that never reached the room.
 */
const PREVIEW_TOTAL_BYTES = 16_000;
/** A handoff summary's budget, same measure. The board bounds an ordinary one at 600 characters. */
const HANDOFF_SUMMARY_BYTES = 4_000;

const utf8 = new TextEncoder();
/** What a string costs inside an event: its JSON encoding, in UTF-8 bytes. */
const jsonBytes = (v: string): number => utf8.encode(JSON.stringify(v)).length;

/** Cut a string to fit `max` JSON-encoded bytes, marking the cut; never splits a surrogate pair. */
function cutToBytes(v: string, max: number): string {
  if (jsonBytes(v) <= max) return v;
  let lo = 0;
  let hi = v.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (jsonBytes(`${v.slice(0, mid)}…`) <= max) lo = mid;
    else hi = mid - 1;
  }
  const code = v.charCodeAt(lo - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? lo - 1 : lo;
  return `${v.slice(0, end)}…`;
}

/** What one preview block costs against `PREVIEW_TOTAL_BYTES`. */
function blockBytes(b: GatePreviewBlock): number {
  if (b.type === "text") return jsonBytes(b.label ?? "") + jsonBytes(b.text);
  if (b.type === "field") return jsonBytes(b.label) + jsonBytes(b.value);
  return jsonBytes(b.label) + jsonBytes(b.url);
}

const cut = (max: number) => (v: string) => (v.length > max ? `${v.slice(0, max - 1)}…` : v);

/** A preview block, re-validated: unknown keys stripped, strings cut, links http(s) only. */
const PreviewBlock = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    label: z.string().transform(cut(PREVIEW_FIELD_MAX)).optional(),
    text: z.string().transform(cut(PREVIEW_TEXT_MAX)),
  }),
  z.object({
    type: z.literal("field"),
    label: z.string().transform(cut(PREVIEW_FIELD_MAX)),
    value: z.string().transform(cut(PREVIEW_FIELD_MAX)),
  }),
  z.object({
    type: z.literal("link"),
    label: z.string().transform(cut(PREVIEW_FIELD_MAX)),
    // Not cut: a shortened URL is a different address. Too long or not http(s) is dropped.
    url: z.string().max(PREVIEW_TEXT_MAX).regex(/^https?:\/\/[^\s<>]+$/),
  }),
]);
export type GatePreviewBlock = z.infer<typeof PreviewBlock>;

/**
 * The same block, accepted only if it needs no cutting. A block that `PreviewBlock` accepts and
 * this refuses was shortened here, which makes the preview incomplete.
 */
const ExactPreviewBlock = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    label: z.string().max(PREVIEW_FIELD_MAX).optional(),
    text: z.string().max(PREVIEW_TEXT_MAX),
  }),
  z.object({
    type: z.literal("field"),
    label: z.string().max(PREVIEW_FIELD_MAX),
    value: z.string().max(PREVIEW_FIELD_MAX),
  }),
  z.object({ type: z.literal("link"), label: z.string().max(PREVIEW_FIELD_MAX), url: z.string() }),
]);

/** The subject's identity is matched exactly by superpipeline, so it is refused, never cut. */
const RawSubject = z.object({
  id: z.string().min(1).max(SUBJECT_KEY_MAX),
  digest: z.string().min(1).max(SUBJECT_KEY_MAX),
  schema: z.string().min(1).max(PREVIEW_FIELD_MAX),
  revision: z.number().finite(),
  expiresAt: z.string().max(PREVIEW_FIELD_MAX).nullish().catch(null),
  preview: z.array(z.unknown()).optional().catch(undefined),
  /** False when the board had to cut or drop blocks to fit the bounds. Absent from older boards. */
  previewComplete: z.boolean().optional().catch(undefined),
});

/** A subject-bound gate's subject, as it rides on the Matrix wire. */
export interface GateSubjectV2 {
  id: string;
  digest: string;
  schema: string;
  revision: number;
  expires_at: string | null;
  preview: GatePreviewBlock[];
  /**
   * Whether `preview` is everything the person must see. False when the board said it cut or
   * dropped blocks, when it sent no preview at all, or when this hub's own re-bounding cut or
   * dropped anything. A client must not offer an approving option on an incomplete preview, and
   * this hub refuses an approving decision.v2 on one (`handleGateDecision`).
   */
  preview_complete: boolean;
}

/**
 * The subject a gate is bound to, or null when it is bound to none — or when what the board
 * sent is not a subject this hub can carry, which `gateOptionsV2` then treats as unshowable.
 */
export function gateSubjectV2(d: GatePendingDelivery): GateSubjectV2 | null {
  const parsed = RawSubject.safeParse(d.approvalSubject);
  if (!parsed.success) return null;
  const s = parsed.data;
  const raw = s.preview ?? [];
  // An older board that sent a preview and no flag is taken as complete. The board's flag is
  // only ever able to make a preview LESS complete: a preview that is absent, not an array
  // (both read as undefined here), or empty once checked has shown the person nothing,
  // whatever the flag says.
  let complete = s.previewComplete !== false && s.preview !== undefined;
  const preview: GatePreviewBlock[] = [];
  let used = 0;
  let full = false;
  for (const block of raw) {
    const b = PreviewBlock.safeParse(block);
    // Dropped (malformed, past the block limit, past the byte budget) or cut: either way, not
    // all of it. Once the budget is reached every later block is dropped, so what is shown is
    // always a prefix of what the board sent, in its order.
    if (!b.success || !ExactPreviewBlock.safeParse(block).success) complete = false;
    if (!b.success) continue;
    if (full || preview.length === PREVIEW_BLOCKS_MAX || used + blockBytes(b.data) > PREVIEW_TOTAL_BYTES) {
      full = true;
      complete = false;
      continue;
    }
    used += blockBytes(b.data);
    preview.push(b.data);
  }
  if (preview.length === 0) complete = false;
  return {
    id: s.id,
    digest: s.digest,
    schema: s.schema,
    revision: s.revision,
    expires_at: s.expiresAt ?? null,
    preview,
    preview_complete: complete,
  };
}

/**
 * What an option means when an older board did not say. The board's own mapping
 * (`optionMeaning` in superpipeline), used only as the fallback.
 */
function derivedMeaning(id: string): GateOptionMeaning {
  if (id === "approve" || id === "approve_automatic" || id === "approve_manual") return "approve";
  if (id === "reject") return "reject";
  if (id === "request_changes") return "revise";
  return "defer";
}

const RawOption = z.object({
  id: z.string().min(1).max(OPTION_ID_MAX),
  label: z.string().transform(cut(PREVIEW_FIELD_MAX)),
  meaning: z.enum(GATE_OPTION_MEANINGS).optional().catch(undefined),
  needsComment: z.boolean().optional().catch(undefined),
  delivery: z.enum(["automatic", "manual"]).optional().catch(undefined),
});

/**
 * The options a gate offers, for gate.v2: every option the board sent, in its order.
 *
 * An option without a usable id or label is dropped, and a repeated id keeps its first entry —
 * answering is by id. `meaning` and `needs_comment` are the board's; an older board sends
 * neither, and then they are derived from the id. An option that approves a subject
 * (`delivery`) is dropped when the subject itself could not be carried: a person must never
 * be offered an approval of something the card cannot show them.
 */
export function gateOptionsV2(d: GatePendingDelivery): GateOptionV2[] {
  // The board said this gate is bound to a subject, and the hub could not carry it. The gate is
  // then recorded as bound to nothing, so an approval would pass this hub's subject checks
  // without any binding — every approving option goes, not only those naming a delivery.
  // Revise and reject stay, so the person can still send the work back.
  const subjectShowable = d.approvalSubject == null || gateSubjectV2(d) !== null;
  const seen = new Set<string>();
  const out: GateOptionV2[] = [];
  for (const raw of d.options) {
    const parsed = RawOption.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const o = parsed.data;
    const meaning = o.meaning ?? derivedMeaning(o.id);
    if (!subjectShowable && (o.delivery || meaning === "approve")) continue;
    seen.add(o.id);
    out.push({
      id: o.id,
      label: o.label,
      meaning,
      needs_comment: o.needsComment ?? o.id === "request_changes",
      ...(o.delivery ? { delivery: o.delivery } : {}),
    });
    if (out.length === OPTIONS_MAX) break;
  }
  return out;
}

/** Fence a text so markdown keeps every character of it: longer than any backtick run inside. */
function fenced(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

function previewMarkdown(preview: GatePreviewBlock[]): string {
  return preview
    .map((b) => {
      if (b.type === "text") return b.label ? `${b.label}:\n${fenced(b.text)}` : fenced(b.text);
      if (b.type === "field") return `${b.label}: ${b.value}`;
      return `${b.label}: <${b.url}>`;
    })
    .join("\n\n");
}

/**
 * The sentence a stock client sees for a gate.v2.
 *
 * For a gate bound to no subject it is the v1 sentence, unchanged. For a subject-bound gate it
 * shows the subject's preview — for a post, the exact text, fenced so markdown cannot eat its
 * asterisks — because charter decision 3 is that a person approves bytes they can see.
 */
export function gateV2ProseBody(d: GatePendingDelivery, link?: string): string {
  const subject = gateSubjectV2(d);
  if (!subject) return gateProseBody(d, link);
  const head = `Approval needed — "${d.cardTitle}" at stage \`${d.stageKey}\`.`;
  const preview = previewMarkdown(subject.preview);
  const tail = link ? `[Open the card](${link})` : "";
  return [head, preview, tail].filter((part) => part !== "").join("\n\n");
}

/**
 * The gate.v2 content: an `m.room.message` / `m.text` with a real `body` and the
 * `suite_event_type` marker. Pinned by the shared fixture.
 */
export function gateV2Content(d: GatePendingDelivery, deepLink?: string): Record<string, unknown> {
  const subject = gateSubjectV2(d);
  return {
    msgtype: "m.text",
    body: gateV2ProseBody(d, deepLink),
    suite_event_type: GATE_V2_SUITE_TYPE,
    schema_version: 1,
    board_id: d.boardId,
    card_id: d.cardId,
    gate_id: d.gateId,
    stage_key: d.stageKey,
    return_stage_key: d.returnStageKey,
    card_title: d.cardTitle,
    produced_by: d.producedBy,
    prompt: `Approve "${d.cardTitle}"?`,
    ...(d.handoffSummary ? { handoff_summary: cutToBytes(d.handoffSummary, HANDOFF_SUMMARY_BYTES) } : {}),
    options: gateOptionsV2(d),
    ...(subject ? { subject } : {}),
    ...(deepLink ? { deep_link: deepLink } : {}),
  };
}
