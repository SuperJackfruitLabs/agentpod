import { expect, test } from "bun:test";
import {
  MCP_PROXY_HARNESSES,
  mcpProxyEligible,
  McpProxyChangeRequest,
  McpProxyFleetView,
  McpProxyStationState,
} from "./mcp-proxy";
import { NodeCapability } from "./posture";
import { VERB_PARAMS, VERB_RESULTS } from "./protocol";

test("only harnesses whose ACP adapter takes HTTP MCP servers in session/new are eligible", () => {
  expect([...MCP_PROXY_HARNESSES].sort()).toEqual(["claude-code", "codex", "hermes", "opencode"]);
  expect(mcpProxyEligible("hermes")).toBe(true);
  expect(mcpProxyEligible("openclaw")).toBe(false);
  expect(mcpProxyEligible("pi")).toBe(false);
  expect(mcpProxyEligible("something-new")).toBe(false);
});

test("the node verbs carry station ids and never a secret", () => {
  expect(VERB_PARAMS["mcp.proxy.status"].parse({})).toEqual({});
  expect(VERB_PARAMS["mcp.proxy.set"].parse({ enable: ["st_a"] })).toEqual({ enable: ["st_a"] });
  expect(VERB_PARAMS["mcp.proxy.set"].parse({ disable: ["st_a"] })).toEqual({ disable: ["st_a"] });
  expect(VERB_PARAMS["mcp.proxy.rotate"].parse({})).toEqual({});
  expect(VERB_PARAMS["mcp.proxy.rotate"].parse({ stations: ["st_a"] })).toEqual({ stations: ["st_a"] });
  // The status answer names stations only. A `secrets` field is stripped, never carried.
  const status = VERB_RESULTS["mcp.proxy.status"].parse({ running: true, stations: ["st_a"], secrets: { st_a: "x" } });
  expect(status).toEqual({ running: true, stations: ["st_a"] });
  expect(VERB_RESULTS["mcp.proxy.set"].parse({ stations: ["st_a"] })).toEqual({ stations: ["st_a"] });
  expect(VERB_RESULTS["mcp.proxy.rotate"].parse({ rotated: ["st_a"] })).toEqual({ rotated: ["st_a"] });
});

test("mcp.proxy.manage is a node capability an older hub can ignore", () => {
  expect(NodeCapability.safeParse("mcp.proxy.manage").success).toBe(true);
});

test("a change names stations or asks for every eligible one, never both or neither", () => {
  expect(McpProxyChangeRequest.safeParse({ action: "enable", stationIds: ["st_a"] }).success).toBe(true);
  expect(McpProxyChangeRequest.safeParse({ action: "enable", allEligible: true }).success).toBe(true);
  expect(McpProxyChangeRequest.safeParse({ action: "enable", allEligible: true, nodeId: "nod_1" }).success).toBe(true);
  expect(McpProxyChangeRequest.safeParse({ action: "enable" }).success).toBe(false);
  expect(McpProxyChangeRequest.safeParse({ action: "enable", stationIds: [] }).success).toBe(false);
  expect(McpProxyChangeRequest.safeParse({ action: "enable", stationIds: ["st_a"], allEligible: true }).success).toBe(false);
  // --all-eligible only ever enables: disabling "every eligible station" is a fleet-wide off switch
  // nobody asked this verb for.
  expect(McpProxyChangeRequest.safeParse({ action: "disable", allEligible: true }).success).toBe(false);
  expect(McpProxyChangeRequest.safeParse({ action: "rotate", stationIds: ["st_a"] }).success).toBe(false);
});

test("the fleet view has a state per station, drift included", () => {
  expect(McpProxyStationState.options.sort()).toEqual(["drifted", "ineffective", "off", "on", "unknown"]);
  const view = McpProxyFleetView.parse({
    nodes: [
      {
        nodeId: "nod_1",
        nodeName: "n",
        reachable: true,
        unadoptedStations: ["st_gone"],
        stations: [
          {
            stationId: "st_a",
            stationKey: "hermes:a",
            displayName: "a",
            harness: "hermes",
            eligible: true,
            declared: null,
            serving: true,
            state: "on",
          },
        ],
      },
    ],
    drifted: 0,
  });
  expect(view.nodes[0]!.stations[0]!.declared).toBeNull();
});
