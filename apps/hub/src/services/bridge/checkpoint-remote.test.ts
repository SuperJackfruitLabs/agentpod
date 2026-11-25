/**
 * A remote bench stage's phases with a fake broker, a fake SuperPipeline board and a fake turn: what
 * each pass sends to which node, what it retains, and when it heartbeats. The ledger is in memory and
 * shaped like the real compare-and-set; tests/integration/bench-remote-attempt.test.ts drives the same
 * phases through the real ledger, broker and current decision.
 */
import { beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { BENCH_COORDINATOR_VERB, BenchCoordinatorRequest, type AcpEvent } from "@agentpod/contract";
import corpus from "../../../../../packages/contract/src/fixtures/bench-coordinator-v1.json";
import claimFixture from "./checkpoint-contract/claim.fixture.json";
import { completedAttemptFixture } from "./checkpoint-completed-attempt.test-fixture";
import { canonicalCheckpoint } from "./checkpoint-json";
import { parseCheckpointProfile } from "./checkpoint-profile";
import { createCheckpointServiceClient } from "./checkpoint-service-client";
import { driveCheckpointAttempt, type CheckpointDriveDeps } from "./checkpoint-orchestrator";
import { REMOTE_DIRTY_PROMPT, REMOTE_DIRTY_RETRIES, REMOTE_HEARTBEAT_MS, REMOTE_PHASES, REMOTE_RENEW_BEFORE_MS,
  resetRemoteTurnsForTests, type RemoteSeams } from "./checkpoint-remote";
import { parseRemoteState, publicKeyFingerprint, remoteDecision } from "./checkpoint-remote-state";
import { REMOTE_TURN_PREFACE, startRemoteTurn, type RemoteTurn, type RemoteTurnClient, type RemoteTurnEnd } from "./checkpoint-remote-turn";
import { z } from "zod";
import { resetCheckpointActivityForTests } from "./checkpoint-activity";
import { advanceCheckpointAttempt, type RetainedCheckpointAttempt } from "./checkpoint-ledger";
import type { AcpPort, DispatchDeps, DispatchResult } from "./dispatch-types";
import type { CheckpointDispatchPort } from "./checkpoint-dispatch";
import { runOnce } from "./dispatch";
import { SuperpipelineClient } from "./superpipeline";
import { TEST_PLANE } from "../../auth/org-plane/config";
import { contractFetch } from "../../../tests/helpers/superpipeline-contract";

const AGENT_NODE = "node-agent-fixture";
const asRecord = (value: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(value);
const validBeforeOf = (credential: unknown) => z.object({ valid_before: z.string() }).parse(credential).valid_before;
const unused = (): never => { throw new Error("not part of this cycle"); };
const idleAcp: AcpPort = { stationReady: async () => ({ ready: true }), createSession: unused, promptSession: unused, subscribe: unused,
  endSession: unused, answerPermission: unused };
const reply = (name: string) => {
  const found = corpus.responses.find((r) => r.name === name);
  if (!found) throw new Error(`fixture ${name} missing`);
  return asRecord(structuredClone(found.value));
};
const PUBLIC_KEY = String((corpus.requests.find((r) => r.name === "attach")?.value as { public_key?: string } | undefined)?.public_key);
const CREDENTIAL = asRecord(reply("attached").credential);
const T0 = Date.parse("2026-11-25T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const tick = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

/** The completed fixture as a remote stage's attempt, in `phase`. */
async function remoteAttempt(phase = "attach_pending") {
  const { attempt, completion } = await completedAttemptFixture();
  const profile = parseCheckpointProfile({ ...attempt.profile,
    executor: { execution: "remote", stationId: attempt.profile.target.station_id, nodeId: AGENT_NODE } });
  const remote: RetainedCheckpointAttempt = { ...attempt, profile, row: { ...attempt.row, profile: canonicalCheckpoint(profile), phase,
    executeRequest: null, executeSHA256: null } };
  // The bench pushed a change, under the remote execution and the digest of the report the node journaled.
  const first = completion.service.checkpoints[0];
  if (!first) throw new Error("fixture checkpoint missing");
  const changed = { ...completion, service: { ...completion.service, execution_id: "7".repeat(32),
    checkpoints: [{ ...first, commit: "1".repeat(first.commit.length) }, ...completion.service.checkpoints.slice(1)] } };
  return { attempt: remote, completion: changed };
}

function fakeTurn() {
  let resolve!: (end: RemoteTurnEnd) => void;
  let done = new Promise<RemoteTurnEnd>((r) => { resolve = r; });
  const state = { sent: [] as string[], alive: true, cancelled: false };
  const turn: RemoteTurn = { sessionId: "acps_fixture", get done() { return done; },
    async send(prompt) { state.sent.push(prompt); done = new Promise((r) => { resolve = r; }); },
    alive: () => state.alive, async cancel() { state.cancelled = true; state.alive = false; } };
  return { turn, state, end: async (stopReason: RemoteTurnEnd["stopReason"] = "end_turn",
    handoff: Record<string, unknown> = { summary: "Done: the parser is fixed." }) => {
    if (stopReason !== "end_turn") state.alive = false;
    resolve({ stopReason, handoff }); await tick();
  } };
}

function harness(initial: RetainedCheckpointAttempt) {
  const calls: Array<{ node: string; verb: string; params: Record<string, unknown> }> = [];
  const board: Array<{ path: string; body: Record<string, unknown> }> = [];
  const turn = fakeTurn();
  const h = {
    now: T0, latest: initial, calls, board, turn, starts: [] as Array<{ cwd: string }>, phases: [] as string[],
    certificateValidBefore: iso(T0 + 30 * 60_000), status: { attemptId: initial.row.attemptId } as Record<string, unknown>,
    finishReplies: [] as Array<Record<string, unknown>>, failure: undefined as Record<string, unknown> | undefined,
    client: new SuperpipelineClient({ baseUrl: "https://board.test", boardId: "brd_ABC123", token: "spa_fixture",
      fetch: contractFetch(async (url, init) => {
        board.push({ path: url.replace("https://board.test", ""), body: JSON.parse(init.body ?? "{}") });
        return { status: 200, ok: true, json: async () => ({}) };
      }) }),
    sent: (verb: string, operation?: string) => calls.filter((c) => c.verb === verb && (!operation || c.params.operation === operation)),
    heartbeats: () => board.filter((c) => c.path.endsWith("/heartbeat")).length,
  };
  const keep = (attempt: RetainedCheckpointAttempt) => { h.latest = attempt; return attempt; };
  const seams: RemoteSeams = {
    turn: { acp: idleAcp, agent: { key: "fixture", boardId: "brd_ABC123", token: "spa_x", stationId: initial.profile.target.station_id,
      hubUserId: "usr_x", mode: "full-auto" }, tenantId: initial.row.tenantId },
    start: async (_deps, _attempt, cwd) => { h.starts.push({ cwd }); return turn.turn; },
    update: async (attempt, remote) => keep({ ...attempt, row: { ...attempt.row, remote } }),
    stationKey: async () => "hermes:fixture",
  };
  const deps: CheckpointDriveDeps = {
    authority: async () => {}, now: () => h.now, remote: seams,
    service: (profile) => createCheckpointServiceClient(profile, { plane: TEST_PLANE, fetch: async () => new Response(null, { status: 500 }) }),
    request: async (node, verb, raw) => {
      const params = asRecord(structuredClone(raw));
      calls.push({ node, verb, params });
      if (verb === BENCH_COORDINATOR_VERB) {
        const sent = BenchCoordinatorRequest.parse(params);
        if (sent.operation === "ready") return { ok: false, error: "unexpected operation" };
        const own = { identity: sent.identity, target: sent.target };
        if (sent.operation === "attach")
          return { ok: true, data: { ...reply("attached"), ...own, credential: { ...CREDENTIAL, valid_before: h.certificateValidBefore } } };
        // A refusal names no attempt; every other reply is the attempt's own.
        const next = h.finishReplies.shift();
        if (sent.operation === "finish") return { ok: true, data: next?.state === "refused" ? next : { ...next, ...own } };
        return { ok: false, error: "unexpected operation" };
      }
      if (verb === "bench.identity.ensure") return { ok: true, data: { publicKey: PUBLIC_KEY } };
      if (verb === "bench.remote.attach") return { ok: true, data: { state: "attached",
        validBefore: iso(Date.parse(validBeforeOf(params.credential))) } };
      if (verb === "bench.remote.status") return { ok: true, data: h.status };
      if (verb === "bench.remote.detach") return { ok: true, data: { state: "detached" } };
      return { ok: false, error: "unexpected verb" };
    },
    advance: async (attempt, evidence) => {
      h.phases.push(evidence.phase);
      const { phase, ...cells } = evidence;
      return { attempt: keep({ ...attempt, row: { ...attempt.row, ...cells, phase } }), send: true };
    },
    fail: async (attempt, failure) => {
      h.failure = { version: "agentpod.checkpoint-failure.v1", ...failure, phase: attempt.row.phase, by: "hub", at: "fixture" };
      return { attempt: keep({ ...attempt, row: { ...attempt.row, phase: "failure_pending", failure: canonicalCheckpoint(h.failure) } }), send: true };
    },
    close: async (attempt, outcome) => ({ attempt: keep({ ...attempt, row: { ...attempt.row, phase: "failed",
      failureReport: canonicalCheckpoint({ version: "agentpod.checkpoint-failure-report.v1", outcome, at: "fixture" }) } }), send: true }),
    retire: async () => { throw new Error("no retirement in this test"); },
  };
  return { ...h, deps, drive: async () => driveCheckpointAttempt(h.latest, h.client, false, deps), get state() { return h; } };
}
type Harness = ReturnType<typeof harness>;
const latestOf = (h: Harness) => h.state.latest;

beforeEach(() => { resetRemoteTurnsForTests(); resetCheckpointActivityForTests(); });

test("remote attempt attaches, runs the turn in the workspace root and settles with the node's completion", async () => {
  const { attempt, completion } = await remoteAttempt();
  const h = harness(attempt);
  h.state.finishReplies.push({ ...reply("finish-completed"), completion });

  const first = await h.drive();
  // The agent's node gives its key; the bench host's node asks for a certificate; the agent's node attaches.
  expect(h.calls.map((c) => [c.node, c.verb, c.params.operation ?? null])).toEqual([
    [AGENT_NODE, "bench.identity.ensure", null], [attempt.profile.target.node_id, BENCH_COORDINATOR_VERB, "attach"],
    [AGENT_NODE, "bench.remote.attach", null]]);
  expect(h.calls[0]?.params).toEqual({ stationId: attempt.profile.target.station_id, stationKey: "hermes:fixture" });
  // Only the inner credential, exactly as the bench host's node relayed it, reaches the agent's node.
  expect(h.calls[2]?.params).toEqual({ stationId: attempt.profile.target.station_id, stationKey: "hermes:fixture",
    attemptId: attempt.row.attemptId, credential: { ...CREDENTIAL, valid_before: iso(T0 + 30 * 60_000) } });
  expect(h.state.phases).toEqual(["working"]);
  // The turn opens after the attach, in the bench's workspace root, and the pass says the work is still going.
  expect(h.state.starts).toEqual([{ cwd: String(CREDENTIAL.working_directory) }]);
  expect(first).toMatchObject({ status: "unreported", recheckMs: 5_000 });

  // The agent ends its turn: that is done. Its handoff goes to the bench host's node as strings.
  await h.turn.end("end_turn", { summary: "Done: the parser is fixed.", station: "station-fixture", session: "acps_fixture",
    contextPeak: { pct: 41, used: 41_000, size: 100_000 } });
  await h.drive();
  const finish = h.sent(BENCH_COORDINATOR_VERB, "finish");
  expect(finish).toHaveLength(1);
  expect(finish[0]?.params.report).toEqual({ handoff: { summary: "Done: the parser is fixed.", station: "station-fixture",
    session: "acps_fixture", contextPeak: JSON.stringify({ pct: 41, used: 41_000, size: 100_000 }) }, outcome: "complete" });
  expect(h.state.phases).toEqual(["working", "finish_pending", "completed"]);
  expect(latestOf(h).row.completion).toBe(canonicalCheckpoint(completion));
  // Detached, and the session that worked in the bench is ended, before the station does anything else.
  expect(h.sent("bench.remote.detach")).toEqual([{ node: AGENT_NODE, verb: "bench.remote.detach",
    params: { stationId: attempt.profile.target.station_id, attemptId: attempt.row.attemptId } }]);
  expect(h.turn.state.cancelled).toBe(true);
  expect(parseRemoteState(latestOf(h).row.remote)).toMatchObject({ attached: true, detached: true, dirtyTries: 0 });
  // Then today's `completed` phase: the settlement path is untouched (its source read fails here, so it parks).
  expect(latestOf(h).row.phase).toBe("completed");
});

test("attach sends only the public key and stores no certificate or token", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  await h.drive();
  const sent = h.sent(BENCH_COORDINATOR_VERB, "attach")[0]?.params ?? {};
  expect(Object.keys(sent).toSorted()).toEqual(["binding_sha256", "board_id", "identity", "operation", "public_key", "station_id",
    "target", "tenant_id", "version"]);
  expect(sent.public_key).toBe(PUBLIC_KEY);
  const row = JSON.stringify(latestOf(h).row);
  expect(row).not.toContain(String(CREDENTIAL.certificate).split(" ")[1]);
  expect(row).not.toContain(PUBLIC_KEY.split(" ")[1]);
  expect(row).not.toMatch(/lease_token|PRIVATE KEY/);
  expect(parseRemoteState(latestOf(h).row.remote)).toEqual({ publicKeyFingerprint: publicKeyFingerprint(PUBLIC_KEY),
    attachRequestSHA256: createHash("sha256").update(JSON.stringify(sent)).digest("hex"), user: String(CREDENTIAL.user),
    address: String(CREDENTIAL.address), workingDirectory: String(CREDENTIAL.working_directory), validBefore: iso(T0 + 30 * 60_000),
    attached: true, detached: false, dirtyTries: 0, resumed: false });
});

test("renewal happens when ten minutes remain and pushes the new certificate to the agent's node", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  await h.drive();
  const firstAttach = h.sent(BENCH_COORDINATOR_VERB, "attach")[0]?.params;

  // Eleven minutes left: nothing is renewed.
  h.state.now = T0 + 19 * 60_000;
  await h.drive();
  expect(h.sent(BENCH_COORDINATOR_VERB, "attach")).toHaveLength(1);

  // Under ten minutes left: the same key, the same bytes, a new certificate, pushed to the agent's node.
  h.state.now = T0 + 20 * 60_000 + 1;
  h.state.certificateValidBefore = iso(T0 + 50 * 60_000);
  expect(REMOTE_RENEW_BEFORE_MS).toBe(600_000);
  await h.drive();
  const attaches = h.sent(BENCH_COORDINATOR_VERB, "attach");
  expect(attaches).toHaveLength(2);
  expect(attaches[1]?.params).toEqual(firstAttach);
  const pushed = h.sent("bench.remote.attach");
  expect(pushed).toHaveLength(2);
  expect(validBeforeOf(pushed[1]?.params.credential)).toBe(iso(T0 + 50 * 60_000));
  expect(parseRemoteState(latestOf(h).row.remote)?.validBefore).toBe(iso(T0 + 50 * 60_000));
  expect(latestOf(h).row.phase).toBe("working");
});

test("no heartbeat while the agent's node reports no attachment", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  await h.drive();
  const after = h.heartbeats();

  // The agent's node holds nothing for this attempt: a minute on, the run is not heartbeated.
  h.state.status = {};
  h.state.now = T0 + REMOTE_HEARTBEAT_MS;
  await h.drive();
  expect(h.heartbeats()).toBe(after);
  // Another attempt's attachment is not this one's either.
  h.state.status = { attemptId: "attempt-other" };
  await h.drive();
  expect(h.heartbeats()).toBe(after);

  // Attached to this attempt: heartbeated, at most once a minute.
  h.state.status = { attemptId: attempt.row.attemptId };
  await h.drive();
  expect(h.heartbeats()).toBe(after + 1);
  h.state.now += REMOTE_HEARTBEAT_MS - 1;
  await h.drive();
  expect(h.heartbeats()).toBe(after + 1);

  // A turn that ended without the agent ending it is not alive: no heartbeat, and the attempt parks.
  h.state.now += 1;
  await h.turn.end("error");
  const parked = await h.drive();
  expect(h.heartbeats()).toBe(after + 1);
  expect(parked).toMatchObject({ status: "unreported" });
  expect(parked.recheckMs).toBeUndefined();
  expect(latestOf(h).row.phase).toBe("working");
});

