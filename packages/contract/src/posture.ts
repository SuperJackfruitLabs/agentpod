import { z } from "zod";

/**
 * Wire shapes for the `posture` capability — a live security read of a machine
 * running agent runtimes.
 *
 * Node-level, not station-level: credential files live in a user's home and a
 * listening socket belongs to a process, so one scan describes one machine.
 * Findings that DO belong to a station carry `station`, which is what lets the
 * console show a station its own problems without re-running anything.
 */

export const PostureStatus = z.enum(["pass", "fail", "unknown"]);
export type PostureStatus = z.infer<typeof PostureStatus>;

export const PostureSeverity = z.enum(["critical", "warning", "info"]);
export type PostureSeverity = z.infer<typeof PostureSeverity>;

/**
 * One observation about one thing.
 *
 * `check` is a stable id so reports can be diffed across runs, and `remedy` is
 * the exact command rather than general advice.
 *
 * `unknown` is deliberately not `pass`: a check that could not determine an
 * answer is reported honestly and excluded from grading, because grading on
 * ignorance is how a scanner earns distrust.
 */
export const PostureFinding = z.object({
  check: z.string().min(1),
  status: PostureStatus,
  severity: PostureSeverity,
  harness: z.string().min(1).optional(),
  /** Station key (e.g. `hermes:analyst-echo`) for per-station findings. */
  station: z.string().min(1).optional(),
  title: z.string().min(1),
  detail: z.string(),
  path: z.string().min(1).optional(),
  remedy: z.string().min(1).optional(),
});
export type PostureFinding = z.infer<typeof PostureFinding>;

export const PostureReport = z.object({
  hostname: z.string(),
  stations: z.number().int().nonnegative(),
  findings: z.array(PostureFinding),
  /** A — nothing · B — info only · C — a warning · F — a critical. */
  grade: z.string().min(1),
});
export type PostureReport = z.infer<typeof PostureReport>;

// ─── Node capabilities ───────────────────────────────────────────────────────

/**
 * Capabilities of a NODE, as opposed to a station.
 *
 * Carried in the `hello` frame rather than a separate verb, which means they
 * refresh on every connect by construction — the staleness bug that station
 * capabilities needed an explicit fix for cannot occur here.
 */
export const NodeCapability = z.enum(["posture"]);
export type NodeCapability = z.infer<typeof NodeCapability>;

/**
 * Unknown entries are filtered rather than rejected, so an older hub keeps
 * working when a newer node advertises something it has never heard of.
 */
export const NodeCapabilityList = z
  .array(z.string())
  .transform((xs) => xs.filter((x): x is NodeCapability => NodeCapability.safeParse(x).success));
