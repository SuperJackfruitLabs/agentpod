import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { BenchCoordinatorRequest, parseBenchCoordinatorResponse } from "@agentpod/contract";
import corpus from "../../../../../packages/contract/src/fixtures/bench-coordinator-v1.json";
import nodeRefusals from "../../../../../packages/contract/src/fixtures/bench-coordinator-node-refusals-v1.json";
import nodeCompletions from "../../../../../packages/contract/src/fixtures/bench-coordinator-node-completions-v1.json";
import { completedAttemptFixture } from "./checkpoint-completed-attempt.test-fixture";
import { CheckpointRefused } from "./checkpoint-profile";
import { TEST_PLANE } from "../../auth/org-plane/config";
import { checkpointPolicyDigest, parsePendingCheckpointClaim } from "./checkpoint-claim";
import { canonicalCheckpoint } from "./checkpoint-json";
import type { RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { CHECKPOINT_RUNNING_RECHECK_MS, driveCheckpointAttempt, endEndedRun, RUN_ENDED_GRACE_MS, setParkedLogForTests,
  type CheckpointDriveDeps } from "./checkpoint-orchestrator";
import { endedRunView, movedRunView, runView } from "./checkpoint-run-view.test-fixture";
import { CheckpointClaimRefused, validateCheckpointContext } from "./checkpoint-claim";
import type { CheckpointServiceClient } from "./checkpoint-service-client";
import type { CheckpointReceipt } from "./checkpoint-settlement-data";
import { createQuietLog } from "./quiet-log";
import { resetCheckpointActivityForTests } from "./checkpoint-activity";
import { NODE_CALL_TIMEOUT_MS } from "./checkpoint-node-call";
import { capacityCard, createCapacityBackoff, CAPACITY_BACKOFF_BASE_MS, CAPACITY_RELEASE_CAP } from "./checkpoint-capacity-backoff";
import { parseCheckpointProfile } from "./checkpoint-profile";
import { createCheckpointServiceClient } from "./checkpoint-service-client";
import { SuperpipelineClient } from "./superpipeline";
import { contractFetch } from "../../../tests/helpers/superpipeline-contract";

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
    completion: null, settlementBody: null, settlementSHA256: null, settlementReceipt: null, retirement: null, failure: null, failureReport: null, createdAt: new Date(0), updatedAt: new Date(0) } };
}

function harness(reply: unknown) {
  const sent: unknown[] = [];
  const deps: CheckpointDriveDeps = {
    authority: async () => {},
    request: async (_node, _verb, params) => { sent.push(params); return { ok: true, data: reply }; },
    service: (profile) => createCheckpointServiceClient(profile, { plane: TEST_PLANE, fetch: async () => new Response(null, { status: 500 }) }),
    advance: async () => { throw new Error("no ledger in this test"); },
    fail: async () => { throw new Error("no ledger in this test"); },
    close: async () => { throw new Error("no ledger in this test"); },
    retire: async () => { throw new Error("no ledger in this test"); },
    now: () => 0,
  };
  const client = new SuperpipelineClient({ baseUrl: "https://board.test", boardId: "brd_ABC123", token: "spa_fixture",
    fetch: contractFetch(async () => ({ status: 200, ok: true, json: async () => ({}) })) });
  return { sent, deps, client };
}

test("any other refusal stays the generic reconciliation park", async () => {
  const attempt = executePending();
  const h = harness({ version: "agentpod.bench-coordinator.v1", operation: "status", state: "refused", code: "unavailable" });
  const result = await driveCheckpointAttempt(attempt, h.client, false, h.deps);
  expect(result.reason).toBe("Checkpoint dispatch requires reconciliation");
  expect(attempt.row.phase).toBe("execute_pending");
});

// The bridge sends every node-internal parked state (cancel_requested,
// release_refused, ...) as the shared corpus "pending" response; the
// benchbridge Go test pins those bytes. The hub parses it and parks generically.
test("a node-internal parked state arrives as pending and parks the row", async () => {
  const pending = corpus.responses.find((c) => c.name === "pending");
  if (!pending) throw new Error("shared pending fixture missing");
  const attempt = executePending();
  const reply = { ...pending.value, identity: attempt.request.identity, target: attempt.request.target };
  const h = harness(reply);
  const result = await driveCheckpointAttempt(attempt, h.client, false, h.deps);
  expect(result.reason).toBe("Checkpoint dispatch requires reconciliation");
  expect(attempt.row.phase).toBe("execute_pending");
  expect(h.sent).toHaveLength(1);
  // It parked because it parsed as pending, not because parsing failed.
  const parsed = await parseBenchCoordinatorResponse(new TextEncoder().encode(JSON.stringify(reply)), BenchCoordinatorRequest.parse(h.sent[0]));
  expect(parsed.state).toBe("pending");
});

// The staging park that said nothing: execute_pending, a node reply that is not completed, and no
// reason in the log or on the card. Every non-completed node state parks naming it.
test.each(["pending", "unknown", "superseded"])("execute_pending parks a node %s reply naming node.state", async (state) => {
  const pending = corpus.responses.find((c) => c.name === "pending");
  if (!pending) throw new Error("shared pending fixture missing");
  resetCheckpointActivityForTests();
  const lines: Array<Record<string, unknown> | undefined> = [];
  const restore = setParkedLogForTests(createQuietLog((_m, meta) => lines.push(meta), { now: () => 0 }));
  try {
    const attempt = executePending();
    const h = harness({ ...pending.value, state, identity: attempt.request.identity, target: attempt.request.target });
    const board = recordingBoard();
    const result = await driveCheckpointAttempt(attempt, board.client, false, h.deps);
    expect(result).toMatchObject({ status: "unreported", reason: "Checkpoint dispatch requires reconciliation" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ phase: "execute_pending", code: "uncertain", reason: `node.state:${state}` });
    expect(JSON.stringify(board.calls)).toContain(`node.state:${state}`);
  } finally { restore(); }
});

test("an attempt parked on every re-check is logged once per phase and code, then once per interval", async () => {
  const pending = corpus.responses.find((c) => c.name === "pending");
  if (!pending) throw new Error("shared pending fixture missing");
  let t = 0;
  const lines: Array<Record<string, unknown> | undefined> = [];
  const restore = setParkedLogForTests(createQuietLog((_m, meta) => lines.push(meta), { now: () => t, relogMs: 1_000 }));
  try {
    const attempt = executePending();
    const reply = { ...pending.value, identity: attempt.request.identity, target: attempt.request.target };
    for (let i = 0; i < 5; i++) {
      const h = harness(reply);
      expect((await driveCheckpointAttempt(attempt, h.client, false, h.deps)).status).toBe("unreported");
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ attemptId: attempt.row.attemptId, phase: "execute_pending", code: "uncertain" });
    t = 2_000;
    const h = harness(reply);
    await driveCheckpointAttempt(attempt, h.client, false, h.deps);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ suppressed: 4 });
  } finally { restore(); }
});

