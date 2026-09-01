/**
 * RosterRail.svelte.test.ts
 *
 * The rail is the console's navigation, so these tests are mostly about
 * "does clicking/typing/pressing get me to the right station" rather than
 * about looks. Two of them (the `relative` row and the h-[34px] grid) pin
 * classes instead, because vitest.config.ts strips <style> and sets
 * css:false — computed styles are not available here, and the `relative`
 * one guards a real layout bug (see the comment on that test).
 */
import { test, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import type { FleetAgent } from "@agentpod/contract";

const { mockFleet, mockPage, goto } = vi.hoisted(() => ({
  mockFleet: { agents: [] as unknown[], nodes: [] as unknown[], runtimes: [] as unknown[] },
  mockPage: { url: { pathname: "/" } },
  goto: vi.fn(),
}));

vi.mock("$lib/stores/fleet.svelte", () => ({ fleet: mockFleet }));
vi.mock("$app/state", () => ({ page: mockPage }));
vi.mock("$app/navigation", () => ({ goto }));

import RosterRail from "./RosterRail.svelte";

/** Only the fields the rail actually reads; the rest of FleetAgent is filler. */
function agent(partial: Partial<FleetAgent> & Pick<FleetAgent, "stationId" | "nodeId" | "nodeName" | "agentName">): FleetAgent {
  return {
    harness: "claude-code",
    kind: "station",
    nodeStatus: "online",
    agentVersion: "1.4.0",
    latestVersion: "1.4.0",
    updateAvailable: false,
    capabilities: [],
    workspacePath: "/srv/work",
    status: "running",
    cpuPct: 1,
    memBytes: 1,
    uptimeSec: 1,
    ...partial,
  } as FleetAgent;
}

// Five agents on two nodes, as the brief's step 1 specifies.
const AGENTS: FleetAgent[] = [
  agent({ stationId: "st_atlas", nodeId: "n_orion", nodeName: "orion", agentName: "atlas", status: "error" }),
  agent({ stationId: "st_h1", nodeId: "n_orion", nodeName: "orion", agentName: "hermes-1", harness: "codex" }),
  agent({ stationId: "st_h2", nodeId: "n_orion", nodeName: "orion", agentName: "hermes-2", status: "stopped" }),
  agent({
    stationId: "st_boreas",
    nodeId: "n_vega",
    nodeName: "vega",
    agentName: "boreas",
    status: "unknown",
    workspacePath: null,
  }),
  agent({ stationId: "st_zephyr", nodeId: "n_vega", nodeName: "vega", agentName: "zephyr" }),
];

const NODES = [
  { id: "n_orion", name: "orion", status: "online", lastSeenAt: new Date().toISOString(), purpose: "release engineering" },
  { id: "n_vega", name: "vega", status: "offline", lastSeenAt: null, purpose: null },
];

const RUNTIMES = [{ id: "rt_1" }, { id: "rt_2" }, { id: "rt_3" }];

beforeEach(() => {
  mockFleet.agents = AGENTS;
  mockFleet.nodes = NODES;
  mockFleet.runtimes = RUNTIMES;
  mockPage.url = { pathname: "/" };
  goto.mockClear();
});

// --- grouping ---------------------------------------------------------------

test("groups by node: one sticky header per node, one row per agent", () => {
  const { getAllByTestId } = render(RosterRail);

  const headers = getAllByTestId("roster-group");
  expect(headers.map((h) => h.textContent)).toEqual([
    expect.stringContaining("orion"),
    expect.stringContaining("vega"),
  ]);
  expect(headers[0].className).toContain("sticky");
  expect(getAllByTestId("roster-row")).toHaveLength(5);
});

test("the grouping button cycles by node → by state → by name and regroups", async () => {
  const { getByTestId, getAllByTestId } = render(RosterRail);
  const button = getByTestId("roster-grouping");

  expect(button.textContent).toContain("by node");

  await fireEvent.click(button);
  expect(button.textContent).toContain("by state");
  // Worst-first, and only the states actually present.
  expect(getAllByTestId("roster-group").map((h) => h.textContent?.trim().split(/\s+/)[0])).toEqual([
    "Error",
    "Unknown",
    "Running",
    "Stopped",
  ]);

  await fireEvent.click(button);
  expect(button.textContent).toContain("by name");
  expect(getAllByTestId("roster-group").map((h) => h.textContent?.trim().split(/\s+/)[0])).toEqual([
    "A",
    "B",
    "H",
    "Z",
  ]);

  await fireEvent.click(button);
  expect(button.textContent).toContain("by node");
});

// --- filtering --------------------------------------------------------------

test("filtering by handle narrows to the matching stations", async () => {
  const { getByTestId, getAllByTestId } = render(RosterRail);

  await fireEvent.input(getByTestId("roster-filter"), { target: { value: "hermes" } });

  const rows = getAllByTestId("roster-row");
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.textContent)).toEqual([
    expect.stringContaining("hermes-1"),
    expect.stringContaining("hermes-2"),
  ]);
  expect(getByTestId("roster-count").textContent).toContain("2 of 5");
});