test("remote finish refused for a dirty tree prompts the agent twice, then fails", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  const dirty = reply("finish-refused-dirty");
  h.state.finishReplies.push(dirty, dirty, dirty);
  await h.drive();
  expect(REMOTE_DIRTY_RETRIES).toBe(2);

  for (let attempts = 1; attempts <= REMOTE_DIRTY_RETRIES; attempts++) {
    await h.turn.end();
    const result = await h.drive();
    expect(result).toMatchObject({ status: "unreported", recheckMs: 5_000 });
    expect(latestOf(h).row.phase).toBe("working");
    expect(parseRemoteState(latestOf(h).row.remote)).toMatchObject({ dirtyTries: attempts });
    expect(parseRemoteState(latestOf(h).row.remote)?.finishRequest).toBeUndefined();
    // Told in the same session, with SuperBench's own words naming the files.
    expect(h.turn.state.sent).toHaveLength(attempts);
    expect(h.turn.state.sent[attempts - 1]).toStartWith(REMOTE_DIRTY_PROMPT);
    expect(h.turn.state.sent[attempts - 1]).toContain("a/notes.txt");
  }

  await h.turn.end();
  const result = await h.drive();
  expect(h.sent(BENCH_COORDINATOR_VERB, "finish")).toHaveLength(3);
  expect(h.turn.state.sent).toHaveLength(2);
  expect(h.state.failure).toMatchObject({ code: "remote.dirty", disposition: "failed", phase: "finish_pending" });
  const fail = h.board.find((c) => c.path.endsWith("/fail"));
  expect(String(fail?.body.reason)).toContain("uncommitted or untracked files");
  expect(String(fail?.body.reason)).toContain("a/notes.txt");
  expect(result).toMatchObject({ status: "failed" });
  // Nothing was settled; the station was detached and its session ended.
  expect(h.state.phases).not.toContain("completed");
  expect(h.sent("bench.remote.detach")).toHaveLength(1);
  expect(h.turn.state.cancelled).toBe(true);
});

