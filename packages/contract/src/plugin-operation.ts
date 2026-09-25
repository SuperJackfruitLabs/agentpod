import { z } from "zod";
import { SkillInstallBinding } from "./skill-install";

// Console plugin management (#553): the node plans enabling or disabling the
// agentpod-live Hermes plugin, the Console reviews that plan, and the node
// applies it only while the profile still matches the review. The node probes
// Hermes's version itself; nothing here vouches for one.
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const OperationId = z.string().regex(/^[a-f0-9]{32}$/);
const Reason = z.string().max(2048);

export const PluginName = z.literal("agentpod-live");
export const PluginAction = z.enum(["enable", "disable"]);

export const PluginOperationBinding = z
  .object({
    nodeId: SkillInstallBinding.shape.nodeId,
    stationKey: SkillInstallBinding.shape.stationKey,
    harness: z.literal("hermes"),
    plugin: PluginName,
  })
  .strict();

/** What the node's version probe allowed, for enable. Disable has none. */
export const PluginGate = z
  .object({ allowed: z.boolean(), version: z.string().max(64).optional(), reason: Reason })
  .strict();

export const PluginConfigPreview = z
  .object({
    path: z.literal("config.yaml"),
    beforeSHA256: Digest,
    afterSHA256: Digest,
    diff: z.string().max(16 << 10),
    diffTruncated: z.boolean(),
    restoresBackup: z.boolean(),
  })
  .strict();

export const PluginFiles = z.enum([
  "absent",
  "current",
  "managed-other",
  "unmanaged-identical",
  "unmanaged-different",
]);
export const PluginFileAction = z.enum(["add", "replace", "keep", "adopt", "remove", "none"]);

/**
 * A plan the node will not carry out still comes back, with `refusal` naming
 * why; it carries no file or configuration change.
 */
export const PluginOperationPlan = z
  .object({
    schemaVersion: z.literal(1),
    operationId: OperationId,
    action: PluginAction,
    binding: PluginOperationBinding,
    version: z.string().min(1).max(64),
    gate: PluginGate.nullable(),
    files: PluginFiles.nullable(),
    filesDigest: z.string().max(80),
    fileAction: PluginFileAction.nullable(),
    fileNames: z.array(z.string().min(1).max(256)).max(64),
    config: PluginConfigPreview.nullable(),
    noOp: z.boolean(),
    notes: z.array(Reason).max(16),
    refusal: Reason.nullable(),
    restartRequired: z.boolean(),
    createdAt: z.iso.datetime(),
    planDigest: Digest,
  })
  .strict()
  .refine((p) => (p.refusal === null) === (p.config !== null && p.fileAction !== null && p.files !== null), {
    message: "A plan either refuses or describes its change",
  })
  .refine((p) => (p.action === "enable") === (p.gate !== null), {
    message: "Only an enable plan carries a version gate",
  });

export const PluginOperationReceipt = z
  .object({
    plan: PluginOperationPlan,
    phase: z.enum(["planned", "applying", "applied", "conflict"]),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    error: Reason.nullable(),
  })
  .strict()
  .refine((r) => (r.phase === "applied") === (r.completedAt !== null));

export const PluginOperationResult = z.object({ receipt: PluginOperationReceipt.nullable() }).strict();

const PluginOperationParams = z
  .object({
    key: z.string().min(1).max(512),
    plugin: PluginName,
    operationId: OperationId,
  })
  .strict();
export const PluginPlanParams = PluginOperationParams.extend({ action: PluginAction }).strict();
export const PluginApplyParams = PluginOperationParams.extend({ expectedPlanDigest: Digest }).strict();
export const PluginInspectParams = PluginOperationParams;

/** Console → hub. The station and plugin are implied by the route. */
export const PluginPlanRequest = z
  .object({ requestId: z.uuid(), action: PluginAction })
  .strict();

export type PluginOperationPlan = z.infer<typeof PluginOperationPlan>;
export type PluginOperationReceipt = z.infer<typeof PluginOperationReceipt>;
export type PluginOperationResult = z.infer<typeof PluginOperationResult>;
export type PluginPlanRequest = z.infer<typeof PluginPlanRequest>;
