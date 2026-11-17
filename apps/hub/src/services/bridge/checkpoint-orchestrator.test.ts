import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { BenchCoordinatorRequest } from "@agentpod/contract";
import corpus from "../../../../../packages/contract/src/fixtures/bench-coordinator-v1.json";
import { TEST_PLANE } from "../../auth/org-plane/config";
import { checkpointPolicyDigest, parsePendingCheckpointClaim } from "./checkpoint-claim";
import { canonicalCheckpoint } from "./checkpoint-json";
import type { RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { driveCheckpointAttempt, type CheckpointDriveDeps } from "./checkpoint-orchestrator";
import { parseCheckpointProfile } from "./checkpoint-profile";
import { CAPACITY_REASON } from "./checkpoint-refusal";
import { createCheckpointServiceClient } from "./checkpoint-service-client";
import { SuperpipelineClient } from "./superpipeline";

// A retained execute_pending attempt shaped like the real ledger row. The
// broker and authority are injected; nothing touches a database or a node.
function executePending(): RetainedCheckpointAttempt {
  const sent = corpus.requests.find((item) => item.name === "prepare");
  if (!sent) throw new Error("shared fixture missing");
  const request = BenchCoordinatorRequest.parse(structuredClone(sent.value));
  if (request.operation !== "prepare") throw new Error("fixture operation");
  request.identity.control_principal_id = "prn_" + "a".repeat(20);
  const identity = request.identity;
  const repositories = [{ name: "api", repositorySHA256: "a".repeat(64), provider: "forge", repository: "example/api", objectFormat: "sha1" }];
  const profile = parseCheckpointProfile({ version: "agentpod.checkpoint-profile.v1", organizationId: "org_" + "b".repeat(20),
    sourceTenantId: "tnt_source", sourceOrigin: "https://pipeline.test", sourceAudience: "https://app.superpipeline.dev",
    reporterPrincipalId: "prn_" + "c".repeat(20), ownerPrincipalId: identity.control_principal_id,
    occupantPrincipalId: "prn_" + "d".repeat(20), agentKey: "fixture", profileKey: request.task.profile_id,
    occupancyEpoch: 1, target: request.target, repositories, checkpointRepository: "api" });
  const policy = { version: "superpipeline.checkpoint-policy.v1", kind: "superbench", allowUnchanged: false,
    repositories: repositories.map(({ name, provider, repository }) => ({ name, provider, repository })),
    checkpointRepository: profile.checkpointRepository, reporterPrincipalId: profile.reporterPrincipalId,
    nodeId: profile.target.node_id, executors: [{ agentId: identity.agent_id, stationId: identity.station_id }] };
  const claim = parsePendingCheckpointClaim({ version: "superpipeline.checkpoint-claim.v1", admissionState: "pending",
    tenantId: profile.sourceTenantId, boardId: identity.board_id, cardId: identity.card_id, stageKey: identity.stage_id,
    agentId: identity.agent_id, runId: identity.run_id, leaseEpoch: identity.epoch, policy, policyDigest: checkpointPolicyDigest(policy) });
  const execute = JSON.stringify({ version: request.version, operation: "execute", identity, target: request.target });
  return { request, profile, claim, row: { tenantId: identity.tenant_id, boardId: identity.board_id, runId: identity.run_id,
    leaseEpoch: identity.epoch, attemptId: identity.attempt_id, profile: canonicalCheckpoint(profile), claim: canonicalCheckpoint(claim),
    authority: "retained-by-real-ledger", prepareRequest: JSON.stringify(request), prepareSHA256: "e".repeat(64), phase: "execute_pending",
    prepared: null, source: null, sourceReceipt: null, executeRequest: execute, executeSHA256: createHash("sha256").update(execute, "utf8").digest("hex"),
    completion: null, settlementBody: null, settlementSHA256: null, settlementReceipt: null, createdAt: new Date(0), updatedAt: new Date(0) } };
}

function harness(reply: unknown) {
  const sent: unknown[] = [];
  const deps: CheckpointDriveDeps = {
    authority: async () => {},
    request: async (_node, _verb, params) => { sent.push(params); return { ok: true, data: reply }; },
    service: (profile) => createCheckpointServiceClient(profile, { plane: TEST_PLANE, fetch: async () => new Response(null, { status: 500 }) }),
  };
  const client = new SuperpipelineClient({ baseUrl: "https://board.test", boardId: "brd_ABC123", token: "spa_fixture",
    fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }) });
  return { sent, deps, client };
}

test("a capacity refusal on execute is named and the row stays parked on its phase", async () => {
  const attempt = executePending();
  const h = harness({ version: "agentpod.bench-coordinator.v1", operation: "status", state: "refused", code: "capacity_exhausted" });
  const result = await driveCheckpointAttempt(attempt, h.client, false, h.deps);
  expect(result).toEqual({ status: "unreported", externalRunId: attempt.claim.runId, attemptId: attempt.row.attemptId, reason: CAPACITY_REASON });
  expect(attempt.row.phase).toBe("execute_pending");
  // Only a status read went to the node; execute was never re-sent.
  expect(h.sent).toHaveLength(1);
  expect(JSON.stringify(h.sent[0])).toContain('"operation":"status"');
});

test("any other refusal stays the generic reconciliation park", async () => {
  const attempt = executePending();
  const h = harness({ version: "agentpod.bench-coordinator.v1", operation: "status", state: "refused", code: "unavailable" });
  const result = await driveCheckpointAttempt(attempt, h.client, false, h.deps);
  expect(result.reason).toBe("Checkpoint dispatch requires reconciliation");
  expect(attempt.row.phase).toBe("execute_pending");
});
