import { http } from "./client";

/** Item 11a: a station's strict runs, their checkpoints and what restoring one would do. */
export interface TimelineRun {
  sessionId: string;
  runId: string;
  state: string;
  status: string;
  createdAt: string;
}
export interface Checkpoint {
  id: string;
  step_id: string;
  step_key: string;
  tree_digest: string;
  files_changed: string[];
}
export type FileAt = { state: "content"; content: string } | { state: "absent" } | { state: "unknown" };
export interface CheckpointFile {
  path: string;
  current: string | null;
  at_checkpoint: FileAt;
  change: "revert" | "delete" | "bring_back" | "unchanged" | "not_restorable";
}
export interface CheckpointDiff {
  checkpoint: Checkpoint;
  current_tree: string;
  files: CheckpointFile[];
}
const base = (station: string) => `/api/stations/${encodeURIComponent(station)}/timeline`;
export const listTimelineRuns = async (station: string) =>
  (await http<{ runs: TimelineRun[] }>(base(station))).runs;
export const listCheckpoints = async (station: string, session: string) =>
  (await http<{ checkpoints: Checkpoint[] }>(`${base(station)}/${encodeURIComponent(session)}/checkpoints`)).checkpoints;
export const checkpointDiff = (station: string, session: string, checkpoint: string) =>
  http<CheckpointDiff>(
    `${base(station)}/${encodeURIComponent(session)}/checkpoints/${encodeURIComponent(checkpoint)}/diff`,
  );