test("a refusal from the agent's node fails the attach with its code; one about the moment parks", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  const request = h.deps.request;
  h.deps.request = async (node, verb, params, opts) => verb === "bench.remote.attach"
    ? { ok: true, data: { state: "refused", code: "credential_files", message: "the profile mounts credential files" } }
    : request(node, verb, params, opts);
  const result = await h.drive();
  expect(h.state.failure).toMatchObject({ code: "credential_files", disposition: "failed", phase: "attach_pending" });
  expect(h.state.starts).toEqual([]);
  expect(result.status).toBe("failed");

  const again = harness((await remoteAttempt()).attempt);
  const base = again.deps.request;
  again.deps.request = async (node, verb, params, opts) => verb === "bench.remote.attach"
    ? { ok: true, data: { state: "refused", code: "unavailable", message: "busy" } } : base(node, verb, params, opts);
  expect((await again.drive()).status).toBe("unreported");
  expect(again.state.failure).toBeUndefined();
  expect(latestOf(again).row.phase).toBe("attach_pending");
});

test("the hub's decision accepts attach and finish only for the bytes it retained, in their phases", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  await h.drive();
  const working = latestOf(h);
  const state = parseRemoteState(working.row.remote);
  const bindingSHA256 = String(h.sent(BENCH_COORDINATOR_VERB, "attach")[0]?.params.binding_sha256);
  if (!state) throw new Error("no state");
  expect(remoteDecision(working, "attach", state.attachRequestSHA256, bindingSHA256)).toBeUndefined();
  expect(remoteDecision(working, "attach", "f".repeat(64), bindingSHA256)).toBe("pending");
  expect(remoteDecision(working, "attach", undefined, bindingSHA256)).toBe("pending");
  // No finish is current until the agent ended its turn and the request was retained.
  expect(remoteDecision(working, "finish", state.attachRequestSHA256, bindingSHA256)).toBe("pending");
  // A one-shot attempt never attaches.
  expect(remoteDecision({ ...working, profile: (await completedAttemptFixture()).attempt.profile }, "attach",
    state.attachRequestSHA256, bindingSHA256)).toBe("invalid");

  h.state.finishReplies.push(reply("finish-pending"));
  await h.turn.end();
  await h.drive();
  const finishing = latestOf(h);
  const finishState = parseRemoteState(finishing.row.remote);
  const finishSHA = createHash("sha256").update(String(finishState?.finishRequest)).digest("hex");
  expect(finishing.row.phase).toBe("finish_pending");
  expect(createHash("sha256").update(JSON.stringify(h.sent(BENCH_COORDINATOR_VERB, "finish")[0]?.params)).digest("hex")).toBe(finishSHA);
  expect(remoteDecision(finishing, "finish", finishSHA, bindingSHA256)).toBeUndefined();
  expect(remoteDecision(finishing, "finish", finishSHA, "0".repeat(64))).toBe("pending");
  expect(remoteDecision(finishing, "finish", "f".repeat(64), bindingSHA256)).toBe("pending");
  // A renewal racing the finish is not current, nor is the finish again once the attempt moved on.
  expect(remoteDecision(finishing, "attach", state.attachRequestSHA256, bindingSHA256)).toBe("pending");
  expect(remoteDecision({ ...finishing, row: { ...finishing.row, phase: "completed" } }, "finish", finishSHA, bindingSHA256)).toBe("pending");
});

