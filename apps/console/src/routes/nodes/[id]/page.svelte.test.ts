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
import { auth } from "$lib/stores/auth.svelte";
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
  matrixId: null, bridgeMatrixId: null, matrixIdentityMode: "bridge" as const, purpose: null,
  principalId: null,
  adoptedAt: "2026-06-22T00:00:00Z",
  createdAt: "2026-06-22T00:00:00Z",
};

beforeEach(() => {
  vi.restoreAllMocks();
  // Adopting is a workspace admin's; the member test overrides this.
  vi.spyOn(auth, "isWorkspaceAdmin", "get").mockReturnValue(true);
});
afterEach(cleanup);

test("renders the node's name and says whether it is online", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([mockNode]);
  vi.spyOn(api, "listDetected").mockResolvedValue([]);
  vi.spyOn(api, "listStations").mockResolvedValue([]);

  const { getByTestId, getByRole } = render(NodeDetailPage);

  await waitFor(() => {
    expect(getByRole("heading", { name: "hermes-01" })).toBeTruthy();
    // The node's OWN word. `nodeState` shares the running token but not the
    // label — a machine is online, only a process runs.
    expect(getByTestId("node-summary").textContent).toMatch(/online/i);
  });
});

test("an offline node reads offline, never 'Error'", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([{ ...mockNode, status: "offline" as const }]);
  vi.spyOn(api, "listDetected").mockResolvedValue([]);
  vi.spyOn(api, "listStations").mockResolvedValue([]);

  const { getByTestId } = render(NodeDetailPage);

  await waitFor(() => {
    expect(getByTestId("node-summary").textContent).toMatch(/offline/i);
  });
  expect(getByTestId("node-summary").textContent).not.toMatch(/error/i);
});

test("detected agents are one table, not a grid of near-identical cards", async () => {
  // A node with a dozen detections used to be a dozen boxes whose only varying
  // content was the word "Added". The shape said "browse these"; the only
  // question actually being asked is which of them to add.
  vi.spyOn(api, "listNodes").mockResolvedValue([mockNode]);
  vi.spyOn(api, "listDetected").mockResolvedValue([detectedStation, secondDetectedStation]);
  vi.spyOn(api, "listStations").mockResolvedValue([]);

  const { getAllByTestId, getByTestId, getByText } = render(NodeDetailPage);

  await waitFor(() => expect(getAllByTestId("detected-row").length).toBe(2));
  // Wide content scrolls in its own box; the document never scrolls sideways.
  expect(getByTestId("detected-table-scroller").className).toContain("overflow-x-auto");
  // The workspace path is the long unbroken string on this row — capped, with
  // the whole thing on hover rather than lost.
  const path = getByText("/home/user/workspace");
  expect(path.className).toContain("truncate");
  expect(path.getAttribute("title")).toBe("/home/user/workspace");
});

test("an already-added agent says so instead of offering to add it twice", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([mockNode]);
  vi.spyOn(api, "listDetected").mockResolvedValue([detectedStation]);
  vi.spyOn(api, "listStations").mockResolvedValue([adoptedStation]);

  const { getByText, queryByText } = render(NodeDetailPage);

  await waitFor(() => expect(getByText("Added")).toBeTruthy());
  expect(queryByText("Register workspace")).toBeNull();
});

