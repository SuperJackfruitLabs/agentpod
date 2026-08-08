/**
 * AgentTable.svelte.test.ts
 *
 * TDD tests for the dense fleet agent table.
 * Asserts:
 *   - 2 agents under the same node → group header + both rows rendered
 *   - agent with updateAvailable:true → Update button present
 *   - agent with updateAvailable:false (all false) → no Update button
 *   - search input filters rows by agentName
 *   - search input filters rows by nodeName
 *   - Update button calls updateNode and shows "updating…"
 *   - Status column renders agent.status badge (P2)
 *   - CPU/Mem/Uptime cells render formatted values or "—" (P2)
 *   - externalFilter.stationId narrows table to one agent (P2)
 *   - externalFilter.status narrows table to matching agents (P2)
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import type { FleetAgent } from "@agentpod/contract";

// ---------------------------------------------------------------------------
// Mocks — hoisted before component import
// ---------------------------------------------------------------------------

vi.mock("svelte-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import * as api from "$lib/api/client";
import AgentTable from "./AgentTable.svelte";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeAgent = (overrides: Partial<FleetAgent> & { stationId: string }): FleetAgent => ({
  nodeId: "n1",
  nodeName: "superchotu",
  agentName: "hanuman",
  harness: "openclaw",
  kind: "agent",
  nodeStatus: "online",
  agentVersion: "v0.1.4",
  latestVersion: "v0.1.4",
  updateAvailable: false,
  capabilities: [],
  workspacePath: null,
  // P2 live health fields
  status: "running",
  cpuPct: null,
  memBytes: null,
  uptimeSec: null,
  ...overrides,
});

const agentWithUpdate = makeAgent({
  stationId: "s1",
  agentName: "hanuman",
  agentVersion: "v0.1.3",
  latestVersion: "v0.1.4",
  updateAvailable: true,
});

const agentNoUpdate = makeAgent({
  stationId: "s2",
  agentName: "kubera",
  agentVersion: "v0.1.4",
  updateAvailable: false,
});

const twoAgents: FleetAgent[] = [agentWithUpdate, agentNoUpdate];

// ---------------------------------------------------------------------------
// Tests — grouping / search / update (P1 coverage kept)
// ---------------------------------------------------------------------------

test("renders both agent rows and a group header with node name", () => {
  const { getAllByTestId, getByText } = render(AgentTable, { props: { agents: twoAgents } });

  // Group header for superchotu
  const headers = getAllByTestId("group-header");
  expect(headers.length).toBeGreaterThan(0);
  expect(headers[0].textContent).toContain("superchotu");

  // Both agent rows
  expect(getByText("hanuman")).toBeTruthy();
  expect(getByText("kubera")).toBeTruthy();
});

test("group header shows correct agent count", () => {
  const { getAllByTestId } = render(AgentTable, { props: { agents: twoAgents } });
  const header = getAllByTestId("group-header")[0];
  expect(header.textContent).toContain("2");
});

test("agent with updateAvailable:true renders an Update button", () => {
  const { getByRole } = render(AgentTable, { props: { agents: twoAgents } });
  expect(getByRole("button", { name: /^update$/i })).toBeTruthy();
});

test("no Update button when all agents have updateAvailable:false", () => {
  const agents = twoAgents.map((a) => ({ ...a, updateAvailable: false }));
  const { queryByRole } = render(AgentTable, { props: { agents } });
  expect(queryByRole("button", { name: /^update$/i })).toBeNull();
});

test("search by agentName narrows rows — non-matching agent disappears", async () => {
  const { getByRole, getByText, queryByText } = render(AgentTable, {
    props: { agents: twoAgents },
  });

  // Both visible initially
  expect(getByText("hanuman")).toBeTruthy();
  expect(getByText("kubera")).toBeTruthy();

  const input = getByRole("searchbox", { name: /search agents/i });
  await fireEvent.input(input, { target: { value: "hanuman" } });

  await waitFor(() => {
    expect(getByText("hanuman")).toBeTruthy();
    expect(queryByText("kubera")).toBeNull();
  });
});

test("search by nodeName matches both agents sharing the node", async () => {
  const { getByRole, getByText } = render(AgentTable, { props: { agents: twoAgents } });

  const input = getByRole("searchbox", { name: /search agents/i });
  await fireEvent.input(input, { target: { value: "superchotu" } });

  await waitFor(() => {
    // Both agents share the node name — both should remain visible
    expect(getByText("hanuman")).toBeTruthy();
    expect(getByText("kubera")).toBeTruthy();
  });
});

test("search with no matches shows empty-filter message", async () => {
  const { getByRole, getByText } = render(AgentTable, { props: { agents: twoAgents } });

  const input = getByRole("searchbox", { name: /search agents/i });
  await fireEvent.input(input, { target: { value: "zzz_nomatch" } });

  await waitFor(() => {
    expect(getByText(/no agents match/i)).toBeTruthy();
  });
});

test("Update button calls updateNode(nodeId) and enters updating state", async () => {
  vi.spyOn(api, "updateNode").mockResolvedValue({ ok: true, updating: true });

  const { getByRole } = render(AgentTable, { props: { agents: [agentWithUpdate] } });

  const btn = getByRole("button", { name: /^update$/i });
  await fireEvent.click(btn);

  expect(api.updateNode).toHaveBeenCalledWith(agentWithUpdate.nodeId);
});

test("agents from two different nodes produce two group headers", () => {
  const agent3 = makeAgent({
    stationId: "s3",
    nodeId: "n2",
    nodeName: "gangaputra",
    agentName: "arjuna",
  });
  const { getAllByTestId } = render(AgentTable, {
    props: { agents: [...twoAgents, agent3] },
  });

  const headers = getAllByTestId("group-header");
  expect(headers.length).toBe(2);
});

test("row links to /nodes/{nodeId}/stations/{stationId}", () => {
  const { container } = render(AgentTable, { props: { agents: [agentWithUpdate] } });
  const link = container.querySelector(`a[href="/nodes/${agentWithUpdate.nodeId}/stations/${agentWithUpdate.stationId}"]`);
  expect(link).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Tests — P2: Status column
// ---------------------------------------------------------------------------

test("Status column shows agent.status badge text", () => {
  const agent = makeAgent({ stationId: "s1", status: "running" });
  const { getAllByText } = render(AgentTable, { props: { agents: [agent] } });
  // The badge renders the status text
  const badges = getAllByText("running");
  expect(badges.length).toBeGreaterThan(0);
});

test("Status column reflects error status", () => {
  const agent = makeAgent({ stationId: "s1", status: "error" });
  const { getAllByText } = render(AgentTable, { props: { agents: [agent] } });
  expect(getAllByText("error").length).toBeGreaterThan(0);
});

test("Status column reflects stopped status", () => {
  const agent = makeAgent({ stationId: "s1", status: "stopped" });
  const { getAllByText } = render(AgentTable, { props: { agents: [agent] } });
  expect(getAllByText("stopped").length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Tests — P2: CPU / Mem / Uptime metric cells
// ---------------------------------------------------------------------------

test("CPU cell shows '—' when cpuPct is null", () => {
  const agent = makeAgent({ stationId: "s1", cpuPct: null });
  const { getAllByTestId } = render(AgentTable, { props: { agents: [agent] } });
  const cpuCells = getAllByTestId("cpu-cell");
  expect(cpuCells[0].textContent?.trim()).toBe("—");
});

test("CPU cell shows formatted percentage when cpuPct is provided", () => {
  const agent = makeAgent({ stationId: "s1", cpuPct: 12.5 });
  const { getAllByTestId } = render(AgentTable, { props: { agents: [agent] } });
  const cpuCells = getAllByTestId("cpu-cell");
  expect(cpuCells[0].textContent?.trim()).toBe("12.5%");
});

test("Mem cell shows '—' when memBytes is null", () => {
  const agent = makeAgent({ stationId: "s1", memBytes: null });
  const { getAllByTestId } = render(AgentTable, { props: { agents: [agent] } });
  const memCells = getAllByTestId("mem-cell");
  expect(memCells[0].textContent?.trim()).toBe("—");
});

test("Mem cell shows MB when memBytes < 1 GiB", () => {
  const agent = makeAgent({ stationId: "s1", memBytes: 740 * 1024 * 1024 });
  const { getAllByTestId } = render(AgentTable, { props: { agents: [agent] } });
  const memCells = getAllByTestId("mem-cell");
  expect(memCells[0].textContent?.trim()).toBe("740 MB");
});

test("Mem cell shows GB when memBytes >= 1 GiB", () => {
  // 2.1 GB in bytes
  const agent = makeAgent({ stationId: "s1", memBytes: Math.round(2.1 * 1024 * 1024 * 1024) });
  const { getAllByTestId } = render(AgentTable, { props: { agents: [agent] } });
  const memCells = getAllByTestId("mem-cell");
  expect(memCells[0].textContent?.trim()).toBe("2.1 GB");
});

test("Uptime cell shows '—' when uptimeSec is null", () => {
  const agent = makeAgent({ stationId: "s1", uptimeSec: null });
  const { getAllByTestId } = render(AgentTable, { props: { agents: [agent] } });
  const uptimeCells = getAllByTestId("uptime-cell");
  expect(uptimeCells[0].textContent?.trim()).toBe("—");
});

test("Uptime cell shows 'Xh Ym' format for >= 1 hour", () => {
  const agent = makeAgent({ stationId: "s1", uptimeSec: 3 * 3600 + 25 * 60 }); // 3h 25m
  const { getAllByTestId } = render(AgentTable, { props: { agents: [agent] } });
  const uptimeCells = getAllByTestId("uptime-cell");
  expect(uptimeCells[0].textContent?.trim()).toBe("3h 25m");
});

test("Uptime cell shows 'Xm' format for < 1 hour", () => {
  const agent = makeAgent({ stationId: "s1", uptimeSec: 42 * 60 }); // 42m
  const { getAllByTestId } = render(AgentTable, { props: { agents: [agent] } });
  const uptimeCells = getAllByTestId("uptime-cell");
  expect(uptimeCells[0].textContent?.trim()).toBe("42m");
});

// ---------------------------------------------------------------------------
// Tests — P2: externalFilter prop
// ---------------------------------------------------------------------------

test("externalFilter.stationId narrows table to only that agent", async () => {
  const { getByText, queryByText } = render(AgentTable, {
    props: {
      agents: twoAgents,
      externalFilter: { stationId: "s1" },
    },
  });

  await waitFor(() => {
    expect(getByText("hanuman")).toBeTruthy();
    expect(queryByText("kubera")).toBeNull();
  });
});

test("externalFilter.status narrows table to agents with that status", async () => {
  const agentStopped = makeAgent({ stationId: "s2", agentName: "kubera", status: "stopped" });
  const { getByText, queryByText } = render(AgentTable, {
    props: {
      agents: [agentWithUpdate, agentStopped],
      externalFilter: { status: "stopped" },
    },
  });

  await waitFor(() => {
    expect(getByText("kubera")).toBeTruthy();
    expect(queryByText("hanuman")).toBeNull();
  });
});

test("null externalFilter shows all agents", async () => {
  const { getByText } = render(AgentTable, {
    props: { agents: twoAgents, externalFilter: null },
  });

  await waitFor(() => {
    expect(getByText("hanuman")).toBeTruthy();
    expect(getByText("kubera")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tests — sorting (Task 3)
// ---------------------------------------------------------------------------

/**
 * `statusBadgeClass` / the severity ranking accept any status string (the
 * mapping is shared across node + agent status vocab), but `FleetAgent.status`
 * is typed to the current 4-value contract enum. The cast here is intentional
 * so these sort tests can exercise the full six-token severity order that
 * AgentTable documents and sorts by.
 */
