import { z } from "zod";

/** Observations are independent; unknown is never defaulted to false. */
export const SkillObservation = z
  .object({
    value: z.boolean().nullable(),
    observedAt: z.iso.datetime().nullable(),
    reason: z.string().min(1).max(2048),
  })
  .refine((v) => v.value === null || v.observedAt !== null, {
    message: "A known observation requires its observation time",
  });
export type SkillObservation = z.infer<typeof SkillObservation>;

export const SkillEvidence = z.object({
  catalogued: SkillObservation,
  present: SkillObservation,
  eligible: SkillObservation,
  loaded: SkillObservation,
  exercised: SkillObservation,
});
export const SkillScope = z.enum(["workspace", "profile", "user", "system"]);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Path = z.string().min(1).max(4096);
export const SkillSource = z.object({
  kind: z.enum(["local", "catalog", "plugin"]),
  locator: z.string().max(4096).nullable(),
  revision: z.string().max(256).nullable(),
  artifactDigest: Digest.nullable(),
});
export const SkillEntry = z.object({
  id: z.string().min(1).max(4096),
  name: z.string().min(1).max(256),
  description: z.string().max(4096),
  path: Path,
  scope: SkillScope,
  source: SkillSource,
  /** SHA-256 of SKILL.md bytes, not of the package or resource closure. */
  entrypointDigest: Digest.nullable(),
  effectivePath: Path.nullable(),
  shadowing: z
    .object({
      status: z.enum(["unknown", "effective", "shadowed"]),
      by: Path.nullable(),
      candidates: z.array(Path).max(1024),
    })
    .refine((v) => (v.status === "shadowed") === (v.by !== null), {
      message: "Only observed shadowing identifies a winner",
    }),
  dependencies: z.object({
    known: z.boolean(),
    items: z
      .array(
        z.object({
          kind: z.enum(["binary", "environment", "config", "skill", "runtime"]),
          name: z.string().min(1).max(256),
          available: SkillObservation,
        }),
      )
      .max(256),
  }),
  compatibility: z
    .array(
      z.object({
        harness: z.string().min(1).max(64),
        version: z.string().min(1).max(256),
        mode: z.enum(["native", "acp"]),
        result: SkillObservation,
        evidenceRef: z.string().min(1).max(4096),
      }),
    )
    .max(256),
  evidence: SkillEvidence,
});
export type SkillEntry = z.infer<typeof SkillEntry>;

export const SkillPlugin = z.object({
  id: z.string().min(1).max(4096),
  name: z.string().min(1).max(256),
  path: Path,
  scope: SkillScope,
  source: SkillSource,
  components: z
    .array(z.enum(["skills", "commands", "hooks", "mcp", "extensions"]))
    .max(5),
  activation: SkillObservation,
  evidence: SkillEvidence,
});
export const SkillInventory = z.object({
  stationKey: z.string().min(1).max(512),
  harness: z.string().min(1).max(64),
  observedAt: z.iso.datetime(),
  skills: z.array(SkillEntry).max(1024),
  plugins: z.array(SkillPlugin).max(256),
  coverage: z.object({
    complete: z.boolean(),
    roots: z
      .array(
        z.object({
          path: Path,
          scope: SkillScope,
          status: z.enum(["scanned", "missing", "unreadable", "truncated"]),
        }),
      )
      .max(64),
    limitations: z.array(z.string().min(1).max(2048)).max(64),
  }),
  issues: z
    .array(z.object({ path: Path, reason: z.string().min(1).max(2048) }))
    .max(256),
});
export type SkillInventory = z.infer<typeof SkillInventory>;
export const SkillInventoryParams = z
  .object({ key: z.string().min(1).max(512) })
  .strict();
