/** Real Node credential + Postgres/issuer/current-run joins; no Current boolean seam. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/drizzle";
import { tenants } from "../../src/db/schema/tenants";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { bridgeAgents } from "../../src/db/schema/bridge";
import { checkpointDispatches } from "../../src/db/schema/checkpoint-dispatch";
import { checkpointCurrentRoutes } from "../../src/routes/checkpoint-current";
import { connectionManager, handleNodeMessage } from "../../src/services/broker";
import { parseCheckpointProfile } from "../../src/services/bridge/checkpoint-profile";
import { readCheckpointAttempt, reserveCheckpointAttempt } from "../../src/services/bridge/checkpoint-ledger";
import { driveCheckpointAttempt } from "../../src/services/bridge/checkpoint-orchestrator";
import { checkpointAgentClient } from "../../src/services/bridge/checkpoint-agent-client";
import { canonicalCheckpoint, checkpointDigest, parseCheckpointJSON } from "../../src/services/bridge/checkpoint-json";
import { parseCheckpointSource, type CheckpointSource } from "../../src/services/bridge/checkpoint-source";
import { checkpointSettlementSchema } from "../../src/services/bridge/checkpoint-settlement-data";
import { checkpointNodeObservation } from "../helpers/checkpoint-node";
import { checkpointPolicyDigest, parsePendingCheckpointClaim } from "../../src/services/bridge/checkpoint-claim";
import { setOrgPlaneClientForTests } from "../../src/auth/org-plane/client";
import { TEST_PLANE } from "../../src/auth/org-plane/config";
import { fakePlane, fakePlaneJwks, signPlaneToken } from "../helpers/fake-plane";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createHash } from "node:crypto";
import claimFixture from "../../src/services/bridge/checkpoint-contract/claim.fixture.json";
import { BenchCoordinatorRequest, parseBenchCoordinatorCurrentResponse } from "@agentpod/contract";

const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
const organizationId = "org_" + suffix;
const tenantId = "fleet_" + suffix, nodeId = "node_" + suffix, stationId = "station_" + suffix;
const owner = "prn_" + suffix, occupant = "prn_" + suffix.slice(1) + "f";
const secret = "fixture-node-secret-" + suffix;
const app = new Hono().route("/api", checkpointCurrentRoutes);
const initialEnvironment = { flag: process.env.PROPOSED_CHECKPOINT_COORDINATOR, file: process.env.PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE, control: process.env.ENFORCE_CONTROL_PAIR };
let root = "";
const profile = parseCheckpointProfile({ version: "agentpod.checkpoint-profile.v1", organizationId: organizationId,
  sourceTenantId: claimFixture.pending.tenantId, sourceOrigin: "https://pipeline.test", sourceAudience: "https://app.superpipeline.dev",
  reporterPrincipalId: "prn_" + "c".repeat(20), ownerPrincipalId: owner, occupantPrincipalId: occupant,
  agentKey: "checkpoint-auth-" + suffix, profileKey: "fixture-profile", occupancyEpoch: 1,
  target: { tenant_id: tenantId, board_id: claimFixture.pending.boardId, agent_id: claimFixture.pending.agentId,
    station_id: stationId, node_id: nodeId, host_id: "host_fixture", registry_sha256: "a".repeat(64),
    coordinator_implementation_sha256: "b".repeat(64), execution_mode: "linux-cgroup-v2", bench_protocol: "superbench.v2",
    worker_version: "agentpod.superbench-worker.v2", worker_sha256: "c".repeat(64) },
  repositories: [{ ...claimFixture.pending.policy.repositories[0], repositorySHA256: "d".repeat(64), objectFormat: "sha1" }], checkpointRepository: "app" });
const policy = { ...claimFixture.pending.policy, reporterPrincipalId: profile.reporterPrincipalId, nodeId,
  executors: [{ agentId: profile.target.agent_id, stationId }] };
const claim = parsePendingCheckpointClaim({ ...claimFixture.pending, policy, policyDigest: checkpointPolicyDigest(policy) });
let contextClaim = claim;
let extraFetch: (address: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error("unexpected private auth fixture request"); };
let attempt: Awaited<ReturnType<typeof reserveCheckpointAttempt>>["attempt"];
let sourceReads = 0;
let afterContext: () => Promise<void> = async () => {};
let restorePlane = () => {};
let restoreFetch: typeof fetch;
const encode = (s: string) => new TextEncoder().encode(s);

beforeAll(async () => {
  await ensurePgMigrations();
  process.env.ENFORCE_CONTROL_PAIR = "true";
  fakePlane.addAgent({ id: occupant }); fakePlane.addHuman({ id: owner, grant: { mayDispatch: [occupant] } });
  for (const id of [occupant, owner]) {
    const principal = fakePlane.principals.get(id);
    if (!principal) throw new Error("fixture principal missing");
    principal.organizationId = organizationId;
  }
  await db.insert(tenants).values({ id: tenantId, name: "private checkpoint auth fixture", externalSource: "org-plane", externalId: organizationId });
  await db.insert(nodes).values({ id: nodeId, tenantId, userId: owner, name: "fixture", hostname: "fixture", os: "linux", arch: "amd64",
    secretHash: await Bun.password.hash(secret), status: "online", lastSeenAt: new Date() });
  await db.insert(stations).values({ id: stationId, tenantId, userId: owner, principalId: occupant, occupancyEpoch: 1,
    nodeId, stationKey: "fixture:" + suffix, kind: "leaf", displayName: "fixture", harness: "codex", workspacePath: "/fixture" });
  await db.insert(bridgeAgents).values({ tenantId, key: profile.agentKey, boardId: claim.boardId, stationId, profileKey: profile.profileKey,
    tokenEncrypted: "", credentialSource: { version: 1, kind: "station-plane", principalId: occupant, organizationId: organizationId, audience: "https://app.superpipeline.dev" } });
  connectionManager.register(nodeId, () => {});
  root = realpathSync(mkdtempSync(join(tmpdir(), "checkpoint-current-auth-"))); chmodSync(root, 0o700);
  const file = join(root, "profiles.json"); writeFileSync(file, JSON.stringify({ version: "agentpod.checkpoint-profiles.v1", profiles: [profile] }), { mode: 0o600 });
  process.env.PROPOSED_CHECKPOINT_COORDINATOR = "true"; process.env.PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE = file;
  restorePlane = setOrgPlaneClientForTests({ ...fakePlane, agentToken: async (principal, audience) => ({ expiresIn: 300,
    accessToken: await signPlaneToken({ sub: principal, principalKind: "agent", aud: audience, ent: ["superpipeline"], scope: "claim", org: organizationId }) }) });
  restoreFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (address === TEST_PLANE.jwksUrl) return Response.json(await fakePlaneJwks());
    if (address === `${profile.sourceOrigin}/v1/boards/${contextClaim.boardId}/runs/${contextClaim.runId}`) {
      sourceReads++; await afterContext();
      return Response.json({ ...claimFixture.context, run: { ...claimFixture.context.run, runId: contextClaim.runId },
        card: { ...claimFixture.context.card, currentRunId: contextClaim.runId },
        stage: { ...claimFixture.context.stage, checkpointPolicy: policy } });
    }
    return extraFetch(address, init);
  };
  attempt = (await reserveCheckpointAttempt(profile, claim, { profile_id: profile.profileKey, prompt: "fixture", timeout_seconds: 60 })).attempt;
});
// Rows are deliberately immutable and retained for this isolated test database.
// The QA driver drops its exact owned database afterward; there is no trigger bypass.
afterAll(async () => {
  if (restoreFetch) globalThis.fetch = restoreFetch; restorePlane(); connectionManager.unregister(nodeId);
  await db.delete(bridgeAgents).where(eq(bridgeAgents.tenantId, tenantId));
  await db.delete(stations).where(eq(stations.tenantId, tenantId));
  await db.delete(nodes).where(eq(nodes.tenantId, tenantId));
  fakePlane.remove(owner); fakePlane.remove(occupant); if (root) rmSync(root, { recursive: true, force: true });
  for (const [name, value] of [["PROPOSED_CHECKPOINT_COORDINATOR", initialEnvironment.flag], ["PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE", initialEnvironment.file], ["ENFORCE_CONTROL_PAIR", initialEnvironment.control]])
    if (name) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});
async function current(overrides: Record<string, unknown> = {}, credential = nodeId + ":" + secret) {
  const raw = encode(JSON.stringify({ version: "agentpod.bench-coordinator-current.v1", phase: "prepare", nonce: crypto.randomUUID().replaceAll("-", ""),
    identity: attempt.request.identity, target: profile.target, profile_id: profile.profileKey, prepare_request_sha256: attempt.row.prepareSHA256, ...overrides }));
  const response = await app.request(`/api/nodes/${nodeId}/bench-coordinator/current`, { method: "POST", headers: { authorization: "Bearer " + credential, "content-type": "application/json" }, body: raw });
  return { response, raw, body: new Uint8Array(await response.arrayBuffer()) };
}
test("actual enrolled Node and fresh DB/issuer/run joins return only an exact short-lived decision", async () => {
  const result = await current(); expect(result.response.status).toBe(200); expect(result.response.headers.get("cache-control")).toBe("no-store");
  const decision = await parseBenchCoordinatorCurrentResponse(result.body, result.raw, Date.now());
  expect(decision.decision).toBe("current"); expect(sourceReads).toBe(1);
  const text = new TextDecoder().decode(result.body); expect(text).not.toContain(secret); expect(text).not.toContain("access_token");
  expect(decision.request_sha256).toBe(createHash("sha256").update(result.raw).digest("hex"));
});
test("actual invalid Node credential never reaches issuer/source authority", async () => {
  const before = sourceReads; const result = await current({}, nodeId + ":wrong-secret");
  expect(result.response.status).toBe(401); expect(sourceReads).toBe(before);
});
test("foreign workspace mapping and revoked actual issuer grant refuse", async () => {
  await db.update(tenants).set({ externalId: "org_" + "f".repeat(20) }).where(eq(tenants.id, tenantId));
  try { const result = await current(); expect((await parseBenchCoordinatorCurrentResponse(result.body, result.raw, Date.now())).decision).toBe("refused"); }
  finally { await db.update(tenants).set({ externalId: organizationId }).where(eq(tenants.id, tenantId)); }
  await fakePlane.putGrant(owner, { mayDispatch: [], mayGrantReach: false, scopes: [] });
  try { const result = await current(); expect((await parseBenchCoordinatorCurrentResponse(result.body, result.raw, Date.now())).decision).toBe("refused"); }
  finally { await fakePlane.putGrant(owner, { mayDispatch: [occupant], mayGrantReach: false, scopes: [] }); }
});
test("retained row cannot change identity or rewind phase", async () => {
  await expect(db.update(checkpointDispatches).set({ prepareSHA256: "f".repeat(64) }).where(eq(checkpointDispatches.attemptId, attempt.row.attemptId)).execute()).rejects.toThrow();
  await expect(db.update(checkpointDispatches).set({ phase: "reported" }).where(eq(checkpointDispatches.attemptId, attempt.row.attemptId)).execute()).rejects.toThrow();
});

test.each(["none", "prepare", "execute", "settlement"])("real broker and immutable DB phases recover %s lost reply without redispatch", async (lost) => {
  const selected = parsePendingCheckpointClaim({ ...claim, runId: "run_" + suffix + lost });
  contextClaim = selected;
  const reserved = await reserveCheckpointAttempt(profile, selected, { profile_id: profile.profileKey, prompt: "fixture", timeout_seconds: 60 });
  const completion = await checkpointNodeObservation(reserved.attempt);
  let prepares = 0, executions = 0, posts = 0, reads = 0;
  let prepared = false, completed = false, lostOnce = false;
  let source: CheckpointSource | undefined;
  let receipt: unknown;
  connectionManager.register(nodeId, (message) => {
    if (message.type !== "req" || message.verb !== "bench.coordinator") return;
    const request = BenchCoordinatorRequest.parse(message.params);
    if (request.operation === "prepare") { prepares++; prepared = true; }
    if (request.operation === "execute") { executions++; completed = true; }
    const response = { version: "agentpod.bench-coordinator.v1", operation: request.operation,
      identity: reserved.attempt.request.identity, target: profile.target,
      ...(completed ? { state: "completed", completion } : prepared ? { state: "prepared", source: completion.source } : { state: "unknown" }) };
    // A different authenticated Node cannot consume the selected request.
    handleNodeMessage("node_wrong_fixture", { type: "res", id: message.id, ok: true, data: { ...response, state: "unknown" } });
    if (!lostOnce && request.operation === lost) {
      lostOnce = true;
      handleNodeMessage(nodeId, { type: "res", id: message.id, ok: false, error: "fixture-lost-reply" });
    } else handleNodeMessage(nodeId, { type: "res", id: message.id, ok: true, data: response });
  });
  extraFetch = async (address, init) => {
    if (address === TEST_PLANE.url + "/api/token/service") return Response.json({ access_token: await signPlaneToken({
      sub: profile.reporterPrincipalId, principalKind: "service", org: organizationId, aud: profile.sourceAudience,
      ent: ["superpipeline"], scope: "checkpoints:read checkpoints:submit" }), expires_in: 300 });
    const base = `${profile.sourceOrigin}/v1/boards/${selected.boardId}/runs/${selected.runId}`;
    if (address === base + "/heartbeat") return Response.json({ ok: true });
    if (address === base + "/checkpoint-source") {
      if (init?.method === "POST") {
        if (typeof init.body !== "string") throw new Error("expected source bytes");
        source = parseCheckpointSource(parseCheckpointJSON(encode(init.body)));
        return Response.json({ runId: selected.runId, leaseEpoch: selected.leaseEpoch, sourceDigest: await checkpointDigest(source), admittedAt: Date.now() });
      }
      return Response.json({ ...source, tenantId: profile.sourceTenantId, policy, policyDigest: selected.policyDigest,
        status: "working", lastHeartbeatMs: Date.now() });
    }
    if (address === base + "/checkpoint-settlements") {
      posts++;
      if (typeof init?.body !== "string") throw new Error("expected report bytes");
      const submitted = checkpointSettlementSchema.parse(parseCheckpointJSON(encode(init.body)));
      receipt = { version: "superpipeline.run-checkpoint-receipt.v1", settlementId: submitted.checkpoint.settlementId,
        requestDigest: await checkpointDigest(submitted), reportDigest: await checkpointDigest(submitted.checkpoint),
        reportedBy: profile.reporterPrincipalId, runId: selected.runId, leaseEpoch: selected.leaseEpoch,
        recordedAt: new Date().toISOString(), checkpoint: submitted.checkpoint.checkpoint };
      if (lost === "settlement" && !lostOnce) { lostOnce = true; throw new Error("fixture-lost-reply"); }
      return Response.json(receipt);
    }
    if (address === base + "/checkpoint") { reads++; return Response.json(receipt); }
    throw new Error("unexpected private orchestration fixture request");
  };
  try {
    const client = await checkpointAgentClient(profile);
    const first = await driveCheckpointAttempt(reserved.attempt, client, reserved.send);
    expect(first.status).toBe(lost === "none" ? "reported" : "unreported");
    const retained = await readCheckpointAttempt(tenantId, reserved.attempt.row.attemptId);
    if (!retained) throw new Error("missing retained attempt");
    const final = first.status === "reported" ? first : await driveCheckpointAttempt(retained, client);
    expect(final.status).toBe("reported");
    expect(prepares).toBe(1); expect(executions).toBe(1); expect(posts).toBe(1);
    expect(reads).toBe(lost === "settlement" ? 1 : 0);
    const stored = await readCheckpointAttempt(tenantId, reserved.attempt.row.attemptId);
    expect(stored?.row.phase).toBe("reported");
    expect(stored?.row.settlementBody).toBe(canonicalCheckpoint(JSON.parse(stored?.row.settlementBody ?? "{}")));
  } finally {
    contextClaim = claim;
    extraFetch = async () => { throw new Error("unexpected private auth fixture request"); };
    connectionManager.register(nodeId, () => {});
  }
});

test("post-context occupancy replacement refuses the old retained attempt", async () => {
  const before = sourceReads;
  afterContext = async () => {
    // The database owns occupancy_epoch: only an actual occupant change advances it.
    const [replaced] = await db.update(stations).set({ principalId: owner }).where(eq(stations.id, stationId)).returning();
    expect(replaced?.occupancyEpoch).toBe(2);
  };
  try { const result = await current(); expect(sourceReads).toBe(before + 1); expect((await parseBenchCoordinatorCurrentResponse(result.body, result.raw, Date.now())).decision).toBe("refused"); }
  finally { afterContext = async () => {}; }
});
