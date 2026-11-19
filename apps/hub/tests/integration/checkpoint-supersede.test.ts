/**
 * An attempt made under a profile the installation has since replaced (a node build or pin change)
 * is resolved, never left to block the station, and never made to disappear:
 *
 * - provably effect-free (prepare_pending, and the node holds no record): the Hub retires it with
 *   the node's reply as evidence, and the station takes a fresh claim under the current profile;
 * - possibly effectful (a source was admitted): it stays parked, and an owner or admin settles it
 *   explicitly through the admin API, with evidence;
 * - the row and its evidence stay either way: retired is terminal, and nothing is deleted.
 */
process.env.DATABASE_URL ||= "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { BenchCoordinatorRequest, parseBenchCoordinatorCurrentResponse } from "@agentpod/contract";
import { db, rawSql } from "../../src/db/drizzle";
import { tenants } from "../../src/db/schema/tenants";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { bridgeAgents } from "../../src/db/schema/bridge";
import { checkpointCurrentRoutes } from "../../src/routes/checkpoint-current";
import { adminCheckpointAttemptsRouter } from "../../src/routes/admin-checkpoint-attempts";
import { connectionManager, handleNodeMessage } from "../../src/services/broker";
import { checkpointProfileId, parseCheckpointProfile, type CheckpointProfile } from "../../src/services/bridge/checkpoint-profile";
import { advanceCheckpointAttempt, pendingCheckpointAttempt, readCheckpointAttempt,
  reserveCheckpointAttempt } from "../../src/services/bridge/checkpoint-ledger";
import { checkpointRuntime } from "../../src/services/bridge/checkpoint-port";
import { checkpointPolicyDigest, parsePendingCheckpointClaim } from "../../src/services/bridge/checkpoint-claim";
import { fakePlane } from "../helpers/fake-plane";
import { createTestUser, deleteTestUsers } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import claimFixture from "../../src/services/bridge/checkpoint-contract/claim.fixture.json";

const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
const organizationId = "org_" + suffix;
const tenantId = "fleet_" + suffix, nodeId = "node_" + suffix, stationId = "station_" + suffix;
const owner = "prn_" + suffix, occupant = "prn_" + suffix.slice(1) + "f";
const secret = "fixture-node-secret-" + suffix;
const agentKey = "checkpoint-supersede-" + suffix;
const envKeys = ["PROPOSED_CHECKPOINT_COORDINATOR", "PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE", "ENFORCE_CONTROL_PAIR"] as const;
const priorEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

function profileWith(workerSHA256: string): CheckpointProfile {
  return parseCheckpointProfile({ version: "agentpod.checkpoint-profile.v1", organizationId,
    sourceTenantId: claimFixture.pending.tenantId, sourceOrigin: "https://pipeline.test", sourceAudience: "https://app.superpipeline.dev",
    reporterPrincipalId: "prn_" + "c".repeat(20), ownerPrincipalId: owner, occupantPrincipalId: occupant,
    agentKey, profileKey: "", coordinatorProfileId: "fixture-profile", occupancyEpoch: 1,
    target: { tenant_id: tenantId, board_id: claimFixture.pending.boardId, agent_id: claimFixture.pending.agentId,
      station_id: stationId, node_id: nodeId, host_id: "host_fixture", registry_sha256: "a".repeat(64),
      coordinator_implementation_sha256: "b".repeat(64), execution_mode: "linux-cgroup-v2", bench_protocol: "superbench.v2",
      worker_version: "agentpod.superbench-worker.v2", worker_sha256: workerSHA256 },
    repositories: [{ ...claimFixture.pending.policy.repositories[0], repositorySHA256: "d".repeat(64), objectFormat: "sha1" }],
    checkpointRepository: "app" });
}
/** Node build A's pins, and build B's: only the packaged worker digest moved. */
const buildA = profileWith("c".repeat(64));
const buildB = profileWith("e".repeat(64));
const policy = { ...claimFixture.pending.policy, reporterPrincipalId: buildA.reporterPrincipalId, nodeId,
  executors: [{ agentId: buildA.target.agent_id, stationId }] };
