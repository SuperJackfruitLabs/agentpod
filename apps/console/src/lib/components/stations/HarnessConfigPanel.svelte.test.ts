import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, within, fireEvent, cleanup } from "@testing-library/svelte";
import { ConfigObservation, ConfigPlan, ConfigReceipt, ConfigSetting } from "@agentpod/contract";
import * as api from "$lib/api/harness-config";
import type { ConfigOptOutRow } from "$lib/api/harness-config";
import { ApiError } from "$lib/api/http-error";
import HarnessConfigPanel from "./HarnessConfigPanel.svelte";

const STATION_ID = "station_1";
const NODE_ID = "node_1";
const STATION_KEY = "hermes:fixture";

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
    level: "station",
    state: "matches",
    ...overrides,
  });
}

/** A reviewed plan, with sane defaults a test can override. */
function plan(overrides: Partial<ConfigPlan>): ConfigPlan {
  return ConfigPlan.parse({
    schemaVersion: 1,
    operationId: "cfgop_1",
    stationKey: "hermes:fixture",
    entries: [
      {
        settingId: "hermes.command_timeout_ms",
        file: "/profiles/fixture/config.yaml",
        keyPath: "command_timeout_ms",
        policy: "reconcilable",
        current: 300,
        intended: 900,
        action: "modify",
        restartToTakeEffect: false,
      },
    ],
    beforeSha256: "a".repeat(64),
    diff: "-command_timeout_ms: 300\n+command_timeout_ms: 900\n",
    diffTruncated: false,
    noOp: false,
    restartRequired: false,
    createdAt: "2026-10-05T00:00:00.000Z",
    planDigest: "digest_1",
    ...overrides,
  });
}

/** An apply receipt, with sane defaults a test can override. */
function receipt(overrides: Partial<ConfigReceipt>): ConfigReceipt {
  return ConfigReceipt.parse({
    plan: plan({}),
    phase: "applied",
    updatedAt: "2026-10-05T00:00:01.000Z",
    written: [{ settingId: "hermes.command_timeout_ms", action: "modify", wrote: 900 }],
    ...overrides,
  });
}

/** One row of the opt-out register, with sane defaults a test can override. */
function optOutRow(overrides: Partial<ConfigOptOutRow>): ConfigOptOutRow {
  return {
    id: "optout_1",
    settingId: "hermes.plugins.enabled",
    stationKey: null,
    nodeId: null,
    optedOut: true,
    reason: null,
    optedOutBy: "user_1",
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    ...overrides,
  };
}

/** Wires the four calls the panel makes on load. Defaults to "nothing exempted at station/node level" so a test opts into the register row it wants to prove. */
function mockLoad(opts: {
  observations?: ConfigObservation[];
  settings?: ConfigSetting[];
  stationOptOuts?: ConfigOptOutRow[];
  nodeOptOuts?: ConfigOptOutRow[];
  configError?: unknown;
}) {
  const getStationConfig = vi.spyOn(api, "getStationConfig");
  if (opts.configError) getStationConfig.mockRejectedValue(opts.configError);
  else getStationConfig.mockResolvedValue({ observations: opts.observations ?? [] });

  vi.spyOn(api, "listConfigSettings").mockResolvedValue({
    settings: opts.settings ?? [setting({})],
    unreachableNodes: [],
  });
  vi.spyOn(api, "listConfigOptOuts").mockImplementation(async (filter) => {
    if (filter?.stationKey) return opts.stationOptOuts ?? [];
    if (filter?.nodeId) return opts.nodeOptOuts ?? [];
    return [];
  });
  return getStationConfig;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

test("matches: declared and observed agree, declared value traced to the station level", async () => {
  mockLoad({
    observations: [observation({ state: "matches", declared: true, observed: true, level: "station" })],
    settings: [setting({ id: "hermes.plugins.enabled" })],
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
        level: "node",
        reason: "declared 300, observed 900",
      }),
    ],
    settings: [setting({ id: "hermes.approvals.max" })],
  });
  const view = render(HarnessConfigPanel, { props: { stationId: STATION_ID, nodeId: NODE_ID } });
  await waitFor(() => expect(view.getByRole("row", { name: /hermes\.approvals\.max/ })).toBeTruthy());
  const row = view.getByRole("row", { name: /hermes\.approvals\.max/ });
  expect(row.textContent).toMatch(/Drifted/);
  expect(row.textContent).toMatch(/300/);
  expect(row.textContent).toMatch(/900/);
  expect(row.textContent).toMatch(/node/);
});

