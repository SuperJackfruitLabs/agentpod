/**
 * page.svelte.test.ts
 *
 * TDD tests for the node detail page (/nodes/[id]).
 * RED → implement +page.svelte (PageHeader, $app/state, Empty, HarnessBadge) → GREEN.
 *
 * Asserts:
 *  - renders hostname + status badge
 *  - detected station card's Adopt button calls adopt(id, [key])
 *  - "Add all agents" calls adopt(id, allUnadoptedKeys)
 *  - detected-empty state renders "No stations detected"
 *  - adopted-empty state renders the added-empty state
 *  - StationTree renders adopted stations (presence via station name)
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import type { DetectedStation } from "@agentpod/contract";
import type { StationRow } from "$lib/api/client";

// ---------------------------------------------------------------------------
// SvelteKit stubs
// ---------------------------------------------------------------------------

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
}));

vi.mock("$app/state", () => ({
  page: {
    params: { id: "node_1" },
    url: { pathname: "/nodes/node_1" },
  },
}));

vi.mock("svelte-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Static import — compiled once after all mocks are registered
// ---------------------------------------------------------------------------

import NodeDetailPage from "./+page.svelte";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockNode = {
  id: "node_1",
  name: "hermes-01",
  hostname: "hermes-01",
  os: "linux",
  arch: "x64",
  cpuCount: 4,
  status: "online" as const,
  lastSeenAt: null,
  createdAt: "2026-06-22T00:00:00Z",
  agentVersion: "v0.1.9",
  latestVersion: "v0.1.9",
  updateAvailable: false,
  provisioned: null,
};

const detectedStation: DetectedStation = {
  key: "claude://workspace",
  harness: "claude",
  kind: "composite",
  displayName: "Workspace",
  parentKey: null,
  workspacePath: "/home/user/workspace",
  capabilities: ["health"],
  adopted: false,
};

const secondDetectedStation: DetectedStation = {
  key: "openclaw://workspace2",
  harness: "openclaw",
  kind: "composite",
  displayName: "Workspace 2",
  parentKey: null,
  workspacePath: "/home/user/workspace2",
  capabilities: ["health"],
  adopted: false,
};

const adoptedStation: StationRow = {
  id: "station_1",
  userId: "user_1",
  nodeId: "node_1",
  harness: "claude",
  stationKey: "claude://workspace",
  kind: "composite",
  parentStationId: null,
  displayName: "Workspace",
  workspacePath: "/home/user/workspace",
  capabilities: ["health"],
  matrixId: null, purpose: null,
  adoptedAt: "2026-06-22T00:00:00Z",
  createdAt: "2026-06-22T00:00:00Z",
};

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

test("renders hostname and status badge", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([mockNode]);
  vi.spyOn(api, "listDetected").mockResolvedValue([]);
  vi.spyOn(api, "listStations").mockResolvedValue([]);

  const { getByText, getByRole } = render(NodeDetailPage);

  await waitFor(() => {
    expect(getByRole("heading", { name: "hermes-01" })).toBeTruthy();
    expect(getByText("online")).toBeTruthy();
  });
});

test("detected station card's Adopt button calls adopt(id, [key])", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([mockNode]);
  vi.spyOn(api, "listDetected").mockResolvedValue([detectedStation]);
  vi.spyOn(api, "listStations").mockResolvedValue([]);
  const adoptSpy = vi.spyOn(api, "adoptStations").mockResolvedValue([adoptedStation]);

  const { getByText } = render(NodeDetailPage);

  await waitFor(() => {
    expect(getByText("Workspace")).toBeTruthy();
    expect((getByText("Add agent") as HTMLButtonElement).disabled).toBe(false);
  });
  getByText("Add agent").click();

  await waitFor(() => {
    expect(adoptSpy).toHaveBeenCalledWith("node_1", ["claude://workspace"]);
  });
});

test("Adopt all calls adopt(id, allUnadoptedKeys)", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([mockNode]);
  vi.spyOn(api, "listDetected").mockResolvedValue([detectedStation, secondDetectedStation]);
  vi.spyOn(api, "listStations").mockResolvedValue([]);
  const adoptSpy = vi.spyOn(api, "adoptStations").mockResolvedValue([adoptedStation]);

  const { getByText } = render(NodeDetailPage);

  // The stations store toggles a single shared `isLoading` flag across its
  // concurrent loadDetected/loadAdopted calls, so the "Add all agents" button can
  // briefly render present-but-disabled before both loaders settle. Wait for
  // it to be enabled (not merely present) before clicking.
  await waitFor(() => {
    const btn = getByText("Add all agents") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
  getByText("Add all agents").click();

  await waitFor(() => {
    expect(adoptSpy).toHaveBeenCalledWith("node_1", [
      "claude://workspace",
      "openclaw://workspace2",
    ]);
  });
});

test("shows detected-empty state", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([mockNode]);
  vi.spyOn(api, "listDetected").mockResolvedValue([]);
  vi.spyOn(api, "listStations").mockResolvedValue([]);

  const { getByText } = render(NodeDetailPage);

  await waitFor(() => {
    expect(getByText("No agents found on this node")).toBeTruthy();
  });
});

test("shows adopted-empty state", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([mockNode]);
  vi.spyOn(api, "listDetected").mockResolvedValue([]);
  vi.spyOn(api, "listStations").mockResolvedValue([]);

  const { getByText } = render(NodeDetailPage);

  await waitFor(() => {
    expect(getByText("No agents added yet")).toBeTruthy();
  });
});

test("StationTree renders adopted stations", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([mockNode]);
  vi.spyOn(api, "listDetected").mockResolvedValue([]);
  vi.spyOn(api, "listStations").mockResolvedValue([adoptedStation]);

  const { getByText } = render(NodeDetailPage);

  await waitFor(() => {
    expect(getByText("Workspace")).toBeTruthy();
  });
});
