/**
 * page.svelte.test.ts
 *
 * Tests for the station detail page's tab wiring — specifically the Chat tab
 * introduced with ACP sessions:
 *   - an `acp`-capable station gets Chat FIRST and selected by default (no
 *     ?tab= param), and the panel is really mounted (the composer is there);
 *   - switching away keeps the chat panel mounted-but-hidden, so its live
 *     WebSocket survives a tab switch;
 *   - the default tab is the one that DELETES ?tab=, so Health on an acp
 *     station is an explicit ?tab=health;
 *   - a station without `acp` has no Chat tab and still defaults to Health.
 *
 * Run: cd apps/console && pnpm test src/routes/nodes/\[id\]/stations
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import type { StationRow } from "$lib/api/client";
import type { StationHealth } from "@agentpod/contract";

// ─── SvelteKit stubs ────────────────────────────────────────────────────────
// The page reads the legacy `$app/stores` page store, so the stub has to be a
// real (writable) store: tests drive ?tab= through it.

const { pageStore, setUrl, setStation, goto } = vi.hoisted(() => {
  const base = "http://localhost/nodes/node_1/stations/station_1";
  let value = {
    url: new URL(base),
    params: { id: "node_1", stationId: "station_1" },
    data: {},
    form: null,
    status: 200,
    error: null,
    route: { id: "/nodes/[id]/stations/[stationId]" },
  };
  const subscribers = new Set<(v: typeof value) => void>();
  return {
    goto: vi.fn(),
    pageStore: {
      subscribe(fn: (v: typeof value) => void) {
        fn(value);
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      },
    },
    setUrl(search: string) {
      value = { ...value, url: new URL(base + search) };
      for (const fn of subscribers) fn(value);
    },
    /** A client-side move to a different agent — what a roster-rail click does. */
    setStation(stationId: string) {
      value = {
        ...value,
        url: new URL(`http://localhost/nodes/node_1/stations/${stationId}`),
        params: { id: "node_1", stationId },
      };
      for (const fn of subscribers) fn(value);
    },
  };
});

vi.mock("$app/stores", () => ({
  page: pageStore,
  navigating: { subscribe: (fn: (v: null) => void) => (fn(null), () => {}) },
  updated: { subscribe: (fn: (v: boolean) => void) => (fn(false), () => {}) },
}));

vi.mock("$app/navigation", () => ({ goto }));

