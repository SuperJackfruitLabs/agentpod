import { z } from "zod";

/**
 * Where a setting lives in its harness, and therefore what may be scoped to a
 * station. `station` is deliberately NOT a scope: for Hermes a station is a
 * profile, and for every other harness a station is a project path while the
 * config is per user — so the scope names the document, never the caller's
 * intent. Spec §6.
 */
export const ConfigScope = z.enum(["profile", "project", "user"]);
export type ConfigScope = z.infer<typeof ConfigScope>;

/**
 * What this system may do to a setting's value (spec D2).
 *
 * `additive-only` exists because a harness persists operator decisions into the
 * same file: reconciling `command_allowlist` to a declared list would delete a
 * grant an operator made minutes earlier through the harness's own UI.
 */
export const ConfigPolicy = z.enum(["reconcilable", "additive-only", "report-only"]);
export type ConfigPolicy = z.infer<typeof ConfigPolicy>;

/** One registered setting. The registry is a list of these, held by the node. */
export const ConfigSetting = z.object({
  /** Stable id used by the API, the CLI and declarations: `<harness>.<path>`. */
  id: z.string().min(1),
  harness: z.string().min(1),
  scope: ConfigScope,
  policy: ConfigPolicy,
  /**
   * Required, never defaulted. Spec F4: the two errors are not symmetric —
   * claiming a restart is needed when it is not costs a restart, while claiming
   * one is not needed when it is leaves a file saying 900 and a gateway still
   * enforcing 300.
   */
  restartToTakeEffect: z.boolean(),
});
export type ConfigSetting = z.infer<typeof ConfigSetting>;

/**
 * What the fleet wants, at exactly one level. `stationId` and `nodeId` are both
 * null for a fleet-wide declaration; setting both is refused, because two levels
 * is not a level.
 */
export const DeclaredSetting = z
  .object({
    settingId: z.string().min(1),
    stationId: z.string().nullable(),
    nodeId: z.string().nullable(),
    value: z.unknown(),
  })
  .refine((d) => !(d.stationId !== null && d.nodeId !== null), {
    message: "a declaration targets one level: station, node, or fleet (both null)",
  });
export type DeclaredSetting = z.infer<typeof DeclaredSetting>;

/**
 * What a station actually has. The NODE produces this and is told nothing about
 * what was declared — comparison is the hub's, because only the hub resolves
 * station → node → fleet precedence.
 */
export const ConfigValue = z.object({
  settingId: z.string().min(1),
  /** Absent when the key is not in the document, or when it could not be read. */
  observed: z.unknown().optional(),
  /** Required: a reader that forgot to set it must not report success. */
  readable: z.boolean(),
  reason: z.string().optional(),
});
export type ConfigValue = z.infer<typeof ConfigValue>;

/** What the hub makes of a station, once values are compared with declarations. */
export const ConfigObservation = z.object({
  settingId: z.string().min(1),
  stationId: z.string().min(1),
  declared: z.unknown().optional(),
  observed: z.unknown().optional(),
  state: z.enum([
    "matches",
    "drifted",
    "absent", // declared, and the key is not in the document
    "opted-out", // an explicit operator opt-out; spec D6
    "awaiting-restart", // written, not yet live; spec F4
    "unreadable", // the document could not be parsed — never `matches`
    "out-of-scope", // declared per-station for a non-station-scoped setting; D7
  ]),
  /** Why, whenever the state is not `matches`. Never a bare boolean. */
  reason: z.string().optional(),
});
export type ConfigObservation = z.infer<typeof ConfigObservation>;
