/**
 * The public entry point of services/board-chat: the names other modules import, and nothing else.
 * Every import from outside this folder goes through here; see docs/contributor/code-quality.md.
 */
export { boardProjectionDeps, joinWake, withJoinWake } from "./board-projection";
export { matrixIdsForBoardHumans } from "./board-room";
export { projectAttention, recordedAttention } from "./attention-projection";
export type { AttentionProjectionDeps } from "./attention-projection";
export { reconcileBoardAttention } from "./fleet-attention";
export { relayTokenForBoard } from "./relay-scope";
export { handleDecisionTimeout, repostEscalationsOnJoin, retryEscalationReposts } from "./decision-notices";
export type { DecisionNoticeDeps, DecisionNoticeOutcome } from "./decision-notices";
export { projectDelivery } from "./delivery-projection";
export { isElicitationPending } from "./elicitation-card";
export { startElicitationSweeper } from "./elicitation-sweep";
export { postedElicitationsAwaitingOutcome, projectElicitation } from "./elicitations";
export { reconcileBoardGates } from "./fleet-gates";
export { handleDecisionPulledBack, handleDecisionReleased } from "./gate-hold";
export type { GateHoldDeps, GateHoldOutcome } from "./gate-hold";
export { handleCheckFailed, handleCheckOverridden } from "./check-notices";
export type { CheckNoticeDeps, CheckNoticeOutcome } from "./check-notices";
export { handleGateApprovalRecorded } from "./gate-progress";
export type { GateProgressDeps, GateProgressOutcome } from "./gate-progress";
export { startGateSweeper } from "./gate-sweep";
export { isGatePending, projectGate, projectionForGate, tenantForBoard } from "./gates";
export type { GatePendingDelivery, GateProjectionDeps } from "./gates";
export { handleAttentionAnswer, parseAttentionAnswer, settleAttentionOutcome } from "./attention-answer";
export { claimAttentionOutcome } from "./attention-projection";
export type { WaitKey } from "./attention-projection";
export { boardRoomFor } from "./board-room";
export { handleCheckOverride } from "./check-override";
export { recordedChecksCard } from "./checks-waiting";
export { handleDeliveryAnswer, parseDeliveryAnswer, settleDeliveryOutcome } from "./delivery-answer";
export { claimDeliveryOutcome, recordedDelivery } from "./delivery-projection";
export { answerElicitationAtSuperpipeline, claimElicitationOutcome, handleElicitationAnswer, recordedQuestion } from "./elicitations";
export { clearAttentionDecision } from "./fleet-attention";
export { handleGateDecision, parseGateDecision, settleGateOutcome } from "./gate-decision";
export { handleGatePullBack } from "./gate-pull-back";
export { roomAgentUser } from "./gate-reads";
export { answerAttentionAtSuperpipeline, overrideCheckAtSuperpipeline, pullBackAtSuperpipeline, resolveGateAtSuperpipeline, updateDeliveryAtSuperpipeline } from "./gate-resolve";
export { readBoardGate } from "./gate-sweep";
export { legacyRequestEvents } from "./legacy-events";
export { bindingOf, handleQuestionAnswer, parseQuestionAnswer, referenceOf } from "./question-answer";
export { matchPermissionAnswer, unmatchedAnswerText } from "./reply-options";
export type { PermissionOption } from "./reply-options";
export { MOVED_BOARDS_ENV, MovedBoardsConfigError, isBoardMoved, movedBoardOfRoom, parseMovedBoards, startMovedBoardNotices } from "./moved-boards";
