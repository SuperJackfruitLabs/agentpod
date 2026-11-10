/**
 * delivery.v2: the follow-up a post approved for manual delivery owes — record its live link, or
 * switch it to automatic delivery.
 *
 * charter → "The decision envelope covers questions and follow-ups" §3. The board pushes
 * `delivery.pending` when a subject-bound gate is resolved `approve_manual` (and lists it at
 * `GET /v1/boards/:id/deliveries/pending` until a link is recorded, the mode is switched or the
 * approval expires). The hub posts it into the gate's board room as one `m.room.message` / `m.text`
 * with a real body and `suite_event_type: dev.superpipeline.delivery.v2`.
 *
 * Pure; no database and no Matrix. The subject is re-bounded exactly as a gate's is
 * (`subjectV2`), and the follow-up offers only what this hub can act on.
 */

import { z } from "zod";
import { deadlineField } from "./decision-timeout-wire";

import type { DeliveryPendingDelivery } from "../bridge";
import {
  GATE_OPTION_MEANINGS,
  GATE_OUTCOME_TYPE,
  cut,
  optionInputV2,
  previewMarkdown,
  subjectV2,
  type GateOptionMeaning,
  type GateSubjectV2,
  type OptionInputV2,
} from "./gate-wire";

export type { DeliveryPendingDelivery };

export const DELIVERY_V2_SUITE_TYPE = "dev.superpipeline.delivery.v2";
export const DELIVERY_ANSWER_V2_SUITE_TYPE = "dev.superpipeline.delivery.answer.v2";

/**
 * The two answers a follow-up takes, and the only ones: each maps to one call on the board's
 * delivery route (`{ liveUrl }` or `{ mode: "automatic" }`), so an option this hub could not act
 * on is not offered in the room.
 */
export const RECORD_LIVE_URL = "record_live_url";
export const SWITCH_TO_AUTOMATIC = "switch_to_automatic";

/** The longest live link the board takes. */
export const LIVE_URL_MAX = 2000;

const LABEL_MAX = 200;

/** One option of a delivery.v2, as it rides on the Matrix wire. */
export interface DeliveryOptionV2 {
  id: typeof RECORD_LIVE_URL | typeof SWITCH_TO_AUTOMATIC;
  label: string;
  meaning: GateOptionMeaning;
  needs_comment: boolean;
  input?: OptionInputV2;
  delivery?: "automatic";
}

/**
 * Is this a follow-up this hub knows how to post? Used on both inbound paths — the signed push
 * and the sweep's read — for the reason `isGatePending` gives: "authenticated" is not "checked".
 */
export function isDeliveryPending(v: unknown): v is DeliveryPendingDelivery {
  if (typeof v !== "object" || v === null) return false;
  if (!("event" in v) || v.event !== "delivery.pending") return false;
  return (
    "boardId" in v &&
    typeof v.boardId === "string" &&
    "cardId" in v &&
    typeof v.cardId === "string" &&
    "cardTitle" in v &&
    typeof v.cardTitle === "string" &&
    "gateId" in v &&
    typeof v.gateId === "string" &&
    v.gateId.length > 0 &&
    "stageKey" in v &&
    typeof v.stageKey === "string" &&
    "options" in v &&
    Array.isArray(v.options)
  );
}

/** The follow-up's subject, re-bounded as a gate's is; null when it is not one this hub can carry. */
export function deliverySubjectV2(d: DeliveryPendingDelivery): GateSubjectV2 | null {
  return subjectV2(d.approvalSubject);
}

const RawOption = z.object({
  id: z.enum([RECORD_LIVE_URL, SWITCH_TO_AUTOMATIC]),
  label: z.string().transform(cut(LABEL_MAX)),
  meaning: z.enum(GATE_OPTION_MEANINGS).optional().catch(undefined),
  needsComment: z.boolean().optional().catch(undefined),
  input: z.unknown().optional(),
});

