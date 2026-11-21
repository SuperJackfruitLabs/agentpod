/**
 * An attempt the node definitely refused ends, on the real ledger, instead of parking forever.
 *
 * A worker crashed during execute: the node journaled the run refused (verification_failed) and
 * released its lease, and answers every later status with that reply. The Hub used to park the
 * attempt in execute_pending, so the card stayed `working` on heartbeats and the station never took
 * another checkpoint claim. Driven from the recorded reply, the attempt now reaches `failed` with
 * the reply as evidence, the run is failed on the board with the reason, and the station is free.
 */
process.env.DATABASE_URL ||= "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { BenchCoordinatorRequest } from "@agentpod/contract";
import { db, rawSql } from "../../src/db/drizzle";
import { tenants } from "../../src/db/schema/tenants";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { bridgeAgents } from "../../src/db/schema/bridge";
import { TEST_PLANE } from "../../src/auth/org-plane/config";
import { adminCheckpointAttemptsRouter } from "../../src/routes/admin-checkpoint-attempts";
import { connectionManager } from "../../src/services/broker";
import { checkpointProfileId, parseCheckpointProfile } from "../../src/services/bridge/checkpoint-profile";
import { advanceCheckpointAttempt, closeFailedCheckpointAttempt, failCheckpointAttempt, pendingCheckpointAttempt,
  readCheckpointAttempt, reserveCheckpointAttempt, retireCheckpointAttempt, type RetainedCheckpointAttempt } from "../../src/services/bridge/checkpoint-ledger";
import { movedRunView } from "../../src/services/bridge/checkpoint-run-view.test-fixture";
import { driveCheckpointAttempt } from "../../src/services/bridge/checkpoint-orchestrator";
import { createCheckpointServiceClient } from "../../src/services/bridge/checkpoint-service-client";
import { checkpointPolicyDigest, parsePendingCheckpointClaim } from "../../src/services/bridge/checkpoint-claim";
import { SuperpipelineClient } from "../../src/services/bridge/superpipeline";
import { fakePlane } from "../helpers/fake-plane";
import { createTestUser, deleteTestUsers } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import claimFixture from "../../src/services/bridge/checkpoint-contract/claim.fixture.json";
import nodeRefusals from "../../../../packages/contract/src/fixtures/bench-coordinator-node-refusals-v1.json";

const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
const organizationId = "org_" + suffix;
const tenantId = "fleet_" + suffix, nodeId = "node_" + suffix, stationId = "station_" + suffix;
const owner = "prn_" + suffix, occupant = "prn_" + suffix.slice(1) + "f";
const agentKey = "checkpoint-failure-" + suffix;
const envKeys = ["PROPOSED_CHECKPOINT_COORDINATOR", "ENFORCE_CONTROL_PAIR"] as const;
const priorEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

const profile = parseCheckpointProfile({ version: "agentpod.checkpoint-profile.v1", organizationId,
  sourceTenantId: claimFixture.pending.tenantId, sourceOrigin: "https://pipeline.test", sourceAudience: "https://app.superpipeline.dev",
  reporterPrincipalId: "prn_" + "c".repeat(20), ownerPrincipalId: owner, occupantPrincipalId: occupant,
  agentKey, profileKey: "", coordinatorProfileId: "fixture-profile", occupancyEpoch: 1,
  target: { tenant_id: tenantId, board_id: claimFixture.pending.boardId, agent_id: claimFixture.pending.agentId,
    station_id: stationId, node_id: nodeId, host_id: "host_fixture", registry_sha256: "a".repeat(64),
    coordinator_implementation_sha256: "b".repeat(64), execution_mode: "linux-cgroup-v2", bench_protocol: "superbench.v2",
    worker_version: "agentpod.superbench-worker.v2", worker_sha256: "c".repeat(64) },
  repositories: [{ ...claimFixture.pending.policy.repositories[0], repositorySHA256: "d".repeat(64), objectFormat: "sha1" }],
  checkpointRepository: "app" });
const policy = { ...claimFixture.pending.policy, reporterPrincipalId: profile.reporterPrincipalId, nodeId,
  executors: [{ agentId: profile.target.agent_id, stationId }] };
const claimFor = (run: string) => parsePendingCheckpointClaim({ ...claimFixture.pending, runId: "run_" + suffix + run,
  policy, policyDigest: checkpointPolicyDigest(policy) });
const task = { profile_id: checkpointProfileId(profile), prompt: "fixture", timeout_seconds: 60 };
const workerCrash = nodeRefusals.replies.find((r) => r.name === "worker-crash-status")?.value;
let userId = "";

