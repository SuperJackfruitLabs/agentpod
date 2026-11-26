/**
 * A remote bench stage's attempt through the real ledger, broker and current decision. Two enrolled
 * nodes: the bench host's (the profile's `target.node_id`), which serves prepare, attach and finish
 * and asks the Hub's current route before each attach and finish exactly as the node does (the
 * request's own bytes, hashed); and the agent's (`executor.nodeId`), where the station lives and which
 * answers the bench identity and attach verbs. The ACP session and SuperPipeline are fakes.
 */
process.env.DATABASE_URL ||= "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { BENCH_COORDINATOR_VERB, BenchCoordinatorRequest, parseBenchCoordinatorCurrentResponse, type AcpEvent } from "@agentpod/contract";
import corpus from "../../../../packages/contract/src/fixtures/bench-coordinator-v1.json";
import { db, rawSql } from "../../src/db/drizzle";
import { tenants } from "../../src/db/schema/tenants";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { bridgeAgents } from "../../src/db/schema/bridge";
import { checkpointDispatches } from "../../src/db/schema/checkpoint-dispatch";
import { checkpointCurrentRoutes } from "../../src/routes/checkpoint-current";
import { connectionManager, handleNodeMessage } from "../../src/services/broker";
import { checkpointProfileId, parseCheckpointProfile } from "../../src/services/bridge/checkpoint-profile";
import { readCheckpointAttempt, reserveCheckpointAttempt, type RetainedCheckpointAttempt } from "../../src/services/bridge/checkpoint-ledger";
import { checkpointDriveDeps, driveCheckpointAttempt } from "../../src/services/bridge/checkpoint-orchestrator";
import { checkpointAgentClient } from "../../src/services/bridge/checkpoint-agent-client";
import { canonicalCheckpoint, checkpointDigest, parseCheckpointJSON } from "../../src/services/bridge/checkpoint-json";
import { parseCheckpointSource, type CheckpointSource } from "../../src/services/bridge/checkpoint-source";
import { checkpointSettlementSchema } from "../../src/services/bridge/checkpoint-settlement-data";
import { checkpointPolicyDigest, parsePendingCheckpointClaim } from "../../src/services/bridge/checkpoint-claim";
import { resetRemoteTurnsForTests, stationBenchBusy } from "../../src/services/bridge/checkpoint-remote";
import { sweepRemoteDetach } from "../../src/services/bridge/checkpoint-remote-sweep";
import { startBenchClearing } from "../../src/services/bridge/bench-clearing";
import { resolveSupersededAttempt } from "../../src/services/bridge/checkpoint-supersede";
import { adminCheckpointAttemptsRouter } from "../../src/routes/admin-checkpoint-attempts";
import { parseRemoteState } from "../../src/services/bridge/checkpoint-remote-state";
import { REMOTE_TURN_PREFACE } from "../../src/services/bridge/checkpoint-remote-turn";
import { runOnce } from "../../src/services/bridge/dispatch";
import { STATION_HELD_MESSAGE, type AcpPort } from "../../src/services/bridge/dispatch-types";
import { withStationOpenLock } from "../../src/services/acp";
import { admitAndOpen } from "../../src/services/acp/open";
import { SuperpipelineClient } from "../../src/services/bridge/superpipeline";
import { setOrgPlaneClientForTests } from "../../src/auth/org-plane/client";
import { TEST_PLANE } from "../../src/auth/org-plane/config";
import { fakePlane, fakePlaneJwks, signPlaneToken } from "../helpers/fake-plane";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { checkpointNodeObservation } from "../helpers/checkpoint-node";
import { contractFetch } from "../helpers/superpipeline-contract";
import claimFixture from "../../src/services/bridge/checkpoint-contract/claim.fixture.json";