test("one-shot attempts never enter a remote phase", async () => {
  expect([...REMOTE_PHASES]).toEqual(["attach_pending", "working", "finish_pending"]);
  const { attempt } = await completedAttemptFixture();
  const h = harness({ ...attempt, row: { ...attempt.row, phase: "attach_pending" } });
  // A one-shot profile in a remote phase is refused before anything is sent.
  const result = await h.drive();
  expect(result.status).toBe("unreported");
  expect(h.calls).toEqual([]);
  // The ledger refuses either execution's phases to the other, before any write.
  const admitted = { ...attempt, row: { ...attempt.row, phase: "admitted" } };
  await expect(advanceCheckpointAttempt(admitted, { phase: "attach_pending" })).rejects.toMatchObject({ code: "stale", reason: "ledger.phase" });
  const remote = (await remoteAttempt("admitted")).attempt;
  await expect(advanceCheckpointAttempt(remote, { phase: "execute_pending", executeRequest: "{}", executeSHA256: "a".repeat(64) }))
    .rejects.toMatchObject({ code: "stale", reason: "ledger.phase" });
});

test("the remote turn opens in the workspace root with the board tools, says the preface, and ends with the agent's turn", async () => {
  const { attempt } = await remoteAttempt("working");
  const opened: Array<Record<string, unknown>> = [];
  const prompts: string[] = [];
  let listener: ((event: AcpEvent) => void) | undefined;
  let seq = 0;
  const emit = (type: AcpEvent["type"], payload: unknown) => listener?.({ sessionId: "acps_t", seq: ++seq, type, payload, createdAt: "" });
  const acp: AcpPort = { stationReady: async () => ({ ready: true }),
    createSession: async (input) => { opened.push(input); return { id: "acps_t", libraryTools: false }; },
    promptSession: async (_user, _session, text) => { prompts.push(text); },
    subscribe: (_id, fn) => { listener = fn; return () => { listener = undefined; }; },
    endSession: async () => {}, answerPermission: async () => {} };
  const client: RemoteTurnClient = { context: async () => structuredClone(claimFixture.context), heartbeat: async () => ({}) };
  const agent = { key: "fixture", boardId: "brd_ABC123", token: "spa_x", stationId: attempt.profile.target.station_id,
    hubUserId: "usr_x", mode: "full-auto" as const, mcpToken: "spm_fixture" };
  const turn = await startRemoteTurn({ acp, agent, tenantId: attempt.row.tenantId, mcpUrl: "https://pipeline.test/mcp", client },
    attempt, "/bounded/benches/card-1");

  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({ stationId: agent.stationId, tenantId: attempt.row.tenantId, userId: "usr_x", mode: "full-auto",
    cwd: "/bounded/benches/card-1", mcpProxy: true, executionRun: { source: "superpipeline", id: attempt.claim.runId, epoch: attempt.claim.leaseEpoch },
    mcpServers: [{ type: "http", name: "superpipeline", url: "https://pipeline.test/mcp", headers: [{ name: "Authorization", value: "Bearer spm_fixture" }] }] });
  expect(prompts[0]).toStartWith(REMOTE_TURN_PREFACE + "\n\n");
  expect(prompts[0]).toContain("Fixture work");

  emit("agent-update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Committed the fix." } });
  emit("state", { status: "idle" });
  expect(await turn.done).toEqual({ stopReason: "end_turn", handoff: { summary: "Committed the fix.", station: agent.stationId, session: "acps_t" } });
  expect(turn.alive()).toBe(true);

  // A turn the hub recorded as failed is not the agent's end of turn, and the agent is no longer alive.
  await turn.send("Commit or remove them.");
  emit("error", { message: "boom" });
  emit("state", { status: "idle" });
  expect((await turn.done).stopReason).toBe("error");
  expect(turn.alive()).toBe(false);
  expect(prompts[1]).toBe("Commit or remove them.");
});