test("a node call that times out parks the attempt naming the timeout, not a bare uncertain", async () => {
  const lines: Array<Record<string, unknown> | undefined> = [];
  const restore = setParkedLogForTests(createQuietLog((_m, meta) => lines.push(meta), { now: () => 0 }));
  try {
    const attempt = executePending();
    const h = harness({});
    h.deps.request = async () => ({ ok: false, error: "timeout" });
    expect((await driveCheckpointAttempt(attempt, h.client, false, h.deps)).status).toBe("unreported");
    expect(lines).toEqual([expect.objectContaining({ attemptId: attempt.row.attemptId, code: "uncertain",
      reason: "node.call.timeout", errorClass: "Error", error: "timeout" })]);
  } finally { restore(); }
});

// The production soak: every real run outlived the Hub's 60 s execute wait, and each card then read
// "waiting at execute_pending (uncertain, node.call.timeout)", which looks like a fault. It is not one.
test("a run that outlives the execute wait is said once on the card as still running, not as a fault", async () => {
  resetCheckpointActivityForTests();
  const attempt = executePending();
  const h = harness({});
  const answers: Array<{ ok: false; error: string } | { ok: true; data: unknown }> = [{ ok: false, error: "timeout" },
    { ok: true, data: pendingStatus(attempt) }, { ok: true, data: pendingStatus(attempt) }];
  h.deps.request = async () => answers.shift() ?? { ok: true, data: pendingStatus(attempt) };
  const board = recordingBoard((path) => path.endsWith(`/runs/${attempt.claim.runId}`)
    ? { status: 200, body: runView(attempt.claim) } : { status: 200 });
  for (let i = 0; i < 3; i++) expect((await driveCheckpointAttempt(attempt, board.client, false, h.deps)).status).toBe("unreported");
  const activities = board.calls.filter((c) => c.path.endsWith("/activities")).map((c) => c.body);
  expect(activities).toEqual([expect.objectContaining({ action: "checkpoint.running",
    parameter: { phase: "execute_pending", waiting: true, reason: "node.call.timeout" } })]);
  const body = String(activities[0]?.body);
  expect(body).toContain("still running");
  for (const word of ["uncertain", "node.call", "waiting at"]) expect(body).not.toContain(word);
});

// Staging: every run longer than the 60 s execute wait then paid the 30 s fault backoff, with a warning.
test("a run still going after the execute wait asks for a short recheck and warns nothing", async () => {
  resetCheckpointActivityForTests();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const info = spyOn(console, "log").mockImplementation(() => {});
  try {
    const attempt = executePending();
    const h = harness({});
    const answers: Array<{ ok: false; error: string } | { ok: true; data: unknown }> = [{ ok: false, error: "timeout" },
      { ok: true, data: pendingStatus(attempt) }];
    h.deps.request = async () => answers.shift() ?? { ok: true, data: pendingStatus(attempt) };
    const board = recordingBoard((path) => path.endsWith(`/runs/${attempt.claim.runId}`)
      ? { status: 200, body: runView(attempt.claim) } : { status: 200 });
    for (let i = 0; i < 2; i++) {
      const result = await driveCheckpointAttempt(attempt, board.client, false, h.deps);
      expect(result).toMatchObject({ status: "unreported", recheckMs: CHECKPOINT_RUNNING_RECHECK_MS });
    }
    expect(warn).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); info.mockRestore(); }
  // A park that is a fault keeps the fault backoff: no recheck.
  for (const [attempt, reply] of [[preparePending(), { ok: false, error: "timeout" }],
    [executePending(), { ok: false, error: "node offline" }]] as const) {
    const h = harness({});
    h.deps.request = async () => reply;
    const board = recordingBoard((path) => path.endsWith(`/runs/${attempt.claim.runId}`)
      ? { status: 200, body: runView(attempt.claim) } : { status: 200 });
    const restore = setParkedLogForTests(createQuietLog(() => {}));
    try {
      const result = await driveCheckpointAttempt(attempt, board.client, attempt.row.phase === "prepare_pending", h.deps);
      expect(result.status).toBe("unreported");
      expect(result.recheckMs).toBeUndefined();
    } finally { restore(); }
  }
});

test("a park that is not a run still going keeps its own words", async () => {
  for (const [attempt, reply, reason] of [
    [preparePending(), { ok: false, error: "timeout" }, "node.call.timeout"],
    [executePending(), { ok: true, data: { ...pendingStatus(executePending()), detail: { message: "bench is reconciling" } } }, "node.state:pending"],
    [executePending(), { ok: false, error: "node offline" }, "node.call.offline"],
  ] as const) {
    resetCheckpointActivityForTests();
    const h = harness({});
    h.deps.request = async () => reply;
    const board = recordingBoard((path) => path.endsWith(`/runs/${attempt.claim.runId}`)
      ? { status: 200, body: runView(attempt.claim) } : { status: 200 });
    expect((await driveCheckpointAttempt(attempt, board.client, attempt.row.phase === "prepare_pending", h.deps)).status).toBe("unreported");
    const activities = board.calls.filter((c) => c.path.endsWith("/activities")).map((c) => c.body);
    expect(activities).toEqual([expect.objectContaining({ action: "checkpoint.parked",
      parameter: expect.objectContaining({ phase: attempt.row.phase, code: "uncertain", reason }) })]);
    expect(String(activities[0]?.body)).toContain(`waiting at ${attempt.row.phase}`);
  }
});

/** The operation of a request the harness recorded. */
function operationOf(params: unknown): string {
  return BenchCoordinatorRequest.parse(params).operation;
}

/** The same attempt, still waiting on its prepare: the row a stranded staging attempt was left in. */
function preparePending(): RetainedCheckpointAttempt {
  const attempt = executePending();
  const prepareRequest = attempt.row.prepareRequest;
  return { ...attempt, row: { ...attempt.row, phase: "prepare_pending", executeRequest: null, executeSHA256: null,
    prepareSHA256: createHash("sha256").update(prepareRequest, "utf8").digest("hex") } };
}

/** A node that answers status with `statusState` and a prepare with `pending`. */
function nodeAnswering(attempt: RetainedCheckpointAttempt, statusState: "unknown" | "pending") {
  const h = harness({});
  h.deps.request = async (_node, _verb, params) => {
    h.sent.push(params);
    const operation = operationOf(params);
    const state = operation === "status" ? statusState : "pending";
    return { ok: true, data: { version: "agentpod.bench-coordinator.v1", operation, state,
      identity: attempt.request.identity, target: attempt.request.target } };
  };
  return h;
}

