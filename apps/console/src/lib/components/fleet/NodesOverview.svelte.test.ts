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

test("renders a row per node: the name it is known by, its hostname, and its link state", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue(mockNodes);

  const { getByText, getAllByTestId } = render(NodesOverview);

  await waitFor(() => {
    // The NAME leads, as it does in the roster rail and on the muster — the
    // fleet knows a machine as "superchotu", not as its FQDN. The hostname is
    // still there, under it.
    expect(getByText("vps1")).toBeTruthy();
    expect(getByText("vps2")).toBeTruthy();
    expect(getByText("vps1.example.com")).toBeTruthy();
    expect(getByText("vps2.example.com")).toBeTruthy();
  });

  expect(getAllByTestId("node-row").length).toBe(2);
});

test("a node's link cell says Online / Offline — the node's own words, not the generic state label", async () => {
  // The muster shipped this bug first: `nodeState` shares the ERROR token with
  // a failed station, so rendering the generic label put "Error" against a
  // laptop somebody had simply closed the lid on. Only a process runs; a
  // machine is online or it is not.
  vi.spyOn(api, "listNodes").mockResolvedValue(mockNodes);

  const { getByTestId, getByText } = render(NodesOverview);

  await waitFor(() => expect(getByText("vps1")).toBeTruthy());

  expect(getByTestId("node-link-node_1").textContent).toMatch(/online/i);
  expect(getByTestId("node-link-node_2").textContent).toMatch(/offline/i);
  expect(getByTestId("node-link-node_2").textContent).not.toMatch(/error/i);

  // Colour still comes from the shared vocabulary: an unreachable machine is
  // as red as a failed agent, it just isn't called the same thing.
  expect(getByTestId("node-link-node_1").innerHTML).toContain("bg-status-running");
  expect(getByTestId("node-link-node_2").innerHTML).toContain("bg-status-error");
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
    expect(getByText(/connect your first node/i)).toBeTruthy();
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
    expect(queryByText(/connect your first node/i)).toBeNull();
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

test("a node behind on its agent shows both versions, and the button that closes the gap", async () => {
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

  const { getByRole } = render(NodesOverview);

  await waitFor(() => {
    // The dialog itself (not the header's "New runtime" button) must open.
    expect(getByRole("dialog")).toBeTruthy();
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

  const { getByRole, queryByRole } = render(NodesOverview);

  await waitFor(() => {
    // No dialog on initial mount without the param.
    expect(queryByRole("dialog")).toBeNull();
  });

  setSearchParam("action", "new-runtime");

  await waitFor(() => {
    expect(getByRole("dialog")).toBeTruthy();
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

// ─── Fleet rollout button (#295) ───────────────────────────────────────────────
//
// Nodes never update themselves — there is no timer anywhere in the agent or
// the hub — so after a release the fleet stays where it is until somebody rolls
// it. These cover the button that does the rolling, and specifically that it
// tells the truth afterwards: a rollout reporting success while machines sat on
// the old binary is the defect issue #296 fixed on the single-node path.

const behindNode = {
  ...mockNodes[0],
  id: "node_behind",
  name: "molt-bot",
  hostname: "molt-bot.example.com",
  agentVersion: "v0.1.22",
  latestVersion: "v0.1.26",
  updateAvailable: true,
};

test("offers no fleet-update button when nothing is behind", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue(mockNodes);

  const { queryByRole } = render(NodesOverview);

  await waitFor(() => {
    expect(queryByRole("button", { name: /update \d+ node/i })).toBeNull();
  });
});

test("offers to update exactly the nodes that are behind", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([behindNode, mockNodes[1]!]);

  const { getByRole } = render(NodesOverview);

  await waitFor(() => {
    expect(getByRole("button", { name: /update 1 node/i })).toBeTruthy();
  });
});

test("rolling out calls the hub once and reports what happened", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([behindNode]);
  const updateAll = vi.spyOn(api, "updateAllNodes").mockResolvedValue({
    ok: true,
    summary: { updated: 1, "no-op": 0, skipped: 2, failed: 0 },
    results: [
      { nodeId: "node_behind", name: "molt-bot", outcome: "updated", tag: "v0.1.26" },
    ],
  });

  const { getByRole } = render(NodesOverview);
  const button = await waitFor(() => getByRole("button", { name: /update 1 node/i }));

  await fireEvent.click(button);
  await tick();

  await waitFor(() => expect(updateAll).toHaveBeenCalledTimes(1));

  const { toast } = await import("svelte-sonner");
  expect(toast.success).toHaveBeenCalled();
});

test("a node that failed is reported as a failure, never as success", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([behindNode]);
  vi.spyOn(api, "updateAllNodes").mockResolvedValue({
    ok: true,
    summary: { updated: 0, "no-op": 0, skipped: 0, failed: 1 },
    results: [
      {
        nodeId: "node_behind",
        name: "molt-bot",
        outcome: "failed",
        error: "checksum mismatch",
      },
    ],
  });

  const { getByRole } = render(NodesOverview);
  const button = await waitFor(() => getByRole("button", { name: /update 1 node/i }));

  await fireEvent.click(button);
  await tick();

  const { toast } = await import("svelte-sonner");
  // The hub answered 200 — the request succeeded and the update did not. An
  // operator must not read that as a fleet that moved.
  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(toast.success).not.toHaveBeenCalled();
});

// ── The table's shape ────────────────────────────────────────────────────────

test("the nodes table scrolls inside its own box, and its sr-only header is positioned", async () => {
  // Two traps this table has already sprung. Wide content must scroll in its
  // own container, never drag the document sideways (constraint 7); and an
  // `sr-only` span is position:absolute, so with no positioned ancestor it
  // escapes that container entirely and sets the DOCUMENT's scroll width —
  // measured at 667px on a 414px viewport before `relative` was added.
  vi.spyOn(api, "listNodes").mockResolvedValue(mockNodes);

  const { getByTestId, container } = render(NodesOverview);

  const scroller = await waitFor(() => getByTestId("nodes-table-scroller"));
  expect(scroller.className).toContain("overflow-x-auto");

  const srOnly = container.querySelector(".sr-only");
  expect(srOnly).toBeTruthy();
  expect(srOnly!.closest(".relative")).toBeTruthy();
});

test("a node with a very long name is capped rather than allowed to eat the table", async () => {
  // Measured: a 62-character name took 425px of a 918px table and squeezed
  // every other column into unreadability.
  const longName = "a-really-quite-unreasonably-long-node-name-that-someone-typed";
  vi.spyOn(api, "listNodes").mockResolvedValue([{ ...mockNodes[0]!, name: longName }]);

  const { getByText } = render(NodesOverview);

  const link = await waitFor(() => getByText(longName));
  expect(link.className).toContain("truncate");
  // The full name survives on hover — capped is not the same as lost.
  expect(link.getAttribute("title")).toBe(longName);
  expect(link.closest("td")!.className).toContain("max-w-[220px]");
});

test("the Agents cell counts what is running out of what is there", async () => {
  vi.spyOn(api, "listNodes").mockResolvedValue([mockNodes[0]!]);
  vi.spyOn(api, "getFleet").mockResolvedValue({
    agents: [
      { stationId: "s1", nodeId: "node_1", agentName: "a", status: "running" },
      { stationId: "s2", nodeId: "node_1", agentName: "b", status: "stopped" },
      { stationId: "s3", nodeId: "node_1", agentName: "c", status: "unknown" },
    ],
    stats: null,
  } as never);

  const { getByTestId } = render(NodesOverview);

  await waitFor(() => expect(getByTestId("node-agents-node_1").textContent).toMatch(/1\/3/));
});

test("a node whose agent doesn't report posture says so, rather than showing a grade it never measured", async () => {
  // Posture is a live scan that writes an audit row, so this column can only
  // ever be a link. Scanning every node on page load would be a
  // denial-of-service on your own fleet, dressed as a column.
  vi.spyOn(api, "listNodes").mockResolvedValue([
    { ...mockNodes[0]!, capabilities: ["posture"] },
    { ...mockNodes[1]! },
  ]);

  const { getAllByTestId, getByText } = render(NodesOverview);

  await waitFor(() => expect(getAllByTestId("node-row").length).toBe(2));
  expect(getByText("Scan")).toBeTruthy();
  expect(getByText("Scan").getAttribute("href")).toBe("/nodes/node_1");
});
