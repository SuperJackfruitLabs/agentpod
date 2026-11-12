/**
 * The public entry point of services/bridge: the names other modules import, and nothing else.
 * Every import from outside this folder goes through here; see docs/contributor/code-quality.md.
 */
export { isBridgeEnabled, loadBridgeConfig } from "./config";
export type { BridgeConfig } from "./config";
export { DECISION_KINDS } from "./deliveries";
export type {
  AttentionPendingDelivery,
  CheckFailedDelivery,
  CheckOverriddenDelivery,
  CheckProvider,
  CheckStatus,
  DecisionKind,
  DecisionPulledBackDelivery,
  DecisionReleasedDelivery,
  DecisionTimeoutDelivery,
  DeliveryPendingDelivery,
  ElicitationPendingDelivery,
  GateApprovalRecordedDelivery,
  GatePendingDelivery,
} from "./deliveries";
export { checkBridgeDispatchGrant, ensureBridgeDispatchGrant } from "./dispatch-grant";
export { attachExecutionReference } from "./execution-reference";
export { startSuperpipelineBridge } from "./loop";
export { subscribeBoardsToPush } from "./push-subscription";
export { RELAY_CREDENTIAL_ENV, createSuperpipelineRelay, readRelayCredential, superpipelineRelayFromEnv } from "./relay";
export type { SuperpipelineRelay } from "./relay";
export {
  bridgePlaneCredential,
  createBridgeAgent,
  deleteBridgeAgent,
  listBridgeAgents,
  readBridgeRoster,
  updateBridgeAgent,
} from "./roster";
export { probeSalaamWork, settleNeverDispatchedSalaamWork } from "./salaam-dispatch";
export { traceDeliveryEvidence } from "./salaam-trace";
export { bridgeReadiness } from "./station-readiness";
export { SuperpipelineApiError, SuperpipelineClient, fetchAdapter } from "./superpipeline";
export type { Fetcher } from "./superpipeline";
export { isWorkAvailable, onWorkAvailable, wakeBoard } from "./work-wake";
export type { WorkAvailableDelivery } from "./work-wake";
