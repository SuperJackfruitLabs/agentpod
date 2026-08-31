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
 *  - Ruling 6: an unassigned station offers a way to put an EXISTING agent
 *    in it, and driving that control actually leaves the station occupied
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import * as grantsApi from "$lib/api/grants";
import * as agentsApi from "$lib/api/agents";
import { setSearchParam, resetReactivePageState } from "../../mocks/reactive-page-state.svelte";

// bits-ui's Select opens on `pointerdown` (not `click`) and picks an item on
// `pointerup`, and touches `hasPointerCapture`/`releasePointerCapture` along
// the way — jsdom implements neither. Needed once the "assign an existing
// agent" dialog's picker is actually opened, below.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "mouse";
    }
  }
  // @ts-expect-error jsdom has no native PointerEvent
  window.PointerEvent = PointerEventPolyfill;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}

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
  vi.spyOn(grantsApi, "listPrincipals").mockResolvedValue([]);
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

test("a suspended agent's station reads as not dispatchable, and says why — not merely healthy", async () => {
  vi.spyOn(api, "getFleet").mockResolvedValue({ stats: mockStats, agents: mockAgents });
  vi.spyOn(api, "listStations").mockResolvedValue([
    stationRow({ id: "s1", stationKey: "hermes:hanuman", principalId: "prn_active" }),
    stationRow({ id: "s2", stationKey: "hermes:kubera", principalId: "prn_suspended" }),
  ]);
  vi.spyOn(grantsApi, "listPrincipals").mockResolvedValue([
    { id: "prn_active", kind: "agent", handle: "hanuman", displayName: null, userId: null, suspendedAt: null },
    {
      id: "prn_suspended",
      kind: "agent",
      handle: "kubera-agent",
      displayName: null,
      userId: null,
      suspendedAt: "2026-08-30T00:00:00Z",
    },
  ]);

  const { getByTestId, queryByTestId } = render(AgentsPage);

  await waitFor(() => {
    // A principalId being present is not enough — kubera's row would have
    // read as "assigned" (i.e. healthy) under the old, principalId-only check.
    const panel = getByTestId("unassigned-stations");
    expect(panel.textContent).toMatch(/suspended/i);
    expect(panel.textContent).toContain("kubera-agent");
  });
  // hanuman's agent is active — it must not appear as blocked.
  expect(queryByTestId("all-assigned")).toBeNull();
});

test("unassigning a suspended station's agent asks first, calls the endpoint, then reloads", async () => {
  vi.spyOn(api, "getFleet").mockResolvedValue({ stats: mockStats, agents: mockAgents });
  const listStationsSpy = vi.spyOn(api, "listStations").mockResolvedValue([
    stationRow({ id: "s1", stationKey: "hermes:hanuman", principalId: "prn_active" }),
    stationRow({ id: "s2", stationKey: "hermes:kubera", principalId: "prn_suspended" }),
  ]);
  vi.spyOn(grantsApi, "listPrincipals").mockResolvedValue([
    { id: "prn_active", kind: "agent", handle: "hanuman", displayName: null, userId: null, suspendedAt: null },
    {
      id: "prn_suspended",
      kind: "agent",
      handle: "kubera-agent",
      displayName: null,
      userId: null,
      suspendedAt: "2026-08-30T00:00:00Z",
    },
  ]);
  vi.spyOn(agentsApi, "unassignStationAgent").mockResolvedValue({ stationId: "s2", principalId: null });

  const { findByRole, getByRole } = render(AgentsPage);

  await fireEvent.click(await findByRole("button", { name: /unassign kubera/i }));
  await fireEvent.click(getByRole("button", { name: /^unassign$/i }));

  await waitFor(() => expect(agentsApi.unassignStationAgent).toHaveBeenCalledWith("s2"));
  // Reloaded rather than patched locally — same convention as the grants page.
  await waitFor(() => expect(listStationsSpy).toHaveBeenCalledTimes(2));
});

