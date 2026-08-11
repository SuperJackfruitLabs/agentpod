import { z } from "zod";

/**
 * Wire shapes for the `changeset` capability — an observe-only view of what an
 * agent has changed in a station's workspace.
 *
 * Deliberately not persisted anywhere. The content-addressed change artifact is
 * Horizon 2; this horizon only answers "what does this machine look like right
 * now", which is the question you cannot answer today without an SSH session.
 */

export const ChangesetFileStatus = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type-changed",
  "untracked",
]);
export type ChangesetFileStatus = z.infer<typeof ChangesetFileStatus>;

/**
 * One changed path.
 *
 * `insertions`/`deletions` are null in two cases: binary files, which have no
 * meaningful line count, and untracked files, which git will not count without
 * `git add -N` — and that would mutate the index of a workspace an agent may be
 * actively writing to. Their content is still fetchable via `changeset.diff`.
 */
export const ChangesetFile = z.object({
  path: z.string().min(1),
  /** Set for renames and copies only. */
  oldPath: z.string().min(1).nullable(),
  status: ChangesetFileStatus,
  insertions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
});
export type ChangesetFile = z.infer<typeof ChangesetFile>;

export const ChangesetSide = z.object({
  files: z.array(ChangesetFile),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type ChangesetSide = z.infer<typeof ChangesetSide>;

export const ChangesetCommit = z.object({
  sha: z.string().min(1),
  shortSha: z.string().min(1),
  subject: z.string(),
  author: z.string(),
  /** ISO-8601 committer date. */
  committedAt: z.string(),
});
export type ChangesetCommit = z.infer<typeof ChangesetCommit>;

export const ChangesetCommittedSide = ChangesetSide.extend({
  commits: z.array(ChangesetCommit),
});
export type ChangesetCommittedSide = z.infer<typeof ChangesetCommittedSide>;

/**
 * Which rule picked the base. Reported rather than inferred: a surprising diff
 * on a machine you are not sitting at is otherwise unexplainable, and "no
 * upstream, so you are seeing uncommitted work only" is a different situation
 * from "diffed against your upstream".
 */
export const ChangesetBaseReason = z.enum([
  "explicit",
  "upstream",
  "default-branch",
  "head",
]);
export type ChangesetBaseReason = z.infer<typeof ChangesetBaseReason>;

/**
 * The base affects only the committed side. `uncommitted` is always the working
 * tree against HEAD, whatever base was selected — changing the base changes
 * which commits count as "not yet on the base"; it cannot change what is
 * currently unsaved on disk.
 */
export const ChangesetStatus = z.object({
  repo: z.object({
    branch: z.string().nullable(),
    head: z.string().nullable(),
    detached: z.boolean(),
  }),
  base: z.object({
    ref: z.string().min(1),
    sha: z.string().min(1),
    reason: ChangesetBaseReason,
  }),
  uncommitted: ChangesetSide,
  committed: ChangesetCommittedSide,
  /** The file list hit its cap. */
  truncatedFiles: z.boolean(),
});
export type ChangesetStatus = z.infer<typeof ChangesetStatus>;

export const ChangesetDiffSide = z.enum(["uncommitted", "committed"]);
export type ChangesetDiffSide = z.infer<typeof ChangesetDiffSide>;

/** Same truncation contract as `fs.read`. */
export const ChangesetDiff = z.object({
  content: z.string(),
  truncated: z.boolean(),
  binary: z.boolean(),
});
export type ChangesetDiff = z.infer<typeof ChangesetDiff>;
