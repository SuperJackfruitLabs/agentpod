import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import * as api from "$lib/api/timeline";
import TimelinePanel from "./TimelinePanel.svelte";

const run = { sessionId: "acps_1", runId: "run_abc", state: "revoked", status: "ended", createdAt: "2026-10-26T09:00:00.000Z" };
const diff = {
  checkpoint: { id: "c1", step_id: "s-c1", step_key: "draft", tree_digest: "t".repeat(64), files_changed: ["runs/r/a.md"] },
  current_tree: "u".repeat(64),
  restore_digest: "d".repeat(64),
  files: [
    { path: "runs/r/a.md", current: "v2", at_checkpoint: { state: "content" as const, content: "v1" }, change: "revert" as const },
    { path: "README.md", current: "x", at_checkpoint: { state: "unknown" as const }, change: "not_restorable" as const },
  ],
};
const ckp = (id: string, step_key: string, files: string[]) => ({ id, step_id: "s-" + id, step_key, tree_digest: "t".repeat(64), files_changed: files });
beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

test("lists the steps' checkpoints for the latest run, files only", async () => {
  vi.spyOn(api, "listTimelineRuns").mockResolvedValue([run]);
  const list = vi.spyOn(api, "listCheckpoints").mockResolvedValue([ckp("c1", "draft", ["runs/r/a.md"]), ckp("c2", "polish", [])]);
  const view = render(TimelinePanel, { props: { stationId: "station_1" } });
  await waitFor(() => expect(view.getByText("After draft")).toBeTruthy());
  expect(list).toHaveBeenCalledWith("station_1", "acps_1");
  expect(view.getByText("After polish")).toBeTruthy();
  expect(view.getByText(/Files only/)).toBeTruthy();
});

test("opening a checkpoint shows what restoring it would do to each file", async () => {
  vi.spyOn(api, "listTimelineRuns").mockResolvedValue([run]);
  vi.spyOn(api, "listCheckpoints").mockResolvedValue([ckp("c1", "draft", ["runs/r/a.md"])]);
  const diff = vi.spyOn(api, "checkpointDiff").mockResolvedValue({
    checkpoint: ckp("c1", "draft", ["runs/r/a.md"]),
    current_tree: "u".repeat(64),
    restore_digest: "d".repeat(64),
    files: [
      { path: "runs/r/a.md", current: "v2", at_checkpoint: { state: "content", content: "v1" }, change: "revert" },
      { path: "runs/r/b.md", current: "new", at_checkpoint: { state: "absent" }, change: "delete" },
      { path: "README.md", current: "x", at_checkpoint: { state: "unknown" }, change: "not_restorable" },
    ],
  });
  const view = render(TimelinePanel, { props: { stationId: "station_1" } });
  await fireEvent.click(await waitFor(() => view.getByRole("button", { name: /After draft/ })));
  await waitFor(() => expect(diff).toHaveBeenCalledWith("station_1", "acps_1", "c1"));
  await waitFor(() => expect(view.getByText("runs/r/a.md")).toBeTruthy());
  expect(view.getByText("Revert")).toBeTruthy();
  expect(view.getByText("Delete (added later)")).toBeTruthy();
  expect(view.getByText(/Can.t restore/)).toBeTruthy();
});

test("a station with no strict runs says so", async () => {
  vi.spyOn(api, "listTimelineRuns").mockResolvedValue([]);
  const view = render(TimelinePanel, { props: { stationId: "station_1" } });
  await waitFor(() => expect(view.getByText(/No board runs yet/)).toBeTruthy());
});

