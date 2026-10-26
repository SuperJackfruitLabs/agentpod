import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import * as api from "$lib/api/timeline";
import TimelinePanel from "./TimelinePanel.svelte";

const run = { sessionId: "acps_1", runId: "run_abc", state: "revoked", status: "ended", createdAt: "2026-10-26T09:00:00.000Z" };
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
