/**
 * Fleet service — aggregate read across all adopted stations + their nodes.
 *
 * Produces the data for GET /api/fleet/agents and GET /api/fleet/stats.
 *
 * All state comes from a single `stations ⋈ nodes` Drizzle join + the cached
 * getLatestAgentVersion() call — no gateway round-trips.
 *
 * The query function and version fetcher are injectable via `FleetDeps` so
 * tests can run without a live database.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { nodes } from "../db/schema/nodes";
import { stations } from "../db/schema/stations";
import { getLatestAgentVersion } from "./agent-version";
import { getHealth } from "./health-cache";
import type { FleetAgent, FleetStats, StationHealthReport } from "@agentpod/contract";
import type { CachedHealth } from "./health-cache";

// ─── Internal raw-row type ────────────────────────────────────────────────────

/**
 * Shape returned by the Drizzle join before version + health annotation.
 * Matches the selected columns exactly.
 *
 * `stationKey` (stations.station_key) is the identifier the node-agent uses
 * in health frames — used internally to look up the health cache.  It is NOT
 * part of the public FleetAgent shape.
 */
export type RawFleetRow = {
  stationId: string;
  nodeId: string;
  nodeName: string;
  agentName: string;
  harness: string;
  kind: string;
  /** Matches the node-agent's health-frame key (stations.station_key). */
  stationKey: string;
  nodeStatus: "online" | "offline";
  agentVersion: string | null;
  capabilities: string[] | null;
  workspacePath: string | null;
};

// ─── Deps type (for injection) ────────────────────────────────────────────────

export type FleetDeps = {
  /**
   * Override the version resolver (e.g. to return a fixed value in tests).
   * Defaults to getLatestAgentVersion().
   */
  latestVersionFn?: () => Promise<string | null>;
  /**
   * Override the DB query (e.g. to return seeded rows in tests).
   * Defaults to the real Drizzle join.
   */
  queryFn?: (userId: string) => Promise<RawFleetRow[]>;
  /**
   * Override the health cache lookup (e.g. return stubbed cache entries in tests).
   * Defaults to the real in-memory health cache singleton.
   * Signature mirrors `CachedHealth | null` so tests can inject arbitrary data.
   */
  getHealthFn?: (nodeId: string, stationKey: string) => CachedHealth | null;
};

// ─── Status derivation (pure, exported for unit tests) ───────────────────────

/** Staleness threshold: reports older than 2.5 × 30 s cadence are treated as unknown. */
const STALE_MS = 75_000;

/**
 * Derive the live status + metrics for a single station from its cached health entry.
 *
 * Rules (in priority order):
 *   1. node offline              → "unknown" + null metrics
 *   2. no cached report          → "unknown" + null metrics
 *   3. age > 75 000 ms (stale)   → "unknown" + null metrics
 *   4. report.ok === false       → "error"   + null metrics
 *   5. ok && running             → "running" + metrics from report
 *   6. ok && !running            → "stopped" + metrics from report
 *
 * @param nodeStatus  Node reachability from the DB row.
 * @param cached      Most recent cached health entry, or null if absent.
 * @param now         Current timestamp in ms (Date.now()); injectable for tests.
 */
export function deriveStatus(
  nodeStatus: "online" | "offline",
  cached: CachedHealth | null,
  now: number
): {
  status: "running" | "stopped" | "error" | "unknown";
  cpuPct: number | null;
  memBytes: number | null;
  uptimeSec: number | null;
  note: string | null;
} {
  if (nodeStatus === "offline" || !cached || now - cached.at > STALE_MS) {
    return { status: "unknown", cpuPct: null, memBytes: null, uptimeSec: null, note: null };
  }
  const { report } = cached;
  if (!report.ok) {
    return { status: "error", cpuPct: null, memBytes: null, uptimeSec: null, note: null };
  }
  return {
    status: report.running ? "running" : "stopped",
    cpuPct: report.cpuPct,
    memBytes: report.memBytes,
    uptimeSec: report.uptimeSec,
    // Passed through rather than dropped. This projection is where the note died:
    // the descriptor set it and the contract carried it, and the four fields listed
    // here were the whole of what reached a caller. `?? null` because a node that
    // predates the field omits it entirely.
    note: report.note ?? null,
  };
}

// ─── Pure helpers (exported for unit tests) ───────────────────────────────────

/**
 * Annotate raw fleet rows with version info + live health status/metrics.
 *
 * Pure function — no DB or network access.  The health lookup is injected via
 * `getHealthFn` (defaults to `() => null`, giving all agents status "unknown").
 *
 * @param getHealthFn  Function returning the cached health entry for a station.
 * @param now          Current timestamp in ms for staleness checks.
 */
