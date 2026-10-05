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
    /**
     * Any type is welcome — this is the fleet's value, in whatever shape the
     * harness's own document holds it — but the field itself must be
     * PRESENT. An omitted `value` is not the same thing as a literal `null`:
     * `compare()` would read it back as declared-but-undefined and report
     * the setting permanently `drifted`, with no write able to satisfy it,
     * because nothing a station could ever observe equals "nothing was
     * declared". `undeclare` (DELETE) is the way to remove a declaration;
     * `PUT` with no `value` is refused rather than silently manufacturing
     * that state. The explicit `.refine()` below does not lean on whichever
     * way a given zod version treats a bare `z.unknown()` field's
     * optionality — that is an implementation default, not a contract.
     */
    value: z.unknown(),
  })
  .refine((d) => !(d.stationId !== null && d.nodeId !== null), {
    message: "a declaration targets one level: station, node, or fleet (both null)",
  })
  .refine((d) => d.value !== undefined, {
    message: "value is required — an omitted value is not a declaration; use DELETE to remove one",
    path: ["value"],
  });
export type DeclaredSetting = z.infer<typeof DeclaredSetting>;

/**
 * An operator's explicit exemption, at exactly one level: a station (keyed
 * on its stable `stationKey`, not its row id, so the exemption survives
 * unadopt/re-adopt) or a node (exempting every station on it). There is
 * deliberately no fleet level here (D9) — `fleet config unset` already
 * covers "nobody wants this setting" at that scope.
 *
 * `stationKey`/`nodeId` are `.nullable().optional()` rather than
 * `DeclaredSetting`'s bare `.nullable()`: the service layer
 * (`harness-config.ts`'s `assertOneOptOutLevel`) tells "named" from
 * "absent" by `undefined`, not by `null`, and a route normalises a literal
 * `null` to `undefined` before calling it — see
 * `routes/harness-config.ts`.
 */
export const ConfigOptOut = z
  .object({
    settingId: z.string(),
    stationKey: z.string().nullable().optional(),
    nodeId: z.string().nullable().optional(),
    optedOut: z.boolean(),
    reason: z.string().optional(),
  })
  .refine((v) => (v.stationKey == null) !== (v.nodeId == null), {
    message: "an opt-out names exactly one of stationKey or nodeId",
  });
export type ConfigOptOut = z.infer<typeof ConfigOptOut>;

/**
 * What a station actually has. The NODE produces this and is told nothing about
 * what was declared — comparison is the hub's, because only the hub resolves
 * station → node → fleet precedence.
 */
export const ConfigValue = z.object({
  settingId: z.string().min(1),
  /** Absent when the key is not in the document, or when it could not be read. */
  observed: z.unknown().optional(),
  /**
   * Required: a reader that forgot to set it must not report success.
   *
   * False covers two things that must not look like a missing key: a document
   * that could not be read at all, and a key that IS present but holds a value
   * the reader cannot speak for — a list or a nested map, where the node reads
   * scalars only. `compare()` maps both to `unreadable`, never to `absent`.
   */
  readable: z.boolean(),
  reason: z.string().optional(),
  /**
   * The HARNESS's own record that an operator disabled this — Hermes'
   * `plugins.disabled`. Distinct from the hub's opt-out register: this one is the
   * operator speaking through the harness's own UI, and agentpod never writes it.
   */
  optedOutByHarness: z.boolean().optional(),
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

/** Every refusal this system can give, each distinct. See spec §9. */
export const ConfigRefusalCode = z.enum([
  "UNKNOWN_SETTING",
  "OUT_OF_SCOPE",
  "SHAPE_UNEXPECTED",
  "PLAN_STALE",
  /**
   * The caller applied a digest that is not the one this operation's recorded
   * plan carries. Distinct from PLAN_STALE on purpose: the remedy differs —
   * a mismatch means re-read the plan, staleness means re-plan against a
   * document that has changed. Spec §9 enumerates seven codes; this is an
   * eighth, added because collapsing it into PLAN_STALE would make two
   * conditions with different answers indistinguishable.
   */
  "PLAN_DIGEST_MISMATCH",
  "OPTED_OUT",
  "UNREADABLE",
  "CREDENTIAL_PATH",
]);
export type ConfigRefusalCode = z.infer<typeof ConfigRefusalCode>;

export const ConfigRefusal = z.object({
  code: ConfigRefusalCode,
  /** A sentence. A refusal that cannot be told from a pass is the failure this area keeps hitting. */
  message: z.string(),
});

/** One setting's intended edit. `current` absent means the key is not in the document. */
export const ConfigPlanEntry = z.object({
  settingId: z.string(),
  /** Absolute path of the document this entry edits. */
  file: z.string(),
  keyPath: z.string(),
  policy: ConfigPolicy,
  current: z.unknown().optional(),
  intended: z.unknown(),
  action: z.enum(["create", "modify", "append", "noop"]),
  restartToTakeEffect: z.boolean(),
});

/**
 * A plan is what review sees. Its digest covers everything in it INCLUDING
 * `beforeSha256`, so a document edited after review yields a different digest
 * and the apply is refused rather than re-derived (D8).
 */
export const ConfigPlan = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string(),
  stationKey: z.string(),
  entries: z.array(ConfigPlanEntry),
  /** SHA-256 of the document as it was when planned. */
  beforeSha256: z.string(),
  diff: z.string(),
  diffTruncated: z.boolean(),
  noOp: z.boolean(),
  refusal: ConfigRefusal.optional(),
  /** True when any entry needs a restart. Nothing here performs one (D4). */
  restartRequired: z.boolean(),
  createdAt: z.string(),
  planDigest: z.string(),
});

export const ConfigWritten = z.object({
  settingId: z.string(),
  action: z.enum(["create", "modify", "append", "noop"]),
  wrote: z.unknown(),
});

/** The journal entry for one apply. There is deliberately no `restarted` field. */
export const ConfigReceipt = z.object({
  plan: ConfigPlan,
  phase: z.enum(["planned", "applying", "applied", "conflict"]),
  updatedAt: z.string(),
  written: z.array(ConfigWritten).default([]),
  afterSha256: z.string().optional(),
  error: z.string().optional(),
});

export type ConfigPlan = z.infer<typeof ConfigPlan>;
export type ConfigReceipt = z.infer<typeof ConfigReceipt>;
export type ConfigPlanEntry = z.infer<typeof ConfigPlanEntry>;
