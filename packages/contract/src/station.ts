import { z } from "zod";
export const Capability = z.enum(["inventory","health","logs","fs.read","fs.write","terminal","lifecycle","cleanup","acp","changeset","skills.inventory","skills.manage","skills.native","plugins.manage","config.manage","matrix.avatar"]);
export type Capability = z.infer<typeof Capability>;
/**
 * Splits raw capability strings into the ones this build knows and the ones it
 * drops.
 *
 * `CapabilityList` is defined in terms of this so a caller that wants to REPORT
 * the drop reads it from the same code that performs it. Computing the dropped
 * set a second time somewhere else is how the two silently disagree, and a
 * disagreement here is invisible by construction.
 *
 * Pure on purpose. `packages/contract` is shared by the hub, the console and the
 * node-agent's contract fixtures, so it cannot reach for a logger; and it must
 * not throw, because the tolerance below is the point — see `CapabilityList`.
 */
export function partitionCapabilities(xs: readonly string[]): {
  known: Capability[];
  dropped: string[];
} {
  const known: Capability[] = [];
  const dropped: string[] = [];
  for (const x of xs) {
    const parsed = Capability.safeParse(x);
    if (parsed.success) known.push(parsed.data);
    else dropped.push(x);
  }
  return { known, dropped };
}

// Station capability lists FILTER unknown capability strings instead of
// rejecting the whole row (carry-in #2: an old hub must not break auto-adopt
// when a newer node advertises capabilities this hub doesn't know about yet).
//
// That tolerance is correct and stays. What was missing is that it was also
// SILENT: `config.manage` was absent from the enum above, so a new hub dropped
// a new node's capability with no error at any layer and three merged PRs of a
// feature could not activate on a real fleet. The drop is now reportable —
// `unknownCapabilitiesByStation` below hands a consumer exactly what was
// thrown away, and the hub logs it at warn (see `reportUnknownCapabilities` in
// apps/hub/src/services/station-registry.ts).
export const CapabilityList = z
  .array(z.string())
  .transform((xs) => partitionCapabilities(xs).known);
export const StationKind = z.enum(["composite","leaf"]);
export const Station = z.object({
  key: z.string().min(1), harness: z.string().min(1), kind: StationKind,
  displayName: z.string(), parentKey: z.string().nullable(),
  workspacePath: z.string().nullable(), capabilities: CapabilityList,
  matrixId: z.string().nullable().optional(),
});
export type Station = z.infer<typeof Station>;
export const DetectedStation = Station.extend({ adopted: z.boolean() });
export type DetectedStation = z.infer<typeof DetectedStation>;
export const StationHealth = z.object({
  running: z.boolean(), pid: z.number().nullable(), cpuPct: z.number().nullable(),
  memBytes: z.number().nullable(), diskBytes: z.number().nullable(),
  uptimeSec: z.number().nullable(), lastActivity: z.string().nullable(), note: z.string().nullable(),
});
export type StationHealth = z.infer<typeof StationHealth>;
export const FsEntry = z.object({
  name: z.string(), path: z.string(), type: z.enum(["file","dir","symlink"]),
  size: z.number().nullable(), modified: z.string().nullable(),
});
export type FsEntry = z.infer<typeof FsEntry>;

/**
 * The capability strings a RAW `detect` payload advertises that this build does
 * not know, per station key. Returns only stations that lost something.
 *
 * Takes the raw payload rather than a parsed one because the parse is where the
 * strings cease to exist: by the time a `DetectedStation[]` is in hand there is
 * nothing left to report. Tolerant of shape for the same reason the filter is —
 * a row it cannot read is skipped, never thrown over, so a caller can run this
 * beside a `safeParse` without changing whether that parse succeeds.
 *
 * A node advertising a capability the hub has never heard of is operationally
 * interesting on its own: it means the hub is behind its fleet.
 */
export function unknownCapabilitiesByStation(
  raw: unknown
): Array<{ key: string; dropped: string[] }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ key: string; dropped: string[] }> = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const { key, capabilities } = row as { key?: unknown; capabilities?: unknown };
    if (typeof key !== "string" || !Array.isArray(capabilities)) continue;
    const strings = capabilities.filter((c): c is string => typeof c === "string");
    const { dropped } = partitionCapabilities(strings);
    if (dropped.length > 0) out.push({ key, dropped });
  }
  return out;
}
