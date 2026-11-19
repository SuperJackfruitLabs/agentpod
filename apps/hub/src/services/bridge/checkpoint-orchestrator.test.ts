import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { BenchCoordinatorRequest, parseBenchCoordinatorResponse } from "@agentpod/contract";
import corpus from "../../../../../packages/contract/src/fixtures/bench-coordinator-v1.json";
import nodeRefusals from "../../../../../packages/contract/src/fixtures/bench-coordinator-node-refusals-v1.json";
import { TEST_PLANE } from "../../auth/org-plane/config";
import { checkpointPolicyDigest, parsePendingCheckpointClaim } from "./checkpoint-claim";
import { canonicalCheckpoint } from "./checkpoint-json";
import type { RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { driveCheckpointAttempt, setParkedLogForTests, type CheckpointDriveDeps } from "./checkpoint-orchestrator";
import { createQuietLog } from "./quiet-log";
import { resetCheckpointActivityForTests } from "./checkpoint-activity";
import { NODE_CALL_TIMEOUT_MS } from "./checkpoint-node-call";
import { parseCheckpointProfile } from "./checkpoint-profile";
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
  };
  const client = new SuperpipelineClient({ baseUrl: "https://board.test", boardId: "brd_ABC123", token: "spa_fixture",
    fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }) });
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
    fetch: async (url, init) => {
      const path = url.replace("https://board.test", "");
      calls.push({ path, body: JSON.parse(init.body ?? "{}") });
      const { status, body } = answer(path);
      return { status, ok: status < 300, json: async () => body ?? {} };
    } });
  const verbs = () => calls.map((c) => c.path.replace(/^\/v1\/boards\/brd_ABC123\/runs\/[^/]+\//, ""));
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
  // Heartbeat, then the card is told why, then the run is failed with the same sentence.
  expect(board.verbs()).toEqual(["heartbeat", "activities", "fail"]);
  const [, activity, fail] = board.calls;
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

test("a verification failure while preparing fails the run too, and nothing was executed", async () => {
  resetCheckpointActivityForTests();
  const attempt = preparePending();
  const h = harness({ ...workerCrash.value, operation: "prepare" });
  const held = ledger(h.deps);
  const board = recordingBoard();
  const result = await driveCheckpointAttempt(attempt, board.client, true, h.deps);
  expect(h.sent.map(operationOf)).toEqual(["prepare"]);
  expect(held.failure).toMatchObject({ code: "verification_failed", disposition: "failed", phase: "prepare_pending" });
  expect(board.verbs()).toEqual(["heartbeat", "activities", "fail"]);
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
  expect(board.verbs()).toEqual(["heartbeat", "activities", "release"]);
  expect(board.calls[1]?.body).toMatchObject({ action: "checkpoint.released" });
  expect(held.closed).toBe("release");
  expect(result).toMatchObject({ status: "released", attemptId: attempt.row.attemptId });
});

test("a conflict releases a preparing card, but parks once execute was sent", async () => {
  resetCheckpointActivityForTests();
  const reply = (operation: string) => ({ version: "agentpod.bench-coordinator.v1", operation, state: "refused", code: "conflict" });
  const prepare = harness(reply("prepare"));
  ledger(prepare.deps);
  expect((await driveCheckpointAttempt(preparePending(), recordingBoard().client, true, prepare.deps)).status).toBe("released");
  const execute = harness(reply("status"));
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
  expect(up.verbs()).toEqual(["fail"]); // the activity was already said in this process
  expect(up.calls[0]?.body.reason).toBe(held.failure?.reason);
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