test("a recovered prepare the node never resolved re-sends the identical retained prepare", async () => {
  const attempt = preparePending();
  const h = nodeAnswering(attempt, "unknown");
  expect((await driveCheckpointAttempt(attempt, h.client, false, h.deps)).status).toBe("unreported");
  expect(h.sent).toHaveLength(2);
  expect(operationOf(h.sent[0])).toBe("status");
  // Byte for byte the retained request, so the node's digest fence and the Hub's current-decision both match it.
  expect(JSON.stringify(h.sent[1])).toBe(attempt.row.prepareRequest);
  expect(attempt.row.phase).toBe("prepare_pending");
});

test("a recovered prepare the node left part way (pending) re-sends the identical prepare to resume it", async () => {
  const attempt = preparePending();
  const h = nodeAnswering(attempt, "pending");
  expect((await driveCheckpointAttempt(attempt, h.client, false, h.deps)).status).toBe("unreported");
  expect(h.sent).toHaveLength(2);
  expect(operationOf(h.sent[0])).toBe("status");
  expect(JSON.stringify(h.sent[1])).toBe(attempt.row.prepareRequest);
});

test("a recovered prepare the node refused is only read, never re-sent", async () => {
  const attempt = preparePending();
  const h = nodeAnswering(attempt, "pending");
  h.deps.request = async (_node, _verb, params) => {
    h.sent.push(params);
    return { ok: true, data: { version: "agentpod.bench-coordinator.v1", operation: "status", state: "refused", code: "unavailable" } };
  };
  expect((await driveCheckpointAttempt(attempt, h.client, false, h.deps)).status).toBe("unreported");
  expect(h.sent).toHaveLength(1);
});

test("unknown never re-sends anything after prepare: execute stays a status read", async () => {
  const attempt = executePending();
  const h = nodeAnswering(attempt, "unknown");
  expect((await driveCheckpointAttempt(attempt, h.client, false, h.deps)).status).toBe("unreported");
  expect(h.sent).toHaveLength(1);
  expect(operationOf(h.sent[0])).toBe("status");
});

test("each node call waits as long as its own operation needs, not a flat 15 seconds", async () => {
  const attempt = preparePending();
  const h = nodeAnswering(attempt, "unknown");
  const waits: Array<[string, number | undefined]> = [];
  const answer = h.deps.request;
  h.deps.request = async (node, verb, params, opts) => {
    waits.push([operationOf(params), opts?.timeoutMs]);
    return answer(node, verb, params, opts);
  };
  await driveCheckpointAttempt(attempt, h.client, false, h.deps);
  expect(waits).toEqual([["status", NODE_CALL_TIMEOUT_MS.status], ["prepare", NODE_CALL_TIMEOUT_MS.prepare]]);
  waits.length = 0;
  await driveCheckpointAttempt(executePending(), h.client, false, h.deps);
  expect(waits).toEqual([["status", NODE_CALL_TIMEOUT_MS.status]]);
});

// ---------------------------------------------------------------------------------------------
// A definite node refusal ends the attempt (checkpoint-refusal.ts holds the ruling).
// ---------------------------------------------------------------------------------------------

/** The node's reply after a worker crashed during execute, as the node's bridge sends it (pinned in Go). */
const workerCrash = (() => {
  const found = nodeRefusals.replies.find((r) => r.name === "worker-crash-status");
  if (!found) throw new Error("recorded node refusal missing");
  return found;
})();

