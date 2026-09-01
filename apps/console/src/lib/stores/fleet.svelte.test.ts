import { test, expect, vi, beforeEach, afterEach } from "vitest";
import * as api from "$lib/api/client";
import type { FleetAgent, FleetStats, NodeSummary, ProvisionedRuntime } from "@agentpod/contract";
import { fleet, refreshFleet, startFleetPoll } from "./fleet.svelte";

const agent: FleetAgent = {
  stationId: "stn_1",
  nodeId: "node_1",
  nodeName: "vps1",
  agentName: "builder",
  harness: "claude-code",
  kind: "leaf",
  nodeStatus: "online",
  agentVersion: "1.0.0",
  latestVersion: "1.0.0",
  updateAvailable: false,
  capabilities: [],
  workspacePath: null,
  status: "running",
  cpuPct: 1,
  memBytes: 100,
  uptimeSec: 10,
};

const stats: FleetStats = {
  nodes: { total: 1, online: 1 },
  agents: { total: 1 },
  updatesAvailable: 0,
  running: 1,
};

const node: NodeSummary = {
  id: "node_1",
  name: "vps1",
  hostname: "vps1",
  os: "linux",
  arch: "amd64",
  cpuCount: 4,
  status: "online",
  lastSeenAt: null,
  createdAt: "2026-06-22T00:00:00Z",
  agentVersion: "1.0.0",
  latestVersion: "1.0.0",
  updateAvailable: false,
};

const runtime: ProvisionedRuntime = {
  id: "rt_1",
  ownerId: "owner_1",
  provider: "docker",
  externalId: null,
  status: "online",
  nodeId: "node_1",
  name: "runtime-1",
  resourceTier: "small",
  harness: "none",
  createdAt: "2026-06-22T00:00:00Z",
  updatedAt: "2026-06-22T00:00:00Z",
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("refreshFleet populates a snapshot", async () => {
  vi.spyOn(api, "getFleet").mockResolvedValue({ agents: [agent], stats });
  vi.spyOn(api, "listNodes").mockResolvedValue([node]);
  vi.spyOn(api, "listRuntimes").mockResolvedValue([runtime]);

  await refreshFleet();

  expect(fleet.agents).toEqual([agent]);
  expect(fleet.stats).toEqual(stats);
  expect(fleet.nodes).toEqual([node]);
  expect(fleet.runtimes).toEqual([runtime]);
  expect(fleet.loadedAt).not.toBeNull();
  expect(fleet.error).toBeNull();
});

test("a rejected listRuntimes leaves agents populated and sets no global error", async () => {
  vi.spyOn(api, "getFleet").mockResolvedValue({ agents: [agent], stats });
  vi.spyOn(api, "listNodes").mockResolvedValue([node]);
  vi.spyOn(api, "listRuntimes").mockRejectedValue(new Error("boom"));

  await refreshFleet();

  expect(fleet.agents).toEqual([agent]);
  expect(fleet.error).toBeNull();
});

test("startFleetPoll is ref-counted: two starts need two stops", async () => {
  const getFleetSpy = vi.spyOn(api, "getFleet").mockResolvedValue({ agents: [agent], stats });
  vi.spyOn(api, "listNodes").mockResolvedValue([node]);
  vi.spyOn(api, "listRuntimes").mockResolvedValue([runtime]);

  const stopA = startFleetPoll();
  const stopB = startFleetPoll();
  await vi.runOnlyPendingTimersAsync();

  const callsAfterStart = getFleetSpy.mock.calls.length;
  expect(callsAfterStart).toBeGreaterThan(0);

  stopA();
  await vi.advanceTimersByTimeAsync(30_000);
  // still polling — one caller stopped, one remains
  expect(getFleetSpy.mock.calls.length).toBeGreaterThan(callsAfterStart);

  const callsBeforeSecondStop = getFleetSpy.mock.calls.length;
  stopB();
  await vi.advanceTimersByTimeAsync(30_000);
  // both callers stopped — no further ticks
  expect(getFleetSpy.mock.calls.length).toBe(callsBeforeSecondStop);
});

test("startFleetPoll is idempotent: calling stop twice is harmless", async () => {
  vi.spyOn(api, "getFleet").mockResolvedValue({ agents: [agent], stats });
  vi.spyOn(api, "listNodes").mockResolvedValue([node]);
  vi.spyOn(api, "listRuntimes").mockResolvedValue([runtime]);

  const stop = startFleetPoll();
  stop();
  expect(() => stop()).not.toThrow();
});
