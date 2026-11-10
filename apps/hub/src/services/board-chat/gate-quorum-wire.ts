/**
 * The wire of a gate that needs more than one approver (charter: "A gate may need more than one
 * approver", 2026-11-09).
 *
 * Two things cross it. The quorum a gate.v2 carries beside its options (§7): `quorum { required,
 * from, approvals: [{ principal_id, at, variant_id? }] }`, from the board's camelCase `quorum`. And
 * the `gate.approval_recorded` the board pushes for each approval short of the quorum, which this
 * hub posts as a progress reply to the gate's card.
 *
 * Pure; no database and no Matrix. Every field comes off the network, so each is re-checked here,
 * and a quorum that is not well formed is not carried at all rather than carried as junk.
 */

import type { GateApprovalRecordedDelivery } from "../bridge";
import { isIsoTime } from "./decision-timeout-wire";

/** The structured half of a progress reply, so a client can update the gate's card count. */
export const GATE_PROGRESS_TYPE = "dev.agentpod.gate.progress.v2";

/** The board's own bounds on `required` (charter §1). */
export const QUORUM_MIN = 2;
export const QUORUM_MAX = 5;
/**
 * At most this many recorded approvals. Each person counts once, but on a variant gate approvals
 * are counted per variant, so a pending gate may hold up to (required - 1) per variant: 12 at the
 * board's bounds. Twice that leaves room and still bounds the event.
 */
export const QUORUM_APPROVALS_MAX = 32;
const PRINCIPAL_ID_MAX = 128;
const VARIANT_ID_MAX = 64;

/** One recorded approval, as it rides on the Matrix wire. */
export interface GateQuorumApprovalV2 {
  principal_id: string;
  at: string;
  variant_id?: string;
}

/** A quorum gate's progress, as it rides on the Matrix wire. */
export interface GateQuorumV2 {
  required: number;
  from: "deciders" | "admins";
  approvals: GateQuorumApprovalV2[];
}

const field = (v: object, k: string): unknown => Reflect.get(v, k);
const isRecord = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);
const boundedId = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/**
 * The board's `{ principalId, at, variantId? }`, carried as `{ principal_id, at, variant_id? }`, or
 * null when it is not one: a principal id that is empty or too long, a time that is not one, or a
 * variant id present but not a bounded string.
 */
export function approvalV2(raw: unknown): GateQuorumApprovalV2 | null {
  if (!isRecord(raw)) return null;
  const principalId = field(raw, "principalId");
  const at = field(raw, "at");
  const variantId = field(raw, "variantId");
  if (!boundedId(principalId, PRINCIPAL_ID_MAX) || !isIsoTime(at)) return null;
  if (variantId !== undefined && !boundedId(variantId, VARIANT_ID_MAX)) return null;
  return { principal_id: principalId, at, ...(variantId !== undefined ? { variant_id: variantId } : {}) };
}

/**
 * The board's quorum, re-validated and carried snake_case, or null when it sent none or one this
 * hub will not carry: `required` not a whole number from 2 to 5, `from` not `deciders` or `admins`,
 * approvals not a list, more than `QUORUM_APPROVALS_MAX`, any one malformed, or one person twice.
 */
export function quorumV2(raw: unknown): GateQuorumV2 | null {
  if (!isRecord(raw)) return null;
  const required = field(raw, "required");
  const from = field(raw, "from");
  const approvals = field(raw, "approvals");
  if (typeof required !== "number" || !Number.isInteger(required) || required < QUORUM_MIN || required > QUORUM_MAX) return null;
  if (from !== "deciders" && from !== "admins") return null;
  if (!Array.isArray(approvals) || approvals.length > QUORUM_APPROVALS_MAX) return null;
  const out: GateQuorumApprovalV2[] = [];
  for (const a of approvals) {
    const approval = approvalV2(a);
    if (!approval || out.some((o) => o.principal_id === approval.principal_id)) return null;
    out.push(approval);
  }
  return { required, from, approvals: out };
}

/** `{ quorum }` to spread into a gate.v2, or nothing, so a gate without one is byte-identical. */
export function quorumField(raw: unknown): { quorum?: GateQuorumV2 } {
  const quorum = quorumV2(raw);
  return quorum ? { quorum } : {};
}

/**
 * Is this a `gate.approval_recorded` this hub can act on? Used on the signed push, because
 * authenticated is not checked: the identifiers present, the approval and the quorum well formed,
 * and the approval among the quorum's recorded ones — a push whose two halves disagree is not one
 * this hub can say anything true about.
 */
export function isGateApprovalRecorded(v: unknown): v is GateApprovalRecordedDelivery {
  if (!isRecord(v) || field(v, "event") !== "gate.approval_recorded") return false;
  const nonEmpty = (k: string) => {
    const x = field(v, k);
    return typeof x === "string" && x !== "";
  };
  if (!nonEmpty("boardId") || !nonEmpty("cardId") || !nonEmpty("gateId")) return false;
  const approval = approvalV2(field(v, "approval"));
  const quorum = quorumV2(field(v, "quorum"));
  if (!approval || !quorum) return false;
  return quorum.approvals.some((a) => a.principal_id === approval.principal_id && a.variant_id === approval.variant_id);
}

/** How many recorded approvals count with this one: those for the same variant (or none). */
export function approvalsCounted(quorum: GateQuorumV2, approval: GateQuorumApprovalV2): number {
  return quorum.approvals.filter((a) => a.variant_id === approval.variant_id).length;
}

/**
 * The sentence a stock client sees: "Approved by rakesh — 1 of 2. Waiting for 1 more." On a variant
 * gate the variant is named ("Approved "Short" by rakesh — …"). Who is a handle, never an mxid; a
 * person this hub cannot name is left out rather than shown as an id.
 */
export function gateProgressBody(input: {
  who: string | null;
  variantLabel: string | null;
  count: number;
  required: number;
}): string {
  const what = input.variantLabel ? `Approved "${input.variantLabel}"` : "Approved";
  const by = input.who ? ` by ${input.who}` : "";
  const more = Math.max(1, input.required - input.count);
  return `${what}${by} — ${input.count} of ${input.required}. Waiting for ${more} more.`;
}

/**
 * The structured half of a progress reply, sent as its own event beside the prose, as the outcome
 * receipt is: it references the gate's own event, so a client knows which card's count to update.
 * Pinned by the shared fixture.
 */
export function gateProgressContent(input: {
  gateId: string;
  boardId: string;
  cardId: string;
  approval: GateQuorumApprovalV2;
  quorum: GateQuorumV2;
  approvedBy: string | null;
  variantLabel: string | null;
  gateEventId: string;
}): Record<string, unknown> {
  return {
    suite_event_type: GATE_PROGRESS_TYPE,
    schema_version: 1,
    gate_id: input.gateId,
    board_id: input.boardId,
    card_id: input.cardId,
    approved_by: input.approvedBy,
    approval: input.approval,
    ...(input.approval.variant_id && input.variantLabel
      ? { chosen_variant: { id: input.approval.variant_id, label: input.variantLabel } }
      : {}),
    quorum: input.quorum,
    "m.relates_to": { rel_type: "m.reference", event_id: input.gateEventId },
  };
}