/** The board, recording every call; `answer` decides a path's reply. */
function recordingBoard(answer: (path: string) => { status: number; body?: unknown } = () => ({ status: 200 })) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = new SuperpipelineClient({ baseUrl: "https://board.test", boardId: "brd_ABC123", token: "spa_fixture",
    fetch: contractFetch(async (url, init) => {
      const path = url.replace("https://board.test", "");
      calls.push({ path, body: JSON.parse(init.body ?? "{}") });
      const { status, body } = answer(path);
      return { status, ok: status < 300, json: async () => body ?? {} };
    }) });
  // A run verb by its action; the read-only run view (GET runs/:id, checkpoint-run-ended.ts) as "run".
  const verbs = () => calls.map((c) => c.path.replace(/^\/v1\/boards\/brd_ABC123\/runs\/[^/]+$/, "run")
    .replace(/^\/v1\/boards\/brd_ABC123\/runs\/[^/]+\//, ""));
  return { client, calls, verbs };
}

/** An in-memory ledger for the two failure transitions, shaped like the real compare-and-set. */
function ledger(deps: CheckpointDriveDeps) {
  const held: { failure?: Record<string, unknown>; closed?: string } = {};
  deps.fail = async (attempt, failure) => {
    held.failure = { version: "agentpod.checkpoint-failure.v1", ...failure, phase: attempt.row.phase, by: "hub", at: "fixture" };
    return { attempt: { ...attempt, row: { ...attempt.row, phase: "failure_pending", failure: canonicalCheckpoint(held.failure) } }, send: true };
  };
  deps.close = async (attempt, outcome) => {
    held.closed = outcome;
    return { attempt: { ...attempt, row: { ...attempt.row, phase: "failed",
      failureReport: canonicalCheckpoint({ version: "agentpod.checkpoint-failure-report.v1", outcome, at: "fixture" }) } }, send: true };
  };
  return held;
}

test("a recorded worker-crash reply ends the attempt failed and settles the run as failed with the reason", async () => {
  resetCheckpointActivityForTests();
  const attempt = executePending();
  const h = harness(workerCrash.value);
  const held = ledger(h.deps);
  const board = recordingBoard();
  const result = await driveCheckpointAttempt(attempt, board.client, false, h.deps);

  // Only a status read went to the node; execute was never re-sent.
  expect(h.sent.map(operationOf)).toEqual(["status"]);
  // The ruling and the node's exact reply are held before the board hears anything.
  expect(held.failure).toMatchObject({ code: "verification_failed", disposition: "failed", phase: "execute_pending" });
  expect(JSON.parse(String(held.failure?.evidence))).toEqual(workerCrash.value);
  // Heartbeat, the board is asked whether the run ended (it has not), then the card is told why,
  // then the run is failed with the same sentence.
  expect(board.verbs()).toEqual(["heartbeat", "run", "activities", "fail"]);
  const [, , activity, fail] = board.calls;
  expect(activity?.body).toMatchObject({ type: "action", action: "checkpoint.failed",
    parameter: { phase: "execute_pending", code: "verification_failed" } });
  expect(fail?.body).toEqual({ leaseEpoch: attempt.claim.leaseEpoch, reason: activity?.body.body });
  expect(String(fail?.body.reason)).toContain("verification_failed");
  expect(held.closed).toBe("fail");
  // The station is free: the attempt is terminal, and the loop is told the run failed.
  expect(result).toEqual({ status: "failed", externalRunId: attempt.claim.runId, attemptId: attempt.row.attemptId,
    reason: String(fail?.body.reason) });
  // Nothing about a pass: no settlement, no complete.
  expect(board.verbs()).not.toContain("complete");
});

const dirtyTree = (() => {
  const found = nodeRefusals.replies.find((r) => r.name === "checkpoint-refused-dirty-tree-status");
  if (!found) throw new Error("recorded node refusal missing");
  return found;
})();

// Seen on staging: SuperBench refused the checkpoint and the release over files the harness left outside
// the repository. The card said "the worker crashed or was stopped", and the held lease went unmentioned.
test("a refused checkpoint with a held lease says the bench's words and names the operator's path", async () => {
  resetCheckpointActivityForTests();
  const attempt = executePending();
  const h = harness(dirtyTree.value);
  const held = ledger(h.deps);
  const board = recordingBoard();
  const result = await driveCheckpointAttempt(attempt, board.client, false, h.deps);
  expect(result.status).toBe("failed");
  expect(board.verbs()).toEqual(["heartbeat", "run", "activities", "activities", "fail"]);
  const [, , failed, lease, fail] = board.calls;
  const words = "bench has uncommitted or untracked files; commit or preserve them before checkpoint/release";
  expect(failed?.body).toMatchObject({ action: "checkpoint.failed", parameter: { code: "verification_failed" } });
  expect(String(failed?.body.body)).toContain(words);
  expect(String(failed?.body.body)).not.toContain("crashed");
  expect(fail?.body.reason).toBe(failed?.body.body);
  expect(lease?.body).toMatchObject({ action: "checkpoint.parked", parameter: { phase: "execute_pending", code: "lease_held" } });
  for (const step of ["bench workspace stop_admin", "bench workspace renew_admin", "bench workspace run", "bench workspace release", "bench workspace reclaim"])
    expect(String(lease?.body.body)).toContain(step);
  expect(String(lease?.body.body)).toContain(words);
  expect(held.closed).toBe("fail");
  expect(board.verbs()).not.toContain("complete");
});

// The production soak: the model provider refused the key, and the card said only "operation failed".
test("a run the model provider refused names the provider's status on the card and in the failure", async () => {
  resetCheckpointActivityForTests();
  const recorded = nodeRefusals.replies.find((r) => r.name === "task-failed-provider-status");
  if (!recorded) throw new Error("recorded node refusal missing");
  const attempt = executePending();
  const h = harness(recorded.value);
  const held = ledger(h.deps);
  const board = recordingBoard();
  expect((await driveCheckpointAttempt(attempt, board.client, false, h.deps)).status).toBe("failed");
  const failed = board.calls.find((c) => c.path.endsWith("/activities"))?.body;
  const fail = board.calls.find((c) => c.path.endsWith("/fail"))?.body;
  expect(failed).toMatchObject({ action: "checkpoint.failed", parameter: { code: "verification_failed" } });
  expect(String(failed?.body)).toContain("HTTP 401 (unauthorized; check the model key)");
  for (const word of ["operation failed", "crashed"]) expect(String(failed?.body)).not.toContain(word);
  expect(fail?.reason).toBe(failed?.body);
  expect(held.closed).toBe("fail");
});

test("a parked reply whose lease is held is said once on the card with the operator's path, not also as a generic park", async () => {
  resetCheckpointActivityForTests();
  const attempt = executePending();
  const reply = { ...pendingStatus(attempt), detail: { lease: "held" } };
  const h = harness(reply);
  const board = recordingBoard((path) => path.endsWith(`/runs/${attempt.claim.runId}`)
    ? { status: 200, body: runView(attempt.claim) } : { status: 200 });
  for (let i = 0; i < 2; i++) expect((await driveCheckpointAttempt(attempt, board.client, false, h.deps)).status).toBe("unreported");
  const activities = board.calls.filter((c) => c.path.endsWith("/activities")).map((c) => c.body);
  expect(activities.map((a) => a.parameter)).toEqual([expect.objectContaining({ code: "lease_held" })]);
  expect(String(activities[0]?.body)).toContain("bench workspace renew_admin");
});

test("a verification failure while preparing fails the run too, and nothing was executed", async () => {
  resetCheckpointActivityForTests();
  const attempt = preparePending();
  const h = harness({ ...workerCrash.value, operation: "prepare" });
  const held = ledger(h.deps);
  const board = recordingBoard();
  const result = await driveCheckpointAttempt(attempt, board.client, true, h.deps);
  expect(h.sent.map(operationOf)).toEqual(["prepare"]);
  expect(held.failure).toMatchObject({ code: "verification_failed", disposition: "failed", phase: "prepare_pending" });
  expect(board.verbs()).toEqual(["heartbeat", "run", "activities", "fail"]);
  expect(result.status).toBe("failed");
});

test("a capacity refusal releases the card for a new claim instead of parking it", async () => {
  resetCheckpointActivityForTests();
  const attempt = executePending();
  const h = harness({ version: "agentpod.bench-coordinator.v1", operation: "status", state: "refused", code: "capacity_exhausted" });
  const held = ledger(h.deps);
  const board = recordingBoard();
  const result = await driveCheckpointAttempt(attempt, board.client, false, h.deps);
  expect(h.sent.map(operationOf)).toEqual(["status"]);
  expect(held.failure).toMatchObject({ code: "capacity_exhausted", disposition: "released" });
  expect(board.verbs()).toEqual(["heartbeat", "run", "activities", "release"]);
  expect(board.calls[2]?.body).toMatchObject({ action: "checkpoint.released" });
  expect(held.closed).toBe("release");
  expect(result).toMatchObject({ status: "released", attemptId: attempt.row.attemptId });
});

const capacityRefused = { version: "agentpod.bench-coordinator.v1", operation: "status", state: "refused", code: "capacity_exhausted" };
test("a capacity release is counted for the card, and holds the station's checkpoint claims", async () => {
  resetCheckpointActivityForTests();
  let now = 0;
  const capacity = createCapacityBackoff({ now: () => now });
  const attempt = executePending();
  const h = harness(capacityRefused);
  h.deps.capacity = capacity;
  ledger(h.deps);
  const result = await driveCheckpointAttempt(attempt, recordingBoard().client, false, h.deps);
  expect(result.status).toBe("released");
  expect(capacity.heldUntil()).toBe(CAPACITY_BACKOFF_BASE_MS);
  now = CAPACITY_BACKOFF_BASE_MS;
  expect(capacity.heldUntil()).toBeUndefined();
});

test("the cap-th capacity refusal in a row fails the run instead of releasing it again", async () => {
  resetCheckpointActivityForTests();
  const capacity = createCapacityBackoff({ now: () => 0 });
  const attempt = executePending();
  for (let i = 1; i < CAPACITY_RELEASE_CAP; i++) capacity.refused(capacityCard(attempt.claim), false);
  const h = harness(capacityRefused);
  h.deps.capacity = capacity;
  const held = ledger(h.deps);
  const board = recordingBoard();
  const result = await driveCheckpointAttempt(attempt, board.client, false, h.deps);
  expect(held.failure).toMatchObject({ code: "capacity_exhausted", disposition: "failed" });
  expect(board.verbs()).toEqual(["heartbeat", "run", "activities", "fail"]);
  expect(String(board.calls[3]?.body.reason)).toContain(`exhausted on ${CAPACITY_RELEASE_CAP} attempts in a row`);
  expect(result.status).toBe("failed");
  // The station still waits before its next checkpoint claim, and the card's count starts again.
  expect(capacity.heldUntil()).toBeDefined();
  expect(capacity.capped(capacityCard(attempt.claim))).toBe(false);
});

const conflict = (operation: string) => ({ version: "agentpod.bench-coordinator.v1", operation, state: "refused", code: "conflict" });
test("a conflict releases a preparing card, but parks once execute was sent", async () => {
  resetCheckpointActivityForTests();
  const prepare = harness(conflict("prepare"));
  ledger(prepare.deps);
  expect((await driveCheckpointAttempt(preparePending(), recordingBoard().client, true, prepare.deps)).status).toBe("released");
  const execute = harness(conflict("status"));
  const held = ledger(execute.deps);
  const board = recordingBoard();
  const result = await driveCheckpointAttempt(executePending(), board.client, false, execute.deps);
  expect(result).toMatchObject({ status: "unreported", reason: "Checkpoint dispatch requires reconciliation" });
  expect(held.failure).toBeUndefined();
  expect(board.verbs()).not.toContain("release");
});

test.each(["stale_owner", "unavailable", "invalid", "unauthorized", "pending"])(
  "refusal %s does not prove the record terminal: parked on its phase, named, nothing told", async (code) => {
  resetCheckpointActivityForTests();
  const lines: Array<Record<string, unknown> | undefined> = [];
  const restore = setParkedLogForTests(createQuietLog((_m, meta) => lines.push(meta), { now: () => 0 }));
  try {
    for (const [attempt, send] of [[executePending(), false], [preparePending(), false]] as const) {
      const h = harness({ version: "agentpod.bench-coordinator.v1", operation: "status", state: "refused", code });
      // A recovered prepare_pending reads status, and a refusal is only read, never re-sent.
      const held = ledger(h.deps);
      const board = recordingBoard();
      const result = await driveCheckpointAttempt(attempt, board.client, send, h.deps);
      expect(result).toMatchObject({ status: "unreported", reason: "Checkpoint dispatch requires reconciliation" });
      expect(held.failure).toBeUndefined();
      expect(board.verbs().filter((v) => v === "fail" || v === "release" || v === "complete")).toEqual([]);
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line?.reason === `node.state:refused.${code}`)).toBe(true);
  } finally { restore(); }
});

