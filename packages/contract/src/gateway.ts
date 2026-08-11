import { z } from "zod";
import { HostInfo } from "./node";
import { RequestMsg, ResponseMsg, StreamMsg, CancelMsg, InputMsg, ResizeMsg } from "./protocol";
import { NodeCapabilityList } from "./posture";

export const HelloMsg = z.object({
  type: z.literal("hello"),
  hostInfo: HostInfo,
  version: z.string().optional(),
  // Absent from older nodes — the hub reads that as "no node capabilities",
  // which is how a node that predates a capability degrades silently.
  capabilities: NodeCapabilityList.optional(),
});
export const HeartbeatMsg = z.object({ type: z.literal("heartbeat"), ts: z.number() });
export const AckMsg = z.object({ type: z.literal("ack"), ts: z.number() });

// ─── Health frame (node-agent → hub, ~30s cadence) ────────────────────────────

/**
 * Per-station health snapshot pushed by the node-agent.
 * `key` matches stations.station_key on the hub side.
 * `ok=false` when the agent's Health(key) call errored (hub marks status "error").
 * Metrics are nullable — omitted when the process is not running or health gather failed.
 */
export const StationHealthReport = z.object({
  key: z.string(),
  ok: z.boolean(),
  running: z.boolean(),
  pid: z.number().int().nullable(),
  cpuPct: z.number().nullable(),
  memBytes: z.number().int().nullable(),
  uptimeSec: z.number().int().nullable(),
});
export type StationHealthReport = z.infer<typeof StationHealthReport>;

/**
 * Health frame sent by a connected node-agent covering all its detected stations.
 * Added to GatewayClientMessage as an additive variant — old agents that never
 * send it leave their stations at status "unknown" (graceful degradation).
 */
export const HealthReportMsg = z.object({
  type: z.literal("health"),
  stations: z.array(StationHealthReport),
});
export type HealthReportMsg = z.infer<typeof HealthReportMsg>;

export const GatewayClientMessage = z.discriminatedUnion("type", [HelloMsg, HeartbeatMsg, ResponseMsg, StreamMsg, HealthReportMsg]);
export type GatewayClientMessage = z.infer<typeof GatewayClientMessage>;
// Hub → node messages: ack/req/cancel (control) + input/resize (terminal interactivity)
export const GatewayServerMessage = z.discriminatedUnion("type", [AckMsg, RequestMsg, CancelMsg, InputMsg, ResizeMsg]);
export type GatewayServerMessage = z.infer<typeof GatewayServerMessage>;
