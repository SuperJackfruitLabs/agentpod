import { z } from "zod";

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
