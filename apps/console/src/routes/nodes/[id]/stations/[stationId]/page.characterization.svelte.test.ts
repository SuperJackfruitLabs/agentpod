/**
 * page.characterization.svelte.test.ts
 *
 * Pins the station page's rendered DOM before it is split into components (modularity plan,
 * Phase 6). Every child panel is replaced with a stub that renders the props it was handed, so
 * each snapshot holds the page's own markup and exactly what it passes to every panel, in every
 * tab, configuration section, width and load state.
 *
 * The serialisation drops Svelte's comment anchors (they mark where blocks start and carry no
 * content) and nothing else. Every input is fixed (the fleet snapshot, the clock, the viewport, the
 * caller's authority), so the snapshots do not depend on the machine or the environment.
 *
 * Run: cd apps/console && pnpm test src/routes/nodes/\[id\]/stations
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import type { StationRow } from "$lib/api/client";

const { pageStore, setUrl, fleetState, stubbed } = vi.hoisted(() => {
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
    stubbed: async (name: string) => (await import("$lib/test-utils/props-stub")).propsStub(name),
    pageStore: {
      subscribe(fn: (v: typeof value) => void) {
        fn(value);
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      },
    },
    setUrl: (search: string) => {
      value = { ...value, url: new URL(base + search) };
      for (const fn of subscribers) fn(value);
    },
    fleetState: {
      agents: [
        {
          stationId: "station_1",
          status: "running",
          nodeName: "alpha",
          agentVersion: "0.1.100",
        },
      ],
      nodes: [{ id: "node_1", name: "alpha", lastSeenAt: "2026-11-02T11:55:00Z" }],
    },
  };
});

vi.mock("$app/stores", () => ({
  page: pageStore,
  navigating: { subscribe: (fn: (v: null) => void) => (fn(null), () => {}) },
  updated: { subscribe: (fn: (v: boolean) => void) => (fn(false), () => {}) },
}));
vi.mock("$app/navigation", () => ({ goto: vi.fn<() => Promise<void>>() }));
vi.mock("svelte-sonner", () => ({ toast: { error: vi.fn<() => void>(), success: vi.fn<() => void>() } }));
vi.mock("$lib/api/my-grant", () => ({ myReach: vi.fn<() => Promise<{ mayGrantReach: boolean }>>(async () => ({ mayGrantReach: true })) }));
vi.mock("$lib/stores/fleet.svelte", () => ({
  fleet: {
    get agents() {
      return fleetState.agents;
    },
    get nodes() {
      return fleetState.nodes;
    },
  },
  refreshFleet: vi.fn<() => Promise<void>>(async () => {}),
}));

// Every panel the page hosts, stubbed to show what it is given.
vi.mock("$lib/components/stations/HealthPanel.svelte", () => stubbed("HealthPanel"));
vi.mock("$lib/components/stations/LogTail.svelte", () => stubbed("LogTail"));
vi.mock("$lib/components/stations/FileBrowser.svelte", () => stubbed("FileBrowser"));
vi.mock("$lib/components/stations/ConfigEditor.svelte", () => stubbed("ConfigEditor"));
vi.mock("$lib/components/stations/Terminal.svelte", () => stubbed("Terminal"));
vi.mock("$lib/components/stations/chat/ChatPanel.svelte", () => stubbed("ChatPanel"));
vi.mock("$lib/components/stations/CleanupPanel.svelte", () => stubbed("CleanupPanel"));
vi.mock("$lib/components/stations/SkillsPanel.svelte", () => stubbed("SkillsPanel"));
vi.mock("$lib/components/stations/SkillManagementPanel.svelte", () => stubbed("SkillManagementPanel"));
vi.mock("$lib/components/stations/PluginManagementPanel.svelte", () => stubbed("PluginManagementPanel"));
vi.mock("$lib/components/stations/HarnessConfigPanel.svelte", () => stubbed("HarnessConfigPanel"));
vi.mock("$lib/components/stations/McpProxyStatus.svelte", () => stubbed("McpProxyStatus"));
vi.mock("$lib/components/stations/ApprovalRulesPanel.svelte", () => stubbed("ApprovalRulesPanel"));
vi.mock("$lib/components/stations/ChangesetPanel.svelte", () => stubbed("ChangesetPanel"));
vi.mock("$lib/components/stations/TimelinePanel.svelte", () => stubbed("TimelinePanel"));
vi.mock("$lib/components/stations/PostureBanner.svelte", () => stubbed("PostureBanner"));
vi.mock("$lib/components/stations/ActivityPanel.svelte", () => stubbed("ActivityPanel"));
vi.mock("$lib/components/shell/ContextRail.svelte", () => stubbed("ContextRail"));

import { auth } from "$lib/stores/auth.svelte";
import { setContextRail } from "$lib/stores/context-rail.svelte";
import { stubProps } from "$lib/test-utils/props-stub";
import StationPage from "./page-characterization-host.svelte";

const ALL = [
  "acp",
  "health",
  "logs",
  "fs.read",
  "fs.write",
  "terminal",
  "lifecycle",
  "changeset",
  "cleanup",
  "skills.inventory",
  "skills.manage",
  "skills.native",
  "plugins.manage",
  "config.manage",
  "matrix.avatar",
] as StationRow["capabilities"];

function station(capabilities: StationRow["capabilities"], over: Partial<StationRow> = {}): StationRow {
  return {
    id: "station_1",
    userId: "user_1",
    nodeId: "node_1",
    harness: "hermes",
    stationKey: "hermes://default",
    kind: "composite",
    parentStationId: null,
    displayName: "Workspace",
    workspacePath: "/home/user/workspace",
    capabilities,
    matrixId: "@workspace:example.org",
    bridgeMatrixId: null,
    matrixIdentityMode: "harness" as const,
    purpose: null,
    principalId: null,
    adoptedAt: "2026-06-22T00:00:00Z",
    createdAt: "2026-06-22T00:00:00Z",
    ...over,
  };
}

const realMatchMedia = window.matchMedia;
const maxWidth = (q: string) => Number(/max-width:\s*(\d+)px/.exec(q)?.[1] ?? Infinity);
function atWidth(width: number) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: width <= maxWidth(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/** The document as rendered, without Svelte's comment anchors, without bits-ui's transient
 *  animation markers (`data-starting-style`/`data-ending-style` last one frame, so whether a
 *  snapshot catches one depends on machine load), and with bits-ui's counter ids numbered by first
 *  appearance (so the output does not depend on how many dialogs any earlier test opened). The context rail the page hands the shell is rendered beside it by the host. */
