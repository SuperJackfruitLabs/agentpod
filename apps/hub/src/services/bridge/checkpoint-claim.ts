/** Proposed checkpoint discovery only. Parsed policy is not source admission or execution authority. */
import { createHash } from "node:crypto";
import { z } from "zod";

export const CHECKPOINT_CLAIM_PROTOCOL = "superpipeline.checkpoint-claim.v1";
const MAX_CLAIM_BYTES = 65_536;

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
const text = z.string().min(1).max(128).refine(scalars);
const name = z.string().max(64).regex(/^[a-z0-9][a-z0-9_-]{0,63}(?![\s\S])/);
const epoch = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const policySchema = z.object({
  version: z.literal("superpipeline.checkpoint-policy.v1"),
  kind: z.literal("superbench"),
  allowUnchanged: z.boolean(),
  repositories: z.array(z.object({ name, provider: z.enum(["forge", "github"]),
    repository: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/),
  }).strict()).min(1).max(32),
  checkpointRepository: name,
  reporterPrincipalId: z.string().max(80).regex(/^prn_[A-Za-z0-9]{6,}(?![\s\S])/),
  nodeId: text,
  executors: z.array(z.object({
    agentId: z.string().max(80).regex(/^agt_[A-Za-z0-9]{6,}(?![\s\S])/), stationId: text,
  }).strict()).min(1).max(32),
}).strict().refine((policy) => {
  const names = policy.repositories.map((member) => member.name);
  return names.every((member, index) => index === 0 || (names[index - 1] ?? "") < member) &&
    names.includes(policy.checkpointRepository) &&
    new Set(policy.executors.map((executor) => executor.agentId + "\0" + executor.stationId)).size === policy.executors.length;
});
export type CheckpointPolicy = z.infer<typeof policySchema>;
const pendingSchema = z.object({
  version: z.literal(CHECKPOINT_CLAIM_PROTOCOL), admissionState: z.literal("pending"),
  tenantId: text, boardId: text, cardId: text, stageKey: text, agentId: text, runId: text,
  leaseEpoch: epoch, policy: policySchema, policyDigest: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/),
}).strict();
export type PendingCheckpointClaim = z.infer<typeof pendingSchema>;

function bounded(value: unknown): void {
  try {
    const raw = JSON.stringify(value);
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_CLAIM_BYTES) throw new Error();
  } catch { throw new CheckpointClaimRefused("invalid"); }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function marker(value: unknown): boolean {
  return record(value) && (Object.hasOwn(value, "checkpointClaim") ||
    (record(value.stage) && Object.hasOwn(value.stage, "checkpointPolicy")));
}
/** A legacy/read-only caller cannot silently project away a required execution boundary. */
export function refuseLegacyCheckpoint(value: unknown): void {
  if (marker(value)) throw new CheckpointClaimRefused("unrequested");
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
function canonical(value: unknown): string {
  if (typeof value === "string") return quote(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (record(value)) return "{" + Object.entries(value).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => quote(key) + ":" + canonical(item)).join(",") + "}";
  throw new CheckpointClaimRefused("invalid");
}
export function checkpointPolicyDigest(value: unknown): string {
  bounded(value);
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) throw new CheckpointClaimRefused("policy");
  return createHash("sha256").update(canonical(parsed.data)).digest("hex");
}
export function parsePendingCheckpointClaim(value: unknown): PendingCheckpointClaim {
  bounded(value);
  const parsed = pendingSchema.safeParse(value);
  if (!parsed.success) throw new CheckpointClaimRefused("invalid");
  if (checkpointPolicyDigest(parsed.data.policy) !== parsed.data.policyDigest)
    throw new CheckpointClaimRefused("policy");
  return parsed.data;
}

const cardBinding = z.object({ id: text, currentStageKey: text, currentRunId: text,
  delegateAgentId: text, state: z.literal("working") }).passthrough();
const stageBinding = z.object({ key: text, checkpointPolicy: policySchema }).passthrough();
const claimBinding = z.object({ claimed: z.literal(true), runId: text, leaseEpoch: epoch,
  card: cardBinding, stage: stageBinding }).passthrough();

/** Preserve a requested DTO only after it agrees with the actual claimed card, run and policy. */
export function readCheckpointClaim(value: unknown, protocol: unknown, boardId: string): PendingCheckpointClaim | undefined {
  if (protocol !== undefined && protocol !== CHECKPOINT_CLAIM_PROTOCOL) throw new CheckpointClaimRefused("unsupported");
  if (!marker(value)) return undefined;
  if (protocol !== CHECKPOINT_CLAIM_PROTOCOL) throw new CheckpointClaimRefused("unrequested");
  if (!record(value) || !Object.hasOwn(value, "checkpointClaim")) throw new CheckpointClaimRefused("required");
  const pending = parsePendingCheckpointClaim(value.checkpointClaim);
  const actual = claimBinding.safeParse(value);
  if (!actual.success) throw new CheckpointClaimRefused("binding");
  const { card, stage, runId, leaseEpoch } = actual.data;
  if (pending.boardId !== boardId || pending.runId !== runId || pending.leaseEpoch !== leaseEpoch ||
    pending.cardId !== card.id || pending.stageKey !== stage.key || card.currentStageKey !== stage.key ||
    card.currentRunId !== runId || card.delegateAgentId !== pending.agentId)
    throw new CheckpointClaimRefused("binding");
  if (checkpointPolicyDigest(stage.checkpointPolicy) !== pending.policyDigest) throw new CheckpointClaimRefused("policy");
  return pending;
}

const contextBinding = z.object({
  run: z.object({ runId: text, cardId: text, stageKey: text, leaseEpoch: epoch,
    status: z.literal("working"), endedAt: z.null() }).passthrough(),
  card: cardBinding, stage: stageBinding,
}).passthrough();
/** Current context is evidence of the same live run and policy, never a source/fencing certificate. */
export function validateCheckpointContext(value: unknown, pending: PendingCheckpointClaim, boardId: string, runId: string): void {
  const actual = contextBinding.safeParse(value);
  if (!actual.success || pending.boardId !== boardId || pending.runId !== runId)
    throw new CheckpointClaimRefused("context");
  const { run, card, stage } = actual.data;
  if (run.runId !== pending.runId || run.cardId !== pending.cardId || run.stageKey !== pending.stageKey ||
    run.leaseEpoch !== pending.leaseEpoch || card.id !== pending.cardId || card.currentRunId !== pending.runId ||
    card.delegateAgentId !== pending.agentId || card.currentStageKey !== pending.stageKey || stage.key !== pending.stageKey)
    throw new CheckpointClaimRefused("context");
  if (checkpointPolicyDigest(stage.checkpointPolicy) !== pending.policyDigest) throw new CheckpointClaimRefused("policy");
}
