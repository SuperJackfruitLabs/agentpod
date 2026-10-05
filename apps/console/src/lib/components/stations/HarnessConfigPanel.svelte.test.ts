import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, within, cleanup } from "@testing-library/svelte";
import { ConfigObservation, ConfigSetting } from "@agentpod/contract";
import * as api from "$lib/api/harness-config";
import type { DeclaredConfigRow } from "$lib/api/harness-config";
import HarnessConfigPanel from "./HarnessConfigPanel.svelte";

const STATION_ID = "station_1";
const NODE_ID = "node_1";

/** A registry entry, with sane defaults a test can override. */
function setting(overrides: Partial<ConfigSetting>): ConfigSetting {
  return ConfigSetting.parse({
    id: "hermes.plugins.enabled",
    harness: "hermes",
    scope: "profile",
    policy: "reconcilable",
    restartToTakeEffect: false,
    ...overrides,
  });
}

/** An observation row, with sane defaults a test can override. */
function observation(overrides: Partial<ConfigObservation>): ConfigObservation {
  return ConfigObservation.parse({
    settingId: "hermes.plugins.enabled",
    stationId: STATION_ID,
    declared: true,
    observed: true,
    state: "matches",
    ...overrides,
  });
}

function declaredRow(overrides: Partial<DeclaredConfigRow>): DeclaredConfigRow {
  return {
    id: "dcfg_1",
    settingId: "hermes.plugins.enabled",
    stationId: null,
    nodeId: null,
    value: true,
    declaredBy: "user_1",
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    ...overrides,
  };
}

