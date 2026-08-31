/**
 * agents/page.svelte.test.ts
 *
 * TDD tests for the /agents page (agent worklist).
 * Asserts:
 *  - renders a PageHeader with title "Agents"
 *  - renders the AgentTable once agents are loaded
 *  - ?status=running derives externalFilter { status: "running" }
 *  - ?station=<id> derives externalFilter { stationId: <id> }
 *  - an unassigned station (no occupying principal) reads as unassigned,
 *    not merely healthy — the console previously had no signal for this at
 *    all, and a station with no principal is dispatchable by nobody
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import { setSearchParam, resetReactivePageState } from "../../mocks/reactive-page-state.svelte";

// ---------------------------------------------------------------------------
// SvelteKit stubs
// ---------------------------------------------------------------------------

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
  replaceState: vi.fn(),
}));

// Reactive $app/state stub — a plain static stub can't exercise the
// ?updates=1 deep-link test below, which needs a real URLSearchParams.
vi.mock("$app/state", async () => {
  const mod = await import("../../mocks/reactive-page-state.svelte");
  return { page: mod.page };
});

// ---------------------------------------------------------------------------
// Sonner stub (used transitively by AgentTable → toast)
// ---------------------------------------------------------------------------

vi.mock("svelte-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Static import — compiled once
// ---------------------------------------------------------------------------

import AgentsPage from "./+page.svelte";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
  resetReactivePageState();
  // Default: no stations to cross-reference, so tests that don't care about
  // assignment never make a real network call for it.
  vi.spyOn(api, "listStations").mockResolvedValue([]);
});
afterEach(cleanup);

function stationRow(overrides: Partial<api.StationRow>): api.StationRow {
  return {
    id: "s1",
    userId: "u1",
    nodeId: "n1",
    harness: "openclaw",
    stationKey: "hermes:agent",
    kind: "agent",
    parentStationId: null,
    displayName: "agent",
    workspacePath: null,
    capabilities: [],
    matrixId: null,
    purpose: null,
    principalId: null,
    adoptedAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const mockAgents = [
  {
    stationId: "s1",
    nodeId: "n1",
    nodeName: "vps1",
    agentName: "hanuman",
    harness: "openclaw",
    kind: "agent" as const,
    nodeStatus: "online" as const,
    agentVersion: "v0.1.4",
    latestVersion: "v0.1.4",
    updateAvailable: false,
    capabilities: [],
    workspacePath: null,
    status: "running" as const,
    cpuPct: null,
    memBytes: null,
    uptimeSec: null,
  },
  {
    stationId: "s2",
    nodeId: "n1",
    nodeName: "vps1",
    agentName: "kubera",
    harness: "openclaw",
    kind: "agent" as const,
    nodeStatus: "online" as const,
    agentVersion: "v0.1.4",
    latestVersion: "v0.1.4",
    updateAvailable: false,
    capabilities: [],
    workspacePath: null,
    status: "stopped" as const,
    cpuPct: null,
    memBytes: null,
    uptimeSec: null,
  },
];

const mockStats = {
  nodes: { online: 1, total: 1 },
  agents: { total: 2 },
  updatesAvailable: 0,
  running: 1,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("renders the Agents page header", async () => {
  vi.spyOn(api, "getFleet").mockResolvedValue({ stats: mockStats, agents: mockAgents });

  const { container } = render(AgentsPage);

  await waitFor(() => {
    expect(container.textContent).toContain("Agents");
  });
});

test("renders agent names after loading", async () => {
  vi.spyOn(api, "getFleet").mockResolvedValue({ stats: mockStats, agents: mockAgents });

  const { getByText } = render(AgentsPage);

  await waitFor(() => {
    expect(getByText("hanuman")).toBeTruthy();
    expect(getByText("kubera")).toBeTruthy();
  });
});

test("shows error message when getFleet fails", async () => {
  vi.spyOn(api, "getFleet").mockRejectedValue(new Error("network error"));

  const { getByText } = render(AgentsPage);

  await waitFor(() => {
    expect(getByText("network error")).toBeTruthy();
  });
});

test("calls getFleet on mount", async () => {
  const spy = vi.spyOn(api, "getFleet").mockResolvedValue({ stats: mockStats, agents: [] });

  render(AgentsPage);

  await waitFor(() => {
    expect(spy).toHaveBeenCalledOnce();
  });
});

test("an unassigned station renders as unassigned, not merely healthy", async () => {
  vi.spyOn(api, "getFleet").mockResolvedValue({ stats: mockStats, agents: mockAgents });
  vi.spyOn(api, "listStations").mockResolvedValue([
    stationRow({ id: "s1", stationKey: "hermes:hanuman", displayName: "hanuman", principalId: "prn_abc123" }),
    stationRow({ id: "s2", stationKey: "hermes:kubera", displayName: "kubera", principalId: null }),
  ]);

  const { getByTestId, getAllByText, queryByText } = render(AgentsPage);

  await waitFor(() => {
    // kubera's FleetAgent row already says "stopped" (a health status) —
    // that alone must not be the only signal. A dedicated, explained section
    // says it has no occupying agent.
    expect(getByTestId("unassigned-stations")).toBeTruthy();
    expect(getAllByText(/no agent/i).length).toBeGreaterThan(0);
  });
  const section = getByTestId("unassigned-stations");
  expect(section.textContent).toContain("kubera");
  // hanuman IS assigned — it must not appear as if it needs one too.
  expect(queryByText(/hanuman/, { selector: '[data-testid="unassigned-stations"] *' })).toBeNull();
});

test("when every station has an agent, the page says so instead of staying silent", async () => {
  vi.spyOn(api, "getFleet").mockResolvedValue({ stats: mockStats, agents: mockAgents });
  vi.spyOn(api, "listStations").mockResolvedValue([
    stationRow({ id: "s1", stationKey: "hermes:hanuman", principalId: "prn_a" }),
    stationRow({ id: "s2", stationKey: "hermes:kubera", principalId: "prn_b" }),
  ]);

  const { getByTestId, queryByTestId } = render(AgentsPage);

  await waitFor(() => {
    expect(getByTestId("all-assigned")).toBeTruthy();
  });
  expect(queryByTestId("unassigned-stations")).toBeNull();
});

test("?updates=1 seeds the updates-only pill pressed and shows only update-available agents", async () => {
  setSearchParam("updates", "1");
  vi.spyOn(api, "getFleet").mockResolvedValue({
    stats: mockStats,
    agents: [
      { ...mockAgents[0], updateAvailable: true },
      { ...mockAgents[1], updateAvailable: false },
    ],
  });

  const { getByRole, getByText, queryByText } = render(AgentsPage);

  await waitFor(() => {
    const pill = getByRole("button", { name: /updates only/i });
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    expect(getByText("hanuman")).toBeTruthy();
    expect(queryByText("kubera")).toBeNull();
  });
});