vi.mock("svelte-sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// The chat panel's markdown renderer isn't jsdom-friendly; the ACP api layer is
// replaced wholesale so mounting the panel touches no network/WebSocket.
vi.mock("$lib/components/stations/chat/Response.svelte", () =>
  import("$lib/components/stations/chat/response.stub.svelte"),
);

vi.mock("$lib/api/acp", () => ({
  listAcpSessions: vi.fn(async () => []),
  createAcpSession: vi.fn(),
  endAcpSession: vi.fn(),
  createAcpSocket: vi.fn(() => ({
    send: vi.fn(),
    onMessage: vi.fn(),
    onClose: vi.fn(),
    close: vi.fn(),
  })),
}));

import * as acpApi from "$lib/api/acp";
import { contextRailSlot, setContextRail } from "$lib/stores/context-rail.svelte";
// Mounted through a Tooltip.Provider host (panels below the tab bar need one).
import StationPage from "./page-test-host.svelte";

// ─── viewport ───────────────────────────────────────────────────────────────
// The Identity tab appears only where the shell has no third column, which the
// page decides with matchMedia("(max-width: 1240px)") — a JS query, because a
// Tailwind max-[1240px]: variant compiles to an exclusive media query that
// leaves 1240px itself in neither branch. vitest-setup's stub answers `false`
// to everything and registers no listeners, so a test that cares supplies one
// that does.

const realMatchMedia = window.matchMedia;
let mediaListeners: Array<(e: MediaQueryListEvent) => void> = [];
let mediaMatches = false;

function narrowViewport(matches: boolean) {
  mediaMatches = matches;
  mediaListeners = [];
  window.matchMedia = ((query: string) => ({
    get matches() {
      return mediaMatches;
    },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => mediaListeners.push(fn),
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => {
      mediaListeners = mediaListeners.filter((l) => l !== fn);
    },
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** Resize, as the browser reports it. */
function setNarrow(matches: boolean) {
  mediaMatches = matches;
  for (const fn of mediaListeners) fn({ matches } as MediaQueryListEvent);
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

function station(capabilities: StationRow["capabilities"]): StationRow {
  return {
    id: "station_1",
    userId: "user_1",
    nodeId: "node_1",
    harness: "claude",
    stationKey: "claude://workspace",
    kind: "composite",
    parentStationId: null,
    displayName: "Workspace",
    workspacePath: "/home/user/workspace",
    capabilities,
    matrixId: null, bridgeMatrixId: null, purpose: null,
    principalId: null,
    adoptedAt: "2026-06-22T00:00:00Z",
    createdAt: "2026-06-22T00:00:00Z",
  };
}

const health: StationHealth = {
  running: true,
  pid: 42,
  cpuPct: 1,
  memBytes: 1024,
  diskBytes: 1024,
  uptimeSec: 60,
  lastActivity: null,
  note: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
  goto.mockClear();
  vi.mocked(acpApi.listAcpSessions).mockClear();
  setStation("station_1");
  setUrl("");
  // The rail is a module-level slot shared with the layout; a page left
  // registered by one test would be read by the next.
  setContextRail(null);
  window.matchMedia = realMatchMedia;
  vi.spyOn(api, "stationHealth").mockResolvedValue(health);
});

afterEach(() => {
  cleanup();
  setContextRail(null);
  window.matchMedia = realMatchMedia;
});

const tabNames = (tabs: HTMLElement[]) => tabs.map((t) => t.getAttribute("aria-label"));
const selected = (tabs: HTMLElement[]) =>
  tabs.find((t) => t.getAttribute("aria-selected") === "true")?.getAttribute("aria-label");

// ─── acp station ────────────────────────────────────────────────────────────

test("an acp station gets Chat first and selected by default, with the panel mounted", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "logs", "acp"])]);

  const { getAllByRole, getByPlaceholderText } = render(StationPage);

  await waitFor(() => {
    const tabs = getAllByRole("tab");
    expect(tabNames(tabs)[0]).toBe("Chat");
    expect(selected(tabs)).toBe("Chat");
  });
  // The panel is really there (not just the tab), and it booted the controller.
  expect(getByPlaceholderText("Message the agent…")).toBeTruthy();
  expect(acpApi.listAcpSessions).toHaveBeenCalledWith("station_1", { limit: 100 });
});

test("switching away from Chat keeps the panel mounted so its socket survives", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "acp"])]);

  const { getAllByRole, getByPlaceholderText, getByRole } = render(StationPage);
  await waitFor(() => expect(selected(getAllByRole("tab"))).toBe("Chat"));
  const composer = getByPlaceholderText("Message the agent…");

  await fireEvent.click(getByRole("tab", { name: "Health" }));
  // Health is not the default tab here, so it must be an explicit ?tab=health.
  expect(String(goto.mock.calls[0][0])).toContain("tab=health");
  setUrl("?tab=health"); // stand in for the navigation goto would perform

  await waitFor(() => expect(selected(getAllByRole("tab"))).toBe("Health"));
  expect(composer.isConnected).toBe(true);
  expect(composer.closest('[role="tabpanel"]')!.className).toContain("hidden");
  // Exactly one controller boot — the panel was never torn down and re-inited.
  expect(acpApi.listAcpSessions).toHaveBeenCalledTimes(1);
});

