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
  /** The file as the live workspace holds it now. */
  current: string | null;
  current_state?: "content" | "absent" | "unreadable";
  at_checkpoint: FileAt;
  change: "revert" | "delete" | "bring_back" | "unchanged" | "not_restorable";
}
export interface CheckpointDiff {
  checkpoint: Checkpoint;
  /** The live workspace's tree now, read through the station; the restore is bound to it. */
  current_tree: string;
  /** The tree after this run's last recorded write. */
  recorded_tree?: string;
  /** The workspace changed outside this run since its last recorded write. */
  drift?: boolean;
  files: CheckpointFile[];
  /** Binds the checkpoint, the current tree and every file change; a restore names exactly this. */
  restore_digest: string;
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
/** Item 11b: restore a checkpoint's files, exactly as shown (workspace admins, ended runs only). */
export const restoreCheckpoint = (station: string, session: string, checkpoint: string, restoreDigest: string) =>
  http<{ version: 1 }>(
    `${base(station)}/${encodeURIComponent(session)}/checkpoints/${encodeURIComponent(checkpoint)}/restore`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ restoreDigest }) },
  );
