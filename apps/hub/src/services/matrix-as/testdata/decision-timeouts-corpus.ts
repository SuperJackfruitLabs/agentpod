/**
 * The inputs behind the shared corpus's decision-timeout entries (fixture version 7): one waiting
 * decision of each kind with a deadline, the expired gate's receipt, and the two notices. The hub's
 * own output for these is what the corpus accepts (`decision-timeout-wire.test.ts`, against `@superjackfruitlabs/treaty-matrix-events`).
 */
import type {
  AttentionPendingDelivery,
  DecisionTimeoutDelivery,
  DeliveryPendingDelivery,
  ElicitationPendingDelivery,
  GatePendingDelivery,
} from "../../bridge";

export const CORPUS_LINK = "https://superpipeline.dev/b/brd_7c1f/c/crd_6b40";
export const CORPUS_CARD_EVENT = "$gateEventId";
const deadline = { remindAt: "2026-11-08T15:00:00.000Z", escalateAt: "2026-11-08T18:00:00.000Z" };

export const DEADLINE_GATE: GatePendingDelivery = {
  event: "gate.pending", boardId: "brd_7c1f", cardId: "crd_6b40", gateId: "gate_8f3a", stageKey: "review", returnStageKey: "draft",
  cardTitle: "Launch post", producedBy: "agt_31d0", options: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
  deadline, ts: "2026-11-08T12:00:00.000Z",
};
export const DEADLINE_QUESTION: ElicitationPendingDelivery = {
  event: "elicitation.pending", boardId: "brd_7c1f", cardId: "crd_6b40", cardTitle: "Launch post", elicitationId: "elc_5d21",
  runId: "run_e074a2160c4b4f28", stageKey: "draft", agentId: "agt_31d0", question: "Which headline?",
  options: [{ id: "a", label: "Ship it today" }, { id: "b", label: "Ship it Monday" }],
  deadline: { escalateAt: deadline.escalateAt }, ts: "2026-11-08T12:00:00.000Z",
};
export const DEADLINE_DELIVERY: DeliveryPendingDelivery = {
  event: "delivery.pending", boardId: "brd_7c1f", cardId: "crd_6b40", cardTitle: "Launch post", gateId: "gate_8f3a", stageKey: "publish",
  options: [{ id: "record_live_url", label: "Record the live link", meaning: "approve", input: { kind: "url", label: "Live link", required: true, maxLength: 2000 } }],
  deadline: { remindAt: deadline.remindAt }, ts: "2026-11-08T12:00:00.000Z",
};
export const DEADLINE_ATTENTION: AttentionPendingDelivery = {
  event: "attention.pending", boardId: "brd_7c1f", cardId: "crd_6b40", cardTitle: "Launch post", stageKey: "draft", stageName: "Draft",
  waitId: "wait_0123456789abcdef", reason: "blocked", detail: "the staging database is down",
  options: [{ id: "archive", label: "Archive", meaning: "reject", needsComment: false }], deadline, ts: "2026-11-08T12:00:00.000Z",
};

export const REMINDED: DecisionTimeoutDelivery = {
  event: "decision.reminded", boardId: "brd_7c1f", boardName: "Press", cardId: "crd_6b40", cardTitle: "Launch post", stageKey: "review",
  stageName: "Review", decisionKind: "gate", decisionId: "gate_8f3a", waitingSince: "2026-11-08T12:00:00.000Z",
  remindedAt: "2026-11-08T15:00:30.000Z", ts: "2026-11-08T15:00:30.000Z",
};
export const ESCALATED: DecisionTimeoutDelivery = {
  ...REMINDED, event: "decision.escalated", remindedAt: undefined, escalatedAt: "2026-11-08T18:02:11.000Z", ts: "2026-11-08T18:02:11.000Z",
};
