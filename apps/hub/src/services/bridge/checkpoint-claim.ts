/** Proposed checkpoint discovery only. Parsed policy is not source admission or execution authority. */
import { z } from "zod";
import { bounded, CheckpointClaimRefused, checkpointPolicyDigest, policySchema, record, text } from "./checkpoint-policy";
import { CHECKPOINT_CLAIM_PROTOCOL_V2, checkpointSelectionSchema, selectionMatchesPolicy, verifyCheckpointSelection } from "./checkpoint-selection";

export { CheckpointClaimRefused, checkpointPolicyDigest, type CheckpointPolicy } from "./checkpoint-policy";
export { CHECKPOINT_CLAIM_PROTOCOL_V2 } from "./checkpoint-selection";
export const CHECKPOINT_CLAIM_PROTOCOL = "superpipeline.checkpoint-claim.v1";
/** What a claimant on a stage whose cards choose sends as `checkpointProtocols`: v1 must be in it. */
export const CARD_CHOICE_CHECKPOINT_PROTOCOLS = Object.freeze([CHECKPOINT_CLAIM_PROTOCOL, CHECKPOINT_CLAIM_PROTOCOL_V2] as const);
export type CheckpointClaimProtocols = typeof CARD_CHOICE_CHECKPOINT_PROTOCOLS;

const epoch = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const pendingSchema = z.object({
  version: z.literal(CHECKPOINT_CLAIM_PROTOCOL), admissionState: z.literal("pending"),
  tenantId: text, boardId: text, cardId: text, stageKey: text, agentId: text, runId: text,
  leaseEpoch: epoch, policy: policySchema, policyDigest: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/),
  /** Claim protocol v2, a stage whose cards choose: `policy` is then the narrowed one (checkpoint-selection.ts). */
  selection: checkpointSelectionSchema.optional(),
}).strict();
export type PendingCheckpointClaim = z.infer<typeof pendingSchema>;

/** A stage carries a checkpoint policy of either kind; `null` is the board's "none". */
const present = (value: unknown, key: string) => record(value) && Object.hasOwn(value, key) && value[key] !== null;
function marker(value: unknown): boolean {
  return record(value) && (Object.hasOwn(value, "checkpointClaim") ||
    present(value.stage, "checkpointPolicy") || present(value.stage, "cardCheckpointPolicy"));
}
/** A legacy/read-only caller cannot silently project away a required execution boundary. */
export function refuseLegacyCheckpoint(value: unknown): void {
  if (marker(value)) throw new CheckpointClaimRefused("unrequested");
}

export function parsePendingCheckpointClaim(value: unknown): PendingCheckpointClaim {
  bounded(value);
  const parsed = pendingSchema.safeParse(value);
  if (!parsed.success) throw new CheckpointClaimRefused("invalid");
  if (checkpointPolicyDigest(parsed.data.policy) !== parsed.data.policyDigest)
    throw new CheckpointClaimRefused("policy");
  // The frozen selection names exactly the narrowed policy's repositories and start.
  if (parsed.data.selection && !selectionMatchesPolicy(parsed.data.selection, parsed.data.policy))
    throw new CheckpointClaimRefused("policy");
  return parsed.data;
}

/**
 * The claim's policy against its stage's. A stage with `checkpointPolicy` (v1, fixed repositories)
 * must equal the claim's by digest, and its claim carries no selection. A stage with
 * `cardCheckpointPolicy` (v2, the card chooses) is read only by a claimant that asked for claim
 * protocol v2, and its claim's selection and narrowed policy are recomputed from it.
 */
function requireStagePolicy(stage: Record<string, unknown>, pending: PendingCheckpointClaim, choosesRepositories: boolean,
  shape: "binding" | "context"): void {
  const fixed = present(stage, "checkpointPolicy");
  const card = present(stage, "cardCheckpointPolicy");
  // No policy, or a v1 policy that does not parse, is the shape refusal it always was.
  if (!fixed && !card) throw new CheckpointClaimRefused(shape);
  if (fixed && card) throw new CheckpointClaimRefused("policy");
  if (fixed) {
    if (!policySchema.safeParse(stage.checkpointPolicy).success) throw new CheckpointClaimRefused(shape);
    if (pending.selection !== undefined || checkpointPolicyDigest(stage.checkpointPolicy) !== pending.policyDigest)
      throw new CheckpointClaimRefused("policy");
    return;
  }
  if (!choosesRepositories) throw new CheckpointClaimRefused("unrequested");
  verifyCheckpointSelection(stage.cardCheckpointPolicy, pending);
}

const cardBinding = z.object({ id: text, currentStageKey: text, currentRunId: text,
  delegateAgentId: text, state: z.literal("working") }).passthrough();
const stageBinding = z.object({ key: text }).passthrough();
const claimBinding = z.object({ claimed: z.literal(true), runId: text, leaseEpoch: epoch,
  card: cardBinding, stage: stageBinding }).passthrough();

/**
 * Preserve a requested DTO only after it agrees with the actual claimed card, run and policy.
 * `choosesRepositories` is whether this claimant sent claim protocol v2 (`checkpointProtocols`):
 * only then may the stage be one whose cards choose.
 */
export function readCheckpointClaim(value: unknown, protocol: unknown, boardId: string,
  choosesRepositories = false): PendingCheckpointClaim | undefined {
  if (protocol !== undefined && protocol !== CHECKPOINT_CLAIM_PROTOCOL) throw new CheckpointClaimRefused("unsupported");
  if (choosesRepositories && protocol !== CHECKPOINT_CLAIM_PROTOCOL) throw new CheckpointClaimRefused("unsupported");
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
  requireStagePolicy(stage, pending, choosesRepositories, "binding");
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
  // A claim with a selection was read under claim protocol v2, so its stage may be one whose cards choose.
  requireStagePolicy(stage, pending, pending.selection !== undefined, "context");
}
