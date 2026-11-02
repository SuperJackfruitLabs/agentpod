/**
 * Unit Tests: fleet service (control-plane P1)
 *
 * Tests the fleet aggregate query service without a live database or network.
 * The query function and version fetcher are both injected via FleetDeps.
 *
 * Scenario seeded for tests:
 *   - 1 node: "superchotu" (online, agentVersion "v0.1.4")
 *   - 2 adopted stations on that node: "alpha-agent" (hermes) + "beta-agent" (openclaw)
 *   - latestVersion stubbed to "v0.1.5" → both agents have updateAvailable:true
 *
 * Verifies:
 *   1. annotateFleetRows pure helper — correct latestVersion + updateAvailable logic.
 *   2. computeFleetStats pure helper — correct node/agent/updates counts.
 *   3. listFleetAgents (via createFleetService) — returns 2 FleetAgents with
 *      correct nodeName, nodeStatus, and updateAvailable.
 *   4. getFleetStats (via createFleetService) — returns correct aggregate counts.
 *   5. Edge cases: null latestVersion, null agentVersion, same version.
 */

import { test, expect, describe } from "bun:test";
import {
  annotateFleetRows,
  computeFleetStats,
  createFleetService,
  deriveStatus,
  type RawFleetRow,
} from "../../src/services/nodes/fleet";
import type { CachedHealth } from "../../src/services/nodes/health-cache";
import type { StationHealthReport } from "@agentpod/contract";

// ─── Seed data ────────────────────────────────────────────────────────────────

const NODE_ID = "node-superchotu-001";
const NODE_NAME = "superchotu";

const STATION_ALPHA = "station-alpha-001";
const STATION_BETA = "station-beta-001";

const STATION_KEY_ALPHA = "hermes-alpha";
const STATION_KEY_BETA = "openclaw-beta";

/** Two adopted stations sharing the same node. */
const seedRows: RawFleetRow[] = [
  {
    stationId: STATION_ALPHA,
    nodeId: NODE_ID,
    nodeName: NODE_NAME,
    agentName: "alpha-agent",
    harness: "hermes",
    kind: "claude",
    stationKey: STATION_KEY_ALPHA,
    nodeStatus: "online",
    agentVersion: "v0.1.4",
    capabilities: ["terminal", "fs.read"],
    workspacePath: "/home/user/alpha",
  },
  {
    stationId: STATION_BETA,
    nodeId: NODE_ID,
    nodeName: NODE_NAME,
    agentName: "beta-agent",
    harness: "openclaw",
    kind: "openai",
    stationKey: STATION_KEY_BETA,
    nodeStatus: "online",
    agentVersion: "v0.1.4",
    capabilities: ["terminal"],
    workspacePath: null,
  },
];

// ─── annotateFleetRows ────────────────────────────────────────────────────────

describe("annotateFleetRows (pure)", () => {
  test("sets latestVersion and updateAvailable:true when versions differ", () => {
    const agents = annotateFleetRows(seedRows, "v0.1.5");
    expect(agents).toHaveLength(2);
    for (const a of agents) {
      expect(a.latestVersion).toBe("v0.1.5");
      expect(a.updateAvailable).toBe(true);
    }
  });

  test("updateAvailable:false when versions match", () => {
    const agents = annotateFleetRows(seedRows, "v0.1.4");
    for (const a of agents) {
      expect(a.updateAvailable).toBe(false);
    }
  });

  test("updateAvailable:false when latestVersion is null", () => {
    const agents = annotateFleetRows(seedRows, null);
    for (const a of agents) {
      expect(a.updateAvailable).toBe(false);
      expect(a.latestVersion).toBeNull();
    }
  });

  test("updateAvailable:false when agentVersion is null", () => {
    const nullVersionRows: RawFleetRow[] = seedRows.map((r) => ({
      ...r,
      agentVersion: null,
    }));
    const agents = annotateFleetRows(nullVersionRows, "v0.1.5");
    for (const a of agents) {
      expect(a.updateAvailable).toBe(false);
    }
  });

  test("null capabilities → empty array", () => {
    const rows: RawFleetRow[] = [{ ...seedRows[0]!, capabilities: null }];
    const [agent] = annotateFleetRows(rows, null);
    expect(agent!.capabilities).toEqual([]);
  });

  test("maps column names to FleetAgent fields correctly", () => {
    const [alpha] = annotateFleetRows([seedRows[0]!], "v0.1.5");
    expect(alpha!.stationId).toBe(STATION_ALPHA);
    expect(alpha!.nodeId).toBe(NODE_ID);
    expect(alpha!.nodeName).toBe(NODE_NAME);
    expect(alpha!.agentName).toBe("alpha-agent");
    expect(alpha!.harness).toBe("hermes");
    expect(alpha!.kind).toBe("claude");
    expect(alpha!.nodeStatus).toBe("online");
    expect(alpha!.agentVersion).toBe("v0.1.4");
    expect(alpha!.workspacePath).toBe("/home/user/alpha");
    expect(alpha!.capabilities).toEqual(["terminal", "fs.read"]);
  });
});

