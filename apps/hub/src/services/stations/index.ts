/**
 * The public entry point of services/stations: the names other modules import, and nothing else.
 * Every import from outside this folder goes through here; see docs/contributor/code-quality.md.
 */
export { stationFailure } from "./failure";
export {
  notifyStationsAdopted,
  onProvisionStation,
  onStationMatrixIdReported,
  onStationsAdopted,
  provisionStationNow,
  stationReportedMatrixId,
  stationSetupMatrixDomain,
} from "./hooks";
export { changeProxy, fleetView, oneStation, rotateProxy } from "./mcp-proxy";
export {
  adoptStations,
  announceStationsForNode,
  gateCapability,
  getStation,
  listAdopted,
  markStationTreeRevoking,
  refreshAdoptedCapabilities,
  reportUnknownCapabilities,
  unadopt,
} from "./registry";
export type { StationRow } from "./registry";
export { stationForPrincipal } from "./self-station";
export type { SelfStation } from "./self-station";
