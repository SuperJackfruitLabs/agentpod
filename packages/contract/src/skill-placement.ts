import { z } from "zod";
import { SkillInstallBinding, SkillGeneration } from "./skill-install";
import { SkillObservation } from "./skills";

// Internal node primitive. No broker verb/capability is enabled until a caller
// can hold a quiescent-workspace guard across the complete publication operation.
const Digest=z.string().regex(/^[a-f0-9]{64}$/);
const OperationId=z.string().regex(/^[a-f0-9]{32}$/);
const Path=z.string().min(1).max(4096);
const RelativePath=z.string().min(1).max(1024).refine(v=>!/[\\:\x00-\x1f\x7f-\uffff]/.test(v)&&v.split('/').length<=64&&v.split('/').every(p=>p!==''&&p!=='.'&&p!=='..'&&p.length<=255));
// The direct layout each harness owns. A plan may only name its own: the layouts
// differ in where a skill's files land, so accepting another harness's literal
// would let a plan describe a projection the node never makes.
const DIRECT_LAYOUTS:Record<string,string>={codex:'codex-direct-v1','claude-code':'claude-direct-v1',hermes:'hermes-direct-v1'};
export const SkillPlacementPlan=z.object({
 schemaVersion:z.literal(1),operationId:OperationId,action:z.enum(['activate','deactivate','rollback']),
 binding:SkillInstallBinding.extend({harness:z.enum(['codex','opencode','pi','openclaw','claude-code','hermes'])}),
 repositoryPath:Path,repositoryIdentity:Digest,expectedInstallationHead:Digest,expectedHead:Digest,
 before:SkillGeneration.nullable(),after:SkillGeneration.nullable(),nativeLayout:z.enum(['codex-direct-v1','claude-direct-v1','hermes-direct-v1']).optional(),targetPath:Path,
 changes:z.object({added:z.array(RelativePath).max(4096),removed:z.array(RelativePath).max(4096),changed:z.array(RelativePath).max(4096)}).strict(),
 discoveryNames:z.array(z.string().min(1).max(256)).max(256),
 activation:z.literal('quiescent-project; loading-unverified'),createdAt:z.iso.datetime(),planDigest:Digest,
}).strict().refine(p=>p.action!=='activate'||p.after!==null).refine(p=>p.action!=='deactivate'||p.after===null).refine(p=>p.nativeLayout===undefined||p.nativeLayout===DIRECT_LAYOUTS[p.binding.harness]);
export const SkillPlacementReceipt=z.object({
 plan:SkillPlacementPlan,phase:z.enum(['planned','staging','switching','applied','conflict']),
 updatedAt:z.iso.datetime(),completedAt:z.iso.datetime().nullable(),error:z.string().max(2048).nullable(),
}).strict().refine(r=>(r.phase==='applied')===(r.completedAt!==null));
export const SkillPlacementVerification=z.object({current:SkillGeneration.nullable(),path:Path,discoveryNames:z.array(z.string().min(1).max(256)).max(256),present:SkillObservation,loaded:SkillObservation}).strict();
export type SkillPlacementPlan=z.infer<typeof SkillPlacementPlan>;
export type SkillPlacementReceipt=z.infer<typeof SkillPlacementReceipt>;
