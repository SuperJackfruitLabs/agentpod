import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import { SkillHubOperation, SkillInstallPlan } from "@agentpod/contract";
import { planFixture } from "../../../../../../packages/contract/src/fixtures/skill-install";
import { placementFixture } from "../../../../../../packages/contract/src/fixtures/skill-placement";
import * as api from "$lib/api/skills";
import SkillManagementPanel from "./SkillManagementPanel.svelte";

const artifact = {
  id: "11111111-1111-4111-8111-111111111111",
  harness: "codex" as const,
  profile: "fixture",
  archiveSHA256: "d".repeat(64),
  size: 100,
  validation: "unverified" as const,
  createdAt: planFixture.createdAt,
};
function operation(state = "planned") {
  return SkillHubOperation.parse({
    id: planFixture.operationId,
    stationId: "station_1",
    nodeId: "fixture-node",
    stationKey: "codex:fixture",
    harness: "codex",
    profile: "fixture",
    kind: "managed",
    action: "install",
    artifactId: artifact.id,
    state,
    error: null,
    inFlight: false,
    createdAt: planFixture.createdAt,
    updatedAt: planFixture.createdAt,
    plan: planFixture,
    receipt:
      state === "applied"
        ? {
            plan: planFixture,
            phase: "applied",
            updatedAt: planFixture.createdAt,
            completedAt: planFixture.createdAt,
            error: null,
          }
        : null,
  });
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "listSkillArtifacts").mockResolvedValue([artifact]);
  vi.spyOn(api, "listSkillOperations").mockResolvedValue([]);
});
afterEach(cleanup);
const props = { stationId: "station_1", harness: "codex", canManage: true };

test("shows exact changes before applying the reviewed digest and keeps activation separate", async () => {
  vi.spyOn(api, "planSkillInstall").mockResolvedValue(operation());
  const apply = vi
    .spyOn(api, "applySkillOperation")
    .mockResolvedValue(operation("applied"));
  const view = render(SkillManagementPanel, { props });
  await waitFor(() =>
    expect(view.getByRole("option", { name: /fixture/ })).toBeTruthy(),
  );
  await fireEvent.change(view.getByLabelText("Artifact"), {
    target: { value: artifact.id },
  });
  await fireEvent.click(
    view.getByRole("button", { name: "Review installation" }),
  );
  await waitFor(() =>
    expect(view.getByText("skills/fixture/SKILL.md")).toBeTruthy(),
  );
  expect(apply).not.toHaveBeenCalled();
  await fireEvent.click(
    view.getByRole("button", { name: "Apply reviewed plan" }),
  );
  await waitFor(() =>
    expect(apply).toHaveBeenCalledWith(
      "station_1",
      planFixture.operationId,
      planFixture.planDigest,
    ),
  );
  await waitFor(() => expect(view.getByText("Files applied")).toBeTruthy());
  expect(view.getByText(/Activation pending/)).toBeTruthy();
});

test("native placement has its own explicit review action and history", async () => {
  const native = SkillHubOperation.parse({
    id: planFixture.operationId,
    stationId: "station_1",
    nodeId: "fixture-node",
    stationKey: "codex:fixture",
    harness: "codex",
    profile: "fixture",
    kind: "native",
    action: "activate",
    artifactId: null,
    state: "planned",
    error: null,
    inFlight: false,
    createdAt: planFixture.createdAt,
    updatedAt: planFixture.createdAt,
    plan: placementFixture,
    receipt: null,
  });
  vi.spyOn(api, "listNativeSkillOperations").mockResolvedValue([]);
  const plan = vi.spyOn(api, "planNativeSkillPlacement").mockResolvedValue(native);
  const view = render(SkillManagementPanel, { props: { ...props, canNative: true } });
  await waitFor(() => expect(view.getByRole("button", { name: "Review native activation" })).toBeTruthy());
  await fireEvent.input(view.getByLabelText("Profile"), { target: { value: "fixture" } });
  await fireEvent.click(view.getByRole("button", { name: "Review native activation" }));
  await waitFor(() => expect(plan).toHaveBeenCalledWith("station_1", "fixture", "activate", expect.any(String)));
  expect(view.getByText(/Native activate/)).toBeTruthy();
  expect(view.getByRole("heading", { name: "Native placement history" })).toBeTruthy();
});

test("uncertain application requires inspection before apply becomes available again", async () => {
  vi.spyOn(api, "planSkillInstall").mockResolvedValue(operation());
  vi.spyOn(api, "applySkillOperation").mockRejectedValue(
    new Error("connection lost"),
  );
  const inspect = vi
    .spyOn(api, "inspectSkillOperation")
    .mockResolvedValue(operation("applied"));
  const view = render(SkillManagementPanel, { props });
  await waitFor(() =>
    expect(view.getByRole("option", { name: /fixture/ })).toBeTruthy(),
  );
  await fireEvent.change(view.getByLabelText("Artifact"), {
    target: { value: artifact.id },
  });
  await fireEvent.click(
    view.getByRole("button", { name: "Review installation" }),
  );
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: "Apply reviewed plan" }),
    ).toBeTruthy(),
  );
  await fireEvent.click(
    view.getByRole("button", { name: "Apply reviewed plan" }),
  );
  await waitFor(() => expect(view.getByText("Outcome unknown")).toBeTruthy());
  expect(
    view.queryByRole("button", { name: "Apply reviewed plan" }),
  ).toBeNull();
  await fireEvent.click(
    view.getByRole("button", { name: "Inspect node outcome" }),
  );
  await waitFor(() =>
    expect(inspect).toHaveBeenCalledWith("station_1", planFixture.operationId),
  );
  await waitFor(() => expect(view.getByText("Files applied")).toBeTruthy());
});

