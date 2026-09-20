import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import { SkillInventory } from "@agentpod/contract";
import { inventoryFixture } from "../../../../../../packages/contract/src/fixtures/skill-inventory";
import * as api from "$lib/api/client";
import SkillsPanel from "./SkillsPanel.svelte";

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);
const fixture = () => SkillInventory.parse(inventoryFixture);

test("shows presence without claiming loading and identifies partial coverage", async () => {
  vi.spyOn(api, "skillsInventory").mockResolvedValue(fixture());
  const { getByText, getByRole } = render(SkillsPanel, {
    props: { stationId: "station_1" },
  });
  await waitFor(() => expect(getByText("example")).toBeTruthy());
  const row = getByRole("row", { name: /example/ });
  expect(row.textContent).toMatch(/Yes/);
  expect(row.textContent).toMatch(/Unknown/);
  expect(getByText(/Partial inventory/)).toBeTruthy();
  expect(getByText(/No plugins observed/)).toBeTruthy();
});
test("empty partial scan does not claim there are no installed skills", async () => {
  vi.spyOn(api, "skillsInventory").mockResolvedValue({
    ...fixture(),
    skills: [],
  });
  const { getByText, queryByText } = render(SkillsPanel, {
    props: { stationId: "station_1" },
  });
  await waitFor(() =>
    expect(getByText(/No skills observed in the scanned roots/)).toBeTruthy(),
  );
  expect(queryByText("No skills installed")).toBeNull();
});
test("a failed refresh remains an error and can be retried", async () => {
  const load = vi
    .spyOn(api, "skillsInventory")
    .mockRejectedValueOnce(new Error("node offline"))
    .mockResolvedValueOnce(fixture());
  const { getByRole, getByText } = render(SkillsPanel, {
    props: { stationId: "station_1" },
  });
  await waitFor(() =>
    expect(getByRole("alert").textContent).toContain("node offline"),
  );
  await fireEvent.click(getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(getByText("example")).toBeTruthy());
  expect(load).toHaveBeenCalledTimes(2);
});
test("navigation never shows a late previous station's inventory", async () => {
  let resolveFirst!: (v: api.SkillInventoryResult) => void;
  vi.spyOn(api, "skillsInventory").mockImplementation((id) =>
    id === "first"
      ? new Promise((r) => {
          resolveFirst = r;
        })
      : Promise.resolve({ ...fixture(), skills: [] }),
  );
  const { rerender, getByText, queryByText } = render(SkillsPanel, {
    props: { stationId: "first" },
  });
  await waitFor(() => expect(resolveFirst).toBeTypeOf("function"));
  await rerender({ stationId: "second" });
  await waitFor(() => expect(getByText(/No skills observed/)).toBeTruthy());
  resolveFirst(fixture());
  await waitFor(() => expect(queryByText("example")).toBeNull());
});