test("a lost fail reply is told again on the next pass, from failure_pending, without asking the node", async () => {
  resetCheckpointActivityForTests();
  const attempt = executePending();
  const h = harness(workerCrash.value);
  const held = ledger(h.deps);
  const down = recordingBoard((path) => path.endsWith("/fail") ? { status: 502 } : { status: 200 });
  const first = await driveCheckpointAttempt(attempt, down.client, false, h.deps);
  expect(first.status).toBe("unreported");
  expect(held.closed).toBeUndefined();

  // The next pass resumes the held failure: no node call, the same sentence, then closed.
  const pending = { ...attempt, row: { ...attempt.row, phase: "failure_pending", failure: canonicalCheckpoint(held.failure) } };
  const sent = h.sent.length;
  const up = recordingBoard();
  const second = await driveCheckpointAttempt(pending, up.client, false, h.deps);
  expect(h.sent.length).toBe(sent);
  expect(up.verbs()).toEqual(["run", "fail"]); // the activity was already said in this process
  expect(up.calls[1]?.body.reason).toBe(held.failure?.reason);
  expect(held.closed).toBe("fail");
  expect(second.status).toBe("failed");
});

test("a run the board already ended (STALE_LEASE) closes the attempt as lease_ended", async () => {
  resetCheckpointActivityForTests();
  const h = harness(workerCrash.value);
  const held = ledger(h.deps);
  const board = recordingBoard((path) => path.endsWith("/fail")
    ? { status: 409, body: { error: { ok: false, code: "STALE_LEASE", message: "lease lapsed" } } } : { status: 200 });
  const result = await driveCheckpointAttempt(executePending(), board.client, false, h.deps);
  expect(held.closed).toBe("lease_ended");
  expect(result.status).toBe("failed");
});

test("a run owned by another agent is never closed on: the failure stays held", async () => {
  resetCheckpointActivityForTests();
  const h = harness(workerCrash.value);
  const held = ledger(h.deps);
  const board = recordingBoard((path) => path.endsWith("/fail")
    ? { status: 403, body: { error: { ok: false, code: "NOT_RUN_OWNER", message: "not yours" } } } : { status: 200 });
  const result = await driveCheckpointAttempt(executePending(), board.client, false, h.deps);
  expect(held.failure).toBeDefined();
  expect(held.closed).toBeUndefined();
  expect(result.status).toBe("unreported");
});

// ---------------------------------------------------------------------------------------------
// A completed reply whose settlement can never be built ends the attempt failed, never as a pass.
// ---------------------------------------------------------------------------------------------

/** The node's reply for a run that finished cleanly with no new commit (pinned on the node's wire in Go). */
const completedUnchanged = (() => {
  const found = nodeCompletions.replies.find((r) => r.name === "completed-unchanged");
  if (!found) throw new Error("recorded node completion missing");
  return found;
})();