// Operator decision 2: while a remote stage holds the station, no roster loop for it claims, checkpoint
// work included; the loop that owns the attempt still drives it, and its pass is the cycle's answer.
test("a station a remote stage holds claims no checkpoint work either, and the owning loop still drives its attempt", async () => {
  const claims: Array<Record<string, unknown>> = [];
  const client = new SuperpipelineClient({ baseUrl: "https://board.test", boardId: "brd_ABC123", token: "spa_fixture",
    fetch: contractFetch(async (_url, init) => { claims.push(JSON.parse(init.body ?? "{}")); return { status: 200, ok: true, json: async () => ({ claimed: false }) }; }) });
  const acp = idleAcp;
  const target = { tenantId: "tnt_x", sourceTenantId: "tnt_source", boardId: "brd_ABC123", agentId: "agt_ABC123", stationId: "station_x",
    nodeId: "node_x", hostId: "host_x", registryRevision: "r", benchProtocol: "superbench.v2" as const, coordinatorImplementationSHA256: "a".repeat(64),
    executionMode: "linux-cgroup-v2" as const, workerVersion: "agentpod.superbench-worker.v2" as const, workerSHA256: "b".repeat(64) };
  let recovered: DispatchResult | undefined;
  const port: CheckpointDispatchPort = { ready: async () => target, current: async () => true, recover: async () => recovered,
    dispatch: async () => { throw new Error("nothing is dispatched on a held station"); } };
  let busy = true;
  const deps: DispatchDeps = { client, acp, agent: { key: "a", boardId: "brd_ABC123", token: "spa_x", stationId: "station_x", hubUserId: "usr_x",
    mode: "full-auto" }, tenantId: "tnt_x", source: "superpipeline", log: () => {}, checkpoint: port, checkpointRefused: () => {},
    benchBusy: async () => busy };
  // Another board's loop on the station, with nothing of its own to recover: it claims nothing at all.
  expect(await runOnce(deps)).toEqual({ status: "idle" });
  expect(claims).toEqual([]);
  // The loop whose remote turn holds the station: its pass is the answer, re-read shortly.
  recovered = { status: "unreported", attemptId: "attempt-x", reason: "Checkpoint dispatch requires reconciliation", recheckMs: 5_000 };
  expect(await runOnce(deps)).toEqual(recovered);
  expect(claims).toEqual([]);
  // Free again: the station claims checkpoint work as before.
  busy = false; recovered = undefined;
  expect(await runOnce(deps)).toEqual({ status: "idle" });
  expect(claims.map((c) => c.checkpointOnly)).toEqual([true]);
});
