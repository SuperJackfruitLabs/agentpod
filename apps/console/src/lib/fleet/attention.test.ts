import { test, expect } from "vitest";
import type { FleetAgent, NodeSummary, ProvisionedRuntime } from "@agentpod/contract";
import { deriveAttention } from "./attention";

function makeAgent(overrides: Partial<FleetAgent> = {}): FleetAgent {
  return {
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
    ...overrides,
  };
}

function makeNode(overrides: Partial<NodeSummary> = {}): NodeSummary {
  return {
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
    ...overrides,
  };
}

function makeRuntime(overrides: Partial<ProvisionedRuntime> = {}): ProvisionedRuntime {
  return {
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
    ...overrides,
  };
}

test("empty input gives []", () => {
  expect(deriveAttention({ agents: [], nodes: [], runtimes: [] })).toEqual([]);
});

test("node-offline: an offline node produces one item, counting its stations", () => {
  const nodes = [makeNode({ id: "node_1", name: "vps1", status: "offline" })];
  const agents = [
    makeAgent({ stationId: "stn_1", nodeId: "node_1", status: "unknown" }),
    makeAgent({ stationId: "stn_2", nodeId: "node_1", status: "unknown" }),
  ];

  const items = deriveAttention({ agents, nodes, runtimes: [] });

  expect(items).toEqual([
    {
      kind: "node-offline",
      token: "error",
      what: "Node offline",
      who: "vps1",
      detail: "2 agents unknown",
      href: "/nodes/node_1",
    },
  ]);
});

test("node-offline: singular detail for exactly one station", () => {
  const nodes = [makeNode({ id: "node_1", status: "offline" })];
  const agents = [makeAgent({ stationId: "stn_1", nodeId: "node_1" })];

  const items = deriveAttention({ agents, nodes, runtimes: [] });

  expect(items[0].detail).toBe("1 agent unknown");
});

test("an online node produces no node-offline item", () => {
  const nodes = [makeNode({ status: "online" })];
  expect(deriveAttention({ agents: [], nodes, runtimes: [] })).toEqual([]);
});

test("offline-node suppression: stations on the offline node produce no item of their own — only the one node item", () => {
  const nodes = [makeNode({ id: "node_1", status: "offline" })];
  const agents = [
    makeAgent({ stationId: "stn_1", nodeId: "node_1", status: "unknown" }),
    makeAgent({ stationId: "stn_2", nodeId: "node_1", status: "unknown" }),
    makeAgent({ stationId: "stn_3", nodeId: "node_1", status: "unknown" }),
  ];

  const items = deriveAttention({ agents, nodes, runtimes: [] });

  // One item for the node, not one per station on it.
  expect(items).toHaveLength(1);
  expect(items[0].kind).toBe("node-offline");
});

test("runtime-error: an errored runtime produces an item with its statusReason", () => {
  const runtimes = [
    makeRuntime({ name: "runtime-1", status: "error", statusReason: "no node enrolled within 2m" }),
  ];

  const items = deriveAttention({ agents: [], nodes: [], runtimes });

  expect(items).toEqual([
    {
      kind: "runtime-error",
      token: "error",
      what: "Runtime failed to start",
      who: "runtime-1",
      detail: "no node enrolled within 2m",
      href: "/runtimes",
    },
  ]);
});

test("runtime-error: falls back to 'no reason given' when statusReason is absent", () => {
  const runtimes = [makeRuntime({ status: "error", statusReason: null })];

  const items = deriveAttention({ agents: [], nodes: [], runtimes });

  expect(items[0].detail).toBe("no reason given");
});

test("a runtime in a non-error status produces no item", () => {
  const runtimes = [makeRuntime({ status: "online" })];
  expect(deriveAttention({ agents: [], nodes: [], runtimes })).toEqual([]);
});

test("drift: a node with updateAvailable produces an item naming both versions", () => {
  const nodes = [
    makeNode({ name: "vps1", updateAvailable: true, agentVersion: "1.2.0", latestVersion: "1.3.0" }),
  ];

  const items = deriveAttention({ agents: [], nodes, runtimes: [] });

  expect(items).toEqual([
    {
      kind: "drift",
      token: "unknown",
      what: "Node agent is behind",
      who: "vps1",
      detail: "1.2.0 to 1.3.0",
      href: "/nodes/node_1",
    },
  ]);
});

test("a node with no update available produces no drift item", () => {
  const nodes = [makeNode({ updateAvailable: false })];
  expect(deriveAttention({ agents: [], nodes, runtimes: [] })).toEqual([]);
});

test("ordering across mixed input: node-offline, then runtime-error, then drift", () => {
  const nodes = [
    makeNode({ id: "node_1", name: "drifting", updateAvailable: true, agentVersion: "1.0.0", latestVersion: "1.1.0" }),
    makeNode({ id: "node_2", name: "down", status: "offline" }),
  ];
  const runtimes = [makeRuntime({ name: "broken-runtime", status: "error", statusReason: "boom" })];

  const items = deriveAttention({ agents: [], nodes, runtimes });

  expect(items.map((i) => i.kind)).toEqual(["node-offline", "runtime-error", "drift"]);
});

// Rule 1 ("unoccupied") and rule 5 ("permission") are deliberately not
// exercised here beyond confirming they never appear: FleetAgent has no
// principal/occupant field and no endpoint reports a waiting ACP session, so
// deriveAttention never produces either kind — see the task report for the
// field gap. If a station carries a status the deriver doesn't otherwise
// recognise, it must still produce nothing rather than guess.
test("a station-only input (no offline node, no runtime, no drift) produces []", () => {
  const agents = [makeAgent({ status: "unknown" }), makeAgent({ stationId: "stn_2", status: "error" })];
  const nodes = [makeNode()];

  expect(deriveAttention({ agents, nodes, runtimes: [] })).toEqual([]);
});