test("choosing Chat again deletes ?tab= (chat is the default tab for acp)", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "acp"])]);
  setUrl("?tab=health");

  const { getAllByRole, getByRole } = render(StationPage);
  // The Chat tab only appears once the station's capabilities have loaded.
  await waitFor(() => expect(getByRole("tab", { name: "Chat" })).toBeTruthy());
  expect(selected(getAllByRole("tab"))).toBe("Health");

  await fireEvent.click(getByRole("tab", { name: "Chat" }));

  expect(String(goto.mock.calls[0][0])).not.toContain("tab=");
});

test("a deep link to ?tab=health on an acp station shows health, not chat", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "acp"])]);
  setUrl("?tab=health");

  const { getAllByRole, getByRole, queryByPlaceholderText } = render(StationPage);

  // Wait for the loaded state (the Chat tab exists) before asserting absence.
  await waitFor(() => expect(getByRole("tab", { name: "Chat" })).toBeTruthy());
  expect(selected(getAllByRole("tab"))).toBe("Health");
  // Never visited → the chat panel (and its WebSocket) was never created.
  expect(queryByPlaceholderText("Message the agent…")).toBeNull();
  expect(acpApi.listAcpSessions).not.toHaveBeenCalled();
});

test("panels wait for the capability list, showing a skeleton instead of a bare header", async () => {
  let resolve: (rows: StationRow[]) => void = () => {};
  vi.spyOn(api, "listStations").mockReturnValue(
    new Promise<StationRow[]>((r) => {
      resolve = r;
    }),
  );
  setUrl("?tab=chat"); // a deep link to a tab that doesn't exist yet

  const { getAllByRole, getByTestId, queryByPlaceholderText } = render(StationPage);
  await waitFor(() => expect(getAllByRole("tab").length).toBeGreaterThan(0));

  // Which tab is the default depends on the capabilities, so nothing mounts yet —
  // but the wait has a shape.
  expect(api.stationHealth).not.toHaveBeenCalled();
  expect(queryByPlaceholderText("Message the agent…")).toBeNull();
  expect(getByTestId("station-panels-loading")).toBeTruthy();

  // The tablist keeps exactly one tabbable tab: PageHeader's roving tabindex
  // hangs off the active tab, so an active tab that isn't rendered would leave
  // the whole tab bar unreachable by keyboard.
  const tabbable = getAllByRole("tab").filter((t) => t.getAttribute("tabindex") === "0");
  expect(tabbable).toHaveLength(1);

  resolve([station(["health", "acp"])]);

  await waitFor(() => expect(queryByPlaceholderText("Message the agent…")).toBeTruthy());
  // Chat exists now, so the deep link resolves to it — and health was never
  // mounted or fetched on the way there.
  expect(selected(getAllByRole("tab"))).toBe("Chat");
  expect(api.stationHealth).not.toHaveBeenCalled();
});

test("a tab the station doesn't have falls back to the default, keeping the tablist tabbable", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "logs"])]);
  setUrl("?tab=terminal"); // no terminal capability → no such tab

  const { getAllByRole } = render(StationPage);

  await waitFor(() => expect(selected(getAllByRole("tab"))).toBe("Health"));
  expect(getAllByRole("tab").filter((t) => t.getAttribute("tabindex") === "0")).toHaveLength(1);
});

// ─── non-acp station ────────────────────────────────────────────────────────

test("a station without acp has no Chat tab and still defaults to Health", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "logs", "terminal"])]);

  const { getAllByRole, queryByRole, queryByPlaceholderText } = render(StationPage);

  await waitFor(() => {
    const tabs = getAllByRole("tab");
    expect(tabNames(tabs)[0]).toBe("Health");
    expect(selected(tabs)).toBe("Health");
  });
  expect(queryByRole("tab", { name: "Chat" })).toBeNull();
  expect(queryByPlaceholderText("Message the agent…")).toBeNull();
});

test("on a non-acp station Health still deletes ?tab=", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "logs"])]);
  setUrl("?tab=logs");

  const { getByRole, getAllByRole } = render(StationPage);
  await waitFor(() => expect(selected(getAllByRole("tab"))).toBe("Logs"));

  await fireEvent.click(getByRole("tab", { name: "Health" }));

  expect(String(goto.mock.calls[0][0])).not.toContain("tab=");
});