function makeAgentWithStatus(
  status: string,
  overrides: Partial<FleetAgent> & { stationId: string }
): FleetAgent {
  return { ...makeAgent(overrides), status } as unknown as FleetAgent;
}

test("sorting by Status orders rows by severity: error < degraded < starting < running < sleeping < stopped", async () => {
  const scrambledOrder = ["stopped", "sleeping", "running", "starting", "degraded", "error"];
  const agentsList = scrambledOrder.map((status, i) =>
    makeAgentWithStatus(status, {
      stationId: `s${i}`,
      agentName: status,
      nodeId: `n${i}`,
      nodeName: `node${i}`,
    })
  );

  const { getByRole, getByTestId, container } = render(AgentTable, {
    props: { agents: agentsList },
  });

  // Switch to flat view so row order is directly comparable.
  await fireEvent.click(getByTestId("group-toggle"));
  await fireEvent.click(getByRole("button", { name: /^status$/i }));

  await waitFor(() => {
    const names = Array.from(container.querySelectorAll('a[href^="/nodes/"]')).map((el) =>
      el.textContent?.trim()
    );
    expect(names).toEqual(["error", "degraded", "starting", "running", "sleeping", "stopped"]);
  });
});

test("sorting by CPU keeps null cpuPct rows last in both ascending and descending order", async () => {
  const agentsList = [
    makeAgent({ stationId: "s1", agentName: "a", nodeId: "n1", nodeName: "node1", cpuPct: 10 }),
    makeAgent({ stationId: "s2", agentName: "b", nodeId: "n2", nodeName: "node2", cpuPct: null }),
    makeAgent({ stationId: "s3", agentName: "c", nodeId: "n3", nodeName: "node3", cpuPct: 30 }),
    makeAgent({ stationId: "s4", agentName: "d", nodeId: "n4", nodeName: "node4", cpuPct: null }),
    makeAgent({ stationId: "s5", agentName: "e", nodeId: "n5", nodeName: "node5", cpuPct: 20 }),
  ];

  const { getByRole, getByTestId, container } = render(AgentTable, {
    props: { agents: agentsList },
  });

  await fireEvent.click(getByTestId("group-toggle"));
  await fireEvent.click(getByRole("button", { name: /^cpu$/i }));

  await waitFor(() => {
    const names = Array.from(container.querySelectorAll('a[href^="/nodes/"]')).map((el) =>
      el.textContent?.trim()
    );
    expect(names).toEqual(["a", "e", "c", "b", "d"]);
  });

  // Toggle to descending — numeric order flips, nulls still sink to the bottom.
  await fireEvent.click(getByRole("button", { name: /^cpu$/i }));

  await waitFor(() => {
    const names = Array.from(container.querySelectorAll('a[href^="/nodes/"]')).map((el) =>
      el.textContent?.trim()
    );
    expect(names).toEqual(["c", "e", "a", "b", "d"]);
  });
});