const claimFor = (run: string) => parsePendingCheckpointClaim({ ...claimFixture.pending, runId: "run_" + suffix + run,
  policy, policyDigest: checkpointPolicyDigest(policy) });
const task = (profile: CheckpointProfile) => ({ profile_id: checkpointProfileId(profile), prompt: "fixture", timeout_seconds: 60 });

let root = "";
let userId = "";
let installs = 0;
/** Install one profile, as a restarted Hub would read it: a new file path is a new snapshot. */
function install(profile: CheckpointProfile) {
  const file = join(root, `profiles-${++installs}.json`);
  writeFileSync(file, JSON.stringify({ version: "agentpod.checkpoint-profiles.v1", profiles: [profile] }), { mode: 0o600 });
  process.env.PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE = file;
}
/** The node's answer to a status read: what the coordinator journal says about the attempt. */
function nodeAnswers(state: "unknown" | "pending") {
  const statuses: unknown[] = [];
  connectionManager.register(nodeId, (message) => {
    if (message.type !== "req" || message.verb !== "bench.coordinator") return;
    const request = BenchCoordinatorRequest.parse(message.params);
    statuses.push(request.operation);
    if (request.operation !== "status") throw new Error("a superseded attempt is only ever read");
    handleNodeMessage(nodeId, { type: "res", id: message.id, ok: true, data: { version: request.version,
      operation: "status", identity: request.identity, target: request.target, state } });
  });
  return statuses;
}
const runtime = () => {
  const found = checkpointRuntime(tenantId, buildA.target.board_id, stationId, agentKey);
  if (!found) throw new Error("fixture runtime missing");
  return found;
};
const admin = () => new Hono().use("*", async (c, next) => {
  c.set("user", { id: userId, authType: "org_plane", tenantId });
  await next();
}).route("/checkpoint/attempts", adminCheckpointAttemptsRouter);

