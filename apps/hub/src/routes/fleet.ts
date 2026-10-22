/**
 * Fleet aggregate routes (control-plane P1).
 *
 * GET /agents → { stats: FleetStats, agents: FleetAgent[] }
 * GET /stats  → FleetStats
 *
 * Mounted at /api/fleet in index.ts under the same authMiddleware guard as
 * /api/nodes.  A factory function is exported for test injection.
 */

import { Hono } from "hono";
import {
  listFleetAgents as defaultListFleetAgents,
  getFleetStats as defaultGetFleetStats,
  type FleetDeps,
  createFleetService,
} from "../services/fleet";
import type { FleetAgent, FleetStats } from "@agentpod/contract";

// ─── Types ────────────────────────────────────────────────────────────────────

type FleetService = {
  listFleetAgents: (tenantId: string) => Promise<FleetAgent[]>;
  getFleetStats: (tenantId: string) => Promise<FleetStats>;
};

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create the authenticated fleet aggregate routes.
 *
 * An optional `deps` override replaces the real service so tests can
 * assert responses without needing a live database or network.
 */
export function createFleetRoutes(deps?: FleetDeps) {
  const service: FleetService = deps
    ? createFleetService(deps)
    : { listFleetAgents: defaultListFleetAgents, getFleetStats: defaultGetFleetStats };

  return (
    new Hono()
      /**
       * GET /api/fleet/agents
       *
       * Returns all adopted agents joined with node data + aggregate stats in
       * one response so the Overview home only needs one fetch.
       */
      .get("/agents", async (c) => {
        const agents = await service.listFleetAgents(c.get("user").tenantId);
        // Compute stats from the same agent list to avoid a second DB query.
        const { computeFleetStats } = await import("../services/fleet");
        const stats = computeFleetStats(agents);
        return c.json({ stats, agents });
      })
      /**
       * GET /api/fleet/stats
       *
       * Lightweight stats-only endpoint for polling / stat-band refresh.
       */
      .get("/stats", async (c) => {
        return c.json(await service.getFleetStats(c.get("user").tenantId));
      })
  );
}

/**
 * Authenticated routes for fleet aggregate reads.
 * Mounted at /api/fleet (under the authMiddleware guard) in index.ts.
 */
export const fleetRoutes = createFleetRoutes();
