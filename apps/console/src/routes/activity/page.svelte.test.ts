/**
 * activity/page.svelte.test.ts
 *
 * Tests for the /activity page (fleet-wide audit log), rendered on the
 * shared DataTable (Plan A).
 * Asserts:
 *  - renders a PageHeader with title "Activity"
 *  - renders activity rows from a mocked listActivity(), with verb,
 *    stationKey, and result all present per row (rows found via the
 *    DataTable's `rowTestId="activity-row"`)
 *  - shows relative time for each row
 *  - empty state: "No activity yet" when listActivity returns []
 *  - error state when listActivity rejects
 *  - listActivity called once on mount
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/svelte";
import * as api from "$lib/api/client";

// ---------------------------------------------------------------------------
// SvelteKit stubs
// ---------------------------------------------------------------------------

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
  replaceState: vi.fn(),
}));

vi.mock("$app/state", () => ({
  page: {
    url: { pathname: "/activity", searchParams: null },
  },
}));

// ---------------------------------------------------------------------------
// Static import
// ---------------------------------------------------------------------------

import ActivityPage from "./+page.svelte";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

const recentIso = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
const olderIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 h ago

const mockRows = [
  {
    id: "row-1",
    verb: "terminal.open",
    stationKey: "opencode:abc",
    nodeId: "node_abc123",
    result: "ok",
    createdAt: recentIso,
  },
  {
    id: "row-2",
    verb: "fs.write",
    stationKey: "hermes:xyz",
    nodeId: "node_xyz456",
    result: "error",
    createdAt: olderIso,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("renders the Activity page header", async () => {
  vi.spyOn(api, "listActivity").mockResolvedValue(mockRows);

  const { container } = render(ActivityPage);

  await waitFor(() => {
    expect(container.textContent).toContain("Activity");
  });
});

test("renders activity rows with verb, stationKey, and result", async () => {
  vi.spyOn(api, "listActivity").mockResolvedValue(mockRows);

  const { getAllByTestId } = render(ActivityPage);

  await waitFor(() => {
    const activityRows = getAllByTestId("activity-row");
    expect(activityRows).toHaveLength(2);

    expect(activityRows[0].textContent).toContain("terminal.open");
    expect(activityRows[0].textContent).toContain("opencode:abc");
    expect(activityRows[0].textContent).toContain("ok");

    expect(activityRows[1].textContent).toContain("fs.write");
    expect(activityRows[1].textContent).toContain("hermes:xyz");
    expect(activityRows[1].textContent).toContain("error");
  });
});

test("shows relative time for each row", async () => {
  vi.spyOn(api, "listActivity").mockResolvedValue(mockRows);

  const { container } = render(ActivityPage);

  await waitFor(() => {
    // 5m ago and 2h ago should appear
    const text = container.textContent ?? "";
    expect(text).toMatch(/\d+m ago|\d+h ago|just now/);
  });
});

test("shows empty state when listActivity returns []", async () => {
  vi.spyOn(api, "listActivity").mockResolvedValue([]);

  const { getByTestId } = render(ActivityPage);

  await waitFor(() => {
    const emptyState = getByTestId("empty-state");
    expect(emptyState.textContent).toContain("No activity yet");
  });
});

test("shows error message when listActivity rejects", async () => {
  vi.spyOn(api, "listActivity").mockRejectedValue(new Error("network error"));

  const { getByText } = render(ActivityPage);

  await waitFor(() => {
    expect(getByText("network error")).toBeTruthy();
  });
});

test("calls listActivity on mount", async () => {
  const spy = vi.spyOn(api, "listActivity").mockResolvedValue([]);

  render(ActivityPage);

  await waitFor(() => {
    expect(spy).toHaveBeenCalledOnce();
  });
});