/** Reserve a fresh attempt and walk it to execute_pending, as a run that was sent would be. */
async function executePending(run: string): Promise<RetainedCheckpointAttempt> {
  let attempt = (await reserveCheckpointAttempt(profile, claimFor(run), task)).attempt;
  attempt = (await advanceCheckpointAttempt(attempt, { phase: "prepared", prepared: "fixture-prepared" })).attempt;
  attempt = (await advanceCheckpointAttempt(attempt, { phase: "source_pending", source: "fixture-source" })).attempt;
  attempt = (await advanceCheckpointAttempt(attempt, { phase: "admitted", sourceReceipt: "fixture-receipt" })).attempt;
  const execute = JSON.stringify({ version: attempt.request.version, operation: "execute", identity: attempt.request.identity,
    target: attempt.request.target });
  return (await advanceCheckpointAttempt(attempt, { phase: "execute_pending", executeRequest: execute,
    executeSHA256: createHash("sha256").update(execute, "utf8").digest("hex") })).attempt;
}
function board() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = new SuperpipelineClient({ baseUrl: "https://board.test", boardId: profile.target.board_id, token: "spa_fixture",
    fetch: async (url, init) => {
      calls.push({ path: url.replace("https://board.test", ""), body: JSON.parse(init.body ?? "{}") });
      return { status: 200, ok: true, json: async () => ({}) };
    } });
  return { client, calls };
}
const admin = () => new Hono().use("*", async (c, next) => {
  c.set("user", { id: userId, authType: "org_plane", tenantId });
  await next();
}).route("/checkpoint/attempts", adminCheckpointAttemptsRouter);
const outcome = (query: PromiseLike<unknown>) => Promise.resolve(query).then(() => "applied", () => "refused");

