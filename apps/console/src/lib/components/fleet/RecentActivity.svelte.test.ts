/**
 * RecentActivity.svelte.test.ts
 *
 * TDD tests for the RecentActivity dashboard panel.
 * Asserts:
 *  - shows "// no activity yet" when listActivity returns []
 *  - renders activity rows (verb · stationKey)
 *  - caps at 6 rows even if more are returned
 *  - "view all →" link points to /activity
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import RecentActivity from "./RecentActivity.svelte";

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
}));

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

const makeRow = (i: number): api.ActivityRow => ({
  id: `row_${i}`,
  verb: `verb_${i}`,
  stationKey: `station_key_${i}`,
  nodeId: "n1",
  result: "ok",
  createdAt: new Date(Date.now() - i * 60000).toISOString(),
});

test("shows 'no activity yet' when listActivity returns an empty array", async () => {
  vi.spyOn(api, "listActivity").mockResolvedValue([]);

  const { getByTestId } = render(RecentActivity);

  await waitFor(() => {
    expect(getByTestId("no-activity")).toBeTruthy();
  });
});

test("renders verb for each activity row", async () => {
  const rows = [makeRow(1), makeRow(2), makeRow(3)];
  vi.spyOn(api, "listActivity").mockResolvedValue(rows);

  const { getAllByTestId } = render(RecentActivity);

  await waitFor(() => {
    const items = getAllByTestId("activity-row");
    expect(items.length).toBe(3);
    expect(items[0].textContent).toContain("verb_1");
    expect(items[1].textContent).toContain("verb_2");
  });
});

test("caps at 6 rows even when listActivity returns more", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => makeRow(i + 1));
  vi.spyOn(api, "listActivity").mockResolvedValue(rows);

  const { getAllByTestId } = render(RecentActivity);

  await waitFor(() => {
    const items = getAllByTestId("activity-row");
    expect(items.length).toBe(6);
  });
});

test("'view all →' link points to /activity", async () => {
  vi.spyOn(api, "listActivity").mockResolvedValue([]);

  const { getByTestId } = render(RecentActivity);

  await waitFor(() => {
    const link = getByTestId("view-all-activity");
    expect(link.getAttribute("href")).toBe("/activity");
  });
});

test("fetch failure shows an error with Retry — never the 'No activity yet' empty state", async () => {
  // Regression: a network failure used to render the same empty state as a
  // genuinely idle fleet, hiding outages from the operator.
  const spy = vi.spyOn(api, "listActivity").mockRejectedValue(new Error("network error"));

  const { getByTestId, queryByTestId, getByRole, getByText } = render(RecentActivity);

  await waitFor(() => {
    expect(getByTestId("activity-error")).toBeTruthy();
  });
  expect(queryByTestId("no-activity")).toBeNull();

  // Retry re-fetches and renders the rows on success.
  spy.mockResolvedValue([
    { id: "a1", verb: "fs.read", stationKey: "st", nodeId: "node-1", createdAt: new Date().toISOString() },
  ] as never);
  const { fireEvent } = await import("@testing-library/svelte");
  await fireEvent.click(getByRole("button", { name: /retry/i }));

  await waitFor(() => {
    expect(getByText("fs.read")).toBeTruthy();
  });
});