test("a recorded completed-but-unchanged reply ends the attempt failed and fails the run: no change, and the stage requires one", async () => {
  resetCheckpointActivityForTests();
  const { attempt } = await completedAttemptFixture();
  // The recording is for exactly this attempt: the node's reply parses against its status request.
  const sentStatus = BenchCoordinatorRequest.parse({ version: attempt.request.version, operation: "status",
    identity: attempt.request.identity, target: attempt.request.target });
  expect(sentStatus).toEqual(BenchCoordinatorRequest.parse(completedUnchanged.request));
  const h = harness(completedUnchanged.value);
  const settled: string[] = [];
  h.deps.service = (profile) => createCheckpointServiceClient(profile, { plane: TEST_PLANE,
    fetch: async (url) => { settled.push(url); return new Response(null, { status: 500 }); } });
  h.deps.advance = async () => { throw new Error("an unchanged run is never advanced to completed"); };
  const held = ledger(h.deps);
  const board = recordingBoard();
  const result = await driveCheckpointAttempt(attempt, board.client, false, h.deps);

  expect(h.sent.map(operationOf)).toEqual(["status"]);
  expect(held.failure).toMatchObject({ code: "settlement.unchanged", disposition: "failed", phase: "execute_pending" });
  expect(JSON.parse(String(held.failure?.evidence))).toEqual(completedUnchanged.value);
  expect(board.verbs()).toEqual(["heartbeat", "run", "activities", "fail"]);
  const [, , activity, fail] = board.calls;
  expect(activity?.body).toMatchObject({ action: "checkpoint.failed", parameter: { phase: "execute_pending", code: "settlement.unchanged" } });
  expect(String(fail?.body.reason)).toContain("the run finished but produced no change, and this stage requires one");
  expect(fail?.body).toEqual({ leaseEpoch: attempt.claim.leaseEpoch, reason: activity?.body.body });
  expect(held.closed).toBe("fail");
  expect(result).toMatchObject({ status: "failed", attemptId: attempt.row.attemptId });
  // Never a pass: no settlement or receipt request, no complete.
  expect(settled).toEqual([]);
  expect(board.verbs()).not.toContain("complete");
});

test("a completed reply whose task did not complete fails the run naming the outcome", async () => {
  resetCheckpointActivityForTests();
  const { attempt, completion } = await completedAttemptFixture();
  const reply = { ...completedUnchanged.value, completion: { ...completion, task: { ...completion.task, outcome: "failed" } } };
  const h = harness(reply);
  const held = ledger(h.deps);
  const board = recordingBoard();
  const result = await driveCheckpointAttempt(attempt, board.client, false, h.deps);
  expect(held.failure).toMatchObject({ code: "settlement.task_outcome", disposition: "failed" });
  expect(String(board.calls.find((c) => c.path.endsWith("/fail"))?.body.reason)).toContain("did not complete (failed)");
  expect(result.status).toBe("failed");
});

test("a changed completed reply is still advanced to completed, not failed", async () => {
  resetCheckpointActivityForTests();
  const { attempt, completion } = await completedAttemptFixture();
  const first = completion.service.checkpoints[0];
  if (!first) throw new Error("fixture checkpoint missing");
  const changed = { ...completion, service: { ...completion.service,
    checkpoints: [{ ...first, commit: "1".repeat(first.commit.length) }, ...completion.service.checkpoints.slice(1)] } };
  const h = harness({ ...completedUnchanged.value, completion: changed });
  const held = ledger(h.deps);
  const advanced: string[] = [];
  h.deps.advance = async (_attempt, evidence) => { advanced.push(evidence.phase); throw new CheckpointRefused("stale", "ledger.raced"); };
  const board = recordingBoard();
  const result = await driveCheckpointAttempt(attempt, board.client, false, h.deps);
  expect(advanced).toEqual(["completed"]);
  expect(held.failure).toBeUndefined();
  // A raced commit is transient: parked, named, and nothing told.
  expect(result.status).toBe("unreported");
  expect(board.verbs()).not.toContain("fail");
});

test("a refusal after completion that is not a settlement refusal is transient: parked, never failed", async () => {
  resetCheckpointActivityForTests();
  const lines: Array<Record<string, unknown> | undefined> = [];
  const restore = setParkedLogForTests(createQuietLog((_m, meta) => lines.push(meta), { now: () => 0 }));
  try {
    const { attempt } = await completedAttemptFixture();
    const h = harness(completedUnchanged.value);
    const held = ledger(h.deps);
    // The authority re-read after the node answered fails: nothing about the run is decided by it.
    let reads = 0;
    h.deps.authority = async () => { if (++reads > 2) throw new CheckpointRefused("authority", "issuer.grant"); };
    const result = await driveCheckpointAttempt(attempt, recordingBoard().client, false, h.deps);
    expect(result.status).toBe("unreported");
    expect(held.failure).toBeUndefined();
    expect(lines).toEqual([expect.objectContaining({ code: "authority", reason: "issuer.grant" })]);
  } finally { restore(); }
});

// ---------------------------------------------------------------------------------------------
// The board ended the run while the attempt was unresolved (bench-checkpoint-reporting.md,
// "When the board ends the run"). Ended on the board's explicit answer only; never a pass.
// ---------------------------------------------------------------------------------------------

const refusedStatus = (code: string) => ({ version: "agentpod.bench-coordinator.v1", operation: "status", state: "refused", code });
const pendingStatus = (attempt: RetainedCheckpointAttempt) => {
  const pending = corpus.responses.find((c) => c.name === "pending");
  if (!pending) throw new Error("shared pending fixture missing");
  return { ...pending.value, identity: attempt.request.identity, target: attempt.request.target };
};
/** The node answers each status in turn, repeating the last. */
function nodeAnswers(deps: CheckpointDriveDeps, replies: unknown[]): string[] {
  const sent: string[] = [];
  deps.request = async (_node, _verb, params) => {
    sent.push(operationOf(params));
    return { ok: true, data: replies.length > 1 ? replies.shift() : replies[0] };
  };
  return sent;
}
/** An in-memory retirement, shaped like the real compare-and-set. */
function retirements(deps: CheckpointDriveDeps) {
  const held: Array<{ reason: string; by: string; phase: string; evidence: Record<string, unknown> }> = [];
  deps.retire = async (attempt, retirement) => {
    held.push({ ...retirement, phase: attempt.row.phase, evidence: JSON.parse(retirement.evidence) });
    return true;
  };
  return held;
}
/** A board whose GET runs/:id answers `view`, and whose run verbs succeed. */
const boardWithRun = (attempt: RetainedCheckpointAttempt, view: () => { status: number; body?: unknown }) =>
  recordingBoard((path) => path === `/v1/boards/brd_ABC123/runs/${attempt.claim.runId}` ? view() : { status: 200 });

