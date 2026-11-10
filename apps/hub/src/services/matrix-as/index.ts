/**
 * The public entry point of services/matrix-as: the names other modules import, and nothing else.
 * Every import from outside this folder goes through here; see docs/contributor/code-quality.md.
 */
export { signalNodeToAdopt } from "./adopt-signal";
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
