/**
 * Projecting a superpipeline approval gate into the room where the work happened.
 *
 * `charter` → `decisions/2026-08-30-a-gate-closes-over-chat.md`. superpipeline owns
 * the gate; this only renders it and carries an answer back.
 *
 * ## Two events, not one
 *
 * A gate is sent as `dev.superpipeline.gate.v1` **and** as an ordinary prose
 * message beside it. That is this codebase's existing convention rather than a
 * new idea — `dev.agentpod.permission.v1` already does it, and supermessage's
 * `PermissionRequestRenderer` documents why: a client that never renders the
 * custom event is then "exactly as able to answer as it was". It matters here
 * because a stock Matrix client renders an unknown **event type** as nothing at
 * all. superpipeline#34 assumed a custom event's own `body` would be shown by every
 * client; that holds for an unknown *msgtype* and not for an unknown *type*.
 *
 * The prose goes first. If only one of the two lands, the room should be left
 * with a readable question and no buttons rather than buttons and no context.
 *
 * **Since 2026-09-28 the prose carries the gate too**, under
 * `dev.superpipeline.gate` (`GATE_REQUEST_CONTENT_KEY`), so one question is
 * one event and one push. The custom event is now the legacy half, sent only
 * while `AGENTPOD_LEGACY_PERMISSION_EVENTS` is on; a decision may reference
 * either.
 *
 * ## Why a gate can be delivered more than once, and must post once
 *
 * superpipeline's push is at-least-once within an attempt cap, its alarm re-picks
 * failed rows, and the sweep asks independently which pending gates have no
 * event. All three are meant to overlap. `matrix_gate_events` keyed on
 * `gate_id` is what turns that overlap into one question instead of three.
 *
 * ## Where each concern lives
 *
 * This file is the service's surface: it re-exports what the rest of the hub (through
 * `index.ts`) and the tests use, from the files that hold each concern.
 *
 *   gate-wire        event types, option ids, `isGatePending`, the prose and the event content
 *                    (v1, and gate.v2: options as offered, the subject and its preview)
 *   gate-projection  `projectGate`: the claim, the held-for-a-join answer, the sends
 *   gate-decision    the way back: parsing a decision, acting on it, the outcome receipt
 *   gate-resolve     resolving at superpipeline as the human, with a minted assertion
 *   gate-reads       `tenantForBoard`, `projectionForGate`, `roomAgentUser`
 */

export type { GatePendingDelivery } from "../bridge";
export {
  GATE_DECISION_SUITE_TYPE,
  GATE_DECISION_V2_SUITE_TYPE,
  GATE_EVENT_TYPE,
  GATE_OPTION_IDS,
  GATE_OUTCOME_TYPE,
  GATE_V2_SUITE_TYPE,
  gateEventContent,
  gateOptionsV2,
  gateProseBody,
  gateRequestCard,
  gateSubjectV2,
  gateV2Content,
  gateV2ProseBody,
  isGateOptionId,
  isGatePending,
} from "./gate-wire";
export type { GateOptionId, GateOptionV2, GateSubjectV2 } from "./gate-wire";
export { projectGate } from "./gate-projection";
export type { GateProjectionDeps, ProjectionOutcome } from "./gate-projection";
export { handleGateDecision, parseGateDecision, settleGateOutcome } from "./gate-decision";
export type {
  DecisionRefusal,
  GateDecisionDeps,
  GateDecisionEvent,
  GateSubjectBinding,
  ParsedGateDecision,
} from "./gate-decision";
export { resolveGateAtSuperpipeline } from "./gate-resolve";
export { projectionForGate, roomAgentUser, tenantForBoard } from "./gate-reads";