test("planning retries preserve the request UUID when the response was lost", async () => {
  const plan = vi
    .spyOn(api, "planSkillInstall")
    .mockRejectedValueOnce(new Error("connection lost"))
    .mockResolvedValue(operation());
  const view = render(SkillManagementPanel, { props });
  await waitFor(() =>
    expect(view.getByRole("option", { name: /fixture/ })).toBeTruthy(),
  );
  await fireEvent.change(view.getByLabelText("Artifact"), {
    target: { value: artifact.id },
  });
  await fireEvent.click(
    view.getByRole("button", { name: "Review installation" }),
  );
  await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
  await fireEvent.click(view.getByRole("button", { name: "Retry planning" }));
  await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
  expect(plan.mock.calls[1]).toEqual(plan.mock.calls[0]);
});

test("station navigation discards a late plan and never offers it for another station", async () => {
  let finish!: (value: SkillHubOperation) => void;
  vi.spyOn(api, "planSkillInstall").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(SkillManagementPanel, { props });
  await waitFor(() =>
    expect(view.getByRole("option", { name: /fixture/ })).toBeTruthy(),
  );
  await fireEvent.change(view.getByLabelText("Artifact"), {
    target: { value: artifact.id },
  });
  await fireEvent.click(
    view.getByRole("button", { name: "Review installation" }),
  );
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  await view.rerender({ ...props, stationId: "station_2" });
  finish(operation());
  await waitFor(() =>
    expect(view.queryByText("skills/fixture/SKILL.md")).toBeNull(),
  );
  expect(
    view.queryByRole("button", { name: "Apply reviewed plan" }),
  ).toBeNull();
});

test("a denied reach grant leaves history visible and disables mutations", async () => {
  const view = render(SkillManagementPanel, {
    props: { ...props, canManage: false },
  });
  await waitFor(() =>
    expect(
      view.getByText(/Permission to change this station is required/),
    ).toBeTruthy(),
  );
  expect(
    view
      .getByRole("button", { name: "Review installation" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    view
      .getByRole("button", { name: "Review rollback" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(view.getByRole("heading", { name: "Recent operations" })).toBeTruthy();
});

test("rollback is a separate reviewed plan and file verification keeps unknown loading", async () => {
  const rollback = operation();
  rollback.action = "rollback";
  rollback.artifactId = null;
  const rollbackPlan = SkillInstallPlan.parse({
    ...planFixture,
    action: "rollback",
    before: planFixture.after,
    after: null,
    targetPath: null,
    changes: { added: [], changed: [], removed: ["skills/fixture/SKILL.md"] },
  });
  rollback.plan = rollbackPlan;
  const plan = vi.spyOn(api, "planSkillRollback").mockResolvedValue(rollback);
  const apply = vi
    .spyOn(api, "applySkillOperation")
    .mockResolvedValue({
      ...rollback,
      state: "applied",
      receipt: {
        plan: rollbackPlan,
        phase: "applied",
        updatedAt: planFixture.createdAt,
        completedAt: planFixture.createdAt,
        error: null,
      },
    });
  vi.spyOn(api, "verifySkillFiles").mockResolvedValue({
    nodeId: "fixture-node",
    stationKey: "codex:fixture",
    harness: "codex",
    profile: "fixture",
    verification: {
      current: null,
      path: null,
      present: {
        value: false,
        reason: "No revision",
        observedAt: planFixture.createdAt,
      },
      loaded: { value: null, reason: "Not observed", observedAt: null },
    },
  });
  const view = render(SkillManagementPanel, { props });
  await waitFor(() =>
    expect(view.getByRole("option", { name: /fixture/ })).toBeTruthy(),
  );
  await fireEvent.input(view.getByLabelText("Profile"), {
    target: { value: "fixture" },
  });
  await fireEvent.click(view.getByRole("button", { name: "Review rollback" }));
  await waitFor(() =>
    expect(plan).toHaveBeenCalledWith(
      "station_1",
      "fixture",
      expect.any(String),
    ),
  );
  await waitFor(() =>
    expect(
      view.getByText(/No managed revision selected after rollback/),
    ).toBeTruthy(),
  );
  expect(apply).not.toHaveBeenCalled();
  await fireEvent.click(
    view.getByRole("button", { name: "Apply reviewed plan" }),
  );
  await waitFor(() => expect(view.getByText("Files applied")).toBeTruthy());
  await fireEvent.click(view.getByRole("button", { name: "Verify files" }));
  await waitFor(() => expect(view.getByText(/Files present: No/)).toBeTruthy());
  expect(view.getByText(/Loaded: Unknown/)).toBeTruthy();
});

test("opening a recorded conflict shows recovery guidance without offering apply", async () => {
  vi.spyOn(api, "listSkillOperations").mockResolvedValue([
    operation("conflict"),
  ]);
  vi.spyOn(api, "getSkillOperation").mockResolvedValue(operation("conflict"));
  const view = render(SkillManagementPanel, { props });
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Open operation" })).toBeTruthy(),
  );
  await fireEvent.click(view.getByRole("button", { name: "Open operation" }));
  await waitFor(() =>
    expect(view.getByText(/Preserve local edits/)).toBeTruthy(),
  );
  expect(
    view.queryByRole("button", { name: "Apply reviewed plan" }),
  ).toBeNull();
});
