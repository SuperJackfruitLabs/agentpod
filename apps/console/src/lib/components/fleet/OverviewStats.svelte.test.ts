/**
 * OverviewStats.svelte.test.ts
 *
 * The stat band reports HEALTH first (how many agents are running / broken,
 * in status colors) and inventory second (nodes/agents/updates as one quiet
 * line). Inventory numbers must never out-shout the health numbers.
 */

import { test, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import OverviewStats from "./OverviewStats.svelte";
import type { FleetStats, FleetAgent } from "@agentpod/contract";

afterEach(cleanup);

const baseStats: FleetStats = {
  nodes: { total: 3, online: 2 },
  agents: { total: 13 },
  updatesAvailable: 0,
  running: 0,
};

const agent = (stationId: string, status: string): FleetAgent =>
  ({
    stationId,
    nodeId: "n1",
    nodeName: "node",
    agentName: stationId,
    harness: "openclaw",
    kind: "agent",
    nodeStatus: "online",
    agentVersion: "v1",
    latestVersion: "v1",
    updateAvailable: false,
    capabilities: [],
    workspacePath: null,
    status,
    cpuPct: null,
    memBytes: null,
    uptimeSec: null,
  }) as FleetAgent;

const mixedAgents = [
  agent("a1", "running"),
  agent("a2", "running"),
  agent("a3", "stopped"),
  agent("a4", "error"),
];

test("health band: running count leads, colored by status token", () => {
  const { getByTestId } = render(OverviewStats, {
    props: { stats: baseStats, agents: mixedAgents },
  });
  const running = getByTestId("stat-running");
  expect(running.textContent?.trim()).toBe("2");
  expect(running.className).toContain("text-status-running");
});

test("health band: problem states appear with their own colored counts", () => {
  const { getByTestId } = render(OverviewStats, {
    props: { stats: baseStats, agents: mixedAgents },
  });
  expect(getByTestId("stat-error").textContent?.trim()).toBe("1");
  expect(getByTestId("stat-error").className).toContain("text-status-error");
  expect(getByTestId("stat-stopped").textContent?.trim()).toBe("1");
});

test("health band: zero-count problem states are omitted; running always shows", () => {
  const { getByTestId, queryByTestId } = render(OverviewStats, {
    props: { stats: baseStats, agents: [agent("a1", "running")] },
  });
  expect(getByTestId("stat-running").textContent?.trim()).toBe("1");
  expect(queryByTestId("stat-error")).toBeNull();
  expect(queryByTestId("stat-stopped")).toBeNull();
});

test("inventory line: nodes online/total, agent total, updates", () => {
  const { getByTestId } = render(OverviewStats, {
    props: { stats: { ...baseStats, updatesAvailable: 5 }, agents: mixedAgents },
  });
  expect(getByTestId("stat-nodes").textContent).toContain("2/3");
  expect(getByTestId("stat-agents").textContent?.trim()).toBe("13");
  expect(getByTestId("stat-updates").textContent?.trim()).toBe("5");
});

test("updates accent only when > 0", () => {
  const withUpdates = render(OverviewStats, {
    props: { stats: { ...baseStats, updatesAvailable: 2 }, agents: mixedAgents },
  });
  expect(withUpdates.getByTestId("stat-updates").className).toContain("text-status-degraded");
  withUpdates.unmount();

  const without = render(OverviewStats, {
    props: { stats: baseStats, agents: mixedAgents },
  });
  expect(without.getByTestId("stat-updates").className).not.toContain("text-status-degraded");
});