function dom(): string {
  const ids = new Map<string, string>();
  return document.body.innerHTML
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/ data-(starting|ending)-style=""/g, "")
    .replace(/bits-[A-Za-z0-9]+/g, (id) => {
      const known = ids.get(id);
      if (known !== undefined) return known;
      const next = `bits-${ids.size + 1}`;
      ids.set(id, next);
      return next;
    });
}

async function shown(search: string, ready: () => void) {
  setUrl(search);
  await waitFor(ready);
  // Let every effect and microtask settle before reading the DOM.
  await new Promise((r) => setTimeout(r, 0));
  return dom();
}

const tab = (name: string) => () =>
  expect(
    document.querySelector(`[role=tab][aria-label="${name}"]`)?.getAttribute("aria-selected"),
  ).toBe("true");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-02T12:00:00Z") });
  setUrl("");
  setContextRail(null);
  window.matchMedia = realMatchMedia;
  vi.spyOn(auth, "isWorkspaceAdmin", "get").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  setContextRail(null);
  window.matchMedia = realMatchMedia;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("an admin on a station with every capability: each tab and configuration section", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(ALL)]);
  render(StationPage);
  const out: Record<string, string> = {};
  out.chat = await shown("", tab("Chat"));
  for (const [id, name] of [
    ["health", "Health"],
    ["logs", "Logs"],
    ["files", "Files"],
    ["terminal", "Terminal"],
    ["config", "Configuration"],
    ["changes", "Changes"],
    ["cleanup", "Cleanup"],
    ["activity", "Activity"],
  ] as const) {
    out[id] = await shown(`?tab=${id}`, tab(name));
  }
  out.plugins = await shown("?tab=config&section=plugins", tab("Configuration"));
  out.skills = await shown("?tab=config&section=skills", tab("Configuration"));
  for (const [k, v] of Object.entries(out)) expect(v).toMatchSnapshot(k);
});

test("a station with only health: the default tab and the notes for logs and files", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([
    station(["health"], { harness: "claude", matrixIdentityMode: "bridge", matrixId: null }),
  ]);
  render(StationPage);
  expect(await shown("", tab("Health"))).toMatchSnapshot("health");
  expect(await shown("?tab=logs", tab("Logs"))).toMatchSnapshot("logs");
  expect(await shown("?tab=files", tab("Files"))).toMatchSnapshot("files");
});