// ─── changeset station ──────────────────────────────────────────────────────

test("a station with the changeset capability gets a Changes tab", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([
    station(["health", "logs", "changeset"]),
  ]);
  vi.spyOn(api, "changesetStatus").mockResolvedValue({
    repo: { branch: "main", head: "abc1234", detached: false },
    base: { ref: "origin/main", sha: "def5678", reason: "upstream" },
    uncommitted: { files: [], insertions: 0, deletions: 0 },
    committed: { files: [], insertions: 0, deletions: 0, commits: [] },
    truncatedFiles: false,
  });

  const { getAllByRole } = render(StationPage);

  await waitFor(() => {
    expect(tabNames(getAllByRole("tab"))).toContain("Changes");
  });
});

test("a station without it gets no Changes tab", async () => {
  // A tab that always errors is worse than no tab — which is exactly why the
  // capability is advertised conditionally in the first place.
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "logs"])]);

  const { getAllByRole } = render(StationPage);

  await waitFor(() => {
    expect(tabNames(getAllByRole("tab"))).toContain("Health");
  });
  expect(tabNames(getAllByRole("tab"))).not.toContain("Changes");
});

test("the Changes panel mounts and asks the station what changed", async () => {
  // The tab existing is not the feature; the panel fetching is.
  vi.spyOn(api, "listStations").mockResolvedValue([
    station(["health", "logs", "changeset"]),
  ]);
  const status = vi.spyOn(api, "changesetStatus").mockResolvedValue({
    repo: { branch: "feat/x", head: "abc1234", detached: false },
    base: { ref: "origin/main", sha: "def5678", reason: "upstream" },
    uncommitted: { files: [], insertions: 0, deletions: 0 },
    committed: { files: [], insertions: 0, deletions: 0, commits: [] },
    truncatedFiles: false,
  });

  setUrl("?tab=changes");
  render(StationPage);

  await waitFor(() => expect(status).toHaveBeenCalledWith("station_1"));
});

// ─── the header ─────────────────────────────────────────────────────────────

test("the header shows the station key in a font-mono element, and the agent's name in another", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "acp"])]);

  const { getByTestId } = render(StationPage);

  await waitFor(() => expect(getByTestId("station-key").textContent).toBe("claude://workspace"));
  // Constraint 3: a station key is machine-issued, so it is mono — but the
  // line it sits in is prose, so the joins around it are not.
  expect(getByTestId("station-key").className).toContain("font-mono");
  expect(getByTestId("station-handle").className).toContain("font-mono");
  expect(getByTestId("station-handle").textContent).toContain("Workspace");
  expect(getByTestId("station-summary").textContent).toContain("last spoke");
});

test("the header carries the state as a word, never as a colour alone", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health"])]);

  const { getByTestId } = render(StationPage);

  // Nothing in the shared fleet snapshot knows this station, and "Unknown" is
  // its own state — never rendered as "Stopped".
  await waitFor(() => expect(getByTestId("station-summary").textContent).toContain("Unknown"));
});

test("Restart and a destructive Stop ride in the header, for a station that has lifecycle", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "lifecycle"])]);
  const call = vi.spyOn(api, "lifecycle").mockResolvedValue(health);

  const { getByRole, findByRole } = render(StationPage);

  await waitFor(() => expect(getByRole("button", { name: "Restart" })).toBeTruthy());
  await fireEvent.click(getByRole("button", { name: "Stop" }));

  // Stopping an agent is destructive, so it is confirmed rather than fired.
  const confirm = await findByRole("button", { name: "Stop agent" });
  expect(call).not.toHaveBeenCalled();
  await fireEvent.click(confirm);
  await waitFor(() => expect(call).toHaveBeenCalledWith("station_1", "stop"));
});

