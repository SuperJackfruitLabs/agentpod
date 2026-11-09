/**
 * The public entry point of services/matrix-as: the names other modules import, and nothing else.
 * Every import from outside this folder goes through here; see docs/contributor/code-quality.md.
 */
export { signalNodeToAdopt } from "./adopt-signal";
export { boardProjectionDeps, joinWake, withJoinWake } from "./board-projection";
export { matrixIdsForBoardHumans } from "./board-room";
export { isMatrixUserInUse } from "./client";
export { isAttentionPending } from "./attention-wire";
export { projectAttention, recordedAttention } from "./attention-projection";
export type { AttentionProjectionDeps } from "./attention-projection";
export { reconcileBoardAttention } from "./fleet-attention";
export { relayTokenForBoard } from "./relay-scope";
export { isApprovalRequest } from "./question-wire";
export { isDecisionTimeout } from "./decision-timeout-wire";
export { handleDecisionTimeout, repostEscalationsOnJoin, retryEscalationReposts } from "./decision-notices";
export type { DecisionNoticeDeps, DecisionNoticeOutcome } from "./decision-notices";
export { isDeliveryPending } from "./delivery-wire";
export { projectDelivery } from "./delivery-projection";
export { isElicitationPending } from "./elicitation-card";
export { startElicitationSweeper } from "./elicitation-sweep";
export { postedElicitationsAwaitingOutcome, projectElicitation } from "./elicitations";
export { reconcileBoardGates } from "./fleet-gates";
export { isGateApprovalRecorded } from "./gate-quorum-wire";
export { isDecisionPulledBack, isDecisionReleased } from "./gate-release-wire";
export { handleDecisionPulledBack, handleDecisionReleased } from "./gate-hold";
export type { GateHoldDeps, GateHoldOutcome } from "./gate-hold";
export { handleGateApprovalRecorded } from "./gate-progress";
export type { GateProgressDeps, GateProgressOutcome } from "./gate-progress";
export { startGateSweeper } from "./gate-sweep";
export { isGatePending, projectGate, projectionForGate, tenantForBoard } from "./gates";
export type { GatePendingDelivery, GateProjectionDeps } from "./gates";
export { recordTransaction } from "./health";
export {
  moveState,
  preJoinNewIdentity,
  preJoinRefusal,
  wireConvergenceListener,
} from "./identity-move";
export type { MoveState, PreJoinOutcome } from "./identity-move";
export { missionAlias } from "./missions";
export { createMatrixBridge, matrixBridgeConfig, startMatrixBridge } from "./service";
export type { MatrixBridge } from "./service";
export { GENERAL_MISSIONS_KEY, ensureSpaceRecord } from "./spaces";
export type { Space } from "./spaces";
export { roomAliasForStation, roomForStation, unboundRoomsForStation } from "./station-room";
export { stationForAgentUserId, stationForAlias } from "./stations";
