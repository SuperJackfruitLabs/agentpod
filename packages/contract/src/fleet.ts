import { z } from "zod";

// ─── FleetAgent ───────────────────────────────────────────────────────────────

/**
 * A single adopted station joined with its parent node.
 * Produced by GET /api/fleet/agents; consumed by the Overview home table.
 */
export const FleetAgent = z.object({
  /** stations.id */
  stationId: z.string(),
  /** nodes.id */
  nodeId: z.string(),
  /** nodes.name */
  nodeName: z.string(),
  /** stations.display_name */
  agentName: z.string(),
  /** stations.harness */
  harness: z.string(),
  /** stations.kind */
  kind: z.string(),
  /** nodes.status — node reachability only */
  nodeStatus: z.enum(["online", "offline"]),
  /** nodes.agent_version — null when the node has never reported a version */
  agentVersion: z.string().nullable(),
  /** latest published release tag (from GitHub, cached 1 h) */
  latestVersion: z.string().nullable(),
  /** true when agentVersion and latestVersion are both non-null and differ */
  updateAvailable: z.boolean(),
  /** stations.capabilities */
  capabilities: z.array(z.string()),
  /** stations.workspace_path */
  workspacePath: z.string().nullable(),
  // ─── P2: live health fields ────────────────────────────────────────────────
  /**
   * Derived from the most recent health push for this station.
   * "unknown" when: node offline; no health report yet; report age > 75 s.
   * "error" when the node's Health(key) call errored (ok=false).
   * "running" / "stopped" reflect the process state from the most recent report.
   */
  status: z.enum(["running", "stopped", "error", "unknown"]),
  /** CPU usage percent — null when status is "unknown" or "error". */
  cpuPct: z.number().nullable(),
  /** Resident memory in bytes — null when status is "unknown" or "error". */
  memBytes: z.number().nullable(),
  /** Process uptime in seconds — null when status is "unknown" or "error". */
  uptimeSec: z.number().nullable(),
  /**
   * An explanation attached by the node when a reading needs one, else null.
   *
   * The case that put it here: on a host running ONE multiplexed Hermes gateway,
   * every profile reports that gateway's cpu/memory/uptime, so fifteen agents show
   * identical figures. The note is what makes that legible instead of looking like
   * a bug — and it is on this shape because a note nothing surfaces is the same as
   * no note at all.
   */
  note: z.string().nullable(),
});
export type FleetAgent = z.infer<typeof FleetAgent>;

// ─── FleetStats ───────────────────────────────────────────────────────────────

/**
 * Aggregate counts for the stat-band at the top of the Overview home.
 * Produced by GET /api/fleet/stats (and embedded in GET /api/fleet/agents).
 */
export const FleetStats = z.object({
  nodes: z.object({
    total: z.number().int().nonnegative(),
    online: z.number().int().nonnegative(),
  }),
  agents: z.object({
    total: z.number().int().nonnegative(),
  }),
  /**
   * Number of adopted agents (stations) whose node is running an outdated
   * agent binary.  Counts agents (not distinct nodes) so the console can
   * show "N agents need an update".
   */
  updatesAvailable: z.number().int().nonnegative(),
  /**
   * Number of adopted agents whose live status is "running" (P2).
   * Zero when no health data is available yet.
   */
  running: z.number().int().nonnegative(),
});
export type FleetStats = z.infer<typeof FleetStats>;
