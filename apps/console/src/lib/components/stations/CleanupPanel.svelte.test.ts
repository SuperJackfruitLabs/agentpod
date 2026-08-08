import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import * as api from "$lib/api/client";
// Static import ensures module is compiled during file collection, so the
// first test doesn't pay the compilation cost inside its waitFor window.
import CleanupPanel from "./CleanupPanel.svelte";

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup); // scroll-lock timer flush lives in src/vitest-setup.ts

const mockPlanItems = [
  { path: "/workspace/.cache/pip", size: 52428800, kind: "cache" },
  { path: "/workspace/logs/old.log", size: 1048576, kind: "log" },
];

const mockPlan = {
  items: mockPlanItems,
  totalBytes: 53477376,
};

test("CleanupPanel renders Scan button initially; Apply is disabled (nothing selected)", async () => {
  vi.spyOn(api, "cleanupPlan").mockResolvedValue(mockPlan);

  const { getByRole, queryByRole } = render(CleanupPanel, {
    props: { stationId: "station_1" },
  });

  // Scan button must exist before any scan is run
  expect(getByRole("button", { name: /scan/i })).toBeTruthy();

  // Click Scan → renders plan items
  fireEvent.click(getByRole("button", { name: /scan/i }));

  await waitFor(() => {
    expect(api.cleanupPlan).toHaveBeenCalledWith("station_1");
  });

  await waitFor(() => {
    // Both paths should be rendered
    expect(getByRole("checkbox", { name: /\.cache\/pip/i })).toBeTruthy();
    expect(getByRole("checkbox", { name: /logs\/old\.log/i })).toBeTruthy();
  });

  // Apply button should exist but be disabled (nothing selected yet)
  const applyBtn = getByRole("button", { name: /apply/i }) as HTMLButtonElement;
  expect(applyBtn.disabled).toBe(true);
});

test("CleanupPanel: selecting an item enables Apply; confirming calls cleanupApply with selected paths", async () => {
  vi.spyOn(api, "cleanupPlan").mockResolvedValue(mockPlan);
  vi.spyOn(api, "cleanupApply").mockResolvedValue({ removedBytes: 52428800 });

  const { getByRole, getByPlaceholderText } = render(CleanupPanel, {
    props: { stationId: "station_1" },
  });

  // Scan
  fireEvent.click(getByRole("button", { name: /scan/i }));

  await waitFor(() => {
    expect(getByRole("checkbox", { name: /\.cache\/pip/i })).toBeTruthy();
  });

  // Select the first item
  const firstCheckbox = getByRole("checkbox", { name: /\.cache\/pip/i }) as HTMLInputElement;
  fireEvent.click(firstCheckbox);

  // Apply button should now be enabled
  await waitFor(() => {
    const applyBtn = getByRole("button", { name: /apply/i }) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(false);
  });

  // Click Apply → TypeToConfirmDialog appears
  fireEvent.click(getByRole("button", { name: /apply/i }));

  await waitFor(() => expect(getByRole("dialog")).toBeTruthy());

  // cleanupApply must NOT be called before confirming
  expect(api.cleanupApply).not.toHaveBeenCalled();

  // Type the confirm phrase (= stationId)
  const input = getByPlaceholderText("station_1");
  fireEvent.input(input, { target: { value: "station_1" } });

  // Confirm button unlocks
  await waitFor(() => {
    const confirmBtn = getByRole("button", { name: /confirm/i }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
  });

  fireEvent.click(getByRole("button", { name: /confirm/i }));

  await waitFor(() => {
    expect(api.cleanupApply).toHaveBeenCalledWith("station_1", ["/workspace/.cache/pip"]);
  });
});

test("CleanupPanel: empty plan shows 'Nothing to clean'", async () => {
  vi.spyOn(api, "cleanupPlan").mockResolvedValue({ items: [], totalBytes: 0 });

  const { getByRole, getByText } = render(CleanupPanel, {
    props: { stationId: "station_2" },
  });

  fireEvent.click(getByRole("button", { name: /scan/i }));

  await waitFor(() => {
    expect(getByText(/nothing to clean/i)).toBeTruthy();
  });
});

test("CleanupPanel: empty plan renders the Empty component (dashed placeholder, not a plain paragraph)", async () => {
  vi.spyOn(api, "cleanupPlan").mockResolvedValue({ items: [], totalBytes: 0 });

  const { getByRole, getByText, container } = render(CleanupPanel, {
    props: { stationId: "station_2b" },
  });

  fireEvent.click(getByRole("button", { name: /scan/i }));

  await waitFor(() => {
    const title = getByText("Nothing to clean");
    // The Empty component renders its title inside a dashed-border placeholder.
    expect(container.querySelector(".border-dashed")).toBeTruthy();
    expect(container.querySelector(".border-dashed")?.contains(title)).toBe(true);
  });
});

test("CleanupPanel: shows removedBytes feedback after successful apply", async () => {
  vi.spyOn(api, "cleanupPlan").mockResolvedValue(mockPlan);
  vi.spyOn(api, "cleanupApply").mockResolvedValue({ removedBytes: 52428800 });

  const { getByRole, getByPlaceholderText, getByText } = render(CleanupPanel, {
    props: { stationId: "station_3" },
  });

  // Scan
  fireEvent.click(getByRole("button", { name: /scan/i }));
  await waitFor(() => expect(getByRole("checkbox", { name: /\.cache\/pip/i })).toBeTruthy());

  // Select first item
  fireEvent.click(getByRole("checkbox", { name: /\.cache\/pip/i }));

  // Apply
  await waitFor(() => {
    const btn = getByRole("button", { name: /apply/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
  fireEvent.click(getByRole("button", { name: /apply/i }));
  await waitFor(() => expect(getByRole("dialog")).toBeTruthy());

  // Type confirm phrase and confirm
  fireEvent.input(getByPlaceholderText("station_3"), { target: { value: "station_3" } });
  await waitFor(() => {
    const btn = getByRole("button", { name: /confirm/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
  fireEvent.click(getByRole("button", { name: /confirm/i }));

  // Freed bytes feedback should appear
  await waitFor(() => {
    expect(getByText(/freed/i)).toBeTruthy();
  });
});