export function annotateFleetRows(
  rows: RawFleetRow[],
  latestVersion: string | null,
  getHealthFn: (nodeId: string, stationKey: string) => CachedHealth | null = () => null,
  now: number = Date.now()
): FleetAgent[] {
  return rows.map((r) => {
    const cached = getHealthFn(r.nodeId, r.stationKey);
    const health = deriveStatus(r.nodeStatus, cached, now);
    return {
      stationId: r.stationId,
      nodeId: r.nodeId,
      nodeName: r.nodeName,
      agentName: r.agentName,
      harness: r.harness,
      kind: r.kind,
      nodeStatus: r.nodeStatus,
      agentVersion: r.agentVersion,
      capabilities: r.capabilities ?? [],
      workspacePath: r.workspacePath,
      latestVersion,
      updateAvailable:
        r.agentVersion != null &&
        latestVersion != null &&
        r.agentVersion !== latestVersion,
      ...health,
    };
  });
}

/**
 * Compute FleetStats from an already-annotated agent list.
 * Pure function — exported for unit tests.
 *
 * Note: nodes.total counts DISTINCT nodeIds in the adopted-station list
 * (not the raw nodes table), so it reflects the nodes that actually have
 * at least one adopted agent.  updatesAvailable counts agents (stations),
 * not distinct nodes, so the console can show "N agents need an update".
 */
export function computeFleetStats(agents: FleetAgent[]): FleetStats {
  // Aggregate per-node status from the agent rows.
  const nodeOnline = new Map<string, boolean>();
  for (const a of agents) {
    // If ANY station on a node sees the node as online, it's online.
    // (In practice all rows for a node share the same status snapshot.)
    nodeOnline.set(a.nodeId, a.nodeStatus === "online");
  }

  return {
    nodes: {
      total: nodeOnline.size,
      online: [...nodeOnline.values()].filter(Boolean).length,
    },
    agents: { total: agents.length },
    updatesAvailable: agents.filter((a) => a.updateAvailable).length,
    running: agents.filter((a) => a.status === "running").length,
  };
}

// ─── Default DB query ─────────────────────────────────────────────────────────

/**
 * Real Drizzle join: adopted stations (all rows in the stations table are
 * adopted; there is no `adopted` boolean — presence in the table IS adoption)
 * inner-joined with their parent node, filtered by userId.
 */
async function defaultQueryFn(userId: string): Promise<RawFleetRow[]> {
  return db
    .select({
      stationId: stations.id,
      nodeId: nodes.id,
      nodeName: nodes.name,
      agentName: stations.displayName,
      harness: stations.harness,
      kind: stations.kind,
      stationKey: stations.stationKey,
      nodeStatus: nodes.status,
      agentVersion: nodes.agentVersion,
      capabilities: stations.capabilities,
      workspacePath: stations.workspacePath,
    })
    .from(stations)
    .innerJoin(nodes, eq(stations.nodeId, nodes.id))
    .where(eq(stations.userId, userId));
}

// ─── Service factory ──────────────────────────────────────────────────────────

/**
 * Create a fleet service with optional dep overrides (for tests).
 *
 * Returns `{ listFleetAgents, getFleetStats }` scoped to a userId.
 */
export function createFleetService(deps?: FleetDeps) {
  const queryFn = deps?.queryFn ?? defaultQueryFn;
  const latestVersionFn = deps?.latestVersionFn ?? getLatestAgentVersion;
  const getHealthFn = deps?.getHealthFn ?? getHealth;

  /**
   * Return all adopted stations joined with their nodes, annotated with
   * latestVersion + updateAvailable + live health status/metrics.
   * Calls the version fetcher once per invocation (cached module-level for 1 h).
   * Health data comes from the in-memory cache — no DB round-trips.
   */
  async function listFleetAgents(userId: string): Promise<FleetAgent[]> {
    const [rows, latestVersion] = await Promise.all([
      queryFn(userId),
      latestVersionFn(),
    ]);
    return annotateFleetRows(rows, latestVersion, getHealthFn, Date.now());
  }

  /**
   * Aggregate counts derived from listFleetAgents.
   * updatesAvailable = number of agents (stations) with updateAvailable:true.
   */
  async function getFleetStats(userId: string): Promise<FleetStats> {
    const agents = await listFleetAgents(userId);
    return computeFleetStats(agents);
  }

  return { listFleetAgents, getFleetStats };
}

// ─── Default singleton (real DB + real version fetcher) ───────────────────────

const _defaultService = createFleetService();

/** List all adopted agents joined with node data for the given user. */
export const listFleetAgents = _defaultService.listFleetAgents;

/** Compute fleet aggregate stats for the given user. */
export const getFleetStats = _defaultService.getFleetStats;
