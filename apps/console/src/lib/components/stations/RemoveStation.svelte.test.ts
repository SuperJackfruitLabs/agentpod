import { test, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import RemoveStation from "./RemoveStation.svelte";
import { removeStation } from "$lib/api/station-setup";
vi.mock("$lib/api/station-setup", () => ({ removeStation: vi.fn() }));
test("removal requires confirmation and retains the dialog on failure", async () => {
  const onRemoved = vi.fn();
  vi.mocked(removeStation)
    .mockRejectedValueOnce(new Error("Hub offline"))
    .mockResolvedValueOnce(undefined);
  const { getByRole, findByText } = render(RemoveStation, {
    stationId: "station-1",
    displayName: "Workspace",
    onRemoved,
  });
  await fireEvent.click(getByRole("button", { name: "Remove station" }));
  expect(removeStation).not.toHaveBeenCalled();
  await fireEvent.click(getByRole("button", { name: "Remove from AgentPod" }));
  await findByText("Hub offline");
  expect(onRemoved).not.toHaveBeenCalled();
  await fireEvent.click(getByRole("button", { name: "Remove from AgentPod" }));
  await waitFor(() => expect(onRemoved).toHaveBeenCalledOnce());
  expect(removeStation).toHaveBeenCalledWith("station-1");
});
