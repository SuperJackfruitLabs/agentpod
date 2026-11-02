/**
 * In-memory health cache — stores the most recent per-station health report
 * received from each connected node-agent.
 *
 * Key design:
 *   - Outer Map keyed by nodeId (cleared on WS close via clearNode).
 *   - Inner Map keyed by stationKey (matches stations.station_key).
 *   - `at` is the wall-clock milliseconds at ingest time (injectable for tests).
 *   - No DB, no TTL sweep — staleness is checked at read time by deriveStatus.
 *
 * Lifecycle:
 *   - Gateway `onMessage` (type="health") → recordHealth(nodeId, stations)
 *   - Gateway `onClose`                  → clearNode(nodeId)
 */

import type { StationHealthReport } from "@agentpod/contract";

// ─── Cache entry ──────────────────────────────────────────────────────────────

export type CachedHealth = {
  report: StationHealthReport;
  /** Date.now() milliseconds at ingest time. */
  at: number;
};

// ─── Cache class (injectable clock for tests) ─────────────────────────────────

export class InMemoryHealthCache {
  private cache = new Map<string, Map<string, CachedHealth>>();

  /**
   * Record a batch of station health reports from a node.
   * Each report in `stations` is written under its `report.key`.
   *
   * @param now  Ingest timestamp (ms).  Defaults to Date.now(); override in tests.
   */
  recordHealth(
    nodeId: string,
    stations: StationHealthReport[],
    now: number = Date.now()
  ): void {
    let nodeMap = this.cache.get(nodeId);
    if (!nodeMap) {
      nodeMap = new Map();
      this.cache.set(nodeId, nodeMap);
    }
    for (const report of stations) {
      nodeMap.set(report.key, { report, at: now });
    }
  }

  /**
   * Retrieve the most recent cached health entry for a specific station.
   * Returns null if the node has no cache entry or the station key is not found.
   */
  getHealth(nodeId: string, stationKey: string): CachedHealth | null {
    return this.cache.get(nodeId)?.get(stationKey) ?? null;
  }

  /**
   * Remove all cached health data for a node (called on WS close).
   * No-op if the node has no cached data.
   */
  clearNode(nodeId: string): void {
    this.cache.delete(nodeId);
  }
}

// ─── Singleton (used by gateway + fleet service) ──────────────────────────────

const _healthCache = new InMemoryHealthCache();

export const recordHealth = (
  nodeId: string,
  stations: StationHealthReport[],
  now?: number
): void => _healthCache.recordHealth(nodeId, stations, now);

export const getHealth = (
  nodeId: string,
  stationKey: string
): CachedHealth | null => _healthCache.getHealth(nodeId, stationKey);

export const clearNode = (nodeId: string): void =>
  _healthCache.clearNode(nodeId);
