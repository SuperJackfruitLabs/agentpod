/**
 * Test-only: an execute_pending attempt whose retained prepared source is exactly the shared corpus's
 * completed reply's, so a completed reply for it reaches the settlement builder. Shared by the
 * report and orchestrator tests and by the recorded completed-reply fixture.
 */
import { createHash } from "node:crypto";
import { BenchCoordinatorCompletion, BenchCoordinatorRequest, benchCoordinatorBindingDigest } from "@agentpod/contract";
import corpus from "../../../../../packages/contract/src/fixtures/bench-coordinator-v1.json";
import { parseCheckpointProfile } from "./checkpoint-profile";
import { checkpointPolicyDigest, parsePendingCheckpointClaim } from "./checkpoint-claim";
import { canonicalCheckpoint } from "./checkpoint-json";
import type { RetainedCheckpointAttempt } from "./checkpoint-ledger";

export async function completedAttemptFixture(): Promise<{ attempt: RetainedCheckpointAttempt; completion: BenchCoordinatorCompletion }> {
  const sent = corpus.requests.find((item) => item.name === "prepare");
  const received = corpus.responses.find((item) => item.name === "completed");
  if (!sent || !received || !("completion" in received.value)) throw new Error("shared fixture missing");
  const request = BenchCoordinatorRequest.parse(structuredClone(sent.value));
  if (request.operation !== "prepare") throw new Error("fixture operation");
  const completion = BenchCoordinatorCompletion.parse(structuredClone(received.value.completion));
  request.identity.control_principal_id = "prn_" + "a".repeat(20);
  completion.source.binding.identity.control_principal_id = request.identity.control_principal_id;
  const identity = request.identity;
  const repositories = completion.source.binding.members.map((m) => ({ name: m.name, repositorySHA256: m.repository_sha256,
    provider: "forge" as const, repository: "example/" + m.name, objectFormat: m.object_format }));
  const profile = parseCheckpointProfile({ version: "agentpod.checkpoint-profile.v1", organizationId: "org_" + "b".repeat(20),
    sourceTenantId: "tnt_source", sourceOrigin: "https://pipeline.test", sourceAudience: "https://app.superpipeline.dev",
    reporterPrincipalId: "prn_" + "c".repeat(20), ownerPrincipalId: identity.control_principal_id,
    occupantPrincipalId: "prn_" + "d".repeat(20), agentKey: "fixture", profileKey: request.task.profile_id,
    occupancyEpoch: 1, target: request.target, repositories, checkpointRepository: completion.source.checkpoint_repository });
  const policy = { version: "superpipeline.checkpoint-policy.v1", kind: "superbench", allowUnchanged: false,
    repositories: repositories.map(({ name, provider, repository }) => ({ name, provider, repository })),
    checkpointRepository: profile.checkpointRepository, reporterPrincipalId: profile.reporterPrincipalId,
    nodeId: profile.target.node_id, executors: [{ agentId: identity.agent_id, stationId: identity.station_id }] };
  const claim = parsePendingCheckpointClaim({ version: "superpipeline.checkpoint-claim.v1", admissionState: "pending",
    tenantId: profile.sourceTenantId, boardId: identity.board_id, cardId: identity.card_id, stageKey: identity.stage_id,
    agentId: identity.agent_id, runId: identity.run_id, leaseEpoch: identity.epoch, policy, policyDigest: checkpointPolicyDigest(policy) });
  request.identity.policy_sha256 = claim.policyDigest;
  completion.source.binding.identity.policy_sha256 = claim.policyDigest;
  completion.source.binding_sha256 = await benchCoordinatorBindingDigest(completion.source.binding);
  const execute = JSON.stringify({ version: request.version, operation: "execute", identity, target: request.target });
  // The production constructor reads this structure from the actual immutable database row.
  const attempt: RetainedCheckpointAttempt = { request, profile, claim, row: { tenantId: identity.tenant_id,
    boardId: identity.board_id, runId: identity.run_id, leaseEpoch: identity.epoch, attemptId: identity.attempt_id,
    profile: canonicalCheckpoint(profile), claim: canonicalCheckpoint(claim), authority: "retained-by-real-ledger",
    prepareRequest: JSON.stringify(request), prepareSHA256: "e".repeat(64), phase: "execute_pending",
    prepared: canonicalCheckpoint(completion.source), source: null, sourceReceipt: null, executeRequest: execute,
    executeSHA256: createHash("sha256").update(execute, "utf8").digest("hex"), completion: null, settlementBody: null,
    settlementSHA256: null, settlementReceipt: null, retirement: null, failure: null, failureReport: null,
    createdAt: new Date(0), updatedAt: new Date(0) } };
  return { attempt, completion };
}
