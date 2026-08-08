/**
 * OverviewStats.svelte.test.ts
 *
 * TDD tests for the Overview stat-band component.
 * Asserts:
 *   - renders nodes online/total
 *   - renders agents total
 *   - renders updatesAvailable value
 *   - updatesAvailable > 0 → accent class applied
 *   - updatesAvailable === 0 → no accent
 */

import { test, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import OverviewStats from "./OverviewStats.svelte";
import type { FleetStats } from "@agentpod/contract";

afterEach(cleanup);

const baseStats: FleetStats = {
  nodes: { total: 3, online: 2 },
  agents: { total: 13 },
  updatesAvailable: 0,
  running: 0,
};

test("renders nodes online and total", () => {
  const { getByTestId } = render(OverviewStats, { props: { stats: baseStats } });
  const nodesEl = getByTestId("stat-nodes");
  expect(nodesEl.textContent).toContain("2");
  expect(nodesEl.textContent).toContain("3");
});

test("renders agents total", () => {
  const { getByTestId } = render(OverviewStats, { props: { stats: baseStats } });
  const agentsEl = getByTestId("stat-agents");
  expect(agentsEl.textContent?.trim()).toBe("13");
});

test("renders updatesAvailable count", () => {
  const stats: FleetStats = { ...baseStats, updatesAvailable: 5 };
  const { getByTestId } = render(OverviewStats, { props: { stats } });
  const updatesEl = getByTestId("stat-updates");
  expect(updatesEl.textContent?.trim()).toBe("5");
});

test("updatesAvailable > 0 applies accent class (text-status-degraded)", () => {
  const stats: FleetStats = { ...baseStats, updatesAvailable: 2 };
  const { getByTestId } = render(OverviewStats, { props: { stats } });
  const updatesEl = getByTestId("stat-updates");
  expect(updatesEl.className).toContain("text-status-degraded");
});

test("updatesAvailable === 0 does not apply text-status-degraded to updates stat", () => {
  const { getByTestId } = render(OverviewStats, { props: { stats: baseStats } });
  const updatesEl = getByTestId("stat-updates");
  expect(updatesEl.className).not.toContain("text-status-degraded");
});