test("the filter also matches node, harness, station key, node purpose and status", async () => {
  const { getByTestId, getAllByTestId } = render(RosterRail);
  const input = getByTestId("roster-filter");

  for (const [query, expected] of [
    ["vega", 2], // node name
    ["codex", 1], // harness
    ["st_atlas", 1], // station key
    ["release engineering", 3], // the node's purpose, inherited by its agents
    ["stopped", 1], // status word
  ] as const) {
    await fireEvent.input(input, { target: { value: query } });
    expect(getAllByTestId("roster-row"), query).toHaveLength(expected);
  }
});

test("a filter that matches nothing says so instead of showing a blank rail", async () => {
  const { getByTestId, queryAllByTestId } = render(RosterRail);

  await fireEvent.input(getByTestId("roster-filter"), { target: { value: "nobody" } });

  expect(queryAllByTestId("roster-row")).toHaveLength(0);
  expect(getByTestId("roster-empty").textContent).toContain("nobody");
});

// --- selection follows the URL ----------------------------------------------

test("a row links to its station route", () => {
  const { getAllByTestId } = render(RosterRail);

  expect(getAllByTestId("roster-row").map((r) => r.getAttribute("href"))).toEqual([
    "/nodes/n_orion/stations/st_atlas",
    "/nodes/n_orion/stations/st_h1",
    "/nodes/n_orion/stations/st_h2",
    "/nodes/n_vega/stations/st_boreas",
    "/nodes/n_vega/stations/st_zephyr",
  ]);
});

test("aria-current follows the URL, so a deep link and a click agree", () => {
  mockPage.url = { pathname: "/nodes/n_orion/stations/st_h2" };
  const { getAllByTestId } = render(RosterRail);

  const current = getAllByTestId("roster-row").filter((r) => r.getAttribute("aria-current") === "page");
  expect(current).toHaveLength(1);
  expect(current[0].textContent).toContain("hermes-2");
});

// --- the flag / last-spoke column -------------------------------------------

test("the second column carries the harness when grouped by node", () => {
  const { getAllByTestId } = render(RosterRail);

  const asides = getAllByTestId("roster-aside");
  expect(asides).toHaveLength(5);
  // Grouped by node (the default), the node name is already the group header,
  // so repeating it per row would be the noise this column exists to avoid.
  const text = asides.map((el) => el.textContent?.trim());
  expect(text).not.toContain("");
  // Two harnesses inside the one node — which is the whole reason this column
  // carries the harness here and not the node name.
  expect(text).toContain("claude-code");
  expect(text).toContain("codex");
});

test("it carries the node once grouping no longer implies it", async () => {
  const { getByTestId, getAllByTestId } = render(RosterRail);

  await fireEvent.click(getByTestId("roster-grouping")); // by node -> by state

  const asides = getAllByTestId("roster-aside");
  expect(asides.some((el) => el.textContent?.includes("orion"))).toBe(true);
});

// --- keyboard ---------------------------------------------------------------

