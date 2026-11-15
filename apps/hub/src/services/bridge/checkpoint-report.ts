/** Proposed service report built only from retained selected-node observations. */
import { createHash } from "node:crypto";
import { checkpointSettlementSchema, type CheckpointSettlement } from "./checkpoint-settlement-data";
import { BenchCoordinatorCompletion } from "@agentpod/contract";
import { canonicalCheckpoint } from "./checkpoint-json";
import { CheckpointRefused } from "./checkpoint-profile";
import { retainedCheckpointSource } from "./checkpoint-current-decision";
import type { RetainedCheckpointAttempt } from "./checkpoint-ledger";


/** The caller must independently authenticate the selected Node, require its
 * current control/profile, and retain this entire immutable body before POST.
 * Hashes identify observed private evidence; this builder does not attest it.
 */
export async function buildCheckpointSettlement(attempt: RetainedCheckpointAttempt, value: unknown): Promise<{ value: CheckpointSettlement; body: string; sha256: string }> {
  try {
    const completion = BenchCoordinatorCompletion.parse(value);
    const { prepared, source } = await retainedCheckpointSource(attempt);
    if (canonicalCheckpoint(completion.source) !== canonicalCheckpoint(prepared) ||
      completion.source_request_sha256 !== source.sourceRequestSha256 || completion.task.outcome !== "complete")
      throw new CheckpointRefused("source");
    const final = completion.service;
    const changed = final.checkpoints.some((m, index) => m.commit !== source.start[index]?.commit);
    if (!changed && !attempt.claim.policy.allowUnchanged) throw new CheckpointRefused("source");
    const members = final.checkpoints.map((m, index) => {
      const pin = attempt.profile.repositories[index];
      if (!pin || pin.name !== m.name || pin.repositorySHA256 !== m.repository_sha256 ||
        m.task_ref !== "refs/heads/card/" + attempt.claim.cardId) throw new CheckpointRefused("source");
      return { name: pin.name, provider: pin.provider, repository: pin.repository,
        branch: m.task_ref.slice("refs/heads/".length), objectFormat: pin.objectFormat, commit: m.commit };
    });
    const settlement = checkpointSettlementSchema.parse({ version: "superpipeline.checkpoint-settlement.v1", checkpoint: {
      version: "superpipeline.run-checkpoint.v1", settlementId: "cp_" + createHash("sha256").update(attempt.row.attemptId).digest("hex"),
      binding: source.binding, policyDigest: attempt.claim.policyDigest, disposition: changed ? "changed" : "unchanged", start: source.start,
      checkpoint: { protocol: "superbench.v2", key: source.benchKey, benchId: source.benchId, requestId: source.requestId,
        generationId: final.generation_id, seal: final.seal_commit, manifestSha256: final.manifest_sha256,
        members, checkpointRepository: prepared.checkpoint_repository }, execution: { id: final.execution_id, exitCode: 0 },
      workerResultSha256: final.worker_result_sha256, sourceReceiptSha256: completion.source_receipt_sha256,
      sourceRequestSha256: completion.source_request_sha256 }, handoff: completion.task.handoff, outcome: "pass" });
    const body = canonicalCheckpoint(settlement);
    if (Buffer.byteLength(body, "utf8") > 65536) throw new CheckpointRefused("invalid");
    return { value: settlement, body, sha256: createHash("sha256").update(body, "utf8").digest("hex") };
  } catch { throw new CheckpointRefused("source"); }
}
