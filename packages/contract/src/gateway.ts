import { z } from "zod";
import { HostInfo } from "./node";
import { RequestMsg, ResponseMsg, StreamMsg, CancelMsg, InputMsg, ResizeMsg } from "./protocol";
import { NodeCapabilityList } from "./posture";
import { TurnError, TurnErrorKind } from "./acp-session";

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

// ─── Turn error frame (node-agent → hub, when a plugin reports one) ──────────

/** A plugin's words are a sentence or two, not a log. */
export const TURN_ERROR_MESSAGE_MAX = 8_192;

/**
 * What a harness plugin writes to its node's intake socket when a turn fails
 * and the harness itself will not say so over ACP (OpenClaw, Pi).
 *
 * The plugin reports what it saw. It does not name the harness or the source:
 * the hub knows which station the matched session belongs to, and a report
 * that could claim to be another harness's would be one more thing to trust.
 * `kind` is optional — the hub classifies the message when it is absent.
 *
 * Matched to a live session by one of two keys: `acpSessionId`, the hub
 * session a node-spawned harness was told about (Pi), or `harnessSessionKey`,
 * the harness's own name for the session, which the hub has already seen in
 * that session's `session_info_update._meta.sessionKey` (OpenClaw).
 */
export const TurnErrorReport = z
  .object({
    acpSessionId: z.string().min(1).optional(),
    harnessSessionKey: z.string().min(1).optional(),
    error: TurnError.omit({ harness: true, source: true })
      .partial({ kind: true })
      .extend({
        message: z.string().min(1).max(TURN_ERROR_MESSAGE_MAX),
        // Each model the harness tried. A plugin reports the words; the hub
        // classifies an attempt that arrives without a kind, as it does the
        // report itself.
        attempts: z
          .array(
            z.object({
              provider: z.string(),
              model: z.string(),
              kind: TurnErrorKind.optional(),
              message: z.string().max(TURN_ERROR_MESSAGE_MAX),
            })
          )
          .max(16)
          .optional(),
      }),
  })
  .refine((r) => r.acpSessionId !== undefined || r.harnessSessionKey !== undefined, {
    message: "a report needs acpSessionId or harnessSessionKey to be matched to a session",
  });
export type TurnErrorReport = z.infer<typeof TurnErrorReport>;

/** The node forwards a report unchanged, wrapped in this envelope. */
export const TurnErrorMsg = z.object({ type: z.literal("turn.error"), report: TurnErrorReport });
export type TurnErrorMsg = z.infer<typeof TurnErrorMsg>;

export const GatewayClientMessage = z.discriminatedUnion("type", [HelloMsg, HeartbeatMsg, ResponseMsg, StreamMsg, HealthReportMsg, TurnErrorMsg]);
export type GatewayClientMessage = z.infer<typeof GatewayClientMessage>;
// Hub → node messages: ack/req/cancel (control) + input/resize (terminal interactivity)
export const GatewayServerMessage = z.discriminatedUnion("type", [AckMsg, RequestMsg, CancelMsg, InputMsg, ResizeMsg]);
export type GatewayServerMessage = z.infer<typeof GatewayServerMessage>;