beforeAll(async () => {
  await ensurePgMigrations();
  userId = (await createTestUser({ name: "checkpoint-failure" })).id;
  process.env.ENFORCE_CONTROL_PAIR = "true";
  process.env.PROPOSED_CHECKPOINT_COORDINATOR = "true";
  fakePlane.addAgent({ id: occupant }); fakePlane.addHuman({ id: owner, grant: { mayDispatch: [occupant] } });
  for (const id of [occupant, owner]) {
    const principal = fakePlane.principals.get(id);
    if (!principal) throw new Error("fixture principal missing");
    principal.organizationId = organizationId;
  }
  await db.insert(tenants).values({ id: tenantId, name: "checkpoint failure fixture", externalSource: "org-plane", externalId: organizationId });
  await db.insert(nodes).values({ id: nodeId, tenantId, userId: owner, name: "fixture", hostname: "fixture", os: "linux", arch: "amd64",
    secretHash: await Bun.password.hash("fixture-node-secret-" + suffix), status: "online", lastSeenAt: new Date() });
  await db.insert(stations).values({ id: stationId, tenantId, userId: owner, principalId: occupant, occupancyEpoch: 1,
    nodeId, stationKey: "fixture:" + suffix, kind: "leaf", displayName: "fixture", harness: "hermes", workspacePath: "/fixture" });
  await db.insert(bridgeAgents).values({ tenantId, key: agentKey, boardId: profile.target.board_id, stationId, profileKey: "",
    tokenEncrypted: "", credentialSource: { version: 1, kind: "station-plane", principalId: occupant, organizationId,
      audience: "https://app.superpipeline.dev" } });
  connectionManager.register(nodeId, () => {});
});
afterAll(async () => {
  connectionManager.unregister(nodeId);
  // Attempt rows are immutable and retained, as in production; the test database is disposable.
  await db.delete(bridgeAgents).where(eq(bridgeAgents.tenantId, tenantId));
  await db.delete(stations).where(eq(stations.tenantId, tenantId));
  await db.delete(nodes).where(eq(nodes.tenantId, tenantId));
  fakePlane.remove(owner); fakePlane.remove(occupant);
  await deleteTestUsers([userId]);
  for (const k of envKeys) { const v = priorEnv[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test("a recorded worker crash ends the attempt failed, fails the run with the reason and frees the station", async () => {
  if (!workerCrash) throw new Error("recorded node refusal missing");
  const attempt = await executePending("a1");
  expect((await pendingCheckpointAttempt(profile))?.attempt.row.attemptId).toBe(attempt.row.attemptId);

  const sent: string[] = [];
  const b = board();
  const result = await driveCheckpointAttempt(attempt, b.client, false, {
    authority: async () => {},
    request: async (_node, _verb, params) => { sent.push(BenchCoordinatorRequest.parse(params).operation); return { ok: true, data: workerCrash }; },
    service: (p) => createCheckpointServiceClient(p, { plane: TEST_PLANE, fetch: async () => new Response(null, { status: 500 }) }),
    advance: advanceCheckpointAttempt, fail: failCheckpointAttempt, close: closeFailedCheckpointAttempt,
    retire: retireCheckpointAttempt, now: Date.now,
  });

  expect(sent).toEqual(["status"]);
  expect(result).toMatchObject({ status: "failed", externalRunId: attempt.claim.runId, attemptId: attempt.row.attemptId });
  const row = (await readCheckpointAttempt(tenantId, attempt.row.attemptId))?.row;
  expect(row?.phase).toBe("failed");
  const failure = JSON.parse(row?.failure ?? "{}");
  expect(failure).toMatchObject({ version: "agentpod.checkpoint-failure.v1", code: "verification_failed", disposition: "failed",
    phase: "execute_pending", by: "hub" });
  expect(JSON.parse(failure.evidence)).toEqual(workerCrash);
  expect(JSON.parse(row?.failureReport ?? "{}")).toMatchObject({ outcome: "fail" });
  // Every evidence cell the attempt already held is still there.
  expect(row?.executeRequest).toBe(attempt.row.executeRequest);

  const fail = b.calls.find((c) => c.path.endsWith(`/runs/${attempt.claim.runId}/fail`));
  expect(fail?.body).toEqual({ leaseEpoch: attempt.claim.leaseEpoch, reason: failure.reason });
  expect(b.calls.some((c) => c.path.endsWith("/activities") && c.body.action === "checkpoint.failed")).toBe(true);

  // The station is free: nothing unresolved, nothing listed, and a fresh claim may prepare.
  expect(await pendingCheckpointAttempt(profile)).toBeUndefined();
  expect(await (await admin().request("/checkpoint/attempts")).json()).toEqual({ attempts: [] });
  const settle = await admin().request(`/checkpoint/attempts/${attempt.row.attemptId}/settle`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: attempt.row.attemptId, evidence: "an operator trying to settle an attempt that already ended" }) });
  expect(settle.status).toBe(409);
  expect((await reserveCheckpointAttempt(profile, claimFor("a2"), task)).send).toBe(true);
});

test("failed is terminal and its evidence immutable; only the phases that ask the node may fail", async () => {
  const [row] = await rawSql`SELECT attempt_id FROM checkpoint_dispatches WHERE tenant_id = ${tenantId} AND phase = 'failed' LIMIT 1`;
  if (!row) throw new Error("fixture failed row missing");
  const id = String(row.attempt_id);
  const update = (set: string) => rawSql.unsafe(`UPDATE checkpoint_dispatches SET ${set} WHERE tenant_id = $1 AND attempt_id = $2`, [tenantId, id]);
  expect(await outcome(update(`phase = 'retired', retirement = '{}'`))).toBe("refused");
  expect(await outcome(update(`phase = 'execute_pending', failure_report = NULL`))).toBe("refused");
  expect(await outcome(update(`failure = '{}'`))).toBe("refused");
  expect(await outcome(update(`failure_report = '{}'`))).toBe("refused");
  expect(await outcome(rawSql`DELETE FROM checkpoint_dispatches WHERE tenant_id = ${tenantId} AND attempt_id = ${id}`)).toBe("refused");

  // The open attempt from the last test: prepare_pending, which asks the node, so it may fail; an
  // admitted row never asks the node and may not.
  const pending = await pendingCheckpointAttempt(profile);
  if (!pending) throw new Error("fixture pending attempt missing");
  const openId = pending.attempt.row.attemptId;
  const open = (set: string) => rawSql.unsafe(`UPDATE checkpoint_dispatches SET ${set} WHERE tenant_id = $1 AND attempt_id = $2`, [tenantId, openId]);
  expect(await outcome(open(`phase = 'failure_pending'`))).toBe("refused"); // a failure needs its evidence
  expect(await outcome(open(`phase = 'failed', failure = '{}', failure_report = '{}'`))).toBe("refused"); // never skips failure_pending
  let attempt = (await advanceCheckpointAttempt(pending.attempt, { phase: "prepared", prepared: "fixture-prepared" })).attempt;
  attempt = (await advanceCheckpointAttempt(attempt, { phase: "source_pending", source: "fixture-source" })).attempt;
  attempt = (await advanceCheckpointAttempt(attempt, { phase: "admitted", sourceReceipt: "fixture-receipt" })).attempt;
  expect(await outcome(open(`phase = 'failure_pending', failure = '{}'`))).toBe("refused");
  await expect(failCheckpointAttempt(attempt, { code: "verification_failed", disposition: "failed", reason: "x", evidence: "{}" }))
    .rejects.toThrow("Checkpoint refused: stale");
});

test("an operator may still retire a failure the board could not be told of", async () => {
  // The station's open attempt, left admitted by the last test, reaches execute_pending.
  const pending = await pendingCheckpointAttempt(profile);
  if (!pending || pending.attempt.row.phase !== "admitted") throw new Error("fixture admitted attempt missing");
  const execute = JSON.stringify({ version: pending.attempt.request.version, operation: "execute",
    identity: pending.attempt.request.identity, target: pending.attempt.request.target });
  const attempt = (await advanceCheckpointAttempt(pending.attempt, { phase: "execute_pending", executeRequest: execute,
    executeSHA256: createHash("sha256").update(execute, "utf8").digest("hex") })).attempt;
  const held = await failCheckpointAttempt(attempt, { code: "verification_failed", disposition: "failed",
    reason: "Checkpoint failed: fixture", evidence: JSON.stringify(workerCrash) });
  expect(held).toMatchObject({ send: true, attempt: { row: { phase: "failure_pending" } } });
  // A raced pass gets the held failure back, without the right to tell the board again.
  expect((await failCheckpointAttempt(attempt, { code: "verification_failed", disposition: "failed",
    reason: "Checkpoint failed: fixture", evidence: "{}" })).send).toBe(false);
  const settle = await admin().request(`/checkpoint/attempts/${attempt.row.attemptId}/settle`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: attempt.row.attemptId, evidence: "the board run was failed by hand; nothing is outstanding" }) });
  expect(settle.status).toBe(200);
  const row = (await readCheckpointAttempt(tenantId, attempt.row.attemptId))?.row;
  expect(row?.phase).toBe("retired");
  expect(JSON.parse(row?.failure ?? "{}")).toMatchObject({ code: "verification_failed" });
  await rawSql`DELETE FROM admin_audit_log WHERE tenant_id = ${tenantId}`;
});

