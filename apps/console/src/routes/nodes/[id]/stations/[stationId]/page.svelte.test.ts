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

const { pageStore, setUrl, goto } = vi.hoisted(() => {
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
// Mounted through the Tooltip.Provider host (PageHeader's tabs need it).
import StationPage from "./page-test-host.svelte";

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
    matrixId: null,
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
  setUrl("");
  vi.spyOn(api, "stationHealth").mockResolvedValue(health);
});

afterEach(cleanup);

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
  expect(acpApi.listAcpSessions).toHaveBeenCalledWith("station_1");
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

test("panels wait for the capability list, so no wrong-default panel is mounted", async () => {
  let resolve: (rows: StationRow[]) => void = () => {};
  vi.spyOn(api, "listStations").mockReturnValue(
    new Promise<StationRow[]>((r) => {
      resolve = r;
    }),
  );

  const { getAllByRole, queryByPlaceholderText } = render(StationPage);
  await waitFor(() => expect(getAllByRole("tab").length).toBeGreaterThan(0));

  // Which tab is the default depends on the capabilities, so nothing mounts yet.
  expect(api.stationHealth).not.toHaveBeenCalled();
  expect(queryByPlaceholderText("Message the agent…")).toBeNull();

  resolve([station(["health", "acp"])]);

  await waitFor(() => expect(queryByPlaceholderText("Message the agent…")).toBeTruthy());
  // Chat was the default all along — health was never mounted or fetched.
  expect(api.stationHealth).not.toHaveBeenCalled();
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