// ─── computeFleetStats ────────────────────────────────────────────────────────

describe("computeFleetStats (pure)", () => {
  test("correct counts for 1 online node + 2 agents (both updateAvailable:true)", () => {
    const agents = annotateFleetRows(seedRows, "v0.1.5");
    const stats = computeFleetStats(agents);
    expect(stats.nodes.total).toBe(1);
    expect(stats.nodes.online).toBe(1);
    expect(stats.agents.total).toBe(2);
    expect(stats.updatesAvailable).toBe(2);
  });

  test("updatesAvailable is 0 when versions match", () => {
    const agents = annotateFleetRows(seedRows, "v0.1.4");
    const stats = computeFleetStats(agents);
    expect(stats.updatesAvailable).toBe(0);
  });

  test("offline node reduces online count", () => {
    const offlineRows = seedRows.map((r) => ({ ...r, nodeStatus: "offline" as const }));
    const agents = annotateFleetRows(offlineRows, "v0.1.5");
    const stats = computeFleetStats(agents);
    expect(stats.nodes.total).toBe(1);
    expect(stats.nodes.online).toBe(0);
  });

  test("empty agents list → all zeros", () => {
    const stats = computeFleetStats([]);
    expect(stats.nodes.total).toBe(0);
    expect(stats.nodes.online).toBe(0);
    expect(stats.agents.total).toBe(0);
    expect(stats.updatesAvailable).toBe(0);
  });

  test("two different nodes counted correctly", () => {
    const twoNodeRows: RawFleetRow[] = [
      { ...seedRows[0]!, nodeId: "node-a", nodeName: "node-a", nodeStatus: "online" },
      { ...seedRows[1]!, nodeId: "node-b", nodeName: "node-b", nodeStatus: "offline" },
    ];
    const agents = annotateFleetRows(twoNodeRows, null);
    const stats = computeFleetStats(agents);
    expect(stats.nodes.total).toBe(2);
    expect(stats.nodes.online).toBe(1);
    expect(stats.agents.total).toBe(2);
  });
});

// ─── createFleetService (integration: mocked query + version fetcher) ─────────

