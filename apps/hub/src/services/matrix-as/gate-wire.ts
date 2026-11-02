/**
 * A gate's wire: the event types and option ids superpipeline owns, the predicate for a gate
 * this hub can post, and the content of the prose message and the custom event.
 *
 * Pure; no database and no Matrix. Split out of `gates.ts`, which re-exports it.
 */

import { type GateRequestCard } from "@agentpod/contract";
import type { GatePendingDelivery } from "../bridge";

export const GATE_EVENT_TYPE = "dev.superpipeline.gate.v1";
export const GATE_DECISION_SUITE_TYPE = "dev.superpipeline.gate.decision.v1";

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
  const options = d.options.filter((o) => isGateOptionId(o.id));
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
    ...(d.handoffSummary ? { handoff_summary: d.handoffSummary } : {}),
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