test("absent: declared, and the key is not in the document — fleet level", async () => {
  mockLoad({
    observations: [
      observation({
        settingId: "hermes.skills.external_dirs",
        state: "absent",
        declared: ["/srv/skills"],
        observed: undefined,
        level: "fleet",
        reason: "declared, and the key is not in the document",
      }),
    ],
    settings: [setting({ id: "hermes.skills.external_dirs", policy: "additive-only" })],
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

// ─── Task 3: plan → review → apply, by digest (spec D13) ──────────────────

async function renderWithReview() {
  mockLoad({
    observations: [
      observation({ settingId: "hermes.command_timeout_ms", state: "drifted", declared: 900, observed: 300 }),
    ],
    settings: [setting({ id: "hermes.command_timeout_ms" })],
  });
  const view = render(HarnessConfigPanel, { props: { stationId: STATION_ID, nodeId: NODE_ID } });
  await waitFor(() => expect(view.getByRole("row", { name: /hermes\.command_timeout_ms/ })).toBeTruthy());
  await fireEvent.click(view.getByRole("button", { name: "Review changes" }));
  return view;
}

test("a refused plan shows its refusal code and message, and offers no apply button — OPTED_OUT", async () => {
  vi.spyOn(api, "planStationConfig").mockRejectedValue(
    new ApiError("An operator exempted this setting for this station.", {
      status: 400,
      detail: "POST /plan → 400",
      code: "OPTED_OUT",
    }),
  );
  const view = await renderWithReview();
  await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
  const text = view.getByRole("alert").textContent ?? "";
  expect(text).toMatch(/OPTED_OUT/);
  expect(text).toMatch(/exempted/);
  expect(view.queryByRole("button", { name: "Apply reviewed plan" })).toBeNull();
});

test("a refused plan shows its refusal code and message, and offers no apply button — CREDENTIAL_PATH, reads differently from OPTED_OUT", async () => {
  vi.spyOn(api, "planStationConfig").mockRejectedValue(
    new ApiError("This key path is a credential file.", {
      status: 400,
      detail: "POST /plan → 400",
      code: "CREDENTIAL_PATH",
    }),
  );
  const view = await renderWithReview();
  await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
  const text = view.getByRole("alert").textContent ?? "";
  expect(text).toMatch(/CREDENTIAL_PATH/);
  expect(text).not.toMatch(/OPTED_OUT/);
  expect(text).not.toMatch(/exempted/);
  expect(view.queryByRole("button", { name: "Apply reviewed plan" })).toBeNull();
});

test("a noOp plan offers no apply — nothing to write means nothing to review", async () => {
  vi.spyOn(api, "planStationConfig").mockResolvedValue(
    plan({ noOp: true, entries: [], diff: "", restartRequired: false }),
  );
  const view = await renderWithReview();
  await waitFor(() => expect(view.getByText(/Nothing to change/)).toBeTruthy());
  expect(view.queryByRole("button", { name: "Apply reviewed plan" })).toBeNull();
});

test("a partially-opted-out plan names each refused setting beside the plannable entries", async () => {
  // The plan route spreads `refused` onto the node's own `ConfigPlan` only
  // when at least one requested setting was opted out before the node was
  // ever asked to plan anything (apps/hub/src/routes/harness-config.ts) —
  // the rest of a mixed request still gets planned normally.
  vi.spyOn(api, "planStationConfig").mockResolvedValue(
    plan({
      refused: [
        {
          settingId: "hermes.approvals.command_allowlist",
          code: "OPTED_OUT",
          message: "an operator opted this setting out of reconciliation",
        },
      ],
    }),
  );
  const view = await renderWithReview();
  await waitFor(() => expect(view.getByText(/hermes\.approvals\.command_allowlist/)).toBeTruthy());
  const section = view.getByRole("region", { name: /Review and apply changes/i });
  expect(section.textContent).toMatch(/OPTED_OUT/);
  expect(section.textContent).toMatch(/an operator opted this setting out of reconciliation/);
  // The plannable entry from `plan()`'s own default fixture is still shown —
  // a refusal for one setting does not hide the rest of the plan.
  expect(section.textContent).toMatch(/hermes\.command_timeout_ms/);
  // And apply is still offered, because the refusal did not make this a noOp.
  expect(view.getByRole("button", { name: "Apply reviewed plan" })).toBeTruthy();
});

test("a stale apply is the hub's answer, not a crash, and the panel never silently re-plans and applies", async () => {
  const planSpy = vi.spyOn(api, "planStationConfig").mockResolvedValue(plan({}));
  const applySpy = vi.spyOn(api, "applyStationConfig").mockRejectedValue(
    new ApiError("That conflicts with the hub's current state — refresh and try again.", {
      status: 409,
      detail: "POST /apply → 409",
      code: "PLAN_DIGEST_MISMATCH",
    }),
  );
  const view = await renderWithReview();
  await waitFor(() => expect(view.getByRole("button", { name: "Apply reviewed plan" })).toBeTruthy());
  await fireEvent.click(view.getByRole("button", { name: "Apply reviewed plan" }));
  await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
  expect(view.getByRole("alert").textContent).toMatch(/document changed/i);
  expect(view.getByRole("alert").textContent).toMatch(/plan again/i);
  // Exactly one plan call and one apply call: the panel did not quietly ask
  // for a fresh plan and apply it on its own.
  expect(planSpy).toHaveBeenCalledTimes(1);
  expect(applySpy).toHaveBeenCalledTimes(1);
  // And it must not keep offering apply against the now-refused plan.
  expect(view.queryByRole("button", { name: "Apply reviewed plan" })).toBeNull();
});

test("restartRequired is surfaced before the apply, and after a successful apply the row reads awaiting-restart", async () => {
  const getStationConfig = vi.spyOn(api, "getStationConfig").mockResolvedValue({
    observations: [
      observation({ settingId: "hermes.approvals.timeout", state: "drifted", declared: 900, observed: 300 }),
    ],
  });
  vi.spyOn(api, "listConfigSettings").mockResolvedValue({
    settings: [setting({ id: "hermes.approvals.timeout", restartToTakeEffect: true })],
    unreachableNodes: [],
  });
  vi.spyOn(api, "planStationConfig").mockResolvedValue(
    plan({
      restartRequired: true,
      entries: [
        {
          settingId: "hermes.approvals.timeout",
          file: "/profiles/fixture/config.yaml",
          keyPath: "approvals.timeout",
          policy: "reconcilable",
          current: 300,
          intended: 900,
          action: "modify",
          restartToTakeEffect: true,
        },
      ],
    }),
  );
  const applySpy = vi.spyOn(api, "applyStationConfig").mockResolvedValue(receipt({ phase: "applied" }));
  const onRestart = vi.fn();

  const view = render(HarnessConfigPanel, { props: { stationId: STATION_ID, nodeId: NODE_ID, onRestart } });
  const declaredTable = () => view.getByRole("table", { name: /Declared harness configuration/ });
  await waitFor(() => expect(within(declaredTable()).getByRole("row", { name: /approvals\.timeout/ })).toBeTruthy());
  await fireEvent.click(view.getByRole("button", { name: "Review changes" }));
  await waitFor(() => expect(view.getByRole("button", { name: "Apply reviewed plan" })).toBeTruthy());

  // Surfaced BEFORE the apply click.
  expect(view.getAllByText(/agentpod will not restart the harness/).length).toBeGreaterThan(0);

  // The next read (after apply) reports the setting as written but not yet live.
  getStationConfig.mockResolvedValueOnce({
    observations: [
      observation({
        settingId: "hermes.approvals.timeout",
        state: "awaiting-restart",
        declared: 900,
        observed: 300,
        reason: "written, and needs a restart to take effect",
      }),
    ],
  });

  await fireEvent.click(view.getByRole("button", { name: "Apply reviewed plan" }));
  expect(applySpy).toHaveBeenCalledOnce();

  await waitFor(() =>
    expect(within(declaredTable()).getByRole("row", { name: /approvals\.timeout/ }).textContent).toMatch(
      /Awaiting restart/,
    ),
  );
  const row = within(declaredTable()).getByRole("row", { name: /approvals\.timeout/ });
  expect(row.textContent).toMatch(/Awaiting restart/);
  expect(view.getAllByText(/agentpod will not restart the harness/).length).toBeGreaterThan(0);
  expect(onRestart).not.toHaveBeenCalled();
});

test("a double click cannot double-apply: the second click is ignored while the first is in flight", async () => {
  vi.spyOn(api, "planStationConfig").mockResolvedValue(plan({}));
  let resolveApply!: (value: ConfigReceipt) => void;
  const applySpy = vi.spyOn(api, "applyStationConfig").mockReturnValue(
    new Promise<ConfigReceipt>((resolve) => {
      resolveApply = resolve;
    }),
  );
  const view = await renderWithReview();
  await waitFor(() => expect(view.getByRole("button", { name: "Apply reviewed plan" })).toBeTruthy());
  const button = view.getByRole("button", { name: "Apply reviewed plan" });
  await fireEvent.click(button);
  await fireEvent.click(button);
  resolveApply(receipt({ phase: "applied" }));
  await waitFor(() => expect(view.getByText(/Applied\./)).toBeTruthy());
  expect(applySpy).toHaveBeenCalledTimes(1);
});

test("apply sends the digest of the DISPLAYED plan, never a digest fetched or re-derived at apply time", async () => {
  // Two different digests from two successive plan calls. The panel must
  // show the FIRST one and send exactly that — never ask for a second plan
  // to apply against, which is the regression Step 4 of the plan exists to
  // catch (D13).
  const planSpy = vi
    .spyOn(api, "planStationConfig")
    .mockResolvedValueOnce(plan({ planDigest: "digest-displayed", operationId: "cfgop_displayed" }))
    .mockResolvedValueOnce(plan({ planDigest: "digest-fresh-and-wrong", operationId: "cfgop_fresh" }));
  const applySpy = vi.spyOn(api, "applyStationConfig").mockResolvedValue(receipt({ phase: "applied" }));
  const view = await renderWithReview();
  await waitFor(() => expect(view.getByText("digest-displayed")).toBeTruthy());
  await fireEvent.click(view.getByRole("button", { name: "Apply reviewed plan" }));
  await waitFor(() => expect(applySpy).toHaveBeenCalledOnce());
  expect(applySpy).toHaveBeenCalledWith(STATION_ID, "cfgop_displayed", "digest-displayed");
  // The apply must not have triggered a second plan call either.
  expect(planSpy).toHaveBeenCalledTimes(1);
});

// ─── Task 4: exemptions, read-only (spec D13 / D11, D9's station-beats-node) ──

test("opted-out exempted at the station level: shows the station level, who recorded it, and the reason", async () => {
  mockLoad({
    observations: [
      observation({
        settingId: "hermes.plugins.enabled",
        state: "opted-out",
        declared: true,
        observed: false,
        reason: "an operator opted this setting out of reconciliation",
      }),
    ],
    settings: [setting({ id: "hermes.plugins.enabled" })],
    stationOptOuts: [
      optOutRow({
        settingId: "hermes.plugins.enabled",
        stationKey: STATION_KEY,
        nodeId: null,
        optedOut: true,
        reason: "customer asked us not to touch this",
        optedOutBy: "user_alice",
      }),
    ],
  });
  const view = render(HarnessConfigPanel, {
    props: { stationId: STATION_ID, nodeId: NODE_ID, stationKey: STATION_KEY },
  });
  await waitFor(() => expect(view.getByRole("row", { name: /hermes\.plugins\.enabled/ })).toBeTruthy());
  const row = view.getByRole("row", { name: /hermes\.plugins\.enabled/ });
  expect(row.textContent).toMatch(/station/i);
  expect(row.textContent).toMatch(/user_alice/);
  expect(row.textContent).toMatch(/customer asked us not to touch this/);
});

test("opted-out exempted at the node level: says it came from the node", async () => {
  mockLoad({
    observations: [
      observation({
        settingId: "hermes.approvals.max",
        state: "opted-out",
        declared: 300,
        observed: 900,
      }),
    ],
    settings: [setting({ id: "hermes.approvals.max" })],
    nodeOptOuts: [
      optOutRow({
        settingId: "hermes.approvals.max",
        stationKey: null,
        nodeId: NODE_ID,
        optedOut: true,
        reason: "node-wide exemption while the fleet migrates",
        optedOutBy: "user_bob",
      }),
    ],
  });
  const view = render(HarnessConfigPanel, {
    props: { stationId: STATION_ID, nodeId: NODE_ID, stationKey: STATION_KEY },
  });
  await waitFor(() => expect(view.getByRole("row", { name: /hermes\.approvals\.max/ })).toBeTruthy());
  const row = view.getByRole("row", { name: /hermes\.approvals\.max/ });
  expect(row.textContent).toMatch(/node/i);
  expect(row.textContent).toMatch(/user_bob/);
  expect(row.textContent).toMatch(/node-wide exemption while the fleet migrates/);
});

test("opted-out at both station and node level attributes it to the station — precedence", async () => {
  mockLoad({
    observations: [observation({ settingId: "hermes.plugins.enabled", state: "opted-out" })],
    settings: [setting({ id: "hermes.plugins.enabled" })],
    stationOptOuts: [
      optOutRow({
        settingId: "hermes.plugins.enabled",
        stationKey: STATION_KEY,
        nodeId: null,
        optedOut: true,
        reason: "station reason",
        optedOutBy: "user_station",
      }),
    ],
    nodeOptOuts: [
      optOutRow({
        settingId: "hermes.plugins.enabled",
        stationKey: null,
        nodeId: NODE_ID,
        optedOut: true,
        reason: "node reason",
        optedOutBy: "user_node",
      }),
    ],
  });
  const view = render(HarnessConfigPanel, {
    props: { stationId: STATION_ID, nodeId: NODE_ID, stationKey: STATION_KEY },
  });
  await waitFor(() => expect(view.getByRole("row", { name: /hermes\.plugins\.enabled/ })).toBeTruthy());
  const row = view.getByRole("row", { name: /hermes\.plugins\.enabled/ });
  expect(row.textContent).toMatch(/station/i);
  expect(row.textContent).toMatch(/user_station/);
  expect(row.textContent).toMatch(/station reason/);
  expect(row.textContent).not.toMatch(/user_node/);
  expect(row.textContent).not.toMatch(/node reason/);
});

test("the harness's own opt-out reads differently from an agentpod exemption", async () => {
  mockLoad({
    observations: [
      observation({
        settingId: "hermes.plugins.disabled_list",
        state: "opted-out",
        declared: ["x"],
        observed: ["y"],
        // The exact wording compare() produces (apps/hub/src/services/harness-config.ts)
        // for the harness-sourced branch — the fixed "not an agentpod exemption" suffix
        // is the one signal the panel actually reads to tell this apart from the hub's
        // own register (see HarnessConfigPanel's `harnessNamedAsSource`).
        reason: "hermes itself reports this setting disabled (its own plugins.disabled) — not an agentpod exemption",
      }),
    ],
    settings: [setting({ id: "hermes.plugins.disabled_list" })],
    // Nothing in agentpod's own register at either level — this exemption
    // did not come from `fleet config opt-out` or the API.
    stationOptOuts: [],
    nodeOptOuts: [],
  });
  const view = render(HarnessConfigPanel, {
    props: { stationId: STATION_ID, nodeId: NODE_ID, stationKey: STATION_KEY },
  });
  await waitFor(() => expect(view.getByRole("row", { name: /disabled_list/ })).toBeTruthy());
  const row = view.getByRole("row", { name: /disabled_list/ });
  expect(row.textContent).toMatch(/hermes/i);
  expect(row.textContent).toMatch(/harness's own record/i);
  // It must not claim this was recorded in agentpod's register, because agentpod never wrote it.
  expect(row.textContent).not.toMatch(/recorded by/i);
  expect(row.textContent).not.toMatch(/opt-out register/i);
});

test("a row with no exemption shows no exemption chrome at all", async () => {
  mockLoad({
    observations: [observation({ settingId: "hermes.plugins.enabled", state: "matches" })],
    settings: [setting({ id: "hermes.plugins.enabled" })],
  });
  const view = render(HarnessConfigPanel, {
    props: { stationId: STATION_ID, nodeId: NODE_ID, stationKey: STATION_KEY },
  });
  await waitFor(() => expect(view.getByRole("row", { name: /hermes\.plugins\.enabled/ })).toBeTruthy());
  const row = view.getByRole("row", { name: /hermes\.plugins\.enabled/ });
  expect(row.textContent).not.toMatch(/exempted/i);
  expect(row.textContent).not.toMatch(/opt-out register/i);
  expect(row.textContent).not.toMatch(/harness's own record/i);
});
