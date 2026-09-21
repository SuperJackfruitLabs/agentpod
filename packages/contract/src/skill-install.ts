import { z } from "zod";
import { SkillObservation } from "./skills";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const OperationId = z.string().regex(/^[a-f0-9]{32}$/);
const RelativePath = z.string().min(1).max(1024).refine(value =>
  !/[\\:\x00-\x1f\x7f-\uffff]/.test(value) &&
  value.split("/").length <= 64 && value.split("/").every(part => part !== "" && part !== "." && part !== ".." && part.length <= 255),
);
export const SkillInstallBinding = z.object({
  nodeId: z.string().min(1).max(256), stationKey: z.string().min(1).max(512),
  harness: z.enum(["codex", "claude-code", "opencode", "pi", "hermes", "openclaw"]),
  profile: z.string().min(1).max(124).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  workspacePath: z.string().min(1).max(4096), workspaceIdentity: Digest,
}).strict();
export const SkillGeneration = z.object({
  generation: OperationId, archiveSHA256: Digest, bundleDigest: Digest,
}).strict();
export const SkillInstallPlan = z.object({
  schemaVersion: z.literal(1), operationId: OperationId,
  action: z.enum(["install", "rollback"]), binding: SkillInstallBinding,
  expectedHead: Digest, before: SkillGeneration.nullable(), after: SkillGeneration.nullable(),
  targetPath: z.string().min(1).max(4096).nullable(),
  changes: z.object({added:z.array(RelativePath).max(4096), removed:z.array(RelativePath).max(4096), changed:z.array(RelativePath).max(4096)}).strict(),
  activation: z.literal("pending"), createdAt: z.iso.datetime(), planDigest: Digest,
}).strict().refine(plan => plan.action === "rollback" || (plan.after !== null && plan.after.generation === plan.operationId), {
  message: "An installation owns a generation named by its operation",
}).refine(plan => (plan.after === null) === (plan.targetPath === null), {
  message: "A selected generation has a concrete destination",
});
export const SkillInstallReceipt = z.object({
  plan: SkillInstallPlan,
  phase: z.enum(["planned", "staging", "switching", "applied", "conflict"]),
  updatedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
  error: z.string().max(2048).nullable(),
}).strict().refine(receipt => (receipt.phase === "applied") === (receipt.completedAt !== null), {
  message: "Only completed installation has a completion time",
});
export type SkillInstallBinding = z.infer<typeof SkillInstallBinding>;
export type SkillGeneration = z.infer<typeof SkillGeneration>;
export type SkillInstallPlan = z.infer<typeof SkillInstallPlan>;
export type SkillInstallReceipt = z.infer<typeof SkillInstallReceipt>;

const SkillProfileParams = z.object({
  key: z.string().min(1).max(512).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value)),
  profile: SkillInstallBinding.shape.profile,
}).strict();
const StationId = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/);
export const SkillVerifyParams = SkillProfileParams;
/** Read-only accounting for the node-owned managed namespace. */
export const SkillRetentionParams = SkillProfileParams;
export const SkillOperationParams = SkillProfileParams.extend({operationId: OperationId});
export const SkillPlanParams = SkillOperationParams.extend({stationId: StationId, archiveSHA256: Digest});
export const SkillApplyParams = SkillOperationParams.extend({stationId: StationId, expectedPlanDigest: Digest});
export const SkillOperationResult = z.object({receipt: SkillInstallReceipt.nullable()}).strict();
export const SkillInstallVerification = z.object({
  current: SkillGeneration.nullable(), path: z.string().min(1).max(4096).nullable(),
  present: SkillObservation, loaded: SkillObservation,
}).strict().refine(value => (value.current === null) === (value.path === null), {
  message: "A verified generation has a concrete path",
});
export const SkillVerifyResult = z.object({
  nodeId: SkillInstallBinding.shape.nodeId, stationKey: SkillInstallBinding.shape.stationKey,
  harness: SkillInstallBinding.shape.harness, profile: SkillInstallBinding.shape.profile,
  verification: SkillInstallVerification,
}).strict();
export const SkillRetentionInspection = z.object({
  namespaceExists: z.boolean(),
  operations: z.number().int().min(0).max(256),
  operationLimit: z.literal(256),
  generations: z.number().int().min(0).max(256),
  staging: z.number().int().min(0).max(16),
  pending: z.number().int().min(0).max(16),
  nativeOperations: z.number().int().min(0).max(256),
  nativeStaging: z.number().int().min(0).max(16),
  nativeBackups: z.number().int().min(0).max(256),
  observedAt: z.iso.datetime(),
  limitation: z.string().min(1).max(2048),
}).strict();
export const SkillRetentionResult = z.object({
  nodeId: SkillInstallBinding.shape.nodeId, stationKey: SkillInstallBinding.shape.stationKey,
  harness: SkillInstallBinding.shape.harness, profile: SkillInstallBinding.shape.profile,
  retention: SkillRetentionInspection,
}).strict();
export const SkillMaintenancePreview = z.object({
  generations: z.array(OperationId).max(256), operations: z.array(OperationId).max(256),
  nativeOperations: z.array(OperationId).max(256), nativeBackups: z.array(OperationId).max(256),
}).strict();
export const SkillMaintenancePlan = z.object({
  preview: SkillMaintenancePreview, planDigest: Digest, observedAt: z.iso.datetime(),
  limitation: z.string().min(1).max(2048),
}).strict();
export const SkillMaintenanceResult = z.object({
  nodeId: SkillInstallBinding.shape.nodeId, stationKey: SkillInstallBinding.shape.stationKey,
  harness: SkillInstallBinding.shape.harness, profile: SkillInstallBinding.shape.profile,
  maintenance: SkillMaintenancePlan,
}).strict();
export const SkillMaintenanceApplyParams = SkillProfileParams.extend({ expectedPlanDigest: Digest });
