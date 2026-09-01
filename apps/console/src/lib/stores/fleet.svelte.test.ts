import { test, expect, vi, beforeEach, afterEach } from "vitest";

// The store asks the auth store whether this user is an admin before it
// touches the admin-only principal directory, so the role has to be settable
// per test.
const { mockAuth } = vi.hoisted(() => ({
  mockAuth: { user: null as { role?: string | null } | null },
}));
vi.mock("$lib/stores/auth.svelte", () => ({ auth: mockAuth }));

import * as api from "$lib/api/client";
import * as grants from "$lib/api/grants";
import type { PrincipalSummary } from "$lib/api/grants";
import type { StationRow } from "$lib/api/client";
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

const station: StationRow = {
  id: "stn_1",
  userId: "usr_1",
  nodeId: "node_1",
  harness: "claude-code",
  stationKey: "vps1/builder",
  kind: "leaf",
  parentStationId: null,
  displayName: "builder",
  workspacePath: null,
  capabilities: [],
  matrixId: null,
  bridgeMatrixId: null,
  purpose: null,
  principalId: "prn_builder",
  adoptedAt: "2026-06-22T00:00:00Z",
  createdAt: "2026-06-22T00:00:00Z",
};

const principal: PrincipalSummary = {
  id: "prn_builder",
  kind: "agent",
  handle: "builder",
  displayName: "builder",
  userId: null,
  suspendedAt: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  mockAuth.user = null;
  // Stubbed for every test, not just the ones about them: the second phase
  // runs on every refresh, and an unstubbed call would reach for the network.
  vi.spyOn(api, "listStations").mockResolvedValue([]);
  vi.spyOn(grants, "listPrincipals").mockResolvedValue([]);
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

// ─── The second phase: stations and principals ───────────────────────────────

test("a non-admin never calls listPrincipals, and gets an empty directory", async () => {
  mockAuth.user = { role: "user" };
  vi.spyOn(api, "getFleet").mockResolvedValue({ agents: [agent], stats });
  vi.spyOn(api, "listNodes").mockResolvedValue([node]);
  vi.spyOn(api, "listRuntimes").mockResolvedValue([runtime]);
  const listPrincipals = vi.spyOn(grants, "listPrincipals").mockResolvedValue([principal]);

  await refreshFleet();

  // A 403 on every 30s tick is noise in two logs at once.
  expect(listPrincipals).not.toHaveBeenCalled();
  expect(fleet.principals).toEqual([]);
});

test("an admin loads the principal directory", async () => {
  mockAuth.user = { role: "admin" };
  vi.spyOn(api, "getFleet").mockResolvedValue({ agents: [agent], stats });
  vi.spyOn(api, "listNodes").mockResolvedValue([node]);
  vi.spyOn(api, "listRuntimes").mockResolvedValue([runtime]);
  const listPrincipals = vi.spyOn(grants, "listPrincipals").mockResolvedValue([principal]);

  await refreshFleet();

  expect(listPrincipals).toHaveBeenCalledTimes(1);
  expect(fleet.principals).toEqual([principal]);
});

test("listStations is called only for online nodes", async () => {
  const offline: NodeSummary = { ...node, id: "node_2", name: "vps2", status: "offline" };
  vi.spyOn(api, "getFleet").mockResolvedValue({ agents: [agent], stats });
  vi.spyOn(api, "listNodes").mockResolvedValue([node, offline]);
  vi.spyOn(api, "listRuntimes").mockResolvedValue([runtime]);
  const listStations = vi.spyOn(api, "listStations").mockResolvedValue([station]);

  await refreshFleet();

  expect(listStations.mock.calls.map((c) => c[0])).toEqual(["node_1"]);
  expect(fleet.stations).toEqual([station]);
});

test("one node's listStations rejecting leaves the other nodes' stations populated", async () => {
  const second: NodeSummary = { ...node, id: "node_2", name: "vps2" };
  const stationOnTwo: StationRow = { ...station, id: "stn_2", nodeId: "node_2", stationKey: "vps2/scribe" };
  vi.spyOn(api, "getFleet").mockResolvedValue({ agents: [agent], stats });
  vi.spyOn(api, "listNodes").mockResolvedValue([node, second]);
  vi.spyOn(api, "listRuntimes").mockResolvedValue([runtime]);
  vi.spyOn(api, "listStations").mockImplementation((nodeId: string) =>
    nodeId === "node_1" ? Promise.reject(new Error("boom")) : Promise.resolve([stationOnTwo])
  );

  await refreshFleet();

  // Filtered by node because the store keeps node_1's last good rows rather
  // than dropping them — the assertion here is that node_2's still arrived.
  expect(fleet.stations.filter((s) => s.nodeId === "node_2")).toEqual([stationOnTwo]);
  expect(fleet.error).toBeNull();
});

test("a node whose listStations rejects keeps the rows it last answered with", async () => {
  vi.spyOn(api, "getFleet").mockResolvedValue({ agents: [agent], stats });
  vi.spyOn(api, "listNodes").mockResolvedValue([node]);
  vi.spyOn(api, "listRuntimes").mockResolvedValue([runtime]);
  vi.spyOn(api, "listStations").mockResolvedValue([station]);
  await refreshFleet();
  expect(fleet.stations).toEqual([station]);

  vi.spyOn(api, "listStations").mockRejectedValue(new Error("boom"));
  await refreshFleet();

  // The last good value for that slice stays on screen, exactly as a failed
  // listNodes leaves the previous nodes up.
  expect(fleet.stations).toEqual([station]);
});
