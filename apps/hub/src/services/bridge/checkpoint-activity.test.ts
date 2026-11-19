import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { BenchCoordinatorCompletion, BenchCoordinatorPrepared, BenchCoordinatorRequest, benchCoordinatorBindingDigest } from "@agentpod/contract";
import corpus from "../../../../../packages/contract/src/fixtures/bench-coordinator-v1.json";
import { TEST_PLANE } from "../../auth/org-plane/config";
import { checkpointPolicyDigest, parsePendingCheckpointClaim } from "./checkpoint-claim";
import { canonicalCheckpoint } from "./checkpoint-json";
import type { RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { checkpointActivity, resetCheckpointActivityForTests } from "./checkpoint-activity";
import { driveCheckpointAttempt, type CheckpointDriveDeps } from "./checkpoint-orchestrator";
import { parseCheckpointProfile } from "./checkpoint-profile";
import { createCheckpointServiceClient } from "./checkpoint-service-client";
import { SuperpipelineClient } from "./superpipeline";

afterEach(() => resetCheckpointActivityForTests());

/** A fresh prepare_pending attempt from the shared corpus, as the real ledger would retain it. */
function preparePending(): RetainedCheckpointAttempt {
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
  const prepareRequest = JSON.stringify(request);
  return { request, profile, claim, row: { tenantId: identity.tenant_id, boardId: identity.board_id, runId: identity.run_id,
    leaseEpoch: identity.epoch, attemptId: identity.attempt_id, profile: canonicalCheckpoint(profile), claim: canonicalCheckpoint(claim),
    authority: "retained-by-real-ledger", prepareRequest, prepareSHA256: createHash("sha256").update(prepareRequest, "utf8").digest("hex"),
    phase: "prepare_pending", prepared: null, source: null, sourceReceipt: null, executeRequest: null, executeSHA256: null,
    completion: null, settlementBody: null, settlementSHA256: null, settlementReceipt: null, retirement: null, failure: null, failureReport: null,
    createdAt: new Date(0), updatedAt: new Date(0) } };
}

/** The corpus's prepared reply, re-bound to this attempt's identity. */
async function preparedReply(attempt: RetainedCheckpointAttempt) {
  const found = corpus.responses.find((c) => c.name === "prepared");
  const source = BenchCoordinatorPrepared.parse(structuredClone(Reflect.get(found?.value ?? {}, "source")));
  const binding = { ...source.binding, identity: attempt.request.identity };
  return { version: "agentpod.bench-coordinator.v1", operation: "prepare", state: "prepared",
    identity: attempt.request.identity, target: attempt.request.target,
    source: { ...source, binding, binding_sha256: await benchCoordinatorBindingDigest(binding) } };
}

/** A board that records every activity and answers each one with `activityStatus`. */
function board(activityStatus = 200) {
  const activities: Array<Record<string, unknown>> = [];
  const client = new SuperpipelineClient({ baseUrl: "https://board.test", boardId: "brd_ABC123", token: "spa_fixture",
    fetch: async (url, init) => {
      if (url.endsWith("/activities")) {
        activities.push(JSON.parse(init.body ?? "{}"));
        return { status: activityStatus, ok: activityStatus < 300, json: async () => ({}) };
      }
      return { status: 200, ok: true, json: async () => ({}) };
    } });
  return { client, activities };
}

function deps(reply: unknown, committed: boolean): CheckpointDriveDeps {
  return {
    authority: async () => {},
    request: async () => ({ ok: true, data: reply }),
    service: (profile) => createCheckpointServiceClient(profile, { plane: TEST_PLANE, fetch: async () => new Response(null, { status: 500 }) }),
    advance: async (attempt, evidence) => ({ attempt: { ...attempt, row: { ...attempt.row, ...evidence } }, send: committed }),
    fail: async () => { throw new Error("no refusal in this test"); },
    close: async () => { throw new Error("no refusal in this test"); },
  };
}

test("a committed phase is said on the card once, and the park after it once", async () => {
  const attempt = preparePending();
  const reply = await preparedReply(attempt);
  const b = board();
  // The fixture's prepared source fails the profile's repository pins at the next phase, so it parks there.
  const result = await driveCheckpointAttempt(attempt, b.client, true, deps(reply, true));
  expect(result.status).toBe("unreported");
  expect(b.activities.map((a) => a.action)).toEqual(["checkpoint.prepared", "checkpoint.parked"]);
  expect(b.activities[1]).toMatchObject({ type: "action", parameter: { phase: "prepared", code: "source" } });
  // Re-checked on every backoff: the same park is not said again.
  await driveCheckpointAttempt({ ...attempt, row: { ...attempt.row, phase: "prepared", prepared: canonicalCheckpoint(reply.source) } },
    b.client, false, deps(reply, true));
  expect(b.activities.map((a) => a.action)).toEqual(["checkpoint.prepared", "checkpoint.parked"]);
});

test("a phase another pass committed is not said again", async () => {
  const attempt = preparePending();
  const b = board();
  await driveCheckpointAttempt(attempt, b.client, true, deps(await preparedReply(attempt), false));
  expect(b.activities.map((a) => a.action)).not.toContain("checkpoint.prepared");
});

test("a board that refuses the activity changes nothing about the checkpoint", async () => {
  const attempt = preparePending();
  const reply = await preparedReply(attempt);
  const quiet = await driveCheckpointAttempt(attempt, board(200).client, true, deps(reply, true));
  resetCheckpointActivityForTests();
  const refused = board(500);
  const loud = await driveCheckpointAttempt(attempt, refused.client, true, deps(reply, true));
  expect(refused.activities.length).toBeGreaterThan(0);
  expect(loud).toEqual(quiet);
});

test("the pushed checkpoint names every member's branch and commit", () => {
  const completion = BenchCoordinatorCompletion.parse(Reflect.get(corpus.responses.find((c) => c.name === "completed")?.value ?? {}, "completion"));
  const activity = checkpointActivity("pushed", { completion });
  const member = completion.service.checkpoints[0];
  if (!member) throw new Error("fixture has no member");
  expect(activity?.action).toBe("checkpoint.pushed");
  expect(activity?.body).toContain(member.commit);
  expect(activity?.body).toContain(member.task_ref.replace("refs/heads/", ""));
});