test("the recorded staging sequence: node refused/unavailable, card moved off the stage, ends the attempt retired", async () => {
  resetCheckpointActivityForTests();
  const attempt = preparePending();
  // The run view the board served: the move left the run working and unbound its card. It is exactly
  // what made every current decision refuse `context`.
  const moved = movedRunView(attempt.claim);
  expect(() => validateCheckpointContext(moved, attempt.claim, attempt.claim.boardId, attempt.claim.runId)).toThrow(CheckpointClaimRefused);
  const h = harness({});
  const sent = nodeAnswers(h.deps, [refusedStatus("unavailable")]);
  const held = retirements(h.deps);
  const board = boardWithRun(attempt, () => ({ status: 200, body: moved }));
  const result = await driveCheckpointAttempt(attempt, board.client, false, h.deps);

  expect(result).toMatchObject({ status: "released", externalRunId: attempt.claim.runId, attemptId: attempt.row.attemptId });
  expect(held).toHaveLength(1);
  expect(held[0]).toMatchObject({ reason: "run_ended", by: "hub", phase: "prepare_pending" });
  expect(held[0]?.evidence).toMatchObject({ board: { reason: "run.unbound", board: { status: "working", cardRunId: null, cardStage: "review" } },
    node: { state: "refused", code: "unavailable" } });
  // The drive's status, then the node is told once more (its current decision now answers stale_owner).
  expect(sent).toEqual(["status", "status"]);
  // Nothing is said to a run whose card moved on: no activity, no fail, release or complete.
  expect(board.verbs()).toEqual(["heartbeat", "run"]);
});

test("revert-proof: the same sequence while the board cannot answer parks exactly as before", async () => {
  resetCheckpointActivityForTests();
  const lines: Array<Record<string, unknown> | undefined> = [];
  const restore = setParkedLogForTests(createQuietLog((_m, meta) => lines.push(meta), { now: () => 0 }));
  try {
    for (const answer of [{ status: 502 }, { status: 200, body: {} }, { status: 403, body: { error: { ok: false, code: "NOT_RUN_OWNER" } } }]) {
      const attempt = preparePending();
      const h = harness(refusedStatus("unavailable"));
      const held = retirements(h.deps);
      const board = boardWithRun(attempt, () => answer);
      const result = await driveCheckpointAttempt(attempt, board.client, false, h.deps);
      expect(result).toMatchObject({ status: "unreported", reason: "Checkpoint dispatch requires reconciliation" });
      expect(held).toEqual([]);
    }
    expect(lines.every((line) => line?.reason === "node.state:refused.unavailable")).toBe(true);
    // And a live, bound run is not ended either.
    const attempt = preparePending();
    const h = harness(refusedStatus("unavailable"));
    const held = retirements(h.deps);
    await driveCheckpointAttempt(attempt, boardWithRun(attempt, () => ({ status: 200, body: runView(attempt.claim) })).client, false, h.deps);
    expect(held).toEqual([]);
  } finally { restore(); }
});

test.each(["prepare_pending", "prepared", "source_pending", "admitted", "completed"])(
  "%s: nothing is running, so a run the board ended retires the attempt and tells the node", async (phase) => {
  const base = preparePending();
  const attempt = { ...base, row: { ...base.row, phase } };
  const h = harness({});
  const sent = nodeAnswers(h.deps, [refusedStatus("stale_owner")]);
  const held = retirements(h.deps);
  const result = await endEndedRun(attempt, { reason: "run.ended", board: { status: "ended", outcome: "reclaimed" } }, h.deps);
  expect(result.status).toBe("released");
  expect(held).toEqual([expect.objectContaining({ reason: "run_ended", phase })]);
  expect(sent).toEqual(["status"]);
});

// Operator ruling: a card moved or cancelled after the bench pushed its work says where that work is.
test("a run ended after the bench pushed this card's work says on the card where it was saved; nothing pushed, nothing said", async () => {
  const { attempt: base, completion } = await completedAttemptFixture();
  const completed = { ...base, row: { ...base.row, phase: "completed", completion: canonicalCheckpoint(completion) } };
  const many = completion.service.checkpoints.length > 1;
  const saved = completion.service.checkpoints.map((m) => (many ? m.name + " " : "") +
    `${m.task_ref.replace("refs/heads/", "")} (${m.commit.slice(0, 7)})`).join(", ");
  for (const [ended, why] of [[{ reason: "run.unbound", board: { status: "working" } }, "the card moved"],
    [{ reason: "run.ended", board: { status: "ended", outcome: "released" } }, "the card moved or its run was ended"]] as const) {
    resetCheckpointActivityForTests();
    const h = harness({});
    nodeAnswers(h.deps, [refusedStatus("stale_owner")]);
    const held = retirements(h.deps);
    const board = recordingBoard();
    expect((await endEndedRun(completed, ended, h.deps, board.client)).status).toBe("released");
    expect(held).toEqual([expect.objectContaining({ reason: "run_ended", phase: "completed" })]);
    const notes = board.calls.filter((c) => c.path.endsWith("/activities")).map((c) => c.body);
    expect(notes).toEqual([expect.objectContaining({ action: "checkpoint.stopped",
      body: `Run stopped because ${why}; partial work saved to ${saved}.` })]);
    expect(saved).toContain("card/");
    expect(board.verbs().filter((v) => ["complete", "fail", "release"].includes(v))).toEqual([]);
  }
  // Retired before anything was pushed: no branch is named, and the card is not written to.
  resetCheckpointActivityForTests();
  const h = harness({});
  nodeAnswers(h.deps, [refusedStatus("stale_owner")]);
  retirements(h.deps);
  const board = recordingBoard();
  expect((await endEndedRun(preparePending(), { reason: "run.unbound", board: { status: "working" } }, h.deps, board.client)).status).toBe("released");
  expect(board.calls).toEqual([]);
});

test("a node that cannot be reached does not keep a nothing-running attempt: it is retired with that as evidence", async () => {
  const h = harness({});
  h.deps.request = async () => ({ ok: false, error: "node offline" });
  const held = retirements(h.deps);
  const result = await endEndedRun(preparePending(), { reason: "run.not_found", board: { httpStatus: 404, code: "RUN_NOT_FOUND" } }, h.deps);
  expect(result.status).toBe("released");
  expect(held[0]).toMatchObject({ reason: "run_ended", evidence: { node: { error: "node.call.offline" } } });
});

