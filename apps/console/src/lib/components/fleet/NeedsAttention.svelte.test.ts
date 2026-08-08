/**
 * NeedsAttention.svelte.test.ts
 *
 * TDD tests for the NeedsAttention dashboard panel.
 * Asserts:
 *  - "all healthy ✓" shown when all agents are running
 *  - non-running agents are listed with a link to /agents?station=<id>
 *  - offline nodes are counted and shown as a link to /nodes
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import type { FleetAgent } from "@agentpod/contract";
import NeedsAttention from "./NeedsAttention.svelte";

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

const makeAgent = (overrides: Partial<FleetAgent> & { stationId: string }): FleetAgent => ({
  nodeId: "n1",
  nodeName: "vps1",
  agentName: "hanuman",
  harness: "openclaw",
  kind: "agent",
  nodeStatus: "online",
  agentVersion: "v0.1.4",
  latestVersion: "v0.1.4",
  updateAvailable: false,
  capabilities: [],
  workspacePath: null,
  status: "running",
  cpuPct: null,
  memBytes: null,
  uptimeSec: null,
  ...overrides,
});

test("shows 'all healthy ✓' when all agents are running", () => {
  const agents = [
    makeAgent({ stationId: "s1", status: "running" }),
    makeAgent({ stationId: "s2", status: "running" }),
  ];

  const { getByTestId } = render(NeedsAttention, { props: { agents } });
  expect(getByTestId("all-healthy")).toBeTruthy();
});

test("lists non-running agents with link to /agents?station=<id>", () => {
  const agents = [
    makeAgent({ stationId: "s1", agentName: "hanuman", status: "running" }),
    makeAgent({ stationId: "s2", agentName: "kubera", status: "stopped" }),
  ];

  const { getAllByTestId, container } = render(NeedsAttention, { props: { agents } });
  const items = getAllByTestId("attention-agent");
  expect(items.length).toBe(1);
  expect(items[0].textContent).toContain("kubera");
  expect(items[0].getAttribute("href")).toBe("/agents?station=s2");
  // running agent not listed
  expect(container.textContent).not.toContain("hanuman");
});

test("shows offline node count linking to /nodes", () => {
  const agents = [
    makeAgent({ stationId: "s1", nodeId: "n_offline", nodeStatus: "offline" }),
    makeAgent({ stationId: "s2", nodeId: "n_offline", nodeStatus: "offline" }), // same node, counted once
  ];

  const { getByTestId } = render(NeedsAttention, { props: { agents } });
  const offlineLink = getByTestId("attention-offline-nodes");
  expect(offlineLink.textContent).toContain("1 node offline");
  expect(offlineLink.getAttribute("href")).toBe("/nodes");
});

test("does not show offline-nodes row when all nodes are online", () => {
  const agents = [
    makeAgent({ stationId: "s1", nodeStatus: "online", status: "running" }),
  ];

  const { queryByTestId } = render(NeedsAttention, { props: { agents } });
  expect(queryByTestId("attention-offline-nodes")).toBeNull();
});

test("shows empty list heading but no all-healthy when there are attention items", () => {
  const agents = [
    makeAgent({ stationId: "s1", agentName: "arjuna", status: "error" }),
  ];

  const { queryByTestId, getByTestId } = render(NeedsAttention, { props: { agents } });
  expect(queryByTestId("all-healthy")).toBeNull();
  expect(getByTestId("attention-agent")).toBeTruthy();
});

test("shows update count linking to the updates deep-link /agents?updates=1", () => {
  const agents = [
    makeAgent({ stationId: "s1", status: "running", updateAvailable: true }),
    makeAgent({ stationId: "s2", status: "running", updateAvailable: false }),
  ];

  const { getByTestId } = render(NeedsAttention, { props: { agents } });
  const updatesLink = getByTestId("attention-updates");
  expect(updatesLink.textContent).toContain("1 update available");
  expect(updatesLink.getAttribute("href")).toBe("/agents?updates=1");
});