/**
 * The options a follow-up offers, for delivery.v2, in the board's order.
 *
 * `record_live_url` always asks for a required `https://` link, whatever an older board said about
 * its input. `switch_to_automatic` is offered only when the subject reached the room with its
 * preview complete: the board offers it only then, and this hub's own re-bounding can make a
 * preview incomplete that the board thought whole — then nobody may turn on posting what the card
 * could not show. Any other option is dropped: there is no call to make for it.
 */
export function deliveryOptionsV2(d: DeliveryPendingDelivery): DeliveryOptionV2[] {
  const subject = deliverySubjectV2(d);
  const seen = new Set<string>();
  const out: DeliveryOptionV2[] = [];
  for (const raw of d.options) {
    const parsed = RawOption.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const o = parsed.data;
    if (o.id === SWITCH_TO_AUTOMATIC && subject?.preview_complete !== true) continue;
    seen.add(o.id);
    if (o.id === RECORD_LIVE_URL) {
      const asked = optionInputV2(o.input);
      out.push({
        id: o.id,
        label: o.label,
        meaning: o.meaning ?? "defer",
        needs_comment: o.needsComment ?? false,
        input: {
          kind: "url",
          label: asked?.label ?? "Live link",
          required: true,
          max_length: Math.min(asked?.max_length ?? LIVE_URL_MAX, LIVE_URL_MAX),
        },
      });
    } else {
      out.push({
        id: o.id,
        label: o.label,
        meaning: o.meaning ?? "approve",
        needs_comment: o.needsComment ?? false,
        delivery: "automatic",
      });
    }
  }
  return out;
}

/**
 * The sentence a stock client sees: what was approved, the exact preview (fenced, as a gate's
 * is), and the choices.
 */
export function deliveryProseBody(
  d: DeliveryPendingDelivery,
  subject: GateSubjectV2 | null,
  options: DeliveryOptionV2[],
  link?: string,
): string {
  const head = `Waiting on a live link — "${cut(LABEL_MAX)(d.cardTitle)}" was approved to be posted by hand. Once it is live, record its link here.`;
  const preview = subject ? previewMarkdown(subject.preview) : "";
  const choices = options.map((o) => `- ${o.label}`).join("\n");
  const tail = link ? `[Open the card](${link})` : "";
  return [head, preview, choices, tail].filter((part) => part !== "").join("\n\n");
}

/** The delivery.v2 content. Pinned by the shared fixture. */
export function deliveryV2Content(d: DeliveryPendingDelivery, deepLink?: string): Record<string, unknown> {
  const subject = deliverySubjectV2(d);
  const options = deliveryOptionsV2(d);
  return {
    msgtype: "m.text",
    body: deliveryProseBody(d, subject, options, deepLink),
    suite_event_type: DELIVERY_V2_SUITE_TYPE,
    schema_version: 1,
    board_id: d.boardId,
    card_id: d.cardId,
    gate_id: d.gateId,
    stage_key: d.stageKey,
    card_title: cut(LABEL_MAX)(d.cardTitle),
    ...(subject ? { subject } : {}),
    options,
    ...deadlineField(d.deadline),
    ...(deepLink ? { deep_link: deepLink } : {}),
  };
}

/** How a follow-up was settled: one of its two answers, or on the board itself. */
export type DeliveryOutcomeDecision = typeof RECORD_LIVE_URL | typeof SWITCH_TO_AUTOMATIC | "settled_elsewhere";

/**
 * The structured half of a follow-up's receipt. A follow-up "is settled by a receipt, like a
 * gate" (charter §3), so it is the gate's own `dev.superpipeline.gate.outcome.v1`, field for field
 * (`settleGateOutcome`), pointing at the follow-up's message so a client knows which card to
 * close. `decided_by` is the person's label; null when it was settled on the board.
 */
export function deliveryOutcomeContent(
  gateId: string,
  followUp: { boardId: string; eventId: string },
  decision: DeliveryOutcomeDecision,
  decidedBy: string | null,
): Record<string, unknown> {
  return {
    suite_event_type: GATE_OUTCOME_TYPE,
    gate_id: gateId,
    board_id: followUp.boardId,
    decision,
    decided_by: decidedBy,
    "m.relates_to": { rel_type: "m.reference", event_id: followUp.eventId },
  };
}