// The staging sequence on the real ledger: a prepare the node refused (refused/unavailable), then the
// card moved off the bench stage. The attempt parked on every reconcile and held the station's
// checkpoint claims, so no other card could take one. It now ends retired and the station is free.
test("an attempt whose card moved off the stage is retired, and another card's checkpoint claim may prepare", async () => {
  const claim = claimFor("m1");
  const attempt = (await reserveCheckpointAttempt(profile, claim, task)).attempt;
  expect((await pendingCheckpointAttempt(profile))?.attempt.row.attemptId).toBe(attempt.row.attemptId);
  const calls: string[] = [];
  const moved = new SuperpipelineClient({ baseUrl: "https://board.test", boardId: profile.target.board_id, token: "spa_fixture",
    fetch: async (url) => {
      const path = url.replace("https://board.test", "");
      calls.push(path);
      return { status: 200, ok: true, json: async () => path.endsWith(`/runs/${claim.runId}`) ? movedRunView(claim) : {} };
    } });
  const sent: string[] = [];
  const result = await driveCheckpointAttempt(attempt, moved, false, {
    authority: async () => {},
    request: async (_node, _verb, params) => { sent.push(BenchCoordinatorRequest.parse(params).operation);
      return { ok: true, data: { version: "agentpod.bench-coordinator.v1", operation: "status", state: "refused", code: "unavailable" } }; },
    service: (p) => createCheckpointServiceClient(p, { plane: TEST_PLANE, fetch: async () => new Response(null, { status: 500 }) }),
    advance: advanceCheckpointAttempt, fail: failCheckpointAttempt, close: closeFailedCheckpointAttempt,
    retire: retireCheckpointAttempt, now: Date.now,
  });
  expect(result).toMatchObject({ status: "released", attemptId: attempt.row.attemptId });
  expect(sent).toEqual(["status", "status"]);
  const row = (await readCheckpointAttempt(tenantId, attempt.row.attemptId))?.row;
  expect(row?.phase).toBe("retired");
  const retirement = JSON.parse(row?.retirement ?? "{}");
  expect(retirement).toMatchObject({ version: "agentpod.checkpoint-retirement.v1", reason: "run_ended", phase: "prepare_pending", by: "hub" });
  expect(JSON.parse(retirement.evidence)).toMatchObject({ board: { reason: "run.unbound" }, node: { state: "refused", code: "unavailable" } });
  // Nothing was said to the run: no fail, release, activity or complete.
  expect(calls.filter((path) => !path.endsWith(`/runs/${claim.runId}`) && !path.endsWith("/heartbeat"))).toEqual([]);
  // The station is free, and a checkpoint claim for another card reserves a fresh attempt.
  expect(await pendingCheckpointAttempt(profile)).toBeUndefined();
  const other = parsePendingCheckpointClaim({ ...claimFixture.pending, cardId: claimFixture.pending.cardId + "x",
    runId: "run_" + suffix + "m2", policy, policyDigest: checkpointPolicyDigest(policy) });
  expect((await reserveCheckpointAttempt(profile, other, task)).send).toBe(true);
});
