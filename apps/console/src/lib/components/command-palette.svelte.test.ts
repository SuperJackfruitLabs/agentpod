/**
 * command-palette.svelte.test.ts
 *
 * The palette is the fleet's verb index, not a second copy of the old
 * resource-page navigation. These tests pin the three things that make it
 * that: an entry per agent you can find by typing its handle, fleet verbs
 * that are only offered when there is something to do, and authority verbs
 * that are only offered to someone who may run them.
 */
import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import type { FleetAgent, NodeSummary } from "@agentpod/contract";

const { mockFleet, mockAuth, goto, updateAllNodes, nodePosture, toast } = vi.hoisted(() => ({
  mockFleet: {
    agents: [] as unknown[],
    nodes: [] as unknown[],
    runtimes: [] as unknown[],
    stations: [] as unknown[],
    principals: [] as unknown[],
  },
  mockAuth: { user: null as { role?: string | null } | null },
  goto: vi.fn(),
  updateAllNodes: vi.fn(),
  nodePosture: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("$lib/stores/fleet.svelte", () => ({ fleet: mockFleet }));
vi.mock("$lib/stores/auth.svelte", () => ({ auth: mockAuth }));
vi.mock("$app/navigation", () => ({ goto }));
vi.mock("$app/state", () => ({ page: { url: { pathname: "/" } } }));
vi.mock("$lib/api/client", () => ({ updateAllNodes, nodePosture }));
vi.mock("svelte-sonner", () => ({ toast }));

import { commandPalette } from "$lib/stores/command-palette.svelte";
import CommandPalette from "./command-palette.svelte";

function agent(
  partial: Partial<FleetAgent> & Pick<FleetAgent, "stationId" | "nodeId" | "nodeName" | "agentName">
): FleetAgent {
  return {
    harness: "claude-code",
    kind: "station",
    nodeStatus: "online",
    agentVersion: "v0.1.32",
    latestVersion: "v0.1.32",
    updateAvailable: false,
    capabilities: [],
    workspacePath: null,
    status: "running",
    cpuPct: 1,
    memBytes: 1,
    uptimeSec: 1,
    ...partial,
  } as FleetAgent;
}

function node(partial: Partial<NodeSummary> & Pick<NodeSummary, "id" | "name">): NodeSummary {
  return {
    hostname: partial.name,
    os: "linux",
    arch: "arm64",
    cpuCount: 4,
    status: "online",
    lastSeenAt: null,
    createdAt: "2026-06-22T00:00:00Z",
    agentVersion: "v0.1.32",
    latestVersion: "v0.1.32",
    updateAvailable: false,
    capabilities: ["posture"],
    ...partial,
  } as NodeSummary;
}

const AGENTS: FleetAgent[] = [
  agent({ stationId: "st_atlas", nodeId: "n_orion", nodeName: "orion", agentName: "atlas", status: "error" }),
  agent({ stationId: "st_hermes", nodeId: "n_vega", nodeName: "vega", agentName: "hermes" }),
];

const NODES: NodeSummary[] = [node({ id: "n_orion", name: "orion" }), node({ id: "n_vega", name: "vega" })];

const PLACEHOLDER = "Search agents and fleet verbs…";

beforeEach(() => {
  vi.clearAllMocks();
  mockFleet.agents = AGENTS;
  mockFleet.nodes = NODES;
  mockAuth.user = { role: "user" };
  commandPalette.close();
});

afterEach(cleanup);

/** Opens the palette and waits for the dialog's input to be on screen. */
async function open() {
  commandPalette.open();
  const view = render(CommandPalette);
  await waitFor(() => expect(view.getByPlaceholderText(PLACEHOLDER)).toBeTruthy());
  return view;
}

// --- Go to ------------------------------------------------------------------

test("when closed: nothing renders", () => {
  commandPalette.close();
  const { queryByPlaceholderText } = render(CommandPalette);

  expect(queryByPlaceholderText(PLACEHOLDER)).toBeNull();
});

test("one entry per agent, addressed by handle", async () => {
  const { getAllByTestId } = await open();

  const entries = getAllByTestId("palette-agent");
  expect(entries).toHaveLength(2);
  expect(entries[0].textContent).toContain("Message atlas");
});

test("an agent entry is tailed with its node and its state", async () => {
  const { getAllByTestId } = await open();

  // The state word, never the hue alone — the palette has no room for a dot.
  expect(getAllByTestId("palette-agent")[0].textContent).toContain("orion");
  expect(getAllByTestId("palette-agent")[0].textContent).toContain("Error");
});

test("typing a handle surfaces that agent's Message entry and hides the rest", async () => {
  const { getByPlaceholderText, getAllByTestId } = await open();

  await fireEvent.input(getByPlaceholderText(PLACEHOLDER), { target: { value: "hermes" } });

  await waitFor(() => {
    const entries = getAllByTestId("palette-agent");
    expect(entries).toHaveLength(1);
    expect(entries[0].textContent).toContain("Message hermes");
  });
});

test("selecting an agent opens its station page", async () => {
  const { getAllByTestId } = await open();

  await fireEvent.click(getAllByTestId("palette-agent")[0]);

  expect(goto).toHaveBeenCalledWith("/nodes/n_orion/stations/st_atlas");
  expect(commandPalette.isOpen).toBe(false);
});

// --- Fleet ------------------------------------------------------------------

test("with no node behind, the update entry is absent", async () => {
  const { queryByTestId } = await open();

  expect(queryByTestId("palette-update-all")).toBeNull();
});

test("with nodes behind, the update entry is offered and counts them", async () => {
  mockFleet.nodes = [node({ id: "n_orion", name: "orion", updateAvailable: true }), NODES[1]];
  const { getByTestId } = await open();

  expect(getByTestId("palette-update-all").textContent).toContain("1 behind");
});

test("selecting the update entry rolls the fleet", async () => {
  mockFleet.nodes = [node({ id: "n_orion", name: "orion", updateAvailable: true }), NODES[1]];
  updateAllNodes.mockResolvedValue({ ok: true, summary: { updated: 1 }, results: [] });
  const { getByTestId } = await open();

  await fireEvent.click(getByTestId("palette-update-all"));

  expect(updateAllNodes).toHaveBeenCalledTimes(1);
});

test("the token and runtime entries open the dialogs on the nodes page", async () => {
  const { getByTestId } = await open();

  await fireEvent.click(getByTestId("palette-enrollment-token"));
  expect(goto).toHaveBeenCalledWith("/nodes?action=create-token");

  cleanup();
  const second = await open();
  await fireEvent.click(second.getByTestId("palette-new-runtime"));
  expect(goto).toHaveBeenCalledWith("/nodes?action=new-runtime");
});

test("a posture scan is offered per node that can run one, and runs it", async () => {
  nodePosture.mockResolvedValue({ hostname: "orion", stations: 2, findings: [], grade: "A" });
  const { getAllByTestId } = await open();

  const scans = getAllByTestId("palette-posture");
  expect(scans).toHaveLength(2);
  expect(scans[0].textContent).toContain("orion");

  await fireEvent.click(scans[0]);
  expect(nodePosture).toHaveBeenCalledWith("n_orion");
});

test("a node that does not advertise posture is not offered a scan", async () => {
  // Known-absent, not merely unknown: an older node reports null capabilities
  // and is still offered one, because the hub is the one that decides.
  mockFleet.nodes = [
    node({ id: "n_orion", name: "orion", capabilities: [] }),
    node({ id: "n_vega", name: "vega", capabilities: null }),
  ];
  const { getAllByTestId } = await open();

  const scans = getAllByTestId("palette-posture");
  expect(scans).toHaveLength(1);
  expect(scans[0].textContent).toContain("vega");
});

test("an offline node is not offered a scan", async () => {
  mockFleet.nodes = [node({ id: "n_orion", name: "orion", status: "offline" }), NODES[1]];
  const { getAllByTestId } = await open();

  expect(getAllByTestId("palette-posture")).toHaveLength(1);
});

// --- Authority --------------------------------------------------------------

test("a non-admin is offered no Authority verbs", async () => {
  mockAuth.user = { role: "user" };
  const { queryByTestId, queryByText } = await open();

  expect(queryByTestId("palette-grants")).toBeNull();
  expect(queryByTestId("palette-suspend")).toBeNull();
  expect(queryByText("Authority")).toBeNull();
});

test("an admin is offered them, tailed destructive", async () => {
  mockAuth.user = { role: "admin" };
  const { getByTestId, getByText } = await open();

  expect(getByText("Authority")).toBeTruthy();
  const grants = getByTestId("palette-grants");
  const suspend = getByTestId("palette-suspend");
  expect(grants.textContent).toContain("destructive");
  expect(suspend.textContent).toContain("destructive");
  // Saturated colour only ever via a status token, and this is the one place
  // in the palette that earns any.
  expect(grants.querySelector(".text-status-error")).toBeTruthy();
  expect(suspend.querySelector(".text-status-error")).toBeTruthy();
});

test("the Authority verbs go to the page that holds them", async () => {
  mockAuth.user = { role: "admin" };
  const { getByTestId } = await open();

  await fireEvent.click(getByTestId("palette-suspend"));

  expect(goto).toHaveBeenCalledWith("/admin/grants");
});
