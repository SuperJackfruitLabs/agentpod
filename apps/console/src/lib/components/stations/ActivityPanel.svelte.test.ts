import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import * as api from "$lib/api/client";
// Static import ensures module is compiled during file collection, so the
// first test doesn't pay the compilation cost inside its waitFor window.
import ActivityPanel from "./ActivityPanel.svelte";

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

const mockRows = [
  {
    id: "row_1",
    userId: "user_a",
    nodeId: "node_1",
    stationKey: "hermes",
    verb: "fs.write",
    paramsSummary: '{"path":"/etc/config.toml"}',
    result: "ok",
    error: null,
    createdAt: "2026-06-28T12:00:00Z",
  },
  {
    id: "row_2",
    userId: "user_a",
    nodeId: "node_1",
    stationKey: "hermes",
    verb: "lifecycle.stop",
    paramsSummary: "{}",
    result: "error",
    error: "process not found",
    createdAt: "2026-06-28T11:00:00Z",
  },
];

test("ActivityPanel renders two rows from mocked activity(); shows verb and result", async () => {
  vi.spyOn(api, "activity").mockResolvedValue(mockRows);

  const { getByText } = render(ActivityPanel, { props: { stationId: "station_1" } });

  await waitFor(() => {
    // Both verbs should be rendered
    expect(getByText(/fs\.write/)).toBeTruthy();
    expect(getByText(/lifecycle\.stop/)).toBeTruthy();
  });

  await waitFor(() => {
    // Results should be rendered
    expect(getByText(/\bok\b/i)).toBeTruthy();
    expect(getByText(/\berror\b/i)).toBeTruthy();
  });

  expect(api.activity).toHaveBeenCalledWith("station_1");
});

test("ActivityPanel preserves newest-first order (renders in mocked array order)", async () => {
  vi.spyOn(api, "activity").mockResolvedValue(mockRows);

  const { getAllByTestId } = render(ActivityPanel, { props: { stationId: "station_1" } });

  await waitFor(() => {
    const rows = getAllByTestId("activity-row");
    expect(rows).toHaveLength(2);
    // First row in DOM is first element in mocked array (newest)
    expect(rows[0].textContent).toContain("fs.write");
    expect(rows[1].textContent).toContain("lifecycle.stop");
  });
});

test("ActivityPanel shows 'No activity yet.' for empty array", async () => {
  vi.spyOn(api, "activity").mockResolvedValue([]);

  const { getByText } = render(ActivityPanel, { props: { stationId: "station_2" } });

  await waitFor(() => {
    expect(getByText(/no activity yet/i)).toBeTruthy();
  });
});

test("ActivityPanel: empty array renders the Empty component (dashed placeholder, not a plain paragraph)", async () => {
  vi.spyOn(api, "activity").mockResolvedValue([]);

  const { getByText, container } = render(ActivityPanel, {
    props: { stationId: "station_2b" },
  });

  await waitFor(() => {
    const title = getByText("No activity yet");
    expect(container.querySelector(".border-dashed")).toBeTruthy();
    expect(container.querySelector(".border-dashed")?.contains(title)).toBe(true);
  });
});

test("ActivityPanel shows loading state initially", async () => {
  let resolve!: (v: typeof mockRows) => void;
  const pending = new Promise<typeof mockRows>((r) => (resolve = r));
  vi.spyOn(api, "activity").mockReturnValue(pending);

  const { getByText, queryByText } = render(ActivityPanel, { props: { stationId: "station_3" } });

  expect(getByText(/loading/i)).toBeTruthy();

  resolve(mockRows);
  await waitFor(() => {
    expect(queryByText(/loading/i)).toBeNull();
    expect(getByText(/fs\.write/)).toBeTruthy();
  });
});

test("ActivityPanel shows error state when activity() rejects", async () => {
  vi.spyOn(api, "activity").mockRejectedValue(new Error("network failure"));

  const { getByText } = render(ActivityPanel, { props: { stationId: "station_4" } });

  await waitFor(() => {
    expect(getByText(/network failure/i)).toBeTruthy();
  });
});

test("ActivityPanel Refresh button re-fetches activity", async () => {
  vi.spyOn(api, "activity").mockResolvedValue(mockRows);

  const { getByRole } = render(ActivityPanel, { props: { stationId: "station_5" } });

  // Wait for initial load
  await waitFor(() => expect(api.activity).toHaveBeenCalledTimes(1));

  // Click refresh
  const refreshBtn = getByRole("button", { name: /refresh/i });
  fireEvent.click(refreshBtn);

  await waitFor(() => expect(api.activity).toHaveBeenCalledTimes(2));
});

test("ActivityPanel renders object paramsSummary as readable JSON, never [object Object]", async () => {
  // The hub stores params_summary as jsonb and returns an OBJECT (see
  // apps/hub/src/db/schema/audit.ts) — not the string the older mocks used.
  vi.spyOn(api, "activity").mockResolvedValue([
    {
      id: "row_obj",
      userId: "user_a",
      nodeId: "node_1",
      stationKey: "claude-code:abc",
      verb: "cleanup.plan",
      paramsSummary: { path: "/workspace", dryRun: true },
      result: "ok",
      error: null,
      createdAt: "2026-08-07T14:00:00Z",
    },
    {
      id: "row_empty",
      userId: "user_a",
      nodeId: "node_1",
      stationKey: "claude-code:abc",
      verb: "term.open",
      paramsSummary: {},
      result: "ok",
      error: null,
      createdAt: "2026-08-07T14:01:00Z",
    },
  ] as never);

  const { getByText, container } = render(ActivityPanel, {
    props: { stationId: "station_1" },
  });

  await waitFor(() => getByText("cleanup.plan"));
  expect(container.textContent).not.toContain("[object Object]");
  // Object params render as compact JSON…
  getByText('{"path":"/workspace","dryRun":true}');
  // …and an empty object renders nothing at all.
  expect(container.textContent).not.toContain("{}");
});