test("j and k move the selection along the visible order", async () => {
  mockPage.url = { pathname: "/nodes/n_orion/stations/st_h1" };
  const { unmount } = render(RosterRail);

  await fireEvent.keyDown(window, { key: "j" });
  expect(goto).toHaveBeenCalledWith("/nodes/n_orion/stations/st_h2");

  await fireEvent.keyDown(window, { key: "k" });
  expect(goto).toHaveBeenLastCalledWith("/nodes/n_orion/stations/st_atlas");
  unmount();
});

test("with nothing selected, j picks the first row and k the last", async () => {
  const { unmount } = render(RosterRail);

  await fireEvent.keyDown(window, { key: "j" });
  expect(goto).toHaveBeenLastCalledWith("/nodes/n_orion/stations/st_atlas");

  await fireEvent.keyDown(window, { key: "k" });
  expect(goto).toHaveBeenLastCalledWith("/nodes/n_vega/stations/st_zephyr");
  unmount();
});

test("Escape clears the selection", async () => {
  mockPage.url = { pathname: "/nodes/n_orion/stations/st_h1" };
  const { unmount } = render(RosterRail);

  await fireEvent.keyDown(window, { key: "Escape" });
  expect(goto).toHaveBeenCalledWith("/");
  unmount();
});

test("typing j in the filter box types a j — it does not navigate the roster", async () => {
  const { getByTestId, unmount } = render(RosterRail);

  await fireEvent.keyDown(getByTestId("roster-filter"), { key: "j" });
  await fireEvent.keyDown(getByTestId("roster-filter"), { key: "k" });
  await fireEvent.keyDown(getByTestId("roster-filter"), { key: "Escape" });

  expect(goto).not.toHaveBeenCalled();
  unmount();
});

test("the window handler is released on destroy", async () => {
  const { unmount } = render(RosterRail);
  unmount();

  await fireEvent.keyDown(window, { key: "j" });
  expect(goto).not.toHaveBeenCalled();
});

// --- where they run ---------------------------------------------------------

test("Where they run links to nodes and runtimes, carrying their counts", () => {
  const { getByTestId } = render(RosterRail);

  const nodes = getByTestId("roster-nodes-link");
  expect(nodes.getAttribute("href")).toBe("/nodes");
  expect(nodes.textContent).toContain("2");

  const runtimes = getByTestId("roster-runtimes-link");
  expect(runtimes.getAttribute("href")).toBe("/runtimes");
  expect(runtimes.textContent).toContain("3");
});

// --- layout ------------------------------------------------------------------

test("a row is a 34px four-track grid: ribbon, dot, handle, trailer", () => {
  const { getAllByTestId } = render(RosterRail);
  const row = getAllByTestId("roster-row")[0];

  expect(row.className).toContain("h-[34px]");
  expect(row.className).toContain("grid-cols-[3px_12px_1fr_auto]");
  // The ribbon carries the state colour, which is what makes the rail's left
  // edge readable as a vertical barcode of fleet health.
  expect(getAllByTestId("roster-ribbon")[0].className).toContain("bg-status-error");
});

test("every row is `relative`, or StateDot's sr-only label widens the document", () => {
  // Not styling. StateDot's label is position:absolute; with no positioned
  // ancestor its containing block is the initial one, so it is not clipped by
  // any overflow:hidden above it and it adds its static x-position to the
  // DOCUMENT's scroll width. This cost task 6 a 328px-wide document with a
  // full attention lane; the rail holds 100s of these dots.
  const { getAllByTestId } = render(RosterRail);

  for (const row of getAllByTestId("roster-row")) {
    expect(row.classList.contains("relative")).toBe(true);
  }
});

test("the rail scrolls its list internally and never widens the document", () => {
  const { getByTestId } = render(RosterRail);

  expect(getByTestId("roster-list").className).toContain("overflow-y-auto");
  expect(getByTestId("roster-list").className).toContain("min-h-0");
  expect(getByTestId("roster").className).toContain("min-w-0");
  expect(getByTestId("roster").className).toContain("overflow-hidden");
});
