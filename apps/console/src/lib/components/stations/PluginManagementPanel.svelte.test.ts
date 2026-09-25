import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import { SkillHubOperation } from "@agentpod/contract";
import { pluginPlanFixture, pluginRefusalFixture } from "../../../../../../packages/contract/src/fixtures/plugin-operation";
import * as api from "$lib/api/plugins";
import PluginManagementPanel from "./PluginManagementPanel.svelte";

function operation(state: string, plan: object = pluginPlanFixture, error: string | null = null) {
  const action = (plan as { action: string }).action;
  return SkillHubOperation.parse({
    id: pluginPlanFixture.operationId, stationId: "station_1", nodeId: "node_fixture", stationKey: "hermes:fixture",
    harness: "hermes", profile: "agentpod-live", kind: "plugin", action, artifactId: null, state, error,
    inFlight: false, createdAt: pluginPlanFixture.createdAt, updatedAt: pluginPlanFixture.createdAt, plan,
    receipt: state === "applied"
      ? { plan, phase: "applied", updatedAt: pluginPlanFixture.createdAt, completedAt: pluginPlanFixture.createdAt, error: null }
      : null,
  });
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "listPluginOperations").mockResolvedValue([]);
});
afterEach(cleanup);

test("shows the node's plan before applying exactly the reviewed digest, then offers the restart", async () => {
  const plan = vi.spyOn(api, "planPluginOperation").mockResolvedValue(operation("planned"));
  const apply = vi.spyOn(api, "applyPluginOperation").mockResolvedValue(operation("applied"));
  const onRestart = vi.fn();
  const view = render(PluginManagementPanel, { props: { stationId: "station_1", canManage: true, onRestart } });
  await waitFor(() => expect((view.getByRole("button", { name: "Review enable" }) as HTMLButtonElement).disabled).toBe(false));
  await fireEvent.click(view.getByRole("button", { name: "Review enable" }));
  await waitFor(() => expect(view.getByText("Ready for review")).toBeTruthy());
  expect(plan).toHaveBeenCalledWith("station_1", "enable", expect.any(String));
  expect(view.getByText(/Hermes 0\.21\.3: tested/)).toBeTruthy();
  expect(view.getByText(/Installs the plugin files: __init__\.py, plugin\.yaml/)).toBeTruthy();
  expect(view.getByLabelText("Configuration change").textContent).toContain("+     - agentpod-live");
  // Nothing restarts until asked.
  expect(view.queryByRole("button", { name: "Restart station…" })).toBeNull();
  await fireEvent.click(view.getByRole("button", { name: "Apply reviewed plan" }));
  await waitFor(() => expect(view.getByText("Applied")).toBeTruthy());
  expect(apply).toHaveBeenCalledWith("station_1", pluginPlanFixture.operationId, pluginPlanFixture.planDigest);
  expect(view.getByText(/restart the station to load the plugin/)).toBeTruthy();
  await fireEvent.click(view.getByRole("button", { name: "Restart station…" }));
  expect(onRestart).toHaveBeenCalledOnce();
});

test("a refusal names the node's reason and offers nothing to apply", async () => {
  vi.spyOn(api, "planPluginOperation").mockResolvedValue(operation("conflict", pluginRefusalFixture, pluginRefusalFixture.refusal));
  const view = render(PluginManagementPanel, { props: { stationId: "station_1", canManage: true } });
  await waitFor(() => expect((view.getByRole("button", { name: "Review disable" }) as HTMLButtonElement).disabled).toBe(false));
  await fireEvent.click(view.getByRole("button", { name: "Review disable" }));
  await waitFor(() => expect(view.getByText(/The node will not disable the plugin: .*no record of installing/)).toBeTruthy());
  expect(view.queryByRole("button", { name: "Apply reviewed plan" })).toBeNull();
});

test("without reach, history is visible but nothing can be planned", async () => {
  vi.spyOn(api, "listPluginOperations").mockResolvedValue([operation("applied")]);
  const view = render(PluginManagementPanel, { props: { stationId: "station_1", canManage: false } });
  await waitFor(() => expect(view.getByText(/agentpod-live · enable · Applied/)).toBeTruthy());
  expect(view.queryByRole("button", { name: "Review enable" })).toBeNull();
  expect(view.getByText(/Permission to change this station is required/)).toBeTruthy();
});
