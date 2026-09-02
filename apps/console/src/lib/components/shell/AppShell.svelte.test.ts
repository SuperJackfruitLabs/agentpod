/**
 * AppShell.svelte.test.ts
 *
 * The shell must not change a single page: whatever it is given renders in
 * the stage column exactly as before. The rest of these tests pin the layout
 * contract that took two rounds to get right in the prototype — asserted as
 * classes, because vitest.config.ts strips <style> and sets css:false, so
 * computed styles are not available here.
 */
import { test, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";

const { mockConnection, mockAuth, mockFleet, stopPoll, startFleetPoll } = vi.hoisted(() => {
  const stopPoll = vi.fn();
  return {
    mockConnection: { apiUrl: "https://hub.agentpod.dev", isConnected: true, reachable: true },
    mockAuth: { initials: "RG" },
    mockFleet: {
      agents: [],
      nodes: [],
      runtimes: [],
      stations: [],
      principals: [],
      stats: null,
      isLoading: false,
      error: null,
      loadedAt: null,
    },
    stopPoll,
    startFleetPoll: vi.fn(() => stopPoll),
  };
});

vi.mock("$lib/stores/connection.svelte", () => ({ connection: mockConnection }));
vi.mock("$lib/stores/auth.svelte", () => ({ auth: mockAuth }));
vi.mock("$lib/stores/fleet.svelte", () => ({ fleet: mockFleet, startFleetPoll }));

import AppShell from "./AppShell.svelte";

const children = createRawSnippet(() => ({
  render: () => `<p data-testid="stage-content">the page that was already here</p>`,
}));

const contextRail = createRawSnippet(() => ({
  render: () => `<p data-testid="context-content">identity</p>`,
}));

beforeEach(() => {
  mockFleet.agents = [];
  mockFleet.nodes = [];
  mockFleet.runtimes = [];
  mockFleet.stations = [];
  mockFleet.principals = [];
  startFleetPoll.mockClear();
  stopPoll.mockClear();
});

test("renders its children in the stage column", () => {
  const { getByTestId } = render(AppShell, { props: { children } });

  expect(getByTestId("stage-content").textContent).toBe("the page that was already here");
  expect(getByTestId("stage").contains(getByTestId("stage-content"))).toBe(true);
});

test("shows which hub this console is talking to", () => {
  const { getByTestId } = render(AppShell, { props: { children } });

  expect(getByTestId("hub-host").textContent?.trim()).toBe("hub.agentpod.dev");
});

test("with an empty fleet the lane says nothing needs a human", () => {
  const { getByText } = render(AppShell, { props: { children } });

  expect(getByText("Nothing needs you. The fleet is running itself.")).toBeTruthy();
});

test("derives the lane from the shared fleet snapshot", () => {
  mockFleet.nodes = [
    { id: "n1", name: "node-alpha", status: "offline", updateAvailable: false },
  ] as never;
  const { getAllByTestId } = render(AppShell, { props: { children } });

  const entries = getAllByTestId("attention-item");
  expect(entries).toHaveLength(1);
  expect(entries[0].textContent).toContain("node-alpha");
});

test("starts the shared fleet poll on mount and stops it on destroy", () => {
  const { unmount } = render(AppShell, { props: { children } });

  expect(startFleetPoll).toHaveBeenCalledTimes(1);
  expect(stopPoll).not.toHaveBeenCalled();

  unmount();
  expect(stopPoll).toHaveBeenCalledTimes(1);
});

test("the roster column holds the fleet, which is the console's navigation", () => {
  mockFleet.agents = [
    {
      stationId: "st_1", nodeId: "n1", nodeName: "node-alpha", agentName: "hermes",
      harness: "claude-code", status: "running", workspacePath: "/w", capabilities: [],
    },
  ] as never;
  const { getByTestId } = render(AppShell, { props: { children } });

  const rail = getByTestId("roster-rail");
  expect(rail.contains(getByTestId("roster-row"))).toBe(true);
  expect(getByTestId("roster-row").getAttribute("href")).toBe("/nodes/n1/stations/st_1");
});

test("the context rail column only exists when a route supplies one", () => {
  const { queryByTestId, unmount } = render(AppShell, { props: { children } });
  expect(queryByTestId("context-rail")).toBeNull();
  unmount();

  const withRail = render(AppShell, { props: { children, contextRail } });
  expect(withRail.getByTestId("context-rail")).toBeTruthy();
  expect(withRail.getByTestId("context-content").textContent).toBe("identity");
});

// --- the layout contract ----------------------------------------------------

test("the outer grid is a capped-height 46px / auto / 1fr with a single bounded column", () => {
  const { getByTestId } = render(AppShell, { props: { children } });
  const shell = getByTestId("app-shell").className;

  // Without grid-cols-[minmax(0,1fr)] the lane's scrolling item list sets the
  // implicit column to its own max-content width and shoves the context rail
  // off screen — measured at 1903px on a 1500px viewport in the prototype.
  expect(shell).toContain("grid-cols-[minmax(0,1fr)]");
  expect(shell).toContain("grid-rows-[46px_auto_1fr]");
  // h-screen, not min-h-screen: capping the shell is what makes inner panes
  // (file tree, logs, terminal) scroll in place instead of the document.
  expect(shell).toContain("h-screen");
  expect(shell).not.toContain("min-h-screen");
});

test("the columns grid is 272px / 1fr / 320px with every child bounded", () => {
  const { getByTestId } = render(AppShell, { props: { children, contextRail } });
  const cols = getByTestId("shell-columns");

  expect(cols.className).toContain("min-[1241px]:grid-cols-[272px_1fr_320px]");
  expect(cols.className).toContain("min-h-0");
  // Same overflow failure as above, one level down.
  for (const child of Array.from(cols.children)) {
    expect(child.className).toContain("min-w-0");
  }
});

test("without a context rail the columns grid stops at two", () => {
  const { getByTestId } = render(AppShell, { props: { children } });

  expect(getByTestId("shell-columns").className).toContain("min-[901px]:grid-cols-[272px_1fr]");
  expect(getByTestId("shell-columns").className).not.toContain("272px_1fr_320px");
});

test("the stage owns no scroll of its own — its inner main does, as the old shell's did", () => {
  const { getByTestId } = render(AppShell, { props: { children } });

  expect(getByTestId("stage").className).toContain("overflow-hidden");
  expect(getByTestId("stage").className).toContain("min-h-0");
  expect(getByTestId("stage-main").className).toContain("overflow-y-auto");
});

test("at and below 900px the roster and the stage are two views, not two columns", async () => {
  const { getByTestId } = render(AppShell, { props: { children } });

  // Asserted as class tokens, not substrings: "overflow-hidden" contains
  // "hidden". Both columns flip on the same min-[901px] the grid does — see
  // the comment in AppShell for why max-[900px] cannot be paired with it.
  expect(getByTestId("roster-rail").classList.contains("hidden")).toBe(true);
  expect(getByTestId("roster-rail").classList.contains("min-[901px]:flex")).toBe(true);
  expect(getByTestId("stage").classList.contains("hidden")).toBe(false);
  expect(getByTestId("stage").classList.contains("flex")).toBe(true);

  await fireEvent.click(getByTestId("roster-toggle"));

  expect(getByTestId("roster-rail").classList.contains("hidden")).toBe(false);
  expect(getByTestId("stage").classList.contains("hidden")).toBe(true);
  expect(getByTestId("stage").classList.contains("min-[901px]:flex")).toBe(true);
});
