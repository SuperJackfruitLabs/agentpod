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
