/**
 * page.svelte.test.ts — the muster.
 *
 * The old Overview had five panels and told you the fleet was fine in five
 * different ways, one of which was wrong. These tests are about the two
 * things the muster owes you instead: the fleet stated in words, and the
 * nodes you can actually act on.
 */
import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/svelte";
import type { FleetAgent, NodeSummary } from "@agentpod/contract";

const { mockFleet, goto, updateNode, listActivity, createEnrollmentToken } = vi.hoisted(() => ({
  mockFleet: {
    agents: [] as unknown[],
    nodes: [] as unknown[],
    runtimes: [] as unknown[],
    stations: [] as unknown[],
    principals: [] as unknown[],
    isLoading: false,
    error: null as string | null,
    loadedAt: 1 as number | null,
  },
  goto: vi.fn(),
  updateNode: vi.fn(),
  listActivity: vi.fn(),
  createEnrollmentToken: vi.fn(),
}));

vi.mock("$lib/stores/fleet.svelte", () => ({ fleet: mockFleet, refreshFleet: vi.fn() }));
vi.mock("$app/navigation", () => ({ goto }));
vi.mock("$app/state", () => ({ page: { url: { pathname: "/", searchParams: null } } }));
vi.mock("$lib/api/client", () => ({ updateNode, listActivity, createEnrollmentToken }));
vi.mock("svelte-sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import Muster from "./+page.svelte";

function agent(partial: Partial<FleetAgent> & Pick<FleetAgent, "stationId" | "nodeId">): FleetAgent {
  return {
    nodeName: "orion",
    agentName: "atlas",
    harness: "claude-code",
    kind: "station",
    nodeStatus: "online",
    agentVersion: "v0.1.27",
    latestVersion: "v0.1.32",
    updateAvailable: false,
    capabilities: [],
    workspacePath: "/srv/work",
    status: "running",
    cpuPct: 1,
    memBytes: 1,
    uptimeSec: 60,
    ...partial,
  } as FleetAgent;
}

function node(partial: Partial<NodeSummary> & Pick<NodeSummary, "id" | "name">): NodeSummary {
  return {
    hostname: "orion.local",
    os: "linux",
    arch: "arm64",
    cpuCount: 8,
    status: "online",
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    agentVersion: "v0.1.32",
    latestVersion: "v0.1.32",
    updateAvailable: false,
    capabilities: ["posture"],
    purpose: null,
    provisioned: null,
    ...partial,
  } as NodeSummary;
}

// Five agents on two nodes. orion is behind (drift); vega is offline.
const AGENTS: FleetAgent[] = [
  agent({ stationId: "st_1", nodeId: "n_orion", agentName: "atlas", status: "running" }),
  agent({ stationId: "st_2", nodeId: "n_orion", agentName: "hermes", status: "running" }),
  agent({ stationId: "st_3", nodeId: "n_orion", agentName: "boreas", status: "error" }),
  agent({ stationId: "st_4", nodeId: "n_vega", nodeName: "vega", agentName: "zephyr", status: "stopped" }),
  agent({ stationId: "st_5", nodeId: "n_vega", nodeName: "vega", agentName: "notus", status: "unknown" }),
];

const NODES: NodeSummary[] = [
  node({ id: "n_orion", name: "orion", agentVersion: "v0.1.27", latestVersion: "v0.1.32", updateAvailable: true }),
  node({ id: "n_vega", name: "vega", status: "offline", lastSeenAt: null, capabilities: [] }),
];

beforeEach(() => {
  mockFleet.agents = AGENTS;
  mockFleet.nodes = NODES;
  mockFleet.runtimes = [];
  mockFleet.stations = [];
  mockFleet.principals = [];
  mockFleet.isLoading = false;
  mockFleet.error = null;
  mockFleet.loadedAt = 1;
  goto.mockClear();
  updateNode.mockReset().mockResolvedValue({ ok: true, updating: true });
  listActivity.mockReset().mockResolvedValue([]);
  createEnrollmentToken.mockReset();
});

afterEach(cleanup);

// --- the hero ---------------------------------------------------------------

test("the hero states the fleet in words, not in stat cards", () => {
  const { getByTestId } = render(Muster);

  expect(getByTestId("muster-hero").textContent).toContain("5 agents on 2 nodes.");
});

test("the hero says how many things need a person, and colours that line", () => {
  // vega is offline (1) and orion's node agent is behind (1).
  const { getByTestId } = render(Muster);
  const line = getByTestId("muster-needs-you");

  expect(line.textContent).toContain("2 need you.");
  expect(line.className).toContain("text-status-unknown");
});

test("with nothing wrong the needs-you line turns green and says so", () => {
  mockFleet.nodes = [node({ id: "n_orion", name: "orion" })];
  mockFleet.agents = [agent({ stationId: "st_1", nodeId: "n_orion" })];

  const { getByTestId } = render(Muster);
  const line = getByTestId("muster-needs-you");

  expect(line.textContent).toContain("Nothing needs you.");
  expect(line.className).toContain("text-status-running");
});

test("one agent on one node is not pluralised", () => {
  mockFleet.nodes = [node({ id: "n_orion", name: "orion" })];
  mockFleet.agents = [agent({ stationId: "st_1", nodeId: "n_orion" })];

  const { getByTestId } = render(Muster);

  expect(getByTestId("muster-hero").textContent).toContain("1 agent on 1 node.");
});

// --- the state bar ----------------------------------------------------------

test("one stacked bar carries the fleet's states, unknown counted as its own", () => {
  const { getByTestId } = render(Muster);
  const bar = getByTestId("muster-state-bar");

  // 2 running, 1 error, 1 stopped, 1 unknown — never "5 stopped", and never
  // an unknown folded into stopped, which is the lie this page replaces.
  const text = bar.textContent ?? "";
  expect(text).toContain("Unknown");
  expect(text).toContain("Stopped");
  expect(text).toContain("Error");
  expect(text).toContain("Running");
});

// --- the nodes table --------------------------------------------------------

test("every node gets a row, linked by name", () => {
  const { getAllByTestId } = render(Muster);
  const rows = getAllByTestId("node-row");

  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("orion");
  expect(rows[0].querySelector("a")?.getAttribute("href")).toBe("/nodes/n_orion");
});

test("a node behind on its agent shows the drift and an Update button in the row", async () => {
  const { getAllByTestId, getByTestId } = render(Muster);

  expect(getByTestId("node-drift-n_orion").textContent).toContain("v0.1.27 → v0.1.32");

  const button = getByTestId("node-update-n_orion");
  expect(button.textContent).toContain("Update");

  button.click();
  await waitFor(() => expect(updateNode).toHaveBeenCalledWith("n_orion"));

  // The node that is current gets no button at all.
  expect(getAllByTestId("node-row")[1].querySelector('[data-testid^="node-update-"]')).toBeNull();
});

test("the node row counts the agents on it", () => {
  const { getByTestId } = render(Muster);

  expect(getByTestId("node-agents-n_orion").textContent?.trim()).toBe("3");
  expect(getByTestId("node-agents-n_vega").textContent?.trim()).toBe("2");
});

test("an offline node reads offline in a word, not only in a colour", () => {
  const { getByTestId } = render(Muster);

  // A machine that is switched off is offline, not "Error" — nodeState carries
  // the node's own words over the shared token (bd40c540, which updated
  // state.test.ts and ActivityFeed's tests but not this one).
  expect(getByTestId("node-link-n_vega").textContent).toContain("Offline");
  expect(getByTestId("node-link-n_orion").textContent).toContain("Online");
});

test("every node row is `relative` — a StateDot's sr-only label must not escape", () => {
  // Same trap the attention lane hit: an absolutely positioned sr-only span
  // with no positioned ancestor widens the document instead of being clipped.
  const { getAllByTestId } = render(Muster);

  for (const row of getAllByTestId("node-row")) {
    expect(row.className).toContain("relative");
  }
});

test("the actions header is `relative` — its sr-only word escaped the table once", () => {
  // Measured in a real browser: this sr-only span is position:absolute, and
  // with no positioned ancestor it broke out of the table's overflow-x-auto
  // and set document.documentElement.scrollWidth to 667 at a 414px viewport.
  const { getByText } = render(Muster);

  expect(getByText("Actions").closest("th")?.className).toContain("relative");
});

test("the nodes table scrolls inside its own box, never the page", () => {
  const { getByTestId } = render(Muster);

  expect(getByTestId("nodes-table-scroller").className).toContain("overflow-x-auto");
});

// --- activity ---------------------------------------------------------------

test("the muster loads activity once and hands it to the feed", async () => {
  listActivity.mockResolvedValue([
    { id: "a1", verb: "posture.scan", stationKey: "claude-code:atlas", nodeId: "n_orion", result: "ok", createdAt: new Date().toISOString() },
  ]);

  const { getAllByTestId } = render(Muster);

  await waitFor(() => {
    expect(listActivity).toHaveBeenCalledOnce();
    expect(getAllByTestId("activity-row")[0].textContent).toContain("posture.scan");
  });
});

// --- the empty fleet --------------------------------------------------------

test("with no nodes at all the muster offers the way to connect one", () => {
  mockFleet.agents = [];
  mockFleet.nodes = [];

  const { getByTestId, queryByTestId } = render(Muster);

  expect(getByTestId("connect-banner")).toBeTruthy();
  expect(queryByTestId("muster-state-bar")).toBeNull();
});

// --- failure ----------------------------------------------------------------

test("a fleet that could not be loaded says so instead of claiming zero agents", () => {
  mockFleet.agents = [];
  mockFleet.nodes = [];
  mockFleet.error = "Couldn't reach the hub.";

  const { getByRole, queryByTestId } = render(Muster);

  expect(getByRole("alert").textContent).toContain("Couldn't reach the hub.");
  expect(queryByTestId("connect-banner")).toBeNull();
});

test("the page starts no poll of its own — the shell holds the only one", () => {
  // The mocked fleet store above deliberately exports no `startFleetPoll`.
  // A muster that opened a second poll would call `undefined()` on mount and
  // this render would throw, so a clean render IS the assertion.
  expect(() => render(Muster)).not.toThrow();
});