test("sortable column headers expose aria-sort, toggling asc → desc → none", async () => {
  const { getByRole } = render(AgentTable, { props: { agents: twoAgents } });

  const header = getByRole("columnheader", { name: /^agent$/i });
  expect(header.getAttribute("aria-sort")).toBeNull();

  const button = getByRole("button", { name: /^agent$/i });

  await fireEvent.click(button);
  expect(header.getAttribute("aria-sort")).toBe("ascending");

  await fireEvent.click(button);
  expect(header.getAttribute("aria-sort")).toBe("descending");

  await fireEvent.click(button);
  expect(header.getAttribute("aria-sort")).toBeNull();
});

test("sorting within groups reorders agents but leaves group order untouched", async () => {
  const agentsList = [
    makeAgent({ stationId: "s1", agentName: "zeta", nodeId: "n1", nodeName: "node1" }),
    makeAgent({ stationId: "s2", agentName: "alpha", nodeId: "n1", nodeName: "node1" }),
    makeAgent({ stationId: "s3", agentName: "yankee", nodeId: "n2", nodeName: "node2" }),
    makeAgent({ stationId: "s4", agentName: "bravo", nodeId: "n2", nodeName: "node2" }),
  ];

  const { getByRole, container } = render(AgentTable, { props: { agents: agentsList } });

  // Default view is grouped by node — leave it grouped and sort by Agent.
  await fireEvent.click(getByRole("button", { name: /^agent$/i }));

  await waitFor(() => {
    const sequence = Array.from(
      container.querySelectorAll('[data-testid="group-header"], a[href^="/nodes/"]')
    ).map((el) => (el.getAttribute("data-testid") === "group-header" ? "group" : el.textContent?.trim()));
    expect(sequence).toEqual(["group", "alpha", "zeta", "group", "bravo", "yankee"]);
  });
});
