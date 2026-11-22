/**
 * The stage checkpoint policy (treaty `run-checkpoint-policy.v1`) and the owner's canonical digest.
 * Parsed policy is not source admission or execution authority. Shared by the claim reader
 * (checkpoint-claim.ts) and the per-card narrowing (checkpoint-selection.ts).
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const MAX_CLAIM_BYTES = 65_536;

export class CheckpointClaimRefused extends Error {
  constructor(reason: "invalid" | "unrequested" | "required" | "binding" | "policy" | "context" | "unsupported") {
    super(`Checkpoint claim refused: ${reason}`);
    this.name = "CheckpointClaimRefused";
  }
}

function scalars(value: string): boolean {
  for (const scalar of value) {
    const code = scalar.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}
export const text = z.string().min(1).max(128).refine(scalars);
export const repositoryName = z.string().max(64).regex(/^[a-z0-9][a-z0-9_-]{0,63}(?![\s\S])/);
export const policyRepository = z.object({ name: repositoryName, provider: z.enum(["forge", "github"]),
  repository: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/),
}).strict();
export const policyExecutor = z.object({
  agentId: z.string().max(80).regex(/^agt_[A-Za-z0-9]{6,}(?![\s\S])/), stationId: text,
}).strict();
/** The fields every checkpoint policy version shares. */
export const policyFields = {
  kind: z.literal("superbench"),
  allowUnchanged: z.boolean(),
  repositories: z.array(policyRepository).min(1).max(32),
  checkpointRepository: repositoryName,
  reporterPrincipalId: z.string().max(80).regex(/^prn_[A-Za-z0-9]{6,}(?![\s\S])/),
  nodeId: text,
  executors: z.array(policyExecutor).min(1).max(32),
};
/** Sorted strictly by name, so names are unique too. */
export const sortedNames = (names: readonly string[]) =>
  names.every((member, index) => index === 0 || (names[index - 1] ?? "") < member);
export const distinctExecutors = (executors: ReadonlyArray<{ agentId: string; stationId: string }>) =>
  new Set(executors.map((executor) => executor.agentId + "\0" + executor.stationId)).size === executors.length;

export const policySchema = z.object({ version: z.literal("superpipeline.checkpoint-policy.v1"), ...policyFields })
  .strict().refine((policy) => {
    const names = policy.repositories.map((member) => member.name);
    return sortedNames(names) && names.includes(policy.checkpointRepository) && distinctExecutors(policy.executors);
  });
export type CheckpointPolicy = z.infer<typeof policySchema>;

export function bounded(value: unknown): void {
  try {
    const raw = JSON.stringify(value);
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_CLAIM_BYTES) throw new Error();
  } catch { throw new CheckpointClaimRefused("invalid"); }
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Matches the owner's ASCII canonical JSON, including lowercase UTF-16 escapes.
function quote(value: string): string {
  let out = '"';
  for (const scalar of value) {
    const code = scalar.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) throw new CheckpointClaimRefused("invalid");
    if (scalar === '"' || scalar === "\\") out += "\\" + scalar;
    else if (code >= 32 && code <= 126) out += scalar;
    else for (const unit of scalar.split("")) out += "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0");
  }
  return out + '"';
}
export function canonical(value: unknown): string {
  if (typeof value === "string") return quote(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (record(value)) return "{" + Object.entries(value).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => quote(key) + ":" + canonical(item)).join(",") + "}";
  throw new CheckpointClaimRefused("invalid");
}
/** SHA-256 of the owner's canonical JSON of an already parsed value. */
export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function checkpointPolicyDigest(value: unknown): string {
  bounded(value);
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) throw new CheckpointClaimRefused("policy");
  return canonicalSha256(parsed.data);
}
