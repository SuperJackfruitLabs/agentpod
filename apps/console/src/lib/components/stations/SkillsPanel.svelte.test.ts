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
  await waitFor(() => expect(getByText(/skills catalogued/)).toBeTruthy());
  await fireEvent.click(getByRole("button", { name: "Show skills" }));
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
  await waitFor(() => expect(getByText(/skills catalogued/)).toBeTruthy());
  await fireEvent.click(getByRole("button", { name: "Show skills" }));
  expect(getByText("example")).toBeTruthy();
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
  // Asserting only that "example" is absent would pass for the wrong reason now
  // that the table arrives folded: the SECOND station's empty state must still
  // be what is on screen, and no count from the first may replace it.
  await waitFor(() => expect(getByText(/No skills observed/)).toBeTruthy());
  expect(queryByText(/skills catalogued/)).toBeNull();
  expect(queryByText("example")).toBeNull();
});

// Measured on a live station: 59 skills rendered a 4960px table — 80% of the
// whole Configuration tab, and four of its five columns read "Unknown" on
// nearly every row. The rows are still available; they no longer arrive
// uninvited.
test("the inventory is summarised behind a count, and opens on request", async () => {
  const many = {
    ...fixture(),
    // Distinct ids: the table's each block is keyed on skill.id, so reusing
    // one row 59 times is a duplicate-key error, not a 59-row table.
    skills: Array.from({ length: 59 }, (_, i) => ({
      ...fixture().skills[0],
      id: `.agents/skills/skill-${i}/SKILL.md`,
      name: `skill-${i}`,
    })),
  };
  vi.spyOn(api, "skillsInventory").mockResolvedValue(many);
  const { getByText, getByRole, queryByRole } = render(SkillsPanel, {
    props: { stationId: "station_1" },
  });

  await waitFor(() => expect(getByText(/59 skills catalogued/)).toBeTruthy());
  expect(queryByRole("table")).toBeNull();

  await fireEvent.click(getByRole("button", { name: "Show skills" }));
  expect(getByRole("table")).toBeTruthy();
  expect(getByRole("row", { name: /skill-0/ })).toBeTruthy();
});