/** Wires the four calls the panel makes on load. Defaults to "nothing declared at station/node level" so a test opts into the level it wants to prove. */
function mockLoad(opts: {
  observations?: ConfigObservation[];
  settings?: ConfigSetting[];
  stationDeclared?: DeclaredConfigRow[];
  nodeDeclared?: DeclaredConfigRow[];
  configError?: unknown;
}) {
  const getStationConfig = vi.spyOn(api, "getStationConfig");
  if (opts.configError) getStationConfig.mockRejectedValue(opts.configError);
  else getStationConfig.mockResolvedValue({ observations: opts.observations ?? [] });

  vi.spyOn(api, "listConfigSettings").mockResolvedValue({
    settings: opts.settings ?? [setting({})],
    unreachableNodes: [],
  });
  vi.spyOn(api, "listStationDeclaredConfig").mockResolvedValue(opts.stationDeclared ?? []);
  vi.spyOn(api, "listNodeDeclaredConfig").mockResolvedValue(opts.nodeDeclared ?? []);
  return getStationConfig;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

test("matches: declared and observed agree, declared value traced to the station level", async () => {
  mockLoad({
    observations: [observation({ state: "matches", declared: true, observed: true })],
    settings: [setting({ id: "hermes.plugins.enabled" })],
    stationDeclared: [declaredRow({ settingId: "hermes.plugins.enabled", stationId: STATION_ID })],
  });
  const view = render(HarnessConfigPanel, { props: { stationId: STATION_ID, nodeId: NODE_ID } });
  await waitFor(() => expect(view.getByRole("row", { name: /hermes\.plugins\.enabled/ })).toBeTruthy());
  const row = view.getByRole("row", { name: /hermes\.plugins\.enabled/ });
  expect(row.textContent).toMatch(/Matches/);
  expect(row.textContent).toMatch(/station/);
});

test("drifted: shows both the declared and observed values, declared value traced to the node level", async () => {
  mockLoad({
    observations: [
      observation({
        settingId: "hermes.approvals.max",
        state: "drifted",
        declared: 300,
        observed: 900,
        reason: "declared 300, observed 900",
      }),
    ],
    settings: [setting({ id: "hermes.approvals.max" })],
    nodeDeclared: [declaredRow({ settingId: "hermes.approvals.max", nodeId: NODE_ID })],
  });
  const view = render(HarnessConfigPanel, { props: { stationId: STATION_ID, nodeId: NODE_ID } });
  await waitFor(() => expect(view.getByRole("row", { name: /hermes\.approvals\.max/ })).toBeTruthy());
  const row = view.getByRole("row", { name: /hermes\.approvals\.max/ });
  expect(row.textContent).toMatch(/Drifted/);
  expect(row.textContent).toMatch(/300/);
  expect(row.textContent).toMatch(/900/);
  expect(row.textContent).toMatch(/node/);
});

test("absent: declared, and the key is not in the document — traced to the fleet level by elimination", async () => {
  mockLoad({
    observations: [
      observation({
        settingId: "hermes.skills.external_dirs",
        state: "absent",
        declared: ["/srv/skills"],
        observed: undefined,
        reason: "declared, and the key is not in the document",
      }),
    ],
    settings: [setting({ id: "hermes.skills.external_dirs", policy: "additive-only" })],
    // Neither the station nor the node list names this setting, so it can
    // only be a fleet-level declaration — compare() never reports a setting
    // nobody declared anywhere.
    stationDeclared: [],
    nodeDeclared: [],
  });
  const view = render(HarnessConfigPanel, { props: { stationId: STATION_ID, nodeId: NODE_ID } });
  await waitFor(() => expect(view.getByRole("row", { name: /hermes\.skills\.external_dirs/ })).toBeTruthy());
  const row = view.getByRole("row", { name: /hermes\.skills\.external_dirs/ });
  expect(row.textContent).toMatch(/Absent/);
  expect(row.textContent).toMatch(/fleet/);
  expect(row.textContent).toMatch(/not in the document/);
});

test("unreadable: never reads as agreement, even though a value was declared", async () => {
  mockLoad({
    observations: [
      observation({
        settingId: "hermes.plugins.stream_reasoning_deltas",
        state: "unreadable",
        declared: true,
        observed: undefined,
        reason: "the document could not be read",
      }),
    ],
    settings: [setting({ id: "hermes.plugins.stream_reasoning_deltas" })],
  });
  const view = render(HarnessConfigPanel, { props: { stationId: STATION_ID, nodeId: NODE_ID } });
  await waitFor(() => expect(view.getByRole("row", { name: /hermes\.plugins\.stream_reasoning_deltas/ })).toBeTruthy());
  const row = view.getByRole("row", { name: /hermes\.plugins\.stream_reasoning_deltas/ });
  const stateCell = within(row).getAllByRole("cell").at(-1)!;
  // The state label itself must say "Unreadable" — never "Matches" and never
  // silently blank. This is the assertion Step 5's mutation must break.
  expect(stateCell.textContent).toMatch(/Unreadable/);
  expect(stateCell.textContent).not.toMatch(/Matches/);
  expect(row.textContent).toMatch(/could not be read/);
});

test("out-of-scope: names why this declaration cannot apply to this station", async () => {
  mockLoad({
    observations: [
      observation({
        settingId: "openclaw.hooks.allowConversationAccess",
        state: "out-of-scope",
        declared: true,
        observed: true,
        reason: "openclaw.hooks.allowConversationAccess is user-scoped: declaring it for one station would change its siblings on the same host",
      }),
    ],
    settings: [setting({ id: "openclaw.hooks.allowConversationAccess", harness: "openclaw", scope: "user", policy: "report-only" })],
    stationDeclared: [declaredRow({ settingId: "openclaw.hooks.allowConversationAccess", stationId: STATION_ID })],
  });
  const view = render(HarnessConfigPanel, { props: { stationId: STATION_ID, nodeId: NODE_ID } });
  await waitFor(() => expect(view.getByRole("row", { name: /allowConversationAccess/ })).toBeTruthy());
  const row = view.getByRole("row", { name: /allowConversationAccess/ });
  expect(row.textContent).toMatch(/Out of scope/);
  expect(row.textContent).toMatch(/would change its siblings/);
});

test("opted-out: shows the exemption reason", async () => {
  mockLoad({
    observations: [
      observation({
        settingId: "hermes.plugins.disabled_list",
        state: "opted-out",
        declared: ["x"],
        observed: ["y"],
        reason: "an operator opted this setting out of reconciliation",
      }),
    ],
    settings: [setting({ id: "hermes.plugins.disabled_list" })],
  });
  const view = render(HarnessConfigPanel, { props: { stationId: STATION_ID, nodeId: NODE_ID } });
  await waitFor(() => expect(view.getByRole("row", { name: /disabled_list/ })).toBeTruthy());
  const row = view.getByRole("row", { name: /disabled_list/ });
  expect(row.textContent).toMatch(/Opted out/);
  expect(row.textContent).toMatch(/operator opted this setting out/);
});

test("awaiting-restart: written but not yet live, and states agentpod will not restart the harness", async () => {
  mockLoad({
    observations: [
      observation({
        settingId: "hermes.approvals.timeout",
        state: "awaiting-restart",
        declared: 900,
        observed: 300,
        reason: "written, and needs a restart to take effect — the gateway has not restarted since",
      }),
    ],
    settings: [setting({ id: "hermes.approvals.timeout", restartToTakeEffect: true })],
  });
  const onRestart = vi.fn();
  const view = render(HarnessConfigPanel, { props: { stationId: STATION_ID, nodeId: NODE_ID, onRestart } });
  await waitFor(() => expect(view.getByRole("row", { name: /approvals\.timeout/ })).toBeTruthy());
  const row = view.getByRole("row", { name: /approvals\.timeout/ });
  expect(row.textContent).toMatch(/Awaiting restart/);
  // The panel states plainly it will not restart anything — in the banner
  // and the row alike, so the assertion allows either or both.
  expect(view.getAllByText(/agentpod will not restart the harness/).length).toBeGreaterThan(0);
  // It never performs the restart itself — only a button wired to the
  // caller's own control, which the test confirms was never invoked.
  expect(onRestart).not.toHaveBeenCalled();
});

test("nothing declared shows an empty state, not an error", async () => {
  mockLoad({ observations: [] });
  const view = render(HarnessConfigPanel, { props: { stationId: STATION_ID, nodeId: NODE_ID } });
  await waitFor(() => expect(view.getByText(/No settings declared for this station/)).toBeTruthy());
  expect(view.queryByRole("alert")).toBeNull();
});

test("an unreachable station says so, and a later failure does not leave the previous station's values on screen", async () => {
  const getStationConfig = vi.spyOn(api, "getStationConfig");
  vi.spyOn(api, "listConfigSettings").mockResolvedValue({
    settings: [setting({ id: "hermes.plugins.enabled" })],
    unreachableNodes: [],
  });
  vi.spyOn(api, "listStationDeclaredConfig").mockResolvedValue([]);
  vi.spyOn(api, "listNodeDeclaredConfig").mockResolvedValue([]);

  getStationConfig.mockResolvedValueOnce({
    observations: [observation({ settingId: "hermes.plugins.enabled", state: "matches" })],
  });
  const view = render(HarnessConfigPanel, { props: { stationId: "first", nodeId: NODE_ID } });
  await waitFor(() => expect(view.getByRole("row", { name: /hermes\.plugins\.enabled/ })).toBeTruthy());

  getStationConfig.mockRejectedValueOnce(new Error("the node could not be reached"));
  await view.rerender({ stationId: "second", nodeId: NODE_ID });
  await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
  expect(view.getByRole("alert").textContent).toMatch(/node could not be reached/);
  expect(view.queryByRole("row", { name: /hermes\.plugins\.enabled/ })).toBeNull();
});