beforeAll(async () => {
  await ensurePgMigrations();
  userId = (await createTestUser({ name: "checkpoint-supersede" })).id;
  process.env.ENFORCE_CONTROL_PAIR = "true";
  process.env.PROPOSED_CHECKPOINT_COORDINATOR = "true";
  fakePlane.addAgent({ id: occupant }); fakePlane.addHuman({ id: owner, grant: { mayDispatch: [occupant] } });
  for (const id of [occupant, owner]) {
    const principal = fakePlane.principals.get(id);
    if (!principal) throw new Error("fixture principal missing");
    principal.organizationId = organizationId;
  }
  await db.insert(tenants).values({ id: tenantId, name: "checkpoint supersede fixture", externalSource: "org-plane", externalId: organizationId });
  await db.insert(nodes).values({ id: nodeId, tenantId, userId: owner, name: "fixture", hostname: "fixture", os: "linux", arch: "amd64",
    secretHash: await Bun.password.hash(secret), status: "online", lastSeenAt: new Date() });
  await db.insert(stations).values({ id: stationId, tenantId, userId: owner, principalId: occupant, occupancyEpoch: 1,
    nodeId, stationKey: "fixture:" + suffix, kind: "leaf", displayName: "fixture", harness: "hermes", workspacePath: "/fixture" });
  await db.insert(bridgeAgents).values({ tenantId, key: agentKey, boardId: buildA.target.board_id, stationId, profileKey: "",
    tokenEncrypted: "", credentialSource: { version: 1, kind: "station-plane", principalId: occupant, organizationId,
      audience: "https://app.superpipeline.dev" } });
  connectionManager.register(nodeId, () => {});
  root = realpathSync(mkdtempSync(join(tmpdir(), "checkpoint-supersede-"))); chmodSync(root, 0o700);
  install(buildA);
});
afterAll(async () => {
  connectionManager.unregister(nodeId);
  // Attempt rows are immutable and retained, as in production; the test database is disposable.
  await db.delete(bridgeAgents).where(eq(bridgeAgents.tenantId, tenantId));
  await db.delete(stations).where(eq(stations.tenantId, tenantId));
  await db.delete(nodes).where(eq(nodes.tenantId, tenantId));
  fakePlane.remove(owner); fakePlane.remove(occupant);
  await rawSql`DELETE FROM admin_audit_log WHERE tenant_id = ${tenantId}`;
  await deleteTestUsers([userId]);
  if (root) rmSync(root, { recursive: true, force: true });
  for (const k of envKeys) { const v = priorEnv[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test("an effect-free attempt under a replaced profile is retired with the node's evidence; the station claims afresh", async () => {
  // Build A reserved the attempt; the node journaled nothing yet (prepare never reached it).
  const old = await reserveCheckpointAttempt(buildA, claimFor("a1"), task(buildA));
  expect(old.send).toBe(true);
  // The node is upgraded to build B and the Hub restarts with B's pins.
  install(buildB);
  const pending = await pendingCheckpointAttempt(buildB);
  expect(pending?.superseded).toBe(true);
  expect(pending?.attempt.row.attemptId).toBe(old.attempt.row.attemptId);

  // The node asking about the old attempt is told it is no longer current, so it retires its record.
  const raw = new TextEncoder().encode(JSON.stringify({ version: "agentpod.bench-coordinator-current.v1", phase: "prepare",
    nonce: crypto.randomUUID().replaceAll("-", ""), identity: old.attempt.request.identity, target: buildA.target,
    profile_id: checkpointProfileId(buildA), prepare_request_sha256: old.attempt.row.prepareSHA256 }));
  const response = await new Hono().route("/api", checkpointCurrentRoutes).request(`/api/nodes/${nodeId}/bench-coordinator/current`,
    { method: "POST", headers: { authorization: `Bearer ${nodeId}:${secret}`, "content-type": "application/json" }, body: raw });
  const decision = await parseBenchCoordinatorCurrentResponse(new Uint8Array(await response.arrayBuffer()), raw, Date.now());
  expect(decision).toMatchObject({ decision: "refused", code: "stale_owner" });

  const statuses = nodeAnswers("unknown");
  try {
    expect(await runtime().port.recover?.()).toBeUndefined();
  } finally { connectionManager.register(nodeId, () => {}); }
  expect(statuses).toEqual(["status"]);
  const retired = await readCheckpointAttempt(tenantId, old.attempt.row.attemptId);
  expect(retired?.row.phase).toBe("retired");
  expect(JSON.parse(retired?.row.retirement ?? "{}")).toMatchObject({ reason: "superseded.no_record", phase: "prepare_pending", by: "hub" });
  // Nothing the attempt held is gone: its request and authority are as they were.
  expect(retired?.row.prepareRequest).toBe(old.attempt.row.prepareRequest);

  // The card can be claimed again under build B: a fresh reservation, with the right to send prepare.
  expect(await pendingCheckpointAttempt(buildB)).toBeUndefined();
  const fresh = await reserveCheckpointAttempt(buildB, claimFor("b1"), task(buildB));
  expect(fresh.send).toBe(true);
});

test("an attempt that may have an effect stays parked, and an owner or admin settles it with evidence", async () => {
  // Build B's attempt got as far as an admitted source; then the pins change back to A.
  const pending = await pendingCheckpointAttempt(buildB);
  if (!pending) throw new Error("fixture attempt missing");
  let attempt = pending.attempt;
  attempt = (await advanceCheckpointAttempt(attempt, { phase: "prepared", prepared: "fixture-prepared" })).attempt;
  attempt = (await advanceCheckpointAttempt(attempt, { phase: "source_pending", source: "fixture-source" })).attempt;
  attempt = (await advanceCheckpointAttempt(attempt, { phase: "admitted", sourceReceipt: "fixture-receipt" })).attempt;
  install(buildA);

  const statuses = nodeAnswers("unknown");
  try {
    // Held, not retired: the Hub cannot prove nothing is outstanding once a source was admitted.
    expect(await runtime().port.recover?.()).toMatchObject({ status: "unreported", attemptId: attempt.row.attemptId });
  } finally { connectionManager.register(nodeId, () => {}); }
  expect(statuses).toEqual([]);
  expect((await readCheckpointAttempt(tenantId, attempt.row.attemptId))?.row.phase).toBe("admitted");

  const listed: unknown = await (await admin().request("/checkpoint/attempts")).json();
  expect(listed).toEqual({ attempts: [expect.objectContaining({ attemptId: attempt.row.attemptId, phase: "admitted",
    superseded: true, effectPossible: true })] });

  const settle = (body: unknown) => admin().request(`/checkpoint/attempts/${attempt.row.attemptId}/settle`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const evidence = "node journal shows the record cancelled and the bench lease released";
  expect((await settle({ confirm: "attempt_other", evidence })).status).toBe(400);
  expect((await settle({ confirm: attempt.row.attemptId, evidence: "looked" })).status).toBe(400);
  expect((await readCheckpointAttempt(tenantId, attempt.row.attemptId))?.row.phase).toBe("admitted");
  const settled = await settle({ confirm: attempt.row.attemptId, evidence });
  expect(settled.status).toBe(200);
  expect(await settled.json()).toEqual({ attemptId: attempt.row.attemptId, from: "admitted", phase: "retired" });
  const row = (await readCheckpointAttempt(tenantId, attempt.row.attemptId))?.row;
  expect(JSON.parse(row?.retirement ?? "{}")).toMatchObject({ reason: "operator", phase: "admitted", by: userId, evidence });
  // Every evidence cell the attempt already held is still there.
  expect(row?.sourceReceipt).toBe("fixture-receipt");
  expect((await settle({ confirm: attempt.row.attemptId, evidence })).status).toBe(409);
  expect(await pendingCheckpointAttempt(buildA)).toBeUndefined();
});

/** Whether the database applied a statement or refused it. */
const outcome = (query: PromiseLike<unknown>) => Promise.resolve(query).then(() => "applied", () => "refused");

test("retired is terminal and its evidence immutable; no attempt row can be deleted", async () => {
  const [row] = await rawSql`SELECT attempt_id FROM checkpoint_dispatches WHERE tenant_id = ${tenantId} AND phase = 'retired' LIMIT 1`;
  if (!row) throw new Error("fixture retired row missing");
  const id = String(row.attempt_id);
  expect(await outcome(rawSql`UPDATE checkpoint_dispatches SET phase = 'prepare_pending', retirement = NULL WHERE tenant_id = ${tenantId} AND attempt_id = ${id}`)).toBe("refused");
  expect(await outcome(rawSql`UPDATE checkpoint_dispatches SET retirement = '{}' WHERE tenant_id = ${tenantId} AND attempt_id = ${id}`)).toBe("refused");
  expect(await outcome(rawSql`DELETE FROM checkpoint_dispatches WHERE tenant_id = ${tenantId} AND attempt_id = ${id}`)).toBe("refused");
  // Retiring needs its evidence, and a retirement needs the retired phase.
  const fresh = await reserveCheckpointAttempt(buildA, claimFor("c1"), task(buildA));
  const freshId = fresh.attempt.row.attemptId;
  expect(await outcome(rawSql`UPDATE checkpoint_dispatches SET phase = 'retired' WHERE tenant_id = ${tenantId} AND attempt_id = ${freshId}`)).toBe("refused");
  expect(await outcome(rawSql`UPDATE checkpoint_dispatches SET retirement = '{}' WHERE tenant_id = ${tenantId} AND attempt_id = ${freshId}`)).toBe("refused");
});
