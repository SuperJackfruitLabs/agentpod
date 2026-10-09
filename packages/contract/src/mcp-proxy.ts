import { z } from "zod";

/**
 * Managing the node's loopback MCP proxy (apps/node-agent/internal/mcpproxy): which stations it
 * serves, and rotating their secrets.
 *
 * The station list lives in the node's own config (`mcpProxy.stations`). The hub records what an
 * operator DECLARED for a station (`stations.mcp_proxy`, null = never declared) and asks the node
 * for what it SERVES; the two disagreeing is drift. Nothing here ever carries a proxy secret: the
 * node generates, persists and checks them, and the hub only ever learns station ids.
 */

/**
 * The harnesses whose ACP adapter registers HTTP MCP servers from `session/new` — measured with an
 * `initialize` probe of each adapter (PR #714). OpenClaw and Pi declare `mcpCapabilities.http:
 * false`; enabling the proxy for them would serve a station whose sessions never get the servers.
 * The node keeps the same list (mcpproxy.SupportsHTTP) and injects nothing for any other harness.
 */
export const MCP_PROXY_HARNESSES = ["hermes", "claude-code", "codex", "opencode"] as const;

export function mcpProxyEligible(harness: string): boolean {
  return (MCP_PROXY_HARNESSES as readonly string[]).includes(harness);
}

const StationIds = z.array(z.string().min(1)).min(1);

// ---- node verbs ------------------------------------------------------------------------------

/** What the node's proxy serves now. Station ids only — never a secret, never the port. */
export const McpProxyStatusParams = z.object({});
export const McpProxyStatusResult = z.object({
  running: z.boolean(),
  stations: z.array(z.string()),
});

/**
 * Add and/or remove stations from the node's `mcpProxy.stations`. A delta, not a full list, so two
 * operators changing different stations cannot undo each other. The node writes its config
 * atomically and applies the change to the running proxy without a restart; a station it already
 * served keeps its secret, so its open sessions keep working.
 */
export const McpProxySetParams = z.object({
  enable: z.array(z.string().min(1)).optional(),
  disable: z.array(z.string().min(1)).optional(),
});
export const McpProxySetResult = z.object({ stations: z.array(z.string()) });

/** New secrets for the named stations — every served station when none are named. A session
 * holding an old secret is refused from then on; that is the point of asking. */
export const McpProxyRotateParams = z.object({ stations: z.array(z.string().min(1)).optional() });
export const McpProxyRotateResult = z.object({ rotated: z.array(z.string()) });

// ---- hub API -----------------------------------------------------------------------------------

/**
 * `POST /api/fleet/mcp-proxy`. Exactly one of `stationIds` / `allEligible`; `allEligible` only
 * enables (every adopted station on an eligible harness, optionally on one node).
 */
export const McpProxyChangeRequest = z
  .object({
    action: z.enum(["enable", "disable"]),
    stationIds: StationIds.optional(),
    allEligible: z.literal(true).optional(),
    nodeId: z.string().min(1).optional(),
  })
  .refine((r) => (r.stationIds === undefined) !== (r.allEligible === undefined), {
    message: "name stations or ask for allEligible, not both and not neither",
  })
  .refine((r) => !(r.allEligible && r.action !== "enable"), {
    message: "allEligible only enables",
  });
export type McpProxyChangeRequest = z.infer<typeof McpProxyChangeRequest>;

/** `POST /api/fleet/mcp-proxy/rotate`. No stations: every station the named node serves. */
export const McpProxyRotateRequest = z
  .object({
    stationIds: StationIds.optional(),
    nodeId: z.string().min(1).optional(),
  })
  .refine((r) => (r.stationIds === undefined) !== (r.nodeId === undefined), {
    message: "name stations or a node",
  });
export type McpProxyRotateRequest = z.infer<typeof McpProxyRotateRequest>;

/**
 * - `on`: the node serves it, and nothing declared otherwise.
 * - `off`: the node does not serve it, and nothing declared otherwise.
 * - `drifted`: the declaration and the node disagree (a hand edit, a reset config).
 * - `ineffective`: served, but its harness takes no HTTP MCP servers, so no session gets them.
 * - `unknown`: the node could not be asked (offline, or too old to answer).
 */
export const McpProxyStationState = z.enum(["on", "off", "drifted", "ineffective", "unknown"]);
export type McpProxyStationState = z.infer<typeof McpProxyStationState>;

export const McpProxyStationView = z.object({
  stationId: z.string(),
  stationKey: z.string(),
  displayName: z.string(),
  harness: z.string(),
  eligible: z.boolean(),
  /** What an operator last declared through the hub; null when nobody has. */
  declared: z.boolean().nullable(),
  /** What the node serves now; null when it could not be asked. */
  serving: z.boolean().nullable(),
  state: McpProxyStationState,
});
export type McpProxyStationView = z.infer<typeof McpProxyStationView>;

export const McpProxyNodeView = z.object({
  nodeId: z.string(),
  nodeName: z.string(),
  reachable: z.boolean(),
  /** Why the node could not be asked, when it could not. */
  reason: z.string().optional(),
  stations: z.array(McpProxyStationView),
  /** Ids the node's config names that are not adopted stations of this node. */
  unadoptedStations: z.array(z.string()),
});
export type McpProxyNodeView = z.infer<typeof McpProxyNodeView>;

export const McpProxyFleetView = z.object({
  nodes: z.array(McpProxyNodeView),
  /** Stations in `drifted` or `ineffective`, plus unadopted ids. */
  drifted: z.number().int().nonnegative(),
});
export type McpProxyFleetView = z.infer<typeof McpProxyFleetView>;

/** One station's outcome in a change or a rotation. */
export const McpProxyChangeOutcome = z.object({
  stationId: z.string(),
  nodeId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
});
export type McpProxyChangeOutcome = z.infer<typeof McpProxyChangeOutcome>;
