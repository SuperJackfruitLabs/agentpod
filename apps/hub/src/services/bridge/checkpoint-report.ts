/** Proposed service report built only from retained selected-node observations. */
import { createHash } from "node:crypto";
import { checkpointSettlementSchema, type CheckpointSettlement } from "./checkpoint-settlement-data";
import { BenchCoordinatorCompletion } from "@agentpod/contract";
import { canonicalCheckpoint } from "./checkpoint-json";
import { CheckpointRefused, type CheckpointSettlementRefusal } from "./checkpoint-profile";
import { retainedCheckpointSource } from "./checkpoint-current-decision";
import type { RetainedCheckpointAttempt } from "./checkpoint-ledger";


const refuse = (why: CheckpointSettlementRefusal, cause?: unknown) => new CheckpointRefused("source", `settlement.${why}`, cause);

/**
 * The caller must independently authenticate the selected Node, require its current control/profile,
 * and retain this entire immutable body before POST. Hashes identify observed private evidence; this
 * builder does not attest it.
 *
 * Every refusal names why (`settlement.*`). Its inputs are the attempt's immutable cells and the
 * node's journaled completion, so a refusal here is deterministic: the same attempt is refused the
 * same way on every pass, and the orchestrator ends it failed instead of re-checking it forever.
 */
export async function buildCheckpointSettlement(attempt: RetainedCheckpointAttempt, value: unknown): Promise<{ value: CheckpointSettlement; body: string; sha256: string }> {
  const parsedCompletion = BenchCoordinatorCompletion.safeParse(value);
  if (!parsedCompletion.success) throw refuse("completion", parsedCompletion.error);
  const completion = parsedCompletion.data;
  let retained: Awaited<ReturnType<typeof retainedCheckpointSource>>;
  try { retained = await retainedCheckpointSource(attempt); }
  catch (error) { throw refuse("retained_source", error); }
  const { prepared, source } = retained;
  if (canonicalCheckpoint(completion.source) !== canonicalCheckpoint(prepared) ||
    completion.source_request_sha256 !== source.sourceRequestSha256) throw refuse("foreign_source");
  if (completion.task.outcome !== "complete") throw refuse("task_outcome");
  const final = completion.service;
  const changed = final.checkpoints.some((m, index) => m.commit !== source.start[index]?.commit);
  if (!changed && !attempt.claim.policy.allowUnchanged) throw refuse("unchanged");
  const members = [];
  for (const [index, m] of final.checkpoints.entries()) {
    const pin = attempt.profile.repositories[index];
    if (!pin || pin.name !== m.name || pin.repositorySHA256 !== m.repository_sha256 ||
      m.task_ref !== "refs/heads/card/" + attempt.claim.cardId) throw refuse("foreign_member");
    members.push({ name: pin.name, provider: pin.provider, repository: pin.repository,
      branch: m.task_ref.slice("refs/heads/".length), objectFormat: pin.objectFormat, commit: m.commit });
  }
  const parsed = checkpointSettlementSchema.safeParse({ version: "superpipeline.checkpoint-settlement.v1", checkpoint: {
    version: "superpipeline.run-checkpoint.v1", settlementId: "cp_" + createHash("sha256").update(attempt.row.attemptId).digest("hex"),
    binding: source.binding, policyDigest: attempt.claim.policyDigest, disposition: changed ? "changed" : "unchanged", start: source.start,
    checkpoint: { protocol: "superbench.v2", key: source.benchKey, benchId: source.benchId, requestId: source.requestId,
      generationId: final.generation_id, seal: final.seal_commit, manifestSha256: final.manifest_sha256,
      members, checkpointRepository: prepared.checkpoint_repository }, execution: { id: final.execution_id, exitCode: 0 },
    workerResultSha256: final.worker_result_sha256, sourceReceiptSha256: completion.source_receipt_sha256,
    sourceRequestSha256: completion.source_request_sha256 }, handoff: completion.task.handoff, outcome: "pass" });
  if (!parsed.success) throw refuse("shape", parsed.error);
  const body = canonicalCheckpoint(parsed.data);
  if (Buffer.byteLength(body, "utf8") > 65536) throw refuse("size");
  return { value: parsed.data, body, sha256: createHash("sha256").update(body, "utf8").digest("hex") };
}