// Item 11b: restore is an admin's, for an ended run, after reviewing exactly what it will do.
async function openCheckpoint(props: Record<string, unknown>, r = run) {
  vi.spyOn(api, "listTimelineRuns").mockResolvedValue([r]);
  vi.spyOn(api, "listCheckpoints").mockResolvedValue([diff.checkpoint]);
  vi.spyOn(api, "checkpointDiff").mockResolvedValue(diff);
  const view = render(TimelinePanel, { props: { stationId: "station_1", ...props } });
  await fireEvent.click(await waitFor(() => view.getByRole("button", { name: /After draft/ })));
  await waitFor(() => expect(view.getByText("runs/r/a.md")).toBeTruthy());
  return view;
}

test("an admin restores an ended run's checkpoint with the exact digest it reviewed", async () => {
  const restore = vi.spyOn(api, "restoreCheckpoint").mockResolvedValue({ version: 1 });
  const view = await openCheckpoint({ canRestore: true });
  await fireEvent.click(view.getByRole("button", { name: /Restore files to here/ }));
  await waitFor(() => expect(view.getByRole("dialog")).toBeTruthy());
  expect(view.getByText(/left as it is/)).toBeTruthy();
  await fireEvent.click(view.getByRole("button", { name: /Approve restore/ }));
  await waitFor(() => expect(restore).toHaveBeenCalledWith("station_1", "acps_1", "c1", "d".repeat(64)));
});

test("a member, or a run that has not ended, gets no restore", async () => {
  const member = await openCheckpoint({ canRestore: false });
  expect(member.queryByRole("button", { name: /Restore files to here/ })).toBeNull();
  cleanup();
  vi.restoreAllMocks();
  const live = await openCheckpoint({ canRestore: true }, { ...run, state: "active", status: "idle" });
  expect(live.queryByRole("button", { name: /Restore files to here/ })).toBeNull();
  expect(live.getByText(/after the run has ended/)).toBeTruthy();
});

// The diff is against the live workspace: a change made outside the run shows, and is named.
test("a change made outside the run shows in the diff and the approval, never as nothing to change", async () => {
  vi.spyOn(api, "restoreCheckpoint").mockResolvedValue({ version: 1 });
  vi.spyOn(api, "listTimelineRuns").mockResolvedValue([run]);
  vi.spyOn(api, "listCheckpoints").mockResolvedValue([diff.checkpoint]);
  vi.spyOn(api, "checkpointDiff").mockResolvedValue({
    ...diff,
    recorded_tree: "t".repeat(64),
    drift: true,
    files: [
      { path: "runs/r/a.md", current: "edited by hand", current_state: "content", at_checkpoint: { state: "content", content: "v1" }, change: "revert" },
    ],
  });
  const view = render(TimelinePanel, { props: { stationId: "station_1", canRestore: true } });
  await fireEvent.click(await waitFor(() => view.getByRole("button", { name: /After draft/ })));
  await waitFor(() => expect(view.getByText("runs/r/a.md")).toBeTruthy());
  expect(view.getByText(/changed outside this run/)).toBeTruthy();
  await fireEvent.click(view.getByRole("button", { name: /Restore files to here/ }));
  await waitFor(() => expect(view.getByRole("dialog")).toBeTruthy());
  expect(view.getAllByText(/changed outside this run/).length).toBeGreaterThan(1);
});

test("a workspace that moved outside the run with nothing to restore says exactly that", async () => {
  vi.spyOn(api, "listTimelineRuns").mockResolvedValue([run]);
  vi.spyOn(api, "listCheckpoints").mockResolvedValue([diff.checkpoint]);
  vi.spyOn(api, "checkpointDiff").mockResolvedValue({ ...diff, recorded_tree: "t".repeat(64), drift: true, files: [] });
  const view = render(TimelinePanel, { props: { stationId: "station_1", canRestore: true } });
  await fireEvent.click(await waitFor(() => view.getByRole("button", { name: /After draft/ })));
  await waitFor(() => expect(view.getByText(/changed outside this run/)).toBeTruthy());
  expect(view.queryByText("Nothing was written after this checkpoint.")).toBeNull();
  expect(view.queryByRole("button", { name: /Restore files to here/ })).toBeNull();
});