describe("createFleetService (mocked deps)", () => {
  function makeService(latestVersion: string | null = "v0.1.5") {
    return createFleetService({
      queryFn: async (_userId: string) => seedRows,
      latestVersionFn: async () => latestVersion,
    });
  }

  test("listFleetAgents returns 2 FleetAgents with correct nodeName and nodeStatus", async () => {
    const { listFleetAgents } = makeService("v0.1.5");
    const agents = await listFleetAgents("user-test-001");
    expect(agents).toHaveLength(2);
    for (const a of agents) {
      expect(a.nodeName).toBe(NODE_NAME);
      expect(a.nodeStatus).toBe("online");
    }
  });

  test("listFleetAgents: updateAvailable:true when latestVersion differs from agentVersion", async () => {
    const { listFleetAgents } = makeService("v0.1.5");
    const agents = await listFleetAgents("user-test-001");
    for (const a of agents) {
      expect(a.updateAvailable).toBe(true);
      expect(a.latestVersion).toBe("v0.1.5");
    }
  });

  test("listFleetAgents: updateAvailable:false when latestVersion matches", async () => {
    const { listFleetAgents } = makeService("v0.1.4");
    const agents = await listFleetAgents("user-test-001");
    for (const a of agents) {
      expect(a.updateAvailable).toBe(false);
    }
  });

  test("getFleetStats returns {nodes:{total:1,online:1},agents:{total:2},updatesAvailable:2}", async () => {
    const { getFleetStats } = makeService("v0.1.5");
    const stats = await getFleetStats("user-test-001");
    expect(stats.nodes.total).toBe(1);
    expect(stats.nodes.online).toBe(1);
    expect(stats.agents.total).toBe(2);
    expect(stats.updatesAvailable).toBe(2);
  });

  test("getFleetStats: updatesAvailable:0 when versions match", async () => {
    const { getFleetStats } = makeService("v0.1.4");
    const stats = await getFleetStats("user-test-001");
    expect(stats.updatesAvailable).toBe(0);
  });

  test("queryFn is called with the userId from the caller", async () => {
    const calls: string[] = [];
    const service = createFleetService({
      queryFn: async (userId) => { calls.push(userId); return []; },
      latestVersionFn: async () => null,
    });
    await service.listFleetAgents("user-xyz");
    expect(calls).toEqual(["user-xyz"]);
  });

  test("latestVersionFn is called exactly once per listFleetAgents call", async () => {
    let versionCallCount = 0;
    const service = createFleetService({
      queryFn: async (_userId) => seedRows,
      latestVersionFn: async () => { versionCallCount++; return "v0.1.5"; },
    });
    await service.listFleetAgents("user-test-001");
    expect(versionCallCount).toBe(1);
  });
});

// ─── Live health + status derivation integration (via createFleetService) ─────

const NOW_FIXED = 1_000_000_000;

/** Build a StationHealthReport for use in stubbed cache entries. */
function makeHealthReport(
  key: string,
  ok: boolean,
  running: boolean
): StationHealthReport {
  return {
    key,
    ok,
    running,
    pid: running ? 1234 : null,
    cpuPct: running ? 8.5 : null,
    memBytes: running ? 128 * 1024 * 1024 : null,
    uptimeSec: running ? 3600 : null,
  };
}

/** Stub a health cache map: nodeId → stationKey → CachedHealth. */
function makeHealthFn(
  entries: Record<string, Record<string, CachedHealth>>
): (nodeId: string, stationKey: string) => CachedHealth | null {
  return (nodeId, stationKey) => entries[nodeId]?.[stationKey] ?? null;
}

describe("annotateFleetRows — health + status derivation", () => {
  test("no health data → all agents get status:unknown + null metrics", () => {
    const agents = annotateFleetRows(seedRows, "v0.1.5", () => null, NOW_FIXED);
    for (const a of agents) {
      expect(a.status).toBe("unknown");
      expect(a.cpuPct).toBeNull();
      expect(a.memBytes).toBeNull();
      expect(a.uptimeSec).toBeNull();
    }
  });

  test("fresh ok+running report → status:running + metrics", () => {
    const getHealthFn = makeHealthFn({
      [NODE_ID]: {
        [STATION_KEY_ALPHA]: {
          report: makeHealthReport(STATION_KEY_ALPHA, true, true),
          at: NOW_FIXED - 1_000,
        },
      },
    });
    const agents = annotateFleetRows(seedRows, null, getHealthFn, NOW_FIXED);
    const alpha = agents.find((a) => a.stationId === STATION_ALPHA)!;
    expect(alpha.status).toBe("running");
    expect(alpha.cpuPct).toBe(8.5);
    expect(alpha.memBytes).toBe(128 * 1024 * 1024);
    expect(alpha.uptimeSec).toBe(3600);
    // beta has no cached entry → unknown
    const beta = agents.find((a) => a.stationId === STATION_BETA)!;
    expect(beta.status).toBe("unknown");
  });

  test("ok=true, running=false → status:stopped", () => {
    const getHealthFn = makeHealthFn({
      [NODE_ID]: {
        [STATION_KEY_ALPHA]: {
          report: makeHealthReport(STATION_KEY_ALPHA, true, false),
          at: NOW_FIXED - 1_000,
        },
      },
    });
    const agents = annotateFleetRows([seedRows[0]!], null, getHealthFn, NOW_FIXED);
    expect(agents[0]!.status).toBe("stopped");
  });

  test("ok=false → status:error + null metrics", () => {
    const getHealthFn = makeHealthFn({
      [NODE_ID]: {
        [STATION_KEY_ALPHA]: {
          report: makeHealthReport(STATION_KEY_ALPHA, false, false),
          at: NOW_FIXED - 1_000,
        },
      },
    });
    const agents = annotateFleetRows([seedRows[0]!], null, getHealthFn, NOW_FIXED);
    expect(agents[0]!.status).toBe("error");
    expect(agents[0]!.cpuPct).toBeNull();
  });

  test("stale report (age > 75s) → status:unknown", () => {
    const getHealthFn = makeHealthFn({
      [NODE_ID]: {
        [STATION_KEY_ALPHA]: {
          report: makeHealthReport(STATION_KEY_ALPHA, true, true),
          at: NOW_FIXED - 80_000, // 80 s > 75 s threshold
        },
      },
    });
    const agents = annotateFleetRows([seedRows[0]!], null, getHealthFn, NOW_FIXED);
    expect(agents[0]!.status).toBe("unknown");
    expect(agents[0]!.cpuPct).toBeNull();
  });

  test("offline node → status:unknown even with fresh cache", () => {
    const offlineRow: RawFleetRow = { ...seedRows[0]!, nodeStatus: "offline" };
    const getHealthFn = makeHealthFn({
      [NODE_ID]: {
        [STATION_KEY_ALPHA]: {
          report: makeHealthReport(STATION_KEY_ALPHA, true, true),
          at: NOW_FIXED - 1_000,
        },
      },
    });
    const agents = annotateFleetRows([offlineRow], null, getHealthFn, NOW_FIXED);
    expect(agents[0]!.status).toBe("unknown");
  });
});

