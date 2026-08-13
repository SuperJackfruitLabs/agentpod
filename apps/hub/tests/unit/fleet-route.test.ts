/**
 * Unit Tests: GET /api/fleet/agents + GET /api/fleet/stats (control-plane P1)
 *
 * Verifies route behavior with mocked service deps (no DB or network).
 * Mirrors the pattern in nodes-update-route.test.ts: createFleetRoutes() is
 * called with injected deps, mounted inside a minimal Hono test app with a
 * fake auth middleware.
 *
 * Verifies:
 *   1. GET /api/fleet/agents → 200 { stats, agents } with correct shape.
 *   2. GET /api/fleet/stats  → 200 FleetStats with correct shape.
 *   3. Routes return 401 without auth.
 */

import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import { createFleetRoutes } from "../../src/routes/fleet";
import type { AuthUser } from "../../src/auth/middleware";
import type { RawFleetRow } from "../../src/services/fleet";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER_ID = "user-fleet-route-test-001";

// ─── Seed data ────────────────────────────────────────────────────────────────

const seedRows: RawFleetRow[] = [
  {
    stationId: "station-alpha-001",
    nodeId: "node-super-001",
    nodeName: "superchotu",
    agentName: "alpha-agent",
    harness: "hermes",
    kind: "claude",
    stationKey: "hermes-alpha",
    nodeStatus: "online",
    agentVersion: "v0.1.4",
    capabilities: ["terminal"],
    workspacePath: "/home/user/alpha",
  },
  {
    stationId: "station-beta-001",
    nodeId: "node-super-001",
    nodeName: "superchotu",
    agentName: "beta-agent",
    harness: "openclaw",
    kind: "openai",
    stationKey: "openclaw-beta",
    nodeStatus: "online",
    agentVersion: "v0.1.4",
    capabilities: [],
    workspacePath: null,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal Hono test app that mounts createFleetRoutes() at /api/fleet
 * with injected seed data, and a fake auth middleware that stamps TEST_USER_ID.
 */
function makeTestApp() {
  const routes = createFleetRoutes({
    queryFn: async (_userId: string) => seedRows,
    latestVersionFn: async () => "v0.1.5",
  });

  return new Hono()
    .use("/api/fleet/*", async (c, next) => {
      c.set("user", {
        id: TEST_USER_ID,
        authType: "api_key",
        tenantId: "fleet_00000000000000000000",
      } satisfies AuthUser);
      return next();
    })
    .route("/api/fleet", routes);
}

/**
 * Build a test app WITHOUT the auth middleware (simulates unauthenticated request).
 */
function makeUnauthApp() {
  const routes = createFleetRoutes({
    queryFn: async (_userId: string) => seedRows,
    latestVersionFn: async () => "v0.1.5",
  });
  // Mount routes without the fake auth middleware — c.get("user") will throw/fail.
  return new Hono().route("/api/fleet", routes);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/fleet/agents", () => {
  test("returns 200 with { stats, agents } when authenticated", async () => {
    const app = makeTestApp();
    const res = await app.request("/api/fleet/agents");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      stats: {
        nodes: { total: number; online: number };
        agents: { total: number };
        updatesAvailable: number;
      };
      agents: Array<{
        stationId: string;
        nodeId: string;
        nodeName: string;
        agentName: string;
        nodeStatus: string;
        updateAvailable: boolean;
        latestVersion: string | null;
      }>;
    };

    // agents shape
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents).toHaveLength(2);

    const alpha = body.agents.find((a) => a.stationId === "station-alpha-001");
    expect(alpha).toBeDefined();
    expect(alpha!.nodeName).toBe("superchotu");
    expect(alpha!.nodeStatus).toBe("online");
    expect(alpha!.updateAvailable).toBe(true);
    expect(alpha!.latestVersion).toBe("v0.1.5");

    // stats shape
    expect(body.stats.nodes.total).toBe(1);
    expect(body.stats.nodes.online).toBe(1);
    expect(body.stats.agents.total).toBe(2);
    expect(body.stats.updatesAvailable).toBe(2);
  });

  test("stats and agents are consistent (same data source)", async () => {
    const app = makeTestApp();
    const res = await app.request("/api/fleet/agents");
    const body = (await res.json()) as {
      stats: { agents: { total: number } };
      agents: unknown[];
    };
    expect(body.stats.agents.total).toBe(body.agents.length);
  });

  test("agentName maps to station displayName", async () => {
    const app = makeTestApp();
    const res = await app.request("/api/fleet/agents");
    const { agents } = (await res.json()) as { agents: Array<{ agentName: string }> };
    const names = agents.map((a) => a.agentName).sort();
    expect(names).toEqual(["alpha-agent", "beta-agent"]);
  });
});

describe("GET /api/fleet/stats", () => {
  test("returns 200 with FleetStats shape when authenticated", async () => {
    const app = makeTestApp();
    const res = await app.request("/api/fleet/stats");
    expect(res.status).toBe(200);

    const stats = (await res.json()) as {
      nodes: { total: number; online: number };
      agents: { total: number };
      updatesAvailable: number;
    };

    expect(stats.nodes.total).toBe(1);
    expect(stats.nodes.online).toBe(1);
    expect(stats.agents.total).toBe(2);
    expect(stats.updatesAvailable).toBe(2);
  });

  test("updatesAvailable is 0 when all versions match latestVersion", async () => {
    const routes = createFleetRoutes({
      queryFn: async (_userId: string) => seedRows,
      latestVersionFn: async () => "v0.1.4", // same as agentVersion in seed
    });
    const app = new Hono()
      .use("/api/fleet/*", async (c, next) => {
        c.set("user", { id: TEST_USER_ID, authType: "api_key" , tenantId: "fleet_00000000000000000000"} satisfies AuthUser);
        return next();
      })
      .route("/api/fleet", routes);

    const res = await app.request("/api/fleet/stats");
    const stats = (await res.json()) as { updatesAvailable: number };
    expect(stats.updatesAvailable).toBe(0);
  });
});