test("a member is told who adds agents, and offered no adopt, update, remove or purpose control", async () => {
  vi.spyOn(auth, "isWorkspaceAdmin", "get").mockReturnValue(false);
  vi.spyOn(api, "listNodes").mockResolvedValue([{ ...mockNode, agentVersion: "v0.1.2", latestVersion: "v0.1.3", updateAvailable: true }]);
  vi.spyOn(api, "listDetected").mockResolvedValue([detectedStation, secondDetectedStation]);
  vi.spyOn(api, "listStations").mockResolvedValue([]);
  const adoptSpy = vi.spyOn(api, "adoptStations");

  const { findByTestId, queryByRole, queryByText, getAllByText } = render(NodeDetailPage);

  expect((await findByTestId("adopt-member")).textContent).toBe(
    "Workspace admins can add agents. Ask an owner or admin of your workspace.",
  );
  await waitFor(() => expect(getAllByText("Not added").length).toBe(2));
  expect(queryByRole("button", { name: "Add agent" })).toBeNull();
  expect(queryByText("Register all workspaces")).toBeNull();
  expect(queryByRole("button", { name: /^update$/i })).toBeNull();
  expect(queryByRole("button", { name: /remove/i })).toBeNull();
  expect(queryByRole("textbox", { name: /purpose/i })).toBeNull();
  expect(adoptSpy).not.toHaveBeenCalled();
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
    const btn = getByText("Register all workspaces") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
  getByText("Register all workspaces").click();
  await waitFor(() => expect(getByText("Register workspaces only")).toBeTruthy());
  getByText("Register workspaces only").click();

  await waitFor(() => {
    expect(adoptSpy).toHaveBeenCalledWith("node_1", [
      "claude://workspace",
      "openclaw://workspace2",
    ]);
  });
});

test("online node with no harnesses says the node may be running as root", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([{ ...mockNode, hostname: "sun-laptop" }]);
  vi.spyOn(api, "listDetected").mockResolvedValue([]);
  vi.spyOn(api, "listStations").mockResolvedValue([]);

  const { getByText } = render(NodeDetailPage);

  await waitFor(() => {
    expect(getByText("No agent harnesses were found on sun-laptop.")).toBeTruthy();
  });
  expect(
    getByText(
      "If they're installed under your user, the node may be running as root — reinstall without sudo or with the installer's default.",
    ),
  ).toBeTruthy();
});

test("shows detected-empty state", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([{ ...mockNode, status: "offline" as const }]);
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

test("an enrolled node offers Remove node", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([mockNode]);
  vi.spyOn(api, "listDetected").mockResolvedValue([]);
  vi.spyOn(api, "listStations").mockResolvedValue([]);

  const { findByRole } = render(NodeDetailPage);

  expect(await findByRole("button", { name: /remove node/i })).toBeTruthy();
});

test("a provisioned runtime's node does not: it is destroyed with its runtime", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([
    { ...mockNode, provisioned: { runtimeId: "rt_1", provider: "docker" } },
  ]);
  vi.spyOn(api, "listDetected").mockResolvedValue([]);
  vi.spyOn(api, "listStations").mockResolvedValue([]);

  const { findByRole, queryByRole } = render(NodeDetailPage);

  await findByRole("button", { name: /destroy/i });
  expect(queryByRole("button", { name: /remove node/i })).toBeNull();
});

test("under 768px each detected agent is a card with its Add action", async () => {
  const { expectCardTable } = await import("$lib/test-utils/viewport");
  vi.spyOn(api, "listNodes").mockResolvedValue([mockNode]);
  vi.spyOn(api, "listDetected").mockResolvedValue([detectedStation, secondDetectedStation]);
  vi.spyOn(api, "listStations").mockResolvedValue([]);
  const { getAllByTestId, getByTestId } = render(NodeDetailPage);
  await waitFor(() => expect(getAllByTestId("detected-row").length).toBe(2));
  expectCardTable(getByTestId("detected-table-scroller").querySelector("table"));
});

