import { z } from "zod";
import { SkillInstallBinding, SkillOperationParams, SkillVerifyParams } from "./skill-install";
import { SkillPlacementReceipt, SkillPlacementVerification } from "./skill-placement";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);

export const SkillNativePlanParams = SkillOperationParams.extend({
  action: z.enum(["activate", "deactivate", "rollback"]),
}).strict();
export const SkillNativeApplyParams = SkillOperationParams.extend({
  expectedPlanDigest: Digest,
}).strict();
export const SkillNativeOperationParams = SkillOperationParams;
export const SkillNativeVerifyParams = SkillVerifyParams;

export const SkillNativeOperationResult = z.object({ receipt: SkillPlacementReceipt.nullable() }).strict();
export const SkillNativeVerifyResult = z.object({
  nodeId: SkillInstallBinding.shape.nodeId,
  stationKey: SkillInstallBinding.shape.stationKey,
  harness: SkillInstallBinding.shape.harness,
  profile: SkillInstallBinding.shape.profile,
  verification: SkillPlacementVerification,
}).strict();