const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
const organizationId = "org_" + suffix;
const tenantId = "fleet_" + suffix, benchNode = "node_b" + suffix, agentNode = "node_a" + suffix, stationId = "station_" + suffix;
const owner = "prn_" + suffix, occupant = "prn_" + suffix.slice(1) + "f";
const secret = "fixture-node-secret-" + suffix;
const stationKey = "hermes:" + suffix;
const remoteExecution = "7".repeat(32);
const app = new Hono().route("/api", checkpointCurrentRoutes);
const envKeys = ["PROPOSED_CHECKPOINT_COORDINATOR", "PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE", "ENFORCE_CONTROL_PAIR", "SUPERPIPELINE_BASE_URL"] as const;
const priorEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
const encode = (s: string) => new TextEncoder().encode(s);
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const asRecord = (raw: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(raw);
const value = (list: Array<{ name: string; value: unknown }>, name: string) => {
  const found = list.find((r) => r.name === name);
  if (!found) throw new Error(`fixture ${name} missing`);
  return asRecord(structuredClone(found.value));
};
const PUBLIC_KEY = String(value(corpus.requests, "attach").public_key);
const CREDENTIAL = asRecord(value(corpus.responses, "attached").credential);

const profile = parseCheckpointProfile({ version: "agentpod.checkpoint-profile.v1", organizationId,
  sourceTenantId: claimFixture.pending.tenantId, sourceOrigin: "https://pipeline.test", sourceAudience: "https://app.superpipeline.dev",
  reporterPrincipalId: "prn_" + "c".repeat(20), ownerPrincipalId: owner, occupantPrincipalId: occupant,
  agentKey: "remote-attempt-" + suffix, profileKey: "", coordinatorProfileId: "fixture-profile", occupancyEpoch: 1,
  target: { tenant_id: tenantId, board_id: claimFixture.pending.boardId, agent_id: claimFixture.pending.agentId,
    station_id: stationId, node_id: benchNode, host_id: "host_fixture", registry_sha256: "a".repeat(64),
    coordinator_implementation_sha256: "b".repeat(64), execution_mode: "linux-cgroup-v2", bench_protocol: "superbench.v2",
    worker_version: "agentpod.superbench-worker.v2", worker_sha256: "c".repeat(64) },
  repositories: [{ ...claimFixture.pending.policy.repositories[0], repositorySHA256: "d".repeat(64), objectFormat: "sha1" }],
  checkpointRepository: "app",
  // The station's agent works from its own node; the bench host's node serves the registry profile.
  executor: { execution: "remote", stationId, nodeId: agentNode } });
const policy = { ...claimFixture.pending.policy, reporterPrincipalId: profile.reporterPrincipalId, nodeId: benchNode,
  executors: [{ agentId: profile.target.agent_id, stationId }] };
const claimFor = (run: string) => parsePendingCheckpointClaim({ ...claimFixture.pending, runId: "run_" + suffix + run,
  policy, policyDigest: checkpointPolicyDigest(policy) });

/** What the fakes saw. */
const seen = {
  bench: [] as Array<{ operation: string; params: Record<string, unknown> }>,
  agent: [] as Array<{ verb: string; params: Record<string, unknown> }>,
  decisions: [] as Array<{ phase: string; probe: string; decision: string; code?: string }>,
  sessions: [] as Array<Record<string, unknown>>, prompts: [] as string[], ended: [] as string[],
  settlements: [] as string[], heartbeats: 0,
  /** What the next finishes answer; a dirty one fences, and until a new attach reaches the agent's node every finish stays dirty. */
  finishReplies: [] as Array<"completed" | "dirty">, fenced: false, reissued: false, detach: "detached" as "detached" | "lost",
  /** The board reclaimed the served run (its heartbeat lapsed). */
  runEnded: false,
  /** The bench host's node's answer to `status`, when set (a node told its run ended stops, releases and answers stale_owner). */
  statusReply: undefined as Record<string, unknown> | undefined,
  /** The bench host's node's `status` asks the hub's current decision (observe), as the real node does. */
  statusDecides: false,
  /** Runs the hub failed on the board. */
  failed: [] as string[],
  /** The agent's node's refusal of the next attach, when set. */
  attachRefusal: undefined as Record<string, unknown> | undefined,
};
let attempt: RetainedCheckpointAttempt;
let completionFor: Awaited<ReturnType<typeof checkpointNodeObservation>>;
let listener: ((event: AcpEvent) => void) | undefined;
let source: CheckpointSource | undefined;
let receipt: unknown;
/** The run the SuperPipeline fake serves: the first card's, then the second's. */
let selected = claimFor("r1");
let restorePlane = () => {};
let restoreFetch: typeof fetch;
let root = "";

/** The bench host's node's current check for an attach or finish: its own request bytes, hashed, plus optional tampering. */
async function decide(phase: "attach" | "finish", params: Record<string, unknown>, override: Record<string, unknown> = {}) {
  const raw = encode(JSON.stringify({ version: "agentpod.bench-coordinator-current.v1", phase, nonce: crypto.randomUUID().replaceAll("-", ""),
    identity: params.identity, target: params.target, profile_id: checkpointProfileId(profile), prepare_request_sha256: attempt.row.prepareSHA256,
    execute_request_sha256: sha(JSON.stringify(params)), binding_sha256: params.binding_sha256, ...override }));
  const response = await app.request(`/api/nodes/${benchNode}/bench-coordinator/current`, { method: "POST",
    headers: { authorization: `Bearer ${benchNode}:${secret}`, "content-type": "application/json" }, body: raw });
  const decision = await parseBenchCoordinatorCurrentResponse(new Uint8Array(await response.arrayBuffer()), raw, Date.now());
  return { decision: decision.decision, ...("code" in decision ? { code: decision.code } : {}) };
}

function benchNodeAnswers() {
  connectionManager.register(benchNode, (message) => {
    if (message.type !== "req" || message.verb !== BENCH_COORDINATOR_VERB) return;
    void (async () => {
      const params = asRecord(message.params);
      const sent = BenchCoordinatorRequest.parse(params);
      seen.bench.push({ operation: sent.operation, params });
      const own = { version: "agentpod.bench-coordinator.v1", operation: sent.operation, identity: attempt.request.identity, target: profile.target };
      let data: Record<string, unknown>;
      // As the bench host's node does: its status asks the hub's own current decision, and retires its record on stale_owner.
      const decided = sent.operation === "status" && seen.statusDecides
        ? await decide("attach", params, { phase: "observe", execute_request_sha256: undefined, binding_sha256: undefined }) : undefined;
      if (decided) data = decided.code === "stale_owner" ? { version: own.version, operation: "status", state: "refused", code: "stale_owner" }
        : { ...own, state: "prepared", source: completionFor.source };
      else if (sent.operation === "status" && seen.statusReply) data = { version: own.version, operation: "status", ...seen.statusReply };
      else if (sent.operation === "prepare" || sent.operation === "status") data = { ...own, state: "prepared", source: completionFor.source };
      else if (sent.operation === "attach" || sent.operation === "finish") {
        const current = await decide(sent.operation, params);
        seen.decisions.push({ phase: sent.operation, probe: "exact", ...current });
        // The same request with another request's bytes, or another binding, is never current.
        seen.decisions.push({ phase: sent.operation, probe: "other-bytes", ...await decide(sent.operation, params, { execute_request_sha256: "f".repeat(64) }) });
        seen.decisions.push({ phase: sent.operation, probe: "other-binding", ...await decide(sent.operation, params, { binding_sha256: "0".repeat(64) }) });
        if (current.decision !== "current") data = { version: own.version, operation: own.operation, state: "refused", code: "unavailable" };
        else if (sent.operation === "attach") {
          if (seen.fenced) seen.reissued = true;
          data = { ...own, state: "attached", credential: CREDENTIAL };
        } else if (seen.fenced || seen.finishReplies[0] === "dirty") {
          if (!seen.fenced) seen.finishReplies.shift();
          seen.fenced = true; seen.reissued = false;
          data = value(corpus.responses, "finish-refused-dirty");
        } else {
          seen.finishReplies.shift();
          const report = sent.report;
          data = { ...own, state: "completed", completion: { ...completionFor, task: { ...completionFor.task, handoff: report.handoff },
            service: { ...completionFor.service, execution_id: remoteExecution, worker_result_sha256: sha(canonicalCheckpoint(report)) } } };
        }
      } else data = { ...own, state: "unknown" };
      handleNodeMessage(benchNode, { type: "res", id: message.id, ok: true, data });
    })();
  });
}
function agentNodeAnswers() {
  connectionManager.register(agentNode, (message) => {
    if (message.type !== "req") return;
    const params = asRecord(message.params);
    seen.agent.push({ verb: message.verb, params });
    // A new certificate reached the agent's node after the fence: its work lands again.
    if (message.verb === "bench.remote.attach" && seen.reissued) seen.fenced = false;
    const data = message.verb === "bench.identity.ensure" ? { publicKey: PUBLIC_KEY }
      : message.verb === "bench.remote.attach" ? seen.attachRefusal ?? { state: "attached", validBefore: "2099-01-01T00:00:00Z" }
        : message.verb === "bench.remote.status" ? { attemptId: attempt.row.attemptId, validBefore: "2099-01-01T00:00:00Z" }
          : message.verb === "bench.remote.detach" && seen.detach === "detached" ? { state: "detached" } : undefined;
    handleNodeMessage(agentNode, data ? { type: "res", id: message.id, ok: true, data } : { type: "res", id: message.id, ok: false, error: "unknown verb" });
  });
}

const acp: AcpPort = {
  stationReady: async () => ({ ready: true }),
  // As the hub's open does: the bridge's admission is checked first, under the station's open lock.
  createSession: async (input) => { await input.admit?.(); seen.sessions.push(input); return { id: "acps_" + suffix, libraryTools: false }; },
  promptSession: async (_user, _session, text) => { seen.prompts.push(text); },
  subscribe: (_session, fn) => { listener = fn; return () => { listener = undefined; }; },
  endSession: async (_user, session) => { seen.ended.push(session); },
  answerPermission: async () => {},
};
const agent = { key: profile.agentKey, boardId: profile.target.board_id, token: "", stationId, hubUserId: "usr_" + suffix,
  mode: "full-auto" as const, mcpToken: "spm_fixture" };
const deps = () => checkpointDriveDeps({ remote: { turn: { acp, agent, tenantId, mcpUrl: "https://pipeline.test/mcp" } } });
const endTurn = async (text: string) => {
  let seq = 100;
  listener?.({ sessionId: "acps_" + suffix, seq: ++seq, type: "agent-update", createdAt: "",
    payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
  listener?.({ sessionId: "acps_" + suffix, seq: ++seq, type: "state", payload: { status: "idle" }, createdAt: "" });
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

beforeAll(async () => {
  await ensurePgMigrations();
  resetRemoteTurnsForTests();
  process.env.ENFORCE_CONTROL_PAIR = "true";
  process.env.SUPERPIPELINE_BASE_URL = "https://app.superpipeline.dev/";
  fakePlane.addAgent({ id: occupant }); fakePlane.addHuman({ id: owner, grant: { mayDispatch: [occupant] } });
  for (const id of [occupant, owner]) {
    const principal = fakePlane.principals.get(id);
    if (!principal) throw new Error("fixture principal missing");
    principal.organizationId = organizationId;
  }
  await db.insert(tenants).values({ id: tenantId, name: "remote attempt fixture", externalSource: "org-plane", externalId: organizationId });
  for (const id of [benchNode, agentNode])
    await db.insert(nodes).values({ id, tenantId, userId: owner, name: id, hostname: id, os: "linux", arch: "amd64",
      secretHash: await Bun.password.hash(secret), status: "online", lastSeenAt: new Date() });
  // The station lives on the agent's node, not on the bench host's.
  await db.insert(stations).values({ id: stationId, tenantId, userId: owner, principalId: occupant, occupancyEpoch: 1,
    nodeId: agentNode, stationKey, kind: "leaf", displayName: "fixture", harness: "hermes", workspacePath: "/home/agent" });
  await db.insert(bridgeAgents).values({ tenantId, key: profile.agentKey, boardId: profile.target.board_id, stationId, profileKey: "",
    tokenEncrypted: "", credentialSource: { version: 1, kind: "station-plane", principalId: occupant, organizationId,
      audience: "https://app.superpipeline.dev" } });
  root = realpathSync(mkdtempSync(join(tmpdir(), "bench-remote-attempt-"))); chmodSync(root, 0o700);
  const file = join(root, "profiles.json");
  writeFileSync(file, JSON.stringify({ version: "agentpod.checkpoint-profiles.v1", profiles: [profile] }), { mode: 0o600 });
  process.env.PROPOSED_CHECKPOINT_COORDINATOR = "true"; process.env.PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE = file;
  restorePlane = setOrgPlaneClientForTests({ ...fakePlane, agentToken: async (principal, audience) => ({ expiresIn: 300,
    accessToken: await signPlaneToken({ sub: principal, principalKind: "agent", aud: audience, ent: ["superpipeline"], scope: "claim", org: organizationId }) }) });
  restoreFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (address === TEST_PLANE.jwksUrl) return Response.json(await fakePlaneJwks());
    if (address === TEST_PLANE.url + "/api/token/service") return Response.json({ access_token: await signPlaneToken({
      sub: profile.reporterPrincipalId, principalKind: "service", org: organizationId, aud: profile.sourceAudience,
      ent: ["superpipeline"], scope: "checkpoints:read checkpoints:submit" }), expires_in: 300 });
    const base = `${profile.sourceOrigin}/v1/boards/${selected.boardId}/runs/${selected.runId}`;
    if (address === base) return Response.json({ ...claimFixture.context, run: { ...claimFixture.context.run, runId: selected.runId,
      ...(seen.runEnded ? { status: "reclaimed", endedAt: "2026-11-25T12:20:00Z" } : {}) },
      card: { ...claimFixture.context.card, currentRunId: seen.runEnded ? null : selected.runId },
      stage: { ...claimFixture.context.stage, checkpointPolicy: policy } });
    if (address === base + "/heartbeat") { seen.heartbeats++; return Response.json({ ok: true }); }
    // A failure is said on the card, then the run is failed: the board ends it.
    if (address === base + "/activities" || address === base + "/activity") return Response.json({ ok: true });
    if (address === base + "/fail") { seen.failed.push(selected.runId); seen.runEnded = true; return Response.json({ ok: true }); }
    if (address === base + "/checkpoint-source") {
      if (init?.method === "POST") {
        if (typeof init.body !== "string") throw new Error("expected source bytes");
        source = parseCheckpointSource(parseCheckpointJSON(encode(init.body)));
        return Response.json({ runId: selected.runId, leaseEpoch: selected.leaseEpoch, sourceDigest: await checkpointDigest(source), admittedAt: Date.now() });
      }
      return Response.json({ ...source, tenantId: profile.sourceTenantId, policy, policyDigest: selected.policyDigest, status: "working",
        lastHeartbeatMs: Date.now() });
    }
    if (address === base + "/checkpoint-settlements") {
      if (typeof init?.body !== "string") throw new Error("expected report bytes");
      seen.settlements.push(init.body);
      const submitted = checkpointSettlementSchema.parse(parseCheckpointJSON(encode(init.body)));
      receipt = { version: "superpipeline.run-checkpoint-receipt.v1", settlementId: submitted.checkpoint.settlementId,
        requestDigest: await checkpointDigest(submitted), reportDigest: await checkpointDigest(submitted.checkpoint),
        reportedBy: profile.reporterPrincipalId, runId: selected.runId, leaseEpoch: selected.leaseEpoch,
        recordedAt: new Date().toISOString(), checkpoint: submitted.checkpoint.checkpoint };
      return Response.json(receipt);
    }
    if (address === base + "/checkpoint") return receipt ? Response.json(receipt) : Response.json({ error: { code: "CHECKPOINT_RECEIPT_MISSING" } }, { status: 404 });
    throw new Error("unexpected fixture request " + address);
  }, { preconnect: restoreFetch.preconnect });
  benchNodeAnswers(); agentNodeAnswers();
  const reserved = await reserveCheckpointAttempt(profile, selected, { profile_id: checkpointProfileId(profile), prompt: "fixture", timeout_seconds: 600 });
  attempt = reserved.attempt;
  completionFor = await checkpointNodeObservation(attempt);
});
afterAll(async () => {
  if (restoreFetch) globalThis.fetch = restoreFetch; restorePlane();
  connectionManager.unregister(benchNode); connectionManager.unregister(agentNode);
  // Attempt rows are immutable and retained, as in production; the test database is disposable.
  await db.delete(bridgeAgents).where(eq(bridgeAgents.tenantId, tenantId));
  await db.delete(stations).where(eq(stations.tenantId, tenantId));
  await db.delete(nodes).where(eq(nodes.tenantId, tenantId));
  fakePlane.remove(owner); fakePlane.remove(occupant);
  if (root) rmSync(root, { recursive: true, force: true });
  resetRemoteTurnsForTests();
  for (const k of envKeys) { const v = priorEnv[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const stored = async () => {
  const row = (await readCheckpointAttempt(tenantId, attempt.row.attemptId))?.row;
  if (!row) throw new Error("attempt row missing");
  return row;
};

test("remote attempt attaches, runs the turn in the workspace root and settles with the node's completion", async () => {
  const client = await checkpointAgentClient(profile);
  // From the claim: prepared and admitted as any bench stage, then attached instead of executed.
  const first = await driveCheckpointAttempt(attempt, client, true, deps());
  expect(first).toMatchObject({ status: "unreported", recheckMs: 5_000 });
  expect(seen.bench.map((c) => c.operation)).toEqual(["prepare", "attach"]);
  expect(seen.agent.map((c) => c.verb)).toEqual(["bench.identity.ensure", "bench.remote.attach"]);
  expect(seen.agent[0]?.params).toEqual({ stationId, stationKey });
  expect(seen.agent[1]?.params).toEqual({ stationId, stationKey, attemptId: attempt.row.attemptId, credential: CREDENTIAL });
  expect((await stored()).phase).toBe("working");
  // The hub's decision: the exact attach is current; other bytes are pending; another binding is a stale owner.
  expect(seen.decisions).toEqual([{ phase: "attach", probe: "exact", decision: "current" },
    { phase: "attach", probe: "other-bytes", decision: "refused", code: "pending" },
    { phase: "attach", probe: "other-binding", decision: "refused", code: "stale_owner" }]);
  // One session, opened after the attach, in the bench's workspace root, with the board tools.
  expect(seen.sessions).toHaveLength(1);
  expect(seen.sessions[0]).toMatchObject({ stationId, tenantId, cwd: CREDENTIAL.working_directory, mcpProxy: true,
    executionRun: { source: "superpipeline", id: attempt.claim.runId, epoch: attempt.claim.leaseEpoch } });
  expect(seen.prompts[0]).toStartWith(REMOTE_TURN_PREFACE);

  // The agent ends its turn: the bench host's node finishes, and today's settlement follows.
  await endTurn("Committed the parser fix on the card branch.");
  const retained = await readCheckpointAttempt(tenantId, attempt.row.attemptId);
  if (!retained) throw new Error("attempt missing");
  const second = await driveCheckpointAttempt(retained, client, false, deps());
  expect(second).toMatchObject({ status: "reported", attemptId: attempt.row.attemptId });
  expect(seen.bench.map((c) => c.operation)).toEqual(["prepare", "attach", "finish"]);
  expect(seen.decisions.slice(3)).toEqual([{ phase: "finish", probe: "exact", decision: "current" },
    { phase: "finish", probe: "other-bytes", decision: "refused", code: "pending" },
    { phase: "finish", probe: "other-binding", decision: "refused", code: "stale_owner" }]);
  expect(seen.bench[2]?.params.report).toEqual({ handoff: { summary: "Committed the parser fix on the card branch.", station: stationId,
    session: "acps_" + suffix }, outcome: "complete" });
  // Detached, and the session that worked in the bench ended.
  expect(seen.agent.map((c) => c.verb).slice(-1)).toEqual(["bench.remote.detach"]);
  expect(seen.ended).toEqual(["acps_" + suffix]);
  const row = await stored();
  expect(row.phase).toBe("reported");
  expect(parseRemoteState(row.remote)).toMatchObject({ attached: true, detached: true, dirtyTries: 0 });
  expect(seen.settlements).toHaveLength(1);
});

test("attach sends only the public key and stores no certificate or token", async () => {
  const sent = seen.bench.find((c) => c.operation === "attach")?.params ?? {};
  expect(sent.public_key).toBe(PUBLIC_KEY);
  expect(sent).not.toHaveProperty("credential");
  const [row] = await rawSql`SELECT * FROM checkpoint_dispatches WHERE tenant_id = ${tenantId} AND attempt_id = ${attempt.row.attemptId}`;
  if (!row) throw new Error("attempt row missing");
  const certificate = String(CREDENTIAL.certificate).split(" ")[1] ?? "certificate";
  for (const [column, cell] of Object.entries(row)) {
    const text = cell instanceof Date ? cell.toISOString() : String(cell ?? "");
    expect({ column, certificate: text.includes(certificate) }).toEqual({ column, certificate: false });
    expect({ column, key: text.includes(PUBLIC_KEY.split(" ")[1] ?? "key") }).toEqual({ column, key: false });
    expect({ column, secret: /lease_token|PRIVATE KEY|spm_fixture/.test(text) }).toEqual({ column, secret: false });
  }
  expect(parseRemoteState(String(row.remote))).toMatchObject({ user: CREDENTIAL.user, address: CREDENTIAL.address,
    workingDirectory: CREDENTIAL.working_directory });
});

test("settlement for a remote attempt carries the remote execution id and report digest", async () => {
  const body = (await stored()).settlementBody;
  const settlement = checkpointSettlementSchema.parse(parseCheckpointJSON(encode(String(body))));
  const report = seen.bench.find((c) => c.operation === "finish")?.params.report;
  expect(settlement.checkpoint.execution).toEqual({ id: remoteExecution, exitCode: 0 });
  expect(settlement.checkpoint.workerResultSha256).toBe(sha(canonicalCheckpoint(report)));
  // The bench is the bench host's node's; the work was the remote station's.
  expect(settlement.checkpoint.binding).toMatchObject({ nodeId: benchNode, stationId });
  expect(settlement.handoff).toEqual(z.record(z.string(), z.string()).parse(asRecord(report).handoff));
});

/** Reserve another card on the same station and make it the one the fakes serve while `fn` runs. */
async function onRun<T>(run: string, fn: () => Promise<T>): Promise<T> {
  const prior = { attempt, selected, completionFor };
  selected = claimFor(run); source = undefined; receipt = undefined;
  attempt = (await reserveCheckpointAttempt(profile, selected, { profile_id: checkpointProfileId(profile), prompt: "fixture", timeout_seconds: 600 })).attempt;
  completionFor = await checkpointNodeObservation(attempt);
  try { return await fn(); } finally { ({ attempt, selected, completionFor } = prior); }
}

test("a dirty tree is attached again, worked in a fresh session, and settles once the agent's fix lands", async () => {
  await onRun("r3", async () => {
    const client = await checkpointAgentClient(profile);
    const sessions = seen.sessions.length, attaches = seen.bench.filter((c) => c.operation === "attach").length;
    seen.finishReplies = ["dirty", "completed"];
    expect(await driveCheckpointAttempt(attempt, client, true, deps())).toMatchObject({ recheckMs: 5_000 });
    await endTurn("Fixed the parser.");
    const again = await readCheckpointAttempt(tenantId, attempt.row.attemptId);
    if (!again) throw new Error("attempt missing");
    // The finish fenced the agent: the hub's decision lets the same attach through again while working, the
    // agent's node gets the new certificate, and a fresh session tells the agent what SuperBench found.
    expect(await driveCheckpointAttempt(again, client, false, deps())).toMatchObject({ recheckMs: 5_000 });
    expect(seen.bench.filter((c) => c.operation === "attach")).toHaveLength(attaches + 2);
    expect(seen.decisions.filter((d) => d.phase === "attach" && d.probe === "exact").at(-1)).toMatchObject({ decision: "current" });
    expect(seen.fenced).toBe(false);
    expect(seen.sessions).toHaveLength(sessions + 2);
    expect(seen.prompts.at(-1)).toContain("a/notes.txt");
    expect((await stored()).phase).toBe("working");
    await endTurn("Removed the stray .orig files.");
    const last = await readCheckpointAttempt(tenantId, attempt.row.attemptId);
    if (!last) throw new Error("attempt missing");
    expect(await driveCheckpointAttempt(last, client, false, deps())).toMatchObject({ status: "reported" });
    const report = asRecord(asRecord(seen.bench.filter((c) => c.operation === "finish").at(-1)?.params.report).handoff);
    expect(report.summary).toBe("Fixed the parser.\n\nRemoved the stray .orig files.");
    expect(parseRemoteState((await stored()).remote)).toMatchObject({ dirtyTries: 1, detached: true });
  });
});

test("a station with a remote attempt takes no other board work", async () => {
  const claims: Array<Record<string, unknown>> = [];
  const ordinary = new SuperpipelineClient({ baseUrl: "https://board.test", boardId: "brd_other1", token: "spa_x",
    fetch: contractFetch(async (_url, init) => { claims.push(JSON.parse(init.body ?? "{}")); return { status: 200, ok: true, json: async () => ({ claimed: false }) }; }) });
  const other = { client: ordinary, acp, agent: { ...agent, key: "other-" + suffix, boardId: "brd_other1" }, tenantId, source: "superpipeline",
    log: () => {}, benchBusy: () => stationBenchBusy(tenantId, stationId) };
  // Settled: the station is free again, and another roster loop for it claims.
  expect(await stationBenchBusy(tenantId, stationId)).toBe(false);
  expect((await runOnce(other)).status).toBe("idle");
  expect(claims).toHaveLength(1);

  // A second card on the same station, left `working`: no loop for the station claims anything.
  await onRun("r2", async () => {
    const result = await driveCheckpointAttempt(attempt, await checkpointAgentClient(profile), true, deps());
    expect(result).toMatchObject({ status: "unreported", recheckMs: 5_000 });
    expect((await stored()).phase).toBe("working");
  });
  expect(await stationBenchBusy(tenantId, stationId)).toBe(true);
  expect(await stationBenchBusy(tenantId, "station_other")).toBe(false);
  expect(await runOnce(other)).toEqual({ status: "idle" });
  expect(claims).toHaveLength(1);
});

test("the ledger keeps the two executions apart and the remote state never cleared", async () => {
  const [row] = await rawSql`SELECT attempt_id FROM checkpoint_dispatches WHERE tenant_id = ${tenantId} AND phase IN ('working','attach_pending') LIMIT 1`;
  if (!row) throw new Error("fixture remote row missing");
  const id = String(row.attempt_id);
  const outcome = (set: string) => Promise.resolve(rawSql.unsafe(`UPDATE checkpoint_dispatches SET ${set} WHERE tenant_id = $1 AND attempt_id = $2`,
    [tenantId, id])).then(() => "applied", () => "refused");
  expect(await outcome(`remote = NULL`)).toBe("refused");
  expect(await outcome(`execute_request = '{}', execute_sha256 = '${"a".repeat(64)}'`)).toBe("refused");
  expect(await outcome(`phase = 'execute_pending', execute_request = '{}'`)).toBe("refused");
  expect(await outcome(`phase = 'admitted'`)).toBe("refused");
  const current = await db.select({ phase: checkpointDispatches.phase }).from(checkpointDispatches)
    .where(eq(checkpointDispatches.attemptId, id));
  expect(["working", "attach_pending"]).toContain(current[0]?.phase ?? "");
});

const stationNamed = (name: string) => `station_${name}_${suffix}`;
/** A copy of the settled first attempt's row on another station, in `phase`, holding `remote`. */
async function rowOn(station: string, phase: string, remote: Record<string, unknown> | null, executor = true) {
  const [first] = await db.select().from(checkpointDispatches)
    .where(and(eq(checkpointDispatches.phase, "reported"), eq(checkpointDispatches.tenantId, tenantId))).limit(1);
  if (!first) throw new Error("no settled attempt");
  const base = asRecord(JSON.parse(first.profile));
  const { executor: _executor, ...oneShot } = base;
  const target = { ...asRecord(base.target), station_id: station };
  const copy = canonicalCheckpoint({ ...(executor ? base : oneShot), target, ...(executor ? { executor: { ...asRecord(base.executor), stationId: station } } : {}) });
  const terminal = phase === "reported";
  await db.insert(checkpointDispatches).values({ ...first, attemptId: "attempt_" + crypto.randomUUID().replaceAll("-", ""),
    leaseEpoch: Math.floor(Math.random() * 1e9) + 10, profile: copy, phase, remote: remote === null ? null : canonicalCheckpoint(remote),
    failure: phase === "failure_pending" ? JSON.stringify({ at: new Date().toISOString(), by: "hub", code: "remote.dirty", disposition: "failed",
      phase: "finish_pending", reason: "Checkpoint failed: fixture." }) : null,
    ...(terminal ? {} : { prepared: null, source: null, sourceReceipt: null, completion: null, settlementBody: null, settlementSHA256: null,
      settlementReceipt: null }) });
}

test("a station stays busy from its claim, and while the agent's node may still be attached whatever the phase", async () => {
  const state = parseRemoteState((await stored()).remote);
  if (!state) throw new Error("no remote state");
  // Claimed, nothing attached yet: busy from prepare_pending on. A one-shot claim is not.
  await rowOn(stationNamed("p"), "prepare_pending", null);
  await rowOn(stationNamed("o"), "prepare_pending", null, false);
  // Settled, but the detach never confirmed (the agent's node was unreachable): still busy.
  await rowOn(stationNamed("u"), "reported", { ...state, detached: false });
  // An attach that was sent and whose reply was lost, then failed or retired: still busy.
  await rowOn(stationNamed("s"), "reported", { ...state, attached: false, agentAttachSent: true, detached: false });
  // Settled and detached: free.
  await rowOn(stationNamed("d"), "reported", { ...state, detached: true });
  // Failed but its bench not yet released (held for an operator), detached: still busy. A one-shot one is not.
  await rowOn(stationNamed("f"), "failure_pending", { ...state, detached: true });
  await rowOn(stationNamed("g"), "failure_pending", null, false);
  expect(await stationBenchBusy(tenantId, stationNamed("p"))).toBe(true);
  expect(await stationBenchBusy(tenantId, stationNamed("o"))).toBe(false);
  expect(await stationBenchBusy(tenantId, stationNamed("u"))).toBe(true);
  expect(await stationBenchBusy(tenantId, stationNamed("s"))).toBe(true);
  expect(await stationBenchBusy(tenantId, stationNamed("f"))).toBe(true);
  expect(await stationBenchBusy(tenantId, stationNamed("g"))).toBe(false);
  expect(await stationBenchBusy(tenantId, stationNamed("d"))).toBe(false);
});

test("an ordinary claim whose station a remote stage took after the cycle's check is handed back before its session opens", async () => {
  const runId = "run_ord" + suffix, cardId = "card_ord" + suffix;
  const board: string[] = [];
  const ordinary = new SuperpipelineClient({ baseUrl: "https://board.test", boardId: "brd_other1", token: "spa_x",
    fetch: contractFetch(async (url, init) => {
      const path = new URL(url).pathname;
      board.push(`${init.method ?? "GET"} ${path}`);
      const body = path.endsWith("/claims") ? { claimed: true, runId, leaseEpoch: 1, card: { id: cardId, title: "Ordinary", attemptCount: 1 },
        stage: { key: "work", name: "Work" }, handoff: null }
        : path.endsWith(`/runs/${runId}`) ? { run: { runId, cardId, stageKey: "work", leaseEpoch: 1, status: "working", outcome: null,
          startedAt: "t", endedAt: null }, card: { id: cardId, title: "Ordinary", currentStageKey: "work", state: "working", attemptCount: 1 },
          stage: { key: "work", name: "Work" }, handoff: null, references: [] } : {};
      return { status: 200, ok: true, json: async () => body };
    }) });
  // Free at the cycle's check; taken by the time the session would open.
  let checks = 0;
  const sessions = seen.sessions.length;
  const result = await runOnce({ client: ordinary, acp, agent: { ...agent, key: "ordinary-" + suffix, boardId: "brd_other1" }, tenantId,
    source: "superpipeline", log: () => {}, benchBusy: async () => ++checks > 1 });
  expect(checks).toBe(2);
  expect(result.status).toBe("released");
  expect(seen.sessions).toHaveLength(sessions);
  expect(board.some((b) => b.endsWith(`/runs/${runId}/release`))).toBe(true);
});

test("the hub's session open checks the bridge's admission under the station's open lock, before anything opens", async () => {
  const order: string[] = [];
  let release!: () => void;
  const held = withStationOpenLock(stationId, () => new Promise<void>((resolve) => { order.push("lock held"); release = resolve; }));
  const refused = admitAndOpen({ stationId, admit: async () => { order.push("admit"); throw new Error(STATION_HELD_MESSAGE); } },
    async () => { order.push("opened"); });
  await Promise.resolve(); await Promise.resolve();
  order.push("lock released");
  release();
  await held;
  await expect(refused).rejects.toThrow(STATION_HELD_MESSAGE);
  await admitAndOpen({ stationId, admit: async () => { order.push("admit"); } }, async () => { order.push("opened"); });
  expect(order).toEqual(["lock held", "lock released", "admit", "admit", "opened"]);
});

test("a reclaimed run makes the bench node release and the agent's node detach", async () => {
  // The second card's attempt (r2), left working above: its agent's turn is lost, and nothing heartbeats the run.
  const [row] = await rawSql`SELECT attempt_id FROM checkpoint_dispatches WHERE tenant_id = ${tenantId} AND phase = 'working'`;
  if (!row) throw new Error("no working attempt");
  const working = await readCheckpointAttempt(tenantId, String(row.attempt_id));
  if (!working) throw new Error("attempt missing");
  const prior = { attempt, selected };
  attempt = working; selected = claimFor("r2");
  try {
    const client = await checkpointAgentClient(profile);
    listener?.({ sessionId: "acps_" + suffix, seq: 900, type: "error", payload: { message: "agent crashed" }, createdAt: "" });
    listener?.({ sessionId: "acps_" + suffix, seq: 901, type: "state", payload: { status: "idle" }, createdAt: "" });
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const beats = seen.heartbeats;
    expect(await driveCheckpointAttempt(working, client, false, deps())).toMatchObject({ status: "unreported" });
    expect(seen.heartbeats).toBe(beats);
    expect((await stored()).phase).toBe("working");

    // SuperPipeline reclaims the run. The bench host's node, told, stops the lease (which cuts every session),
    // releases it and retires its record; the agent's node restores the station's terminal.
    seen.runEnded = true;
    seen.statusReply = { state: "refused", code: "stale_owner" };
    const ended = seen.ended.length, detaches = seen.agent.filter((c) => c.verb === "bench.remote.detach").length;
    const parked = await readCheckpointAttempt(tenantId, working.row.attemptId);
    if (!parked) throw new Error("attempt missing");
    expect(await driveCheckpointAttempt(parked, client, false, deps())).toMatchObject({ status: "released" });
    expect(seen.bench.at(-1)?.operation).toBe("status");
    expect(seen.agent.filter((c) => c.verb === "bench.remote.detach")).toHaveLength(detaches + 1);
    expect(seen.agent.at(-1)?.params).toEqual({ stationId, attemptId: working.row.attemptId });
    expect(seen.ended.length).toBeGreaterThan(ended);
    const retired = await stored();
    expect(retired.phase).toBe("retired");
    expect(JSON.parse(String(retired.retirement))).toMatchObject({ reason: "run_ended", phase: "working", by: "hub" });
    expect(parseRemoteState(retired.remote)).toMatchObject({ detached: true });
    // Any later attach or finish the node might ask about is a stale owner; the station is free; nothing was sent to the board.
    const lastAttach = seen.bench.filter((c) => c.operation === "attach").at(-1)?.params;
    if (!lastAttach) throw new Error("no attach");
    expect(await decide("attach", lastAttach)).toEqual({ decision: "refused", code: "stale_owner" });
    expect(await stationBenchBusy(tenantId, stationId)).toBe(false);
  } finally {
    ({ attempt, selected } = prior);
    seen.runEnded = false; seen.statusReply = undefined;
  }
});

test("a remote run the board ended is a stale owner to its bench node's status, which releases, and the attempt retires", async () => {
  await onRun("r8", async () => {
    const client = await checkpointAgentClient(profile);
    expect(await driveCheckpointAttempt(attempt, client, true, deps())).toMatchObject({ recheckMs: 5_000 });
    expect((await stored()).phase).toBe("working");
    const working = await readCheckpointAttempt(tenantId, attempt.row.attemptId);
    if (!working) throw new Error("attempt missing");
    // The agent's turn is lost; nothing heartbeats the run, and the board ends it.
    listener?.({ sessionId: "acps_" + suffix, seq: 950, type: "error", payload: { message: "agent crashed" }, createdAt: "" });
    listener?.({ sessionId: "acps_" + suffix, seq: 951, type: "state", payload: { status: "idle" }, createdAt: "" });
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(await driveCheckpointAttempt(working, client, false, deps())).toMatchObject({ status: "unreported" });
    seen.statusDecides = true; seen.runEnded = true;
    try {
      // The card moved off the stage: the bench node's own status asks the hub, which must say stale_owner.
      const parked = await readCheckpointAttempt(tenantId, working.row.attemptId);
      if (!parked) throw new Error("attempt missing");
      expect(await driveCheckpointAttempt(parked, client, false, deps())).toMatchObject({ status: "released" });
      const retired = await stored();
      expect(retired.phase).toBe("retired");
      expect(JSON.parse(String(retired.retirement))).toMatchObject({ reason: "run_ended", phase: "working", by: "hub" });
    } finally { seen.statusDecides = false; seen.runEnded = false; }
  });
});

test("detach sweep retries until the agent's node answers", async () => {
  // The first card settled, but say its detach never confirmed: the station stays busy.
  const settled = await stored();
  const state = parseRemoteState(settled.remote);
  if (!state) throw new Error("no remote state");
  await rawSql`UPDATE checkpoint_dispatches SET remote = ${canonicalCheckpoint({ ...state, detached: false })}
    WHERE tenant_id = ${tenantId} AND attempt_id = ${attempt.row.attemptId}`;
  expect(await stationBenchBusy(tenantId, stationId)).toBe(true);
  // Its settlement's own detach was the first.
  const before = seen.agent.filter((c) => c.verb === "bench.remote.detach" && c.params.attemptId === attempt.row.attemptId).length;
  const asked = () => seen.agent.filter((c) => c.verb === "bench.remote.detach" && c.params.attemptId === attempt.row.attemptId).length - before;
  // The agent's node does not answer: nothing is recorded, still busy.
  seen.detach = "lost";
  try {
    await sweepRemoteDetach();
    expect(asked()).toBe(1);
    expect(await stationBenchBusy(tenantId, stationId)).toBe(true);
    expect(parseRemoteState((await stored()).remote)).toMatchObject({ detached: false });
  } finally { seen.detach = "detached"; }
  // It answers: on the bench clearing's own timer, the detach is recorded, only now is the station free,
  // and the next sweep asks nothing of it.
  const timer = startBenchClearing(20);
  try {
    for (let i = 0; i < 200 && parseRemoteState((await stored()).remote)?.detached !== true; i++) await Bun.sleep(10);
  } finally { timer.stop(); }
  expect(asked()).toBe(2);
  expect(parseRemoteState((await stored()).remote)).toMatchObject({ detached: true });
  expect((await stored()).phase).toBe("reported");
  expect(await stationBenchBusy(tenantId, stationId)).toBe(false);
  await sweepRemoteDetach();
  expect(asked()).toBe(2);
});

test("an operator's retirement of a remote attempt stops its agent and detaches the station at once", async () => {
  await onRun("r6", async () => {
    const client = await checkpointAgentClient(profile);
    expect(await driveCheckpointAttempt(attempt, client, true, deps())).toMatchObject({ recheckMs: 5_000 });
    expect(await stationBenchBusy(tenantId, stationId)).toBe(true);
    const ended = seen.ended.length, detaches = seen.agent.filter((c) => c.verb === "bench.remote.detach").length;
    const admin = new Hono().use("*", async (c, next) => {
      c.set("user", { id: "usr_admin" + suffix, authType: "org_plane", tenantId });
      await next();
    }).route("/checkpoint/attempts", adminCheckpointAttemptsRouter);
    const response = await admin.request(`/checkpoint/attempts/${attempt.row.attemptId}/settle`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: attempt.row.attemptId,
        evidence: "Checked the bench host's journal and the board: the agent's run is abandoned." }) });
    expect(response.status).toBe(200);
    // Its live turn is cancelled (the session ended), and the station detached and recorded so, in the same request.
    expect(seen.ended.length).toBe(ended + 1);
    expect(seen.agent.filter((c) => c.verb === "bench.remote.detach")).toHaveLength(detaches + 1);
    const row = await stored();
    expect(row.phase).toBe("retired");
    expect(parseRemoteState(row.remote)).toMatchObject({ detached: true });
    expect(await stationBenchBusy(tenantId, stationId)).toBe(false);
  });
});

test("a remote attempt the agent's node refused is a stale owner to the bench node, which is told so it releases", async () => {
  await onRun("r7", async () => {
    seen.attachRefusal = { state: "refused", code: "credential_files", message: "the profile mounts credential files" };
    seen.statusDecides = true;
    try {
      const client = await checkpointAgentClient(profile);
      const told = seen.bench.length;
      expect(await driveCheckpointAttempt(attempt, client, true, deps())).toMatchObject({ status: "failed" });
      expect(seen.failed).toEqual([selected.runId]);
      expect((await stored()).phase).toBe("failed");
      // The bench node's record still holds the lease: it is told while the attempt is failure_pending (its own
      // decision is already stale_owner, so it releases before the board is told), and every later check is too.
      expect(seen.bench.slice(told).map((c) => c.operation)).toEqual(["prepare", "attach", "status"]);
      const lastAttach = seen.bench.filter((c) => c.operation === "attach").at(-1)?.params;
      if (!lastAttach) throw new Error("no attach");
      expect(await decide("attach", lastAttach)).toEqual({ decision: "refused", code: "stale_owner" });
      expect(await decide("attach", lastAttach, { phase: "observe", execute_request_sha256: undefined, binding_sha256: undefined }))
        .toEqual({ decision: "refused", code: "stale_owner" });
    } finally { seen.attachRefusal = undefined; seen.runEnded = false; seen.statusDecides = false; }
  });
});

test("superseded remote attempt detaches", async () => {
  await onRun("r5", async () => {
    const client = await checkpointAgentClient(profile);
    expect(await driveCheckpointAttempt(attempt, client, true, deps())).toMatchObject({ recheckMs: 5_000 });
    const working = await readCheckpointAttempt(tenantId, attempt.row.attemptId);
    if (!working) throw new Error("attempt missing");
    const ended = seen.ended.length;
    // Its profile was replaced: it is parked for an owner or admin, and its agent stops first.
    expect(await resolveSupersededAttempt(working)).toEqual({ outcome: "parked", reason: "superseded.effect_possible" });
    expect(seen.agent.at(-1)).toEqual({ verb: "bench.remote.detach", params: { stationId, attemptId: attempt.row.attemptId } });
    expect(seen.ended.length).toBe(ended + 1);
    const row = await stored();
    expect(row.phase).toBe("working");
    expect(parseRemoteState(row.remote)).toMatchObject({ detached: true });
  });
});