test("a board cancel mid-run: the node is told to stop, the attempt waits for its record to end, then retires; never a pass", async () => {
  resetCheckpointActivityForTests();
  const lines: Array<Record<string, unknown> | undefined> = [];
  const restore = setParkedLogForTests(createQuietLog((_m, meta) => lines.push(meta), { now: () => 0 }));
  try {
    const attempt = executePending();
    const h = harness({});
    // The node's current decision answered stale_owner: it sent one cancel and reports the wind-down as pending.
    const sent = nodeAnswers(h.deps, [pendingStatus(attempt)]);
    const held = retirements(h.deps);
    const board = boardWithRun(attempt, () => ({ status: 200, body: movedRunView(attempt.claim) }));
    const first = await driveCheckpointAttempt(attempt, board.client, false, h.deps);
    expect(first).toMatchObject({ status: "unreported" });
    expect(held).toEqual([]);
    expect(lines.at(-1)).toMatchObject({ phase: "execute_pending", reason: "run_ended.node:pending" });
    expect(sent).toEqual(["status", "status"]);
    // Not written to the card: an activity on an unbound run would heartbeat it.
    expect(board.verbs()).toEqual(["heartbeat", "run"]);

    // The next pass: the run's receipt is in, the lease released, the record terminal (stale_owner).
    const h2 = harness({});
    nodeAnswers(h2.deps, [refusedStatus("stale_owner")]);
    const held2 = retirements(h2.deps);
    const board2 = boardWithRun(attempt, () => ({ status: 200, body: movedRunView(attempt.claim) }));
    const second = await driveCheckpointAttempt(attempt, board2.client, false, h2.deps);
    expect(second.status).toBe("released");
    expect(held2).toEqual([expect.objectContaining({ reason: "run_ended.stopped", phase: "execute_pending",
      evidence: expect.objectContaining({ node: expect.objectContaining({ state: "refused", code: "stale_owner" }) }) })]);
    for (const b of [board, board2]) expect(b.verbs().filter((v) => ["complete", "fail", "release", "activities"].includes(v))).toEqual([]);
  } finally { restore(); }
});

test("after execute, a node that never confirms ends the attempt only past the task's timeout and the grace period", async () => {
  const attempt = executePending();
  const deadline = attempt.row.updatedAt.getTime() + attempt.request.task.timeout_seconds * 1000 + RUN_ENDED_GRACE_MS;
  const ended = { reason: "run.ended" as const, board: { status: "ended", outcome: "crashed" } };
  const early = harness({});
  nodeAnswers(early.deps, [pendingStatus(attempt)]);
  early.deps.now = () => deadline - 1;
  const notYet = retirements(early.deps);
  expect((await endEndedRun(attempt, ended, early.deps)).status).toBe("unreported");
  expect(notYet).toEqual([]);
  const late = harness({});
  late.deps.request = async () => ({ ok: false, error: "timeout" });
  late.deps.now = () => deadline;
  const held = retirements(late.deps);
  expect((await endEndedRun(attempt, ended, late.deps)).status).toBe("released");
  expect(held).toEqual([expect.objectContaining({ reason: "run_ended.unconfirmed", evidence: { board: ended, node: { error: "node.call.timeout" } } })]);
});

test("a held failure whose card moved on closes run_ended and tells the board nothing", async () => {
  resetCheckpointActivityForTests();
  const h = harness(workerCrash.value);
  const failed = ledger(h.deps);
  const attempt = executePending();
  // The node's terminal refusal is held; the board's run view says the card moved on before it is told.
  const board = boardWithRun(attempt, () => ({ status: 200, body: movedRunView(attempt.claim) }));
  const result = await driveCheckpointAttempt(attempt, board.client, false, h.deps);
  expect(failed.failure).toMatchObject({ code: "verification_failed" });
  expect(failed.closed).toBe("run_ended");
  expect(result).toMatchObject({ status: "failed", attemptId: attempt.row.attemptId });
  // `fail` on that run would have failed the card wherever it is now.
  expect(board.verbs()).toEqual(["heartbeat", "run"]);
});

test("revert-proof: a held failure on a live run is still told to the board", async () => {
  resetCheckpointActivityForTests();
  const h = harness(workerCrash.value);
  const failed = ledger(h.deps);
  const attempt = executePending();
  const board = boardWithRun(attempt, () => ({ status: 200, body: runView(attempt.claim) }));
  await driveCheckpointAttempt(attempt, board.client, false, h.deps);
  expect(failed.closed).toBe("fail");
  expect(board.verbs()).toEqual(["heartbeat", "run", "activities", "fail"]);
});

const unused = async (): Promise<never> => { throw new Error("only the receipt is read in this test"); };
/** A submission_pending row whose service client answers the receipt lookup with `receipt`. */
function submissionPending(receipt: CheckpointReceipt | undefined) {
  const base = executePending();
  const body = "{\"settlement\":\"fixture\"}";
  const attempt = { ...base, row: { ...base.row, phase: "submission_pending", settlementBody: body,
    settlementSHA256: createHash("sha256").update(body, "utf8").digest("hex") } };
  const h = harness({});
  const lookups: string[] = [];
  const service: CheckpointServiceClient = { receipt: async () => { lookups.push("receipt"); return receipt; },
    settle: unused, source: unused, sourceEvidence: unused, admit: unused };
  h.deps.service = () => service;
  return { attempt, h, lookups };
}

test("submission_pending: no receipt on the board and the run ended, so the settlement can never land: retired unsettled", async () => {
  const { attempt, h, lookups } = submissionPending(undefined);
  nodeAnswers(h.deps, [refusedStatus("stale_owner")]);
  const held = retirements(h.deps);
  const board = boardWithRun(attempt, () => ({ status: 200, body: endedRunView(attempt.claim, "reclaimed") }));
  const result = await driveCheckpointAttempt(attempt, board.client, false, h.deps);
  expect(lookups).toEqual(["receipt"]);
  expect(result.status).toBe("released");
  expect(held).toEqual([expect.objectContaining({ reason: "run_ended.unsettled", phase: "submission_pending" })]);
  expect(board.verbs()).toEqual(["run"]);
});

test("revert-proof: a settlement whose receipt the board holds is never retired, though the settled run has ended", async () => {
  const { attempt, h } = submissionPending({ version: "superpipeline.run-checkpoint-receipt.v1", settlementId: "settle_fixture",
    requestDigest: "a".repeat(64), reportDigest: "b".repeat(64), reportedBy: "prn_fixture1", runId: "run_ABC123", leaseEpoch: 1,
    recordedAt: "2026-11-21T10:30:00.000Z", checkpoint: { protocol: "superbench.v2", key: "bench", benchId: "c".repeat(32),
      requestId: "request", generationId: "d".repeat(32), seal: "e".repeat(40), manifestSha256: "f".repeat(64),
      members: [{ name: "api", provider: "forge", repository: "example/api", branch: "card/card_fixture", objectFormat: "sha1",
        commit: "1".repeat(40) }], checkpointRepository: "api" } });
  const held = retirements(h.deps);
  const board = boardWithRun(attempt, () => ({ status: 200, body: endedRunView(attempt.claim, "completed") }));
  await driveCheckpointAttempt(attempt, board.client, false, h.deps);
  expect(held).toEqual([]);
  expect(board.verbs()).not.toContain("run");
});
