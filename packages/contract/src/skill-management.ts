import { z } from "zod";
import {
  SkillInstallBinding,
  SkillInstallPlan,
  SkillInstallReceipt,
} from "./skill-install";
import { SkillPlacementPlan, SkillPlacementReceipt } from "./skill-placement";

export const SkillArtifactMetadata = z
  .object({
    id: z.uuid(),
    archiveSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    harness: SkillInstallBinding.shape.harness,
    profile: SkillInstallBinding.shape.profile,
    size: z
      .number()
      .int()
      .positive()
      .max(32 << 20),
    createdAt: z.iso.datetime(),
    // Upload declarations do not establish package validity, compatibility or loading.
    validation: z.literal("unverified"),
  })
  .strict();
export const SkillArtifactUploadQuery = z
  .object({
    harness: SkillInstallBinding.shape.harness,
    profile: SkillInstallBinding.shape.profile,
  })
  .strict();
export const SkillPlanRequest = z
  .object({ requestId: z.uuid(), artifactId: z.uuid() })
  .strict();
export const SkillRollbackRequest = z
  .object({ requestId: z.uuid(), profile: SkillInstallBinding.shape.profile })
  .strict();
export const SkillApplyRequest = z
  .object({ planDigest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const SkillNativePlanRequest = z
  .object({
    requestId: z.uuid(),
    profile: SkillInstallBinding.shape.profile,
    action: z.enum(["activate", "deactivate", "rollback"]),
  })
  .strict();
export const SkillOperationAction = z.enum([
  "install",
  "rollback",
  "activate",
  "deactivate",
]);
const SkillOperationPlan = z.union([SkillInstallPlan, SkillPlacementPlan]);
const SkillOperationReceipt = z.union([
  SkillInstallReceipt,
  SkillPlacementReceipt,
]);
export const SkillHubOperationSummary = z
  .object({
    id: z.string().regex(/^[a-f0-9]{32}$/),
    stationId: z.string().min(1).max(256),
    nodeId: SkillInstallBinding.shape.nodeId,
    stationKey: SkillInstallBinding.shape.stationKey,
    harness: SkillInstallBinding.shape.harness,
    profile: SkillInstallBinding.shape.profile,
    kind: z.enum(["managed", "native"]),
    action: SkillOperationAction,
    artifactId: z.uuid().nullable(),
    state: z.enum([
      "requested",
      "planning",
      "planned",
      "applying",
      "applied",
      "unknown",
      "conflict",
    ]),
    error: z.string().max(2048).nullable(),
    inFlight: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const SkillHubOperation = SkillHubOperationSummary.extend({
  plan: SkillOperationPlan.nullable(),
  receipt: SkillOperationReceipt.nullable(),
}).refine((value) => {
  const plan = value.plan ?? value.receipt?.plan;
  return !plan || plan.action === value.action;
}, {
  message: "Plan action must match its operation",
}).refine((value) => {
  return value.kind === "native"
    ? value.action !== "install"
    : value.action === "install" || value.action === "rollback";
}, {
  message: "Operation kind must match its action",
}).refine(
  (value) => value.state !== "applied" || value.receipt?.phase === "applied",
  {
    message: "Completion requires a node receipt",
  },
);
export type SkillArtifactMetadata = z.infer<typeof SkillArtifactMetadata>;
export type SkillHubOperation = z.infer<typeof SkillHubOperation>;
export type SkillHubOperationSummary = z.infer<typeof SkillHubOperationSummary>;
