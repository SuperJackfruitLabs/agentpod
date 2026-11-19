import { expect, test } from "bun:test";
import { BenchCoordinatorCompletion, BenchCoordinatorRequest, benchCoordinatorBindingDigest } from "@agentpod/contract";
import corpus from "../../../../../packages/contract/src/fixtures/bench-coordinator-v1.json";
import { buildCheckpointSettlement } from "./checkpoint-report";
import { parseCheckpointProfile } from "./checkpoint-profile";
import { checkpointPolicyDigest, parsePendingCheckpointClaim } from "./checkpoint-claim";
import { canonicalCheckpoint } from "./checkpoint-json";
import type { RetainedCheckpointAttempt } from "./checkpoint-ledger";

async function fixture() {
  const sent = corpus.requests.find((item) => item.name === "prepare");
  const received = corpus.responses.find((item) => item.name === "completed");
  if (!sent || !received || !("completion" in received.value)) throw new Error("shared fixture missing");
  const request = BenchCoordinatorRequest.parse(structuredClone(sent.value));
  if (request.operation !== "prepare") throw new Error("fixture operation");
  const completion = BenchCoordinatorCompletion.parse(structuredClone(received.value.completion));
  request.identity.control_principal_id = "prn_" + "a".repeat(20);
  completion.source.binding.identity.control_principal_id = request.identity.control_principal_id;
  completion.source.binding_sha256 = await benchCoordinatorBindingDigest(completion.source.binding);
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
  const first = completion.service.checkpoints[0];
  if (!first) throw new Error("fixture checkpoint missing");
  first.commit = "1".repeat(first.commit.length);
  // The production constructor reads this structure from the actual immutable
  // database row; this unit tests only projection joins, not issuer authority.
  const attempt: RetainedCheckpointAttempt = { request, profile, claim, row: { tenantId: identity.tenant_id,
    boardId: identity.board_id, runId: identity.run_id, leaseEpoch: identity.epoch, attemptId: identity.attempt_id,
    profile: canonicalCheckpoint(profile), claim: canonicalCheckpoint(claim), authority: "retained-by-real-ledger",
    prepareRequest: JSON.stringify(request), prepareSHA256: "e".repeat(64), phase: "completed",
    prepared: canonicalCheckpoint(completion.source), source: null, sourceReceipt: null, executeRequest: null,
    executeSHA256: null, completion: null, settlementBody: null, settlementSHA256: null, settlementReceipt: null, retirement: null, failure: null, failureReport: null,
    createdAt: new Date(0), updatedAt: new Date(0) } };
  return { attempt, completion };
}
test("whole report uses only trusted logical repository mapping and exact source/completion", async () => {
  const { attempt, completion } = await fixture();
  const result = await buildCheckpointSettlement(attempt, completion);
  expect(result.value.checkpoint.binding.runId).toBe(attempt.claim.runId);
  expect(result.value.checkpoint.checkpoint.members.map((m) => m.repository)).toEqual(attempt.profile.repositories.map((m) => m.repository));
  expect(result.value.checkpoint.sourceRequestSha256).toBe(completion.source_request_sha256);
  expect(result.value.checkpoint.sourceReceiptSha256).toBe(completion.source_receipt_sha256);
  expect(result.body).toBe(canonicalCheckpoint(result.value));
  expect(result.body).not.toContain("repository_sha256");
  expect(result.body).not.toContain("control_grant_id");
});
test.each(["unreleased", "failed", "unchanged", "foreign-start", "foreign-repository", "unknown-capability"])("%s never becomes a settlement", async (kind) => {
  const { attempt, completion } = await fixture();
  const changed: unknown = kind === "unreleased" ? { ...completion, service: { ...completion.service, released: false } } :
    kind === "unchanged" ? { ...completion, service: { ...completion.service, checkpoints: completion.source.binding.sources } } :
    kind === "failed" ? { ...completion, task: { ...completion.task, outcome: "failed" } } :
    kind === "foreign-start" ? { ...completion, source: { ...completion.source, request_id: "foreign_request" } } :
    kind === "foreign-repository" ? { ...completion, service: { ...completion.service, checkpoints: completion.service.checkpoints.map((m) => ({ ...m, repository_sha256: "f".repeat(64) })) } } :
    { ...completion, lease_token: "not-a-real-token" };
  await expect(buildCheckpointSettlement(attempt, changed)).rejects.toThrow("source");
});