test("a station without the lifecycle capability gets no Restart or Stop", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "acp"])]);

  const { getAllByRole, queryByRole } = render(StationPage);

  await waitFor(() => expect(getAllByRole("tab").length).toBeGreaterThan(0));
  expect(queryByRole("button", { name: "Restart" })).toBeNull();
  expect(queryByRole("button", { name: "Stop" })).toBeNull();
});

// ─── the context rail ───────────────────────────────────────────────────────

test("the page hands its rail to the shell while it is mounted, and takes it back", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "acp"])]);

  const { unmount } = render(StationPage);

  await waitFor(() => expect(contextRailSlot.snippet).not.toBeNull());
  unmount();
  // A snippet outliving its owner would be rendered against state that is gone.
  await waitFor(() => expect(contextRailSlot.snippet).toBeNull());
});

test("below 1240px the rail becomes an Identity tab, and the shell is given nothing", async () => {
  narrowViewport(true);
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "acp"])]);

  const { getAllByRole } = render(StationPage);

  await waitFor(() => expect(tabNames(getAllByRole("tab"))).toContain("Identity"));
  // Registering it as well would mount ContextRail twice and ask the hub for
  // the grants twice.
  expect(contextRailSlot.snippet).toBeNull();
});

test("the Identity tab disappears again when the viewport grows past 1240px", async () => {
  narrowViewport(true);
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "acp"])]);

  const { getAllByRole } = render(StationPage);
  await waitFor(() => expect(tabNames(getAllByRole("tab"))).toContain("Identity"));

  setNarrow(false);

  await waitFor(() => expect(tabNames(getAllByRole("tab"))).not.toContain("Identity"));
  await waitFor(() => expect(contextRailSlot.snippet).not.toBeNull());
});

// ─── moving between agents ──────────────────────────────────────────────────

test("clicking a different agent loads that agent — the route is one page, not one per station", async () => {
  // The regression this guards: [stationId] changing does not remount the
  // page, so an onMount-only fetch left the previous agent's header, tabs and
  // panels on screen under the new URL. Reachable from the node page only by
  // accident; with the roster rail it is the ordinary move.
  const rows = vi.spyOn(api, "listStations").mockResolvedValue([
    station(["health", "logs", "acp"]),
    { ...station(["health"]), id: "station_2", displayName: "scribe", stationKey: "pi://scratch" },
  ]);

  const { getByTestId, getAllByRole } = render(StationPage);
  await waitFor(() => expect(getByTestId("station-handle").textContent).toContain("Workspace"));
  expect(tabNames(getAllByRole("tab"))).toContain("Chat");

  setStation("station_2");

  await waitFor(() => expect(getByTestId("station-handle").textContent).toContain("scribe"));
  expect(getByTestId("station-key").textContent).toBe("pi://scratch");
  // …and its capabilities came with it: no acp on this one, so no Chat tab and
  // Health leads instead.
  expect(tabNames(getAllByRole("tab"))).not.toContain("Chat");
  await waitFor(() => expect(selected(getAllByRole("tab"))).toBe("Health"));
  expect(rows.mock.calls.length).toBeGreaterThan(1);
});

test("a reply about the agent we have just navigated away from is dropped", async () => {
  // Two fetches in flight at once is the normal case for a fast double-click
  // down the roster; the slower one must not win.
  let resolveFirst: (rows: StationRow[]) => void = () => {};
  vi.spyOn(api, "listStations")
    .mockReturnValueOnce(new Promise<StationRow[]>((r) => (resolveFirst = r)))
    .mockResolvedValue([
      { ...station(["health"]), id: "station_2", displayName: "scribe", stationKey: "pi://scratch" },
    ]);

  const { getByTestId } = render(StationPage);
  setStation("station_2");
  await waitFor(() => expect(getByTestId("station-handle").textContent).toContain("scribe"));

  resolveFirst([station(["health", "acp"])]);
  await new Promise((r) => setTimeout(r, 20));

  expect(getByTestId("station-handle").textContent).toContain("scribe");
});
