import { z } from "zod";

export const HostInfo = z.object({
  hostname: z.string().min(1),
  os: z.string().min(1),
  arch: z.string().min(1),
  cpuCount: z.number().int().positive(),
});
export type HostInfo = z.infer<typeof HostInfo>;

export const EnrollRequest = z.object({ token: z.string().min(1), hostInfo: HostInfo });
export type EnrollRequest = z.infer<typeof EnrollRequest>;

export const EnrollResponse = z.object({ nodeId: z.string(), nodeSecret: z.string() });
export type EnrollResponse = z.infer<typeof EnrollResponse>;

export const NodeStatus = z.enum(["online", "offline"]);
export const NodeSummary = z.object({
  id: z.string(), name: z.string(), hostname: z.string(), os: z.string(),
  arch: z.string(), cpuCount: z.number().int(),
  status: NodeStatus, lastSeenAt: z.string().nullable(), createdAt: z.string(),
  agentVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  /** Node-level capabilities from the hello frame. Null on older nodes. */
  capabilities: z.array(z.string()).nullable().optional(),
  /**
   * The purpose an agent adopted here inherits when it has none of its own — a
   * default, not the truth. What an agent IS for lives on the station.
   */
  purpose: z.string().nullable().optional(),
  provisioned: z.object({ runtimeId: z.string(), provider: z.string() }).nullable().optional(),
});
export type NodeSummary = z.infer<typeof NodeSummary>;

/**
 * DELETE /api/nodes/:id — a retired machine leaving the fleet.
 *
 * The node row goes, and with it the credential the machine dials in with, so
 * it cannot reconnect and quietly re-register; joining again takes a fresh
 * `fleet invite` token. Its stations are unregistered the way "Remove station"
 * does it. `disconnected` says whether a live gateway session was cut.
 */
export const RemoveNodeResponse = z.object({
  ok: z.literal(true),
  node: z.object({ id: z.string(), name: z.string() }),
  stationsRemoved: z.array(z.object({ id: z.string(), stationKey: z.string() })),
  disconnected: z.boolean(),
});
export type RemoveNodeResponse = z.infer<typeof RemoveNodeResponse>;

/**
 * Why a removal was refused (409). Each is a different instruction:
 *   - `provisioned` — a runtime owns this node; `fleet runtimes rm` removes both.
 *   - `bridged` — a bridge agent's roster row points at a station here; remove
 *     the row first (`fleet bridge rm`), since it holds a credential.
 *   - `online` — the node is connected; retry with `force` to disconnect it.
 */
export const RemoveNodeRefusalCode = z.enum(["provisioned", "bridged", "online"]);
export type RemoveNodeRefusalCode = z.infer<typeof RemoveNodeRefusalCode>;

export const RemoveNodeRefusal = z.object({
  ok: z.literal(false),
  code: RemoveNodeRefusalCode,
  error: z.string(),
  /** Set when `code` is `provisioned`. */
  runtimeId: z.string().optional(),
  /** Set when `code` is `bridged`: the roster keys in the way. */
  bridgeAgents: z.array(z.string()).optional(),
});
export type RemoveNodeRefusal = z.infer<typeof RemoveNodeRefusal>;