test("an actively-assigned station offers a real Unassign control — not SQL", async () => {
  vi.spyOn(api, "getFleet").mockResolvedValue({ stats: mockStats, agents: mockAgents });
  vi.spyOn(api, "listStations").mockResolvedValue([
    stationRow({ id: "s1", stationKey: "hermes:hanuman", principalId: "prn_a" }),
    stationRow({ id: "s2", stationKey: "hermes:kubera", principalId: "prn_b" }),
  ]);
  vi.spyOn(grantsApi, "listPrincipals").mockResolvedValue([
    { id: "prn_a", kind: "agent", handle: "hanuman", displayName: null, userId: null, suspendedAt: null },
    { id: "prn_b", kind: "agent", handle: "kubera", displayName: null, userId: null, suspendedAt: null },
  ]);
  vi.spyOn(agentsApi, "unassignStationAgent").mockResolvedValue({ stationId: "s1", principalId: null });

  const { findByRole, getByRole, getByTestId } = render(AgentsPage);

  await waitFor(() => expect(getByTestId("assigned-stations")).toBeTruthy());

  await fireEvent.click(await findByRole("button", { name: /unassign hanuman/i }));
  await fireEvent.click(getByRole("button", { name: /^unassign$/i }));

  await waitFor(() => expect(agentsApi.unassignStationAgent).toHaveBeenCalledWith("s1"));
});

test("Ruling 6: assigning an existing agent to an unassigned station leaves it occupied", async () => {
  // Task 3 wired `unassignStationAgent`; `assignStationAgent`'s only caller
  // was AgentCreate's mint-and-assign flow. This is the way back for a
  // principal that already exists — most pointedly, one this same page just
  // unassigned above — with no database client required.
  vi.spyOn(api, "getFleet").mockResolvedValue({ stats: mockStats, agents: mockAgents });
  const rows = [
    stationRow({ id: "s1", stationKey: "hermes:hanuman", displayName: "hanuman", principalId: "prn_a" }),
    stationRow({ id: "s2", stationKey: "hermes:kubera", displayName: "kubera", principalId: null }),
  ];
  const listStationsSpy = vi.spyOn(api, "listStations").mockImplementation(async () => rows.map((r) => ({ ...r })));
  vi.spyOn(grantsApi, "listPrincipals").mockResolvedValue([
    { id: "prn_a", kind: "agent", handle: "hanuman", displayName: null, userId: null, suspendedAt: null },
    { id: "prn_stranded", kind: "agent", handle: "stranded-writer", displayName: null, userId: null, suspendedAt: null },
  ]);
  vi.spyOn(agentsApi, "assignStationAgent").mockImplementation(async (stationId, principalId) => {
    // What the hub actually does: the NEXT read reflects the write.
    rows.find((r) => r.id === stationId)!.principalId = principalId;
    return { stationId, principalId };
  });

  const { findByRole, getByRole, getByTestId } = render(AgentsPage);

  await waitFor(() => expect(getByTestId("unassigned-stations")).toBeTruthy());

  await fireEvent.click(await findByRole("button", { name: /assign an existing agent to kubera/i }));
  const trigger = await findByRole("button", { name: /^agent to assign$/i });
  await fireEvent.pointerDown(trigger, { pointerId: 1, button: 0, pointerType: "mouse" });
  const option = await waitFor(() => getByRole("option", { name: /stranded-writer/i }));
  await fireEvent.pointerUp(option, { pointerId: 1, button: 0, pointerType: "mouse" });
  await fireEvent.click(getByRole("button", { name: /^assign$/i }));

  await waitFor(() => {
    expect(agentsApi.assignStationAgent).toHaveBeenCalledWith("s2", "prn_stranded");
  });
  // Reloaded rather than patched locally, and the station now reads as
  // occupied — proving the control actually worked, not merely that the
  // endpoint was invoked.
  await waitFor(() => {
    expect(listStationsSpy).toHaveBeenCalledTimes(2);
    expect(getByTestId("all-assigned")).toBeTruthy();
  });
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