test.each([360, 390])("at %ipx nothing on a node's page is wider than the screen", async (width) => {
  const { setViewport, expectNoOverflow } = await import("$lib/test-utils/viewport");
  const restore = setViewport(width);
  try {
    vi.spyOn(api, "listNodes").mockResolvedValue([mockNode]);
    vi.spyOn(api, "listDetected").mockResolvedValue([detectedStation, secondDetectedStation]);
    vi.spyOn(api, "listStations").mockResolvedValue([]);
    const { container, getAllByTestId } = render(NodeDetailPage);
    await waitFor(() => expect(getAllByTestId("detected-row").length).toBe(2));
    expectNoOverflow(container, width);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// A full page load under the org plane (staging, 2026-10-22): the page mounts before the session
// is re-established. It used to fire its requests with no token, show "Couldn't reach the hub",
// and never recover. Its requests now wait for auth, then load.
// ---------------------------------------------------------------------------

test("a full load before auth resolves shows no connection error and loads the stations once it does", async () => {
  const authStore = await import("$lib/stores/auth.svelte");
  authStore.clearAuthSession();
  localStorage.setItem("agentpod.apiUrl", "https://hub.test");
  authStore.setAuthApiUrl("https://hub.test");
  authStore.setPlane({ issuer: "https://accounts.test", url: "https://accounts.test", audience: "hub" });
  vi.spyOn(authStore, "getToken").mockResolvedValue("at1");
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const body = url.endsWith("/stations") ? [adoptedStation] : url.endsWith("/stations/adopt") ? [] : [mockNode];
    return new Response(JSON.stringify(body), { status: 200 });
  });

  try {
    const { queryByText, findByText } = render(NodeDetailPage);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(queryByText(/reach the hub/)).toBeNull();

    await authStore.initAuth();

    expect(await findByText("Workspace")).toBeTruthy();
    expect(queryByText(/reach the hub/)).toBeNull();
    for (const [, init] of fetchSpy.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer at1");
    }
  } finally {
    authStore.clearAuthSession();
    localStorage.clear();
  }
});

/** The hub's answer for a node it cannot reach: a 502 with a reason, CORS and all. */
async function withHub502(
  status: "online" | "offline",
  run: (r: ReturnType<typeof render>) => Promise<void>,
  answer: { status: number; body: Record<string, string> } = { status: 502, body: { error: "node offline" } },
) {
  const authStore = await import("$lib/stores/auth.svelte");
  authStore.clearAuthSession();
  localStorage.setItem("agentpod.apiUrl", "https://hub.test");
  authStore.setAuthApiUrl("https://hub.test");
  authStore.setPlane({ issuer: "https://accounts.test", url: "https://accounts.test", audience: "hub" });
  vi.spyOn(authStore, "getToken").mockResolvedValue("at1");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/detected")) {
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    }
    const body = url.endsWith("/stations") ? [] : [{ ...mockNode, status }];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    await authStore.initAuth();
    await run(render(NodeDetailPage));
  } finally {
    authStore.clearAuthSession();
    localStorage.clear();
  }
}

test("an offline node's page says the node is offline, never that the hub is unreachable", async () => {
  await withHub502("offline", async ({ findByText, queryByText, getByRole }) => {
    expect(await findByText("hermes-01 is offline. Detected agents show here when it reconnects.")).toBeTruthy();
    expect(queryByText(/reach the hub|check your connection/i)).toBeNull();
    expect(getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

test("a 502 from detect blames the node even while the list still says online", async () => {
  await withHub502("online", async ({ findByText, queryByText }) => {
    expect(await findByText("hermes-01 is offline. Detected agents show here when it reconnects.")).toBeTruthy();
    expect(queryByText(/reach the hub|check your connection/i)).toBeNull();
  });
});

// The hub stopped sending 502 (an edge replaces it with CORS-less HTML): node failures are now 503
// station_unavailable or 424 node_failed, and they must still blame the node.
for (const answer of [
  { status: 503, body: { error: "node offline", code: "station_unavailable" } },
  { status: 424, body: { error: "invalid detect response from node", code: "node_failed" } },
]) {
  test(`a ${answer.status} ${answer.body.code} from detect blames the node, never the hub`, async () => {
    await withHub502("online", async ({ findByText, queryByText }) => {
      expect(await findByText("hermes-01 is offline. Detected agents show here when it reconnects.")).toBeTruthy();
      expect(queryByText(/reach the hub|check your connection/i)).toBeNull();
    }, answer);
  });
}

test("a real network failure keeps the hub-connection copy", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([mockNode]);
  const { networkError } = await import("$lib/api/http-error");
  vi.spyOn(api, "listDetected").mockRejectedValue(networkError("GET /api/nodes/node_1/detected", new TypeError("Failed to fetch")));
  vi.spyOn(api, "listStations").mockResolvedValue([]);
  const { findByText } = render(NodeDetailPage);
  expect(await findByText("Couldn't reach the hub — check your connection.")).toBeTruthy();
});
