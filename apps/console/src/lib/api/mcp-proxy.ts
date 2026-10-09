import { McpProxyStationView } from "@agentpod/contract";
import { http } from "./client";

/** Whether the station's node serves it through the loopback MCP proxy (fleet mcp-proxy). Read-only. */
export const getStationMcpProxy = async (stationId: string) =>
  McpProxyStationView.parse(await http(`/api/stations/${encodeURIComponent(stationId)}/mcp-proxy`));
