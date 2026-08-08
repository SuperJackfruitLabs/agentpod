/**
 * NodesOverview.svelte.test.ts
 *
 * TDD tests for the fleet home Nodes Overview panel.
 * RED → implement NodesOverview.svelte → GREEN.
 *
 * Mocks $lib/api/client; asserts:
 *   - listNodes() → 2 nodes → both node cards render (host + status badge)
 *   - each card links to /nodes/<id>
 *   - empty array → empty state shown
 *   - "Create enrollment token" button is present
 *   - clicking it calls createEnrollmentToken and shows the returned token
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import * as nav from "$app/navigation";
import { setSearchParam, resetReactivePageState } from "../../../mocks/reactive-page-state.svelte";
import NodesOverview from "./NodesOverview.svelte";

// Stub svelte-sonner (its runed dependency can't resolve in the jsdom test env)
vi.mock("svelte-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Reactive $app/state stub
//
// The default global stub (src/mocks/app-state.ts) is a plain non-reactive
// object — fine for tests that only read the URL at mount time, but it can't
// exercise NodesOverview's $effect that reacts to `page.url.searchParams`
// changing on the same route (e.g. the command palette navigating
// /nodes → /nodes?action=new-runtime without a remount). This file swaps in
// reactive-page-state.svelte.ts, which wraps `url` in a real $state rune so
// `setSearchParam` genuinely triggers the effect.
// ---------------------------------------------------------------------------

vi.mock("$app/state", async () => {
  const mod = await import("../../../mocks/reactive-page-state.svelte");
  return { page: mod.page };
});

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
  replaceState: vi.fn(),
}));

beforeEach(() => {
  vi.restoreAllMocks();
  resetReactivePageState();
});
afterEach(cleanup);

const mockNodes = [
  {
    id: "node_1",
    name: "vps1",
    hostname: "vps1.example.com",
    os: "linux",
    arch: "amd64",
    cpuCount: 4,
    status: "online" as const,
    lastSeenAt: "2026-06-28T10:00:00Z",
    createdAt: "2026-06-22T00:00:00Z",
    agentVersion: null,
    latestVersion: null,
    updateAvailable: false,
  },
  {
    id: "node_2",
    name: "vps2",
    hostname: "vps2.example.com",
    os: "linux",
    arch: "arm64",
    cpuCount: 8,
    status: "offline" as const,
    lastSeenAt: null,
    createdAt: "2026-06-23T00:00:00Z",
    agentVersion: null,
    latestVersion: null,
    updateAvailable: false,
  },
];

test("renders both node cards with hostname and status badge", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue(mockNodes);

  const { getByText } = render(NodesOverview);

  await waitFor(() => {
    expect(getByText("vps1.example.com")).toBeTruthy();
    expect(getByText("vps2.example.com")).toBeTruthy();
  });

  expect(getByText("online")).toBeTruthy();
  expect(getByText("offline")).toBeTruthy();
});

test("each node card links to /nodes/<id>", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue(mockNodes);

  const { container } = render(NodesOverview);

  await waitFor(() => {
    const links = Array.from(container.querySelectorAll("a[href]"));
    const hrefs = links.map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/nodes/node_1");
    expect(hrefs).toContain("/nodes/node_2");
  });
});

test("shows empty state when listNodes returns an empty array", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([]);

  const { getByText } = render(NodesOverview);

  await waitFor(() => {
    expect(getByText(/no nodes yet/i)).toBeTruthy();
  });
});

test("'Create enrollment token' button is present", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([]);

  const { getByRole } = render(NodesOverview);

  const btn = getByRole("button", { name: /create enrollment token/i });
  expect(btn).toBeTruthy();
});

test("mint failure shows inline mintError without replacing the node grid", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue(mockNodes);
  vi.spyOn(api, "createEnrollmentToken").mockRejectedValue(new Error("token quota exceeded"));

  const { getByRole, getByText, queryByText } = render(NodesOverview);

  // Wait for nodes to load
  await waitFor(() => {
    expect(getByText("vps1.example.com")).toBeTruthy();
  });

  const btn = getByRole("button", { name: /create enrollment token/i });
  fireEvent.click(btn);

  await waitFor(() => {
    // Inline mint error is shown
    expect(getByText("token quota exceeded")).toBeTruthy();
    // Node grid is still visible
    expect(getByText("vps1.example.com")).toBeTruthy();
    expect(getByText("vps2.example.com")).toBeTruthy();
    // Full-page error banner is NOT shown (no cyber-card border-destructive replacing the grid)
    expect(queryByText(/no nodes yet/i)).toBeNull();
  });
});

test("provisioned node shows 'provisioned · docker' badge; unprovisioned node does not", async () => {
  const provisionedNode = {
    ...mockNodes[0],
    id: "node_p1",
    hostname: "provisioned.local",
    provisioned: { runtimeId: "rt_1", provider: "docker" },
  };
  const unprovisionedNode = {
    ...mockNodes[1],
    id: "node_p2",
    hostname: "manual.local",
    provisioned: null,
  };
  vi.spyOn(api, "listNodes").mockResolvedValue([provisionedNode, unprovisionedNode]);

  const { getAllByText, queryAllByText } = render(NodesOverview);

  await waitFor(() => {
    // The provisioned node shows the badge
    const badges = getAllByText(/provisioned · docker/i);
    expect(badges.length).toBeGreaterThan(0);
  });

  // The unprovisioned node does NOT show a provisioned badge
  // (there's exactly 1 badge — the provisioned one; not 2)
  expect(queryAllByText(/provisioned · docker/i)).toHaveLength(1);
});

test("shows ConnectBanner heading when nodes is empty", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([]);

  const { getByText } = render(NodesOverview);

  await waitFor(() => {
    expect(getByText(/connect your first node/i)).toBeTruthy();
  });
});

test("clicking 'Create enrollment token' calls createEnrollmentToken and shows the token command", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([]);
  vi.spyOn(api, "createEnrollmentToken").mockResolvedValue({
    token: "tok_test_abc123",
    expiresAt: "2026-12-31T00:00:00Z",
  });

  const { getByRole, getByText } = render(NodesOverview);

  const btn = getByRole("button", { name: /create enrollment token/i });
  fireEvent.click(btn);

  await waitFor(() => {
    expect(api.createEnrollmentToken).toHaveBeenCalledOnce();
    expect(getByText(/tok_test_abc123/)).toBeTruthy();
  });
});

test("error branch's Retry button refetches and renders nodes on success", async () => {
  vi.spyOn(api, "listNodes")
    .mockRejectedValueOnce(new Error("network down"))
    .mockResolvedValueOnce(mockNodes);

  const { getByRole, getByText, queryByText } = render(NodesOverview);

  await waitFor(() => {
    expect(getByText("network down")).toBeTruthy();
  });

  const retryBtn = getByRole("button", { name: /retry/i });
  await fireEvent.click(retryBtn);

  await waitFor(() => {
    expect(api.listNodes).toHaveBeenCalledTimes(2);
    expect(getByText("vps1.example.com")).toBeTruthy();
    expect(getByText("vps2.example.com")).toBeTruthy();
    // The error banner is gone now that the retry succeeded.
    expect(queryByText("network down")).toBeNull();
  });
});

// ── Update button TDD tests ────────────────────────────────────────────────────

test("node with updateAvailable:true renders Update button and version upgrade text", async () => {
  const updatableNode = {
    id: "node_upd",
    name: "updatable",
    hostname: "updatable.local",
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
    status: "online" as const,
    lastSeenAt: null,
    createdAt: "2026-06-30T00:00:00Z",
    agentVersion: "v0.1.2",
    latestVersion: "v0.1.3",
    updateAvailable: true,
  };
  vi.spyOn(api, "listNodes").mockResolvedValue([updatableNode]);
  vi.spyOn(api, "updateNode").mockResolvedValue({ ok: true, updating: true, tag: "v0.1.3" });

  const { getByRole, getByText } = render(NodesOverview);

  await waitFor(() => {
    // Version upgrade text is visible
    expect(getByText(/v0\.1\.2.*v0\.1\.3/)).toBeTruthy();
    // Update button is present
    expect(getByRole("button", { name: /^update$/i })).toBeTruthy();
  });
});

test("node with updateAvailable:false renders no Update button", async () => {
  const upToDateNode = {
    ...mockNodes[0],
    agentVersion: "v0.1.3",
    latestVersion: "v0.1.3",
    updateAvailable: false,
  };
  vi.spyOn(api, "listNodes").mockResolvedValue([upToDateNode]);

  const { queryByRole, getByText } = render(NodesOverview);

  // Wait for the node to render
  await waitFor(() => {
    expect(getByText(upToDateNode.hostname)).toBeTruthy();
  });

  expect(queryByRole("button", { name: /^update$/i })).toBeNull();
});

// ── ?action= query param handling (open dialog / mint token from the command
//    palette, including while already mounted on /nodes) ─────────────────────

test("?action=new-runtime already in the URL at mount opens the New Runtime dialog and clears the param", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([]);
  setSearchParam("action", "new-runtime");

  const { getByText } = render(NodesOverview);

  await waitFor(() => {
    expect(getByText("New Runtime")).toBeTruthy();
    expect(nav.replaceState).toHaveBeenCalledWith("/nodes", {});
  });
});

test("?action=create-token already in the URL at mount mints a token and clears the param", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([]);
  vi.spyOn(api, "createEnrollmentToken").mockResolvedValue({
    token: "tok_mount_abc123",
    expiresAt: "2026-12-31T00:00:00Z",
  });
  setSearchParam("action", "create-token");

  const { getByText } = render(NodesOverview);

  await waitFor(() => {
    expect(api.createEnrollmentToken).toHaveBeenCalledOnce();
    expect(getByText(/tok_mount_abc123/)).toBeTruthy();
    expect(nav.replaceState).toHaveBeenCalledWith("/nodes", {});
  });
});

test("?action= appearing while already mounted on /nodes (same-route palette navigation, no remount) still opens the dialog", async () => {
  // This is the regression case: SvelteKit doesn't remount NodesOverview when
  // the command palette navigates /nodes → /nodes?action=new-runtime while
  // /nodes is already showing. Mount with NO action param first — mirroring
  // being parked on the page — then mutate the reactive page.url the same
  // way a same-route goto() would, and assert the $effect (not onMount,
  // which only ever runs once) picks it up.
  vi.spyOn(api, "listNodes").mockResolvedValue([]);

  const { getByText, queryByText } = render(NodesOverview);

  await waitFor(() => {
    // No dialog on initial mount without the param.
    expect(queryByText("New Runtime")).toBeNull();
  });

  setSearchParam("action", "new-runtime");

  await waitFor(() => {
    expect(getByText("New Runtime")).toBeTruthy();
    expect(nav.replaceState).toHaveBeenCalledWith("/nodes", {});
  });
});

// ── Loop-guard semantics ─────────────────────────────────────────────────────
//
// IMPORTANT: real SvelteKit's replaceState() does NOT reassign the reactive
// page.url (it patches the history entry, not the page store) — so the
// $effect can't rely on the param "clearing itself" reactively. Worse, the
// history entry it writes can still carry the stale "?action=…" query, so a
// browser back-navigation onto that entry can reconstruct page.url WITH the
// param again. NodesOverview instead tracks the last-handled action value
// explicitly and only resets that tracker when the URL has NO action param.
// These two tests exercise both sides of that contract, without assuming
// replaceState ever touches page.url itself (the mock above deliberately
// doesn't — see the "$app/navigation" mock, which leaves page.url alone).

test("?action= genuine second palette invocation reprocesses once the URL has passed through an action-less state", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([]);
  vi.spyOn(api, "createEnrollmentToken").mockResolvedValue({
    token: "tok_once_abc123",
    expiresAt: "2026-12-31T00:00:00Z",
  });

  render(NodesOverview);

  // First palette invocation.
  setSearchParam("action", "create-token");
  await waitFor(() => {
    expect(api.createEnrollmentToken).toHaveBeenCalledOnce();
    expect(nav.replaceState).toHaveBeenCalledTimes(1);
  });

  // Some later real navigation clears the param (e.g. the user browses
  // elsewhere and back, or a subsequent goto() lands back on a bare /nodes)
  // — simulated directly here since replaceState itself does not do this.
  // `tick()` lets the $effect actually observe this intermediate action-less
  // state (Svelte batches same-microtask state changes, so two synchronous
  // setSearchParam calls with no yield in between would otherwise collapse
  // into one effect run that never sees action=null).
  setSearchParam("action", null);
  await tick();

  // A second, genuine palette invocation of the same action.
  setSearchParam("action", "create-token");

  await waitFor(() => {
    expect(api.createEnrollmentToken).toHaveBeenCalledTimes(2);
    expect(nav.replaceState).toHaveBeenCalledTimes(2);
  });
});

test("?action= the same value re-appearing WITHOUT an intervening action-less state (browser back-nav onto the stale history entry) does NOT reprocess", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([]);
  vi.spyOn(api, "createEnrollmentToken").mockResolvedValue({
    token: "tok_once_abc123",
    expiresAt: "2026-12-31T00:00:00Z",
  });

  render(NodesOverview);

  setSearchParam("action", "create-token");
  await waitFor(() => {
    expect(api.createEnrollmentToken).toHaveBeenCalledOnce();
  });

  // Simulate a browser back-navigation reconstructing page.url with the same
  // stale "?action=create-token" — a *new* URL object (as a real navigation
  // would produce) but the identical action value, with no action-less state
  // in between. The handledAction guard must block reprocessing here.
  setSearchParam("action", "create-token");

  // Give any (incorrect) re-processing a chance to happen, then confirm it didn't.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(api.createEnrollmentToken).toHaveBeenCalledOnce();
  expect(nav.replaceState).toHaveBeenCalledTimes(1);
});