test("a Salaam station: the timeline tab and approval rules in settings", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([
    station(["acp", "health", "lifecycle", "config.manage"], { harness: "salaam" }),
  ]);
  render(StationPage);
  expect(await shown("?tab=timeline", tab("Timeline"))).toMatchSnapshot("timeline");
  expect(await shown("?tab=config", tab("Configuration"))).toMatchSnapshot("config");
});

test("a station with skills but no configuration management", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "skills.inventory"])]);
  render(StationPage);
  expect(await shown("?tab=config", tab("Configuration"))).toMatchSnapshot("config");
});

test("a workspace member", async () => {
  vi.spyOn(auth, "isWorkspaceAdmin", "get").mockReturnValue(false);
  vi.spyOn(api, "listStations").mockResolvedValue([station(ALL)]);
  render(StationPage);
  expect(await shown("", tab("Chat"))).toMatchSnapshot("chat");
  expect(await shown("?tab=config", tab("Configuration"))).toMatchSnapshot("config");
  expect(await shown("?tab=files", tab("Files"))).toMatchSnapshot("files");
});

test("a workspace member on a Salaam station", async () => {
  vi.spyOn(auth, "isWorkspaceAdmin", "get").mockReturnValue(false);
  vi.spyOn(api, "listStations").mockResolvedValue([
    station(["acp", "health", "lifecycle", "config.manage"], { harness: "salaam" }),
  ]);
  render(StationPage);
  expect(await shown("?tab=timeline", tab("Timeline"))).toMatchSnapshot("timeline");
  expect(await shown("?tab=config", tab("Configuration"))).toMatchSnapshot("config");
});

test("between 901 and 1240px: the Identity tab", async () => {
  atWidth(1000);
  vi.spyOn(api, "listStations").mockResolvedValue([station(ALL)]);
  render(StationPage);
  expect(await shown("?tab=identity", tab("Identity"))).toMatchSnapshot("identity");
});

test("on a phone: the About sheet", async () => {
  atWidth(390);
  vi.spyOn(api, "listStations").mockResolvedValue([station(ALL)]);
  const { getByRole } = render(StationPage);
  expect(await shown("", tab("Chat"))).toMatchSnapshot("closed");
  await fireEvent.click(getByRole("button", { name: /About Workspace/ }));
  await waitFor(() => expect(document.querySelector("[data-testid=station-about]")).toBeTruthy());
  await new Promise((r) => setTimeout(r, 0));
  expect(dom()).toMatchSnapshot("about");
});

test("Restart in the header opens the confirm", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(ALL)]);
  const { getAllByRole } = render(StationPage);
  await shown("?tab=health", tab("Health"));
  await fireEvent.click(getAllByRole("button", { name: "Restart" })[0]);
  await waitFor(() => expect(document.body.textContent).toContain("Restart agent"));
  await new Promise((r) => setTimeout(r, 0));
  expect(dom()).toMatchSnapshot("confirm");
});

test("Edit (diff) in the file browser opens the config editor dialog", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(ALL)]);
  render(StationPage);
  await shown("?tab=files", tab("Files"));
  const open = stubProps.get("FileBrowser")?.onOpenConfigEditor;
  if (typeof open !== "function") throw new Error("FileBrowser was given no onOpenConfigEditor");
  open("/home/user/.hermes/config.yaml");
  await waitFor(() => expect(document.querySelector("[data-stub=ConfigEditor]")).toBeTruthy());
  await new Promise((r) => setTimeout(r, 0));
  expect(dom()).toMatchSnapshot("editor");
});

test("a station the node no longer has", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([]);
  render(StationPage);
  expect(
    await shown("", () => expect(document.querySelector("[data-testid=station-not-found]")).toBeTruthy()),
  ).toMatchSnapshot("not-found");
});

test("a station list that fails to load", async () => {
  vi.spyOn(api, "listStations").mockRejectedValue(new Error("hub unreachable"));
  render(StationPage);
  expect(
    await shown("", () => expect(document.body.textContent).toContain("hub unreachable")),
  ).toMatchSnapshot("error");
});

test("while the station list loads", async () => {
  vi.spyOn(api, "listStations").mockReturnValue(new Promise(() => {}));
  render(StationPage);
  expect(
    await shown("", () =>
      expect(document.querySelector("[data-testid=station-panels-loading]")).toBeTruthy(),
    ),
  ).toMatchSnapshot("loading");
});