describe("computeFleetStats — running count (P2)", () => {
  test("running = count of agents with status:running", () => {
    const getHealthFn = makeHealthFn({
      [NODE_ID]: {
        [STATION_KEY_ALPHA]: {
          report: makeHealthReport(STATION_KEY_ALPHA, true, true),
          at: NOW_FIXED - 1_000,
        },
        [STATION_KEY_BETA]: {
          report: makeHealthReport(STATION_KEY_BETA, true, false),
          at: NOW_FIXED - 1_000,
        },
      },
    });
    const agents = annotateFleetRows(seedRows, null, getHealthFn, NOW_FIXED);
    const stats = computeFleetStats(agents);
    // alpha → running, beta → stopped
    expect(stats.running).toBe(1);
  });

  test("running = 0 when all agents have status:unknown", () => {
    const agents = annotateFleetRows(seedRows, null, () => null, NOW_FIXED);
    const stats = computeFleetStats(agents);
    expect(stats.running).toBe(0);
  });

  test("running = 0 on empty agent list", () => {
    const stats = computeFleetStats([]);
    expect(stats.running).toBe(0);
  });
});

describe("createFleetService — getHealthFn injection", () => {
  test("getHealthFn is called with nodeId + stationKey per agent", async () => {
    const calls: [string, string][] = [];
    const service = createFleetService({
      queryFn: async (_userId) => seedRows,
      latestVersionFn: async () => null,
      getHealthFn: (nodeId, stationKey) => {
        calls.push([nodeId, stationKey]);
        return null;
      },
    });
    await service.listFleetAgents("user-test-001");
    // Two rows → two calls
    expect(calls).toHaveLength(2);
    expect(calls.some(([n, k]) => n === NODE_ID && k === STATION_KEY_ALPHA)).toBe(true);
    expect(calls.some(([n, k]) => n === NODE_ID && k === STATION_KEY_BETA)).toBe(true);
  });

  test("getFleetStats.running reflects live health data", async () => {
    const service = createFleetService({
      queryFn: async (_userId) => seedRows,
      latestVersionFn: async () => null,
      getHealthFn: (nodeId, stationKey) => {
        if (stationKey === STATION_KEY_ALPHA) {
          return {
            report: makeHealthReport(STATION_KEY_ALPHA, true, true),
            at: Date.now() - 1_000, // fresh
          };
        }
        return null;
      },
    });
    const stats = await service.getFleetStats("user-test-001");
    expect(stats.running).toBe(1); // only alpha is running
  });
});
