/**
 * The public entry point of services/nodes: the names other modules import, and nothing else.
 * Every import from outside this folder goes through here; see docs/contributor/code-quality.md.
 */
export { enrollNode, mintEnrollmentToken, verifyNodeCredential } from "./enrollment";
export { createFleetService, getFleetStats, listFleetAgents } from "./fleet";
export type { FleetDeps } from "./fleet";
export { clearNode, recordHealth } from "./health-cache";
export {
  listNodes,
  resetOrphanedOnlineNodes,
  setNodeAgentVersion,
  setNodeCapabilities,
  setNodeStatus,
} from "./registry";
export { nodeInTenant, removeNode } from "./removal";
export { executeRollout, planRollout, summarise } from "./rollout";
export type { RolloutNode } from "./rollout";
