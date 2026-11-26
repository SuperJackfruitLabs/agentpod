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
import { driveCheckpointAttempt, setParkedLogForTests, type CheckpointDriveDeps } from "./checkpoint-orchestrator";
import { createQuietLog } from "./quiet-log";
import { endRemoteWork, REMOTE_DIRTY_PROMPT, REMOTE_DIRTY_RETRIES, REMOTE_HEARTBEAT_MS, REMOTE_PHASES, REMOTE_REATTACH_RETRY_MS,
  REMOTE_RENEW_BEFORE_MS, REMOTE_RESUME_PROMPT, resetRemoteTurnsForTests, type RemoteSeams } from "./checkpoint-remote";
import { sweepRemoteDetach } from "./checkpoint-remote-sweep";
import { resolveSupersededAttempt } from "./checkpoint-supersede";
import { parseRemoteState, publicKeyFingerprint, remoteDecision } from "./checkpoint-remote-state";
import { REMOTE_TURN_PREFACE, startRemoteTurn, type RemoteTurn, type RemoteTurnClient, type RemoteTurnDeps,
  type RemoteTurnEnd } from "./checkpoint-remote-turn";
import { OWN_WORK_FINISHED_PROMPT } from "./dispatch-turn";
import { z } from "zod";
import { resetCheckpointActivityForTests } from "./checkpoint-activity";
import { advanceCheckpointAttempt, type RetainedCheckpointAttempt } from "./checkpoint-ledger";
import type { AcpPort, DispatchDeps, DispatchResult } from "./dispatch-types";
import type { CheckpointDispatchPort } from "./checkpoint-dispatch";
import { runOnce } from "./dispatch";
import { SuperpipelineClient, type RunElicitation } from "./superpipeline";
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
  // The stage's task timeout bounds the agent's turn: an hour here.
  const request = { ...attempt.request, task: { ...attempt.request.task, timeout_seconds: 3600 } };
  const remote: RetainedCheckpointAttempt = { ...attempt, profile, request, row: { ...attempt.row, profile: canonicalCheckpoint(profile), phase,
    // Claimed well before the attach (a long prepare): the turn's bound counts from the turn, not the claim.
    executeRequest: null, executeSHA256: null, createdAt: new Date(T0 - 55 * 60_000), updatedAt: new Date(T0) } };
  // The bench pushed a change, under the remote execution and the digest of the report the node journaled.
  const first = completion.service.checkpoints[0];
  if (!first) throw new Error("fixture checkpoint missing");
  const changed = { ...completion, service: { ...completion.service, execution_id: "7".repeat(32),
    checkpoints: [{ ...first, commit: "1".repeat(first.commit.length) }, ...completion.service.checkpoints.slice(1)] } };
  return { attempt: remote, completion: changed };
}

function fakeTurn(id: string) {
  let resolve!: (end: RemoteTurnEnd) => void;
  let done = new Promise<RemoteTurnEnd>((r) => { resolve = r; });
  const state = { sent: [] as string[], alive: true, cancelled: false, opening: "" };
  const turn: RemoteTurn = { sessionId: id, get done() { return done; },
    async send(prompt) { state.sent.push(prompt); done = new Promise((r) => { resolve = r; }); },
    alive: () => state.alive,
    async cancel() { state.cancelled = true; state.alive = false; resolve({ stopReason: "cancelled", handoff: {} }); } };
  return { turn, state, end: async (stopReason: RemoteTurnEnd["stopReason"] = "end_turn",
    handoff: Record<string, unknown> = { summary: "Done: the parser is fixed." }) => {
    if (stopReason !== "end_turn") state.alive = false;
    resolve({ stopReason, handoff }); await tick();
  } };
}

/**
 * The bench host's node and SuperBench as they behave: a dirty finish fences every session and retires
 * the certificate, so the agent's work counts again only after a new attach reached the agent's node.
 */
function harness(initial: RetainedCheckpointAttempt) {
  const calls: Array<{ node: string; verb: string; params: Record<string, unknown> }> = [];
  const board: Array<{ path: string; body: Record<string, unknown> }> = [];
  const turns: Array<ReturnType<typeof fakeTurn>> = [];
  const h = {
    now: T0, latest: initial, calls, board, turns, starts: [] as Array<{ cwd: string; opening: string }>, phases: [] as string[],
    certificateValidBefore: iso(T0 + 30 * 60_000), status: { attemptId: initial.row.attemptId } as Record<string, unknown>,
    finishReplies: [] as Array<Record<string, unknown>>, failure: undefined as Record<string, unknown> | undefined,
    /** The last finish fenced the sessions: until a bench attach and then an agent attach, nothing the agent does lands. */
    fenced: false, reissued: false, locks: [] as string[],
    agentAttach: undefined as undefined | ((params: Record<string, unknown>) => { ok: boolean; data?: unknown; error?: string }),
    /** The agent's node's answer to a detach. */
    agentDetach: (): { ok: boolean; data?: unknown; error?: string } => ({ ok: true, data: { state: "detached" } }),
    /** The bench host's node's answer to the run-ended `status`: by default it stopped and released (the hub said stale_owner). */
    statusReply: { state: "refused", code: "stale_owner" } as Record<string, unknown>,
    /** What the board's run view says (GET runs/:id); undefined is the run still working. */
    runView: undefined as unknown, stationReady: true, endedSessions: [] as string[],
    /** Whether the station's node confirms its sessions' processes closed, and how often it was asked. */
    closeConfirmed: true, stationCloses: 0,
    retired: [] as Array<{ reason: string; by: string; evidence: string; phase: string }>,
    client: new SuperpipelineClient({ baseUrl: "https://board.test", boardId: "brd_ABC123", token: "spa_fixture",
      fetch: contractFetch(async (url, init) => {
        board.push({ path: url.replace("https://board.test", ""), body: JSON.parse(init.body ?? "{}") });
        const view: unknown = init.method === "GET" && url.endsWith(`/runs/${initial.claim.runId}`) ? h.runView : undefined;
        return { status: 200, ok: true, json: async (): Promise<unknown> => view ?? {} };
      }) }),
    sent: (verb: string, operation?: string) => calls.filter((c) => c.verb === verb && (!operation || c.params.operation === operation)),
    heartbeats: () => board.filter((c) => c.path.endsWith("/heartbeat")).length,
    /** The run verbs the hub must never send on its own for a lost agent. */
    runVerbs: () => board.filter((c) => /\/(fail|release)$/.test(c.path)),
    turn: () => { const t = turns.at(-1); if (!t) throw new Error("no turn started"); return t; },
  };
  // Every write stamps the row as the ledger does: the run-ended wait counts from the last one.
  const keep = (attempt: RetainedCheckpointAttempt) => { h.latest = { ...attempt, row: { ...attempt.row, updatedAt: new Date(h.now) } }; return h.latest; };
  const seams: RemoteSeams = {
    turn: { acp: { ...idleAcp, withStationLock: async (stationId, fn) => { h.locks.push(`enter:${stationId}`);
      try { return await fn(); } finally { h.locks.push(`leave:${stationId}`); } },
    stationReady: async () => ({ ready: h.stationReady, ...(h.stationReady ? {} : { reason: "Node is offline." }) }),
    endSession: async (_user, session) => { h.endedSessions.push(session); },
    closeStationSessions: async () => { h.stationCloses++; return h.closeConfirmed; } },
    agent: { key: "fixture", boardId: "brd_ABC123", token: "spa_x", stationId: initial.profile.target.station_id,
      hubUserId: "usr_x", mode: "full-auto" }, tenantId: initial.row.tenantId },
    start: async (_deps, _attempt, cwd, opening = "") => {
      h.starts.push({ cwd, opening });
      const t = fakeTurn(`acps_${turns.length + 1}`);
      t.state.opening = opening;
      turns.push(t);
      return t.turn;
    },
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
        if (sent.operation === "status") return { ok: true, data: { version: sent.version, operation: "status", ...h.statusReply,
          ...(h.statusReply.state === "refused" ? {} : own) } };
        if (sent.operation === "attach") {
          if (h.fenced) h.reissued = true;
          return { ok: true, data: { ...reply("attached"), ...own, credential: { ...CREDENTIAL, valid_before: h.certificateValidBefore } } };
        }
        if (sent.operation === "finish") {
          // A fenced bench never saw the agent's fix: still dirty. Otherwise the next scripted reply.
          const next = h.fenced ? reply("finish-refused-dirty") : h.finishReplies.shift();
          if (next?.state === "refused" && next.code === "dirty") { h.fenced = true; h.reissued = false; }
          // A refusal names no attempt; every other reply is the attempt's own.
          return { ok: true, data: next?.state === "refused" ? next : { ...next, ...own } };
        }
        return { ok: false, error: "unexpected operation" };
      }
      if (verb === "bench.identity.ensure") return { ok: true, data: { publicKey: PUBLIC_KEY } };
      if (verb === "bench.remote.attach") {
        if (h.agentAttach) return h.agentAttach(params);
        if (h.reissued) h.fenced = false;
        return { ok: true, data: { state: "attached", validBefore: iso(Date.parse(validBeforeOf(params.credential))) } };
      }
      if (verb === "bench.remote.status") return { ok: true, data: h.status };
      if (verb === "bench.remote.detach") return h.agentDetach();
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
    retire: async (attempt, retirement) => {
      h.retired.push({ ...retirement, phase: attempt.row.phase });
      keep({ ...attempt, row: { ...attempt.row, phase: "retired" } });
      return true;
    },
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
  expect(h.state.starts).toEqual([{ cwd: String(CREDENTIAL.working_directory), opening: REMOTE_TURN_PREFACE }]);
  // The agent's node attached under the station's session-open lock, and only after the row said it was sent.
  expect(h.state.locks).toEqual([`enter:${attempt.profile.target.station_id}`, `leave:${attempt.profile.target.station_id}`]);
  expect(first).toMatchObject({ status: "unreported", recheckMs: 5_000 });

  // The agent ends its turn: that is done. Its handoff goes to the bench host's node as strings.
  await h.turn().end("end_turn", { summary: "Done: the parser is fixed.", station: "station-fixture", session: "acps_fixture",
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
  expect(h.turn().state.cancelled).toBe(true);
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
    agentAttachSent: true, attached: true, detached: false, dirtyTries: 0, resumed: false,
    // When the stage's bound started, and the session the agent works in: neither is a credential.
    turnStartedAt: new Date(T0).toISOString() });
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
  await h.turn().end("error");
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

  for (let tries = 1; tries <= REMOTE_DIRTY_RETRIES; tries++) {
    await h.turn().end();
    const fenced = h.turn();
    const result = await h.drive();
    expect(result).toMatchObject({ status: "unreported", recheckMs: 5_000 });
    expect(latestOf(h).row.phase).toBe("working");
    expect(parseRemoteState(latestOf(h).row.remote)).toMatchObject({ dirtyTries: tries });
    expect(parseRemoteState(latestOf(h).row.remote)?.finishRequest).toBeUndefined();
    expect(parseRemoteState(latestOf(h).row.remote)?.retryPrompt).toBeUndefined();
    // The fence retired the certificate: attached again, on both nodes, before a fresh session.
    expect(h.sent(BENCH_COORDINATOR_VERB, "attach")).toHaveLength(1 + tries);
    expect(h.sent("bench.remote.attach")).toHaveLength(1 + tries);
    expect(fenced.state.cancelled).toBe(true);
    expect(h.state.starts).toHaveLength(1 + tries);
    // Told in the fresh session, with SuperBench's own words naming the files.
    expect(h.turn().state.opening).toStartWith(REMOTE_TURN_PREFACE);
    expect(h.turn().state.opening).toContain(REMOTE_DIRTY_PROMPT);
    expect(h.turn().state.opening).toContain("a/notes.txt");
  }

  await h.turn().end();
  const result = await h.drive();
  expect(h.sent(BENCH_COORDINATOR_VERB, "finish")).toHaveLength(3);
  expect(h.state.starts).toHaveLength(3);
  expect(h.state.failure).toMatchObject({ code: "remote.dirty", disposition: "failed", phase: "finish_pending" });
  const fail = h.board.find((c) => c.path.endsWith("/fail"));
  expect(String(fail?.body.reason)).toContain("uncommitted or untracked files");
  expect(String(fail?.body.reason)).toContain("a/notes.txt");
  expect(result).toMatchObject({ status: "failed" });
  // Nothing was settled; the station was detached and its session ended.
  expect(h.state.phases).not.toContain("completed");
  expect(h.sent("bench.remote.detach")).toHaveLength(1);
  expect(h.turn().state.cancelled).toBe(true);
});

test("a dirty tree is fixed after the re-attach and settles, the report keeping the first turn's summary", async () => {
  const { attempt, completion } = await remoteAttempt();
  const h = harness(attempt);
  // The finish fences; the bench only checkpoints what the agent did after a new certificate reached it.
  h.state.finishReplies.push(reply("finish-refused-dirty"), { ...reply("finish-completed"), completion });
  await h.drive();
  await h.turn().end("end_turn", { summary: "Fixed the parser and added its tests.", station: "s", session: "acps_1" });
  await h.drive();
  expect(h.state.fenced).toBe(false);
  expect(h.turn().state.opening).toContain("Your earlier turn reported: Fixed the parser and added its tests.");
  await h.turn().end("end_turn", { summary: "Removed the stray .orig files.", station: "s", session: "acps_2" });
  await h.drive();
  expect(latestOf(h).row.phase).toBe("completed");
  const reports = h.sent(BENCH_COORDINATOR_VERB, "finish").map((c) => asRecord(asRecord(c.params.report).handoff).summary);
  expect(reports).toEqual(["Fixed the parser and added its tests.",
    "Fixed the parser and added its tests.\n\nRemoved the stray .orig files."]);
});

test("an attach the agent's node may have applied is detached before the attempt fails, though its reply was lost", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  h.state.agentAttach = () => ({ ok: false, error: "request timed out" });
  expect((await h.drive()).status).toBe("unreported");
  // Written before the agent's node was asked: the station may point at the bench.
  expect(parseRemoteState(latestOf(h).row.remote)).toMatchObject({ agentAttachSent: true, attached: false, detached: false });
  expect(latestOf(h).row.phase).toBe("attach_pending");
  // Then the agent's node refuses outright: the run fails, and the station is detached first.
  h.state.agentAttach = () => ({ ok: true, data: { state: "refused", code: "terminal_in_use", message: "busy" } });
  await h.drive();
  expect(h.state.failure).toMatchObject({ code: "terminal_in_use", phase: "attach_pending" });
  expect(h.sent("bench.remote.detach")).toHaveLength(1);
  expect(parseRemoteState(latestOf(h).row.remote)).toMatchObject({ agentAttachSent: true, detached: true });
});

test("past the stage's time limit the turn is ended, and nothing more is heartbeated or renewed", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  await h.drive();
  const beats = h.heartbeats();
  // An hour on: the certificate would need renewing and a heartbeat is due, but the turn is over.
  h.state.now = T0 + 3600_000;
  const parked = await h.drive();
  expect(h.turn().state.cancelled).toBe(true);
  expect(parked.recheckMs).toBeUndefined();
  expect(h.heartbeats()).toBe(beats);
  expect(h.sent(BENCH_COORDINATOR_VERB, "attach")).toHaveLength(1);
  expect(h.sent("bench.remote.status")).toEqual([]);
  h.state.now += 600_000;
  await h.drive();
  expect(h.heartbeats()).toBe(beats);
  expect(h.sent(BENCH_COORDINATOR_VERB, "attach")).toHaveLength(1);
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

const refusedAttach = (h: Harness) => {
  const request = h.deps.request;
  h.deps.request = async (node, verb, params, opts) => verb === "bench.remote.attach"
    ? { ok: true, data: { state: "refused", code: "credential_files", message: "the profile mounts credential files" } }
    : request(node, verb, params, opts);
};
/** The bench host's node holding a dirty tree for an operator (operator ruling, 2026-11-26). */
const HELD_DIRTY = { state: "pending", detail: { lease: "held",
  message: "workspace has uncommitted or untracked files; commit or remove them before checkpoint or release: notes.txt" } };
/** Every park's reason, in order, while the returned restore is not yet called. */
function captureParks(): { last: () => string | undefined; restore: () => void } {
  const reasons: string[] = [];
  const restore = setParkedLogForTests(createQuietLog((_m, meta) => { reasons.push(String(meta?.reason)); }, { now: () => 0, relogMs: 0 }));
  return { last: () => reasons.at(-1), restore };
}
/** The card's held-bench notices: `checkpoint.parked` with code `lease_held` (not a park whose reason merely names it). */
const heldActivities = (h: Harness) => h.state.board.filter((c) => c.path.endsWith("/activities") &&
  JSON.stringify(c.body).includes('"code":"lease_held"'));

test("a failed remote attempt tells the bench host's node while the run is still ours, and closes once its lease is released", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  refusedAttach(h);
  const failedBeforeStatus: boolean[] = [];
  const request = h.deps.request;
  h.deps.request = async (node, verb, params, opts) => {
    if (verb === BENCH_COORDINATOR_VERB && BenchCoordinatorRequest.safeParse(params).data?.operation === "status") failedBeforeStatus.push(h.runVerbs().some((c) => c.path.endsWith("/fail")));
    return request(node, verb, params, opts);
  };
  expect((await h.drive()).status).toBe("failed");
  // The agent's node refused, so the bench node's record still holds the lease: one status, before the
  // board's fail, has it ask the hub's decision (stale_owner), save a clean tree and release.
  const status = h.sent(BENCH_COORDINATOR_VERB, "status");
  expect(status).toHaveLength(1);
  expect(status[0]?.node).toBe(attempt.profile.target.node_id);
  expect(failedBeforeStatus).toEqual([false]);
  expect(h.runVerbs().filter((c) => c.path.endsWith("/fail"))).toHaveLength(1);
  expect(latestOf(h).row.phase).toBe("failed");

  // A run the board ended before the failure was told takes no run verb, and the bench node is still told.
  const ended = harness((await remoteAttempt()).attempt);
  refusedAttach(ended);
  ended.state.runView = endedView(attempt);
  await ended.drive();
  expect(ended.runVerbs()).toEqual([]);
  expect(ended.sent(BENCH_COORDINATOR_VERB, "status")).toHaveLength(1);
  expect(latestOf(ended).row.phase).toBe("failed");
});

test("a failed remote attempt whose bench holds a dirty tree waits for an operator, said once, and closes when the lease is released", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  refusedAttach(h);
  h.state.statusReply = HELD_DIRTY;
  const parks = captureParks();
  try {
  await h.drive();
  // The board has the failure, but the attempt stays failure_pending (its station held), named for the operator.
  expect(h.runVerbs().filter((c) => c.path.endsWith("/fail"))).toHaveLength(1);
  expect(latestOf(h).row.phase).toBe("failure_pending");
  expect(parks.last()).toBe("remote.held_dirty");
  const said = heldActivities(h);
  expect(said).toHaveLength(1);
  for (const step of ["stop_admin", "renew_admin", "bench workspace run", "bench workspace release"]) expect(JSON.stringify(said[0]?.body)).toContain(step);
  // Later passes (the run is over now) ask the bench node again; while it is held nothing closes and nothing more is said.
  h.state.runView = endedView(attempt);
  h.state.now = T0 + 24 * 3_600_000; // far past any bound: a held bench is never timed out
  expect((await h.drive()).status).toBe("unreported");
  expect(parks.last()).toBe("remote.held_dirty");
  expect(latestOf(h).row.phase).toBe("failure_pending");
  expect(heldActivities(h)).toHaveLength(1);
  expect(h.runVerbs().filter((c) => c.path.endsWith("/fail"))).toHaveLength(1);
  // An operator released the lease: the node's record is terminal, and the failure closes as normal.
  h.state.statusReply = { state: "refused", code: "stale_owner" };
  expect((await h.drive()).status).toBe("failed");
  expect(latestOf(h).row.phase).toBe("failed");
  expect(h.sent(BENCH_COORDINATOR_VERB, "status")).toHaveLength(3);
  } finally { parks.restore(); }
});

test("a failed remote attempt whose bench node does not answer waits, within the bound, before its failure closes", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  refusedAttach(h);
  // The bench host's node is unreachable for now: nothing proves its lease released.
  h.state.statusReply = { state: "refused", code: "unavailable" };
  const parks = captureParks();
  try {
    expect((await h.drive()).status).toBe("unreported");
    expect(parks.last()).toBe("remote.release.refused");
    expect(latestOf(h).row.phase).toBe("failure_pending");
    expect(h.runVerbs().filter((c) => c.path.endsWith("/fail"))).toHaveLength(1);
    // The run is over now; inside the task's timeout plus the grace period, it still waits.
    h.state.runView = endedView(attempt);
    h.state.now = T0 + 30 * 60_000;
    expect((await h.drive()).status).toBe("unreported");
    expect(latestOf(h).row.phase).toBe("failure_pending");
    // Past the bound, a node that never answered stops holding the station: the failure closes.
    h.state.now = T0 + 3 * 3_600_000;
    expect((await h.drive()).status).toBe("failed");
    expect(latestOf(h).row.phase).toBe("failed");
    expect(heldActivities(h)).toEqual([]);
  } finally { parks.restore(); }
});

test("a held release that is not a dirty tree waits as remote.lease_held", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  refusedAttach(h);
  h.state.statusReply = { state: "pending", detail: { lease: "held", message: "workspace HEAD vector differs from its complete checkpoint" } };
  const parks = captureParks();
  try {
    await h.drive();
    expect(parks.last()).toBe("remote.lease_held");
    expect(latestOf(h).row.phase).toBe("failure_pending");
    expect(heldActivities(h)).toHaveLength(1);
    h.state.runView = endedView(attempt);
    h.state.now = T0 + 24 * 3_600_000; // a held lease is never timed out
    await h.drive();
    expect(parks.last()).toBe("remote.lease_held");
    expect(latestOf(h).row.phase).toBe("failure_pending");
  } finally { parks.restore(); }
});

test("a remote run the board ended with a dirty bench is held for an operator, never timed out, and retired once released", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  await h.drive();
  await h.turn().end("error", {});
  h.state.now = T0 + 16 * 60_000;
  h.state.runView = endedView(attempt);
  h.state.statusReply = HELD_DIRTY;
  const parks = captureParks();
  try {
  expect((await h.drive()).status).toBe("unreported");
  expect(parks.last()).toBe("remote.held_dirty");
  expect(heldActivities(h)).toHaveLength(1);
  expect(h.sent("bench.remote.detach")).toHaveLength(1);
  // Past the task's own timeout plus the grace period: still held, still the station's.
  h.state.now = T0 + 3 * 3_600_000;
  expect((await h.drive()).status).toBe("unreported");
  expect(parks.last()).toBe("remote.held_dirty");
  expect(h.state.retired).toEqual([]);
  expect(latestOf(h).row.phase).toBe("working");
  expect(heldActivities(h)).toHaveLength(1);
  h.state.statusReply = { state: "refused", code: "stale_owner" };
  expect((await h.drive()).status).toBe("released");
  expect(h.state.retired).toMatchObject([{ reason: "run_ended", by: "hub", phase: "working" }]);
  expect(h.runVerbs()).toEqual([]);
  } finally { parks.restore(); }
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
  await h.turn().end();
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
  const client: RemoteTurnClient = { context: async () => structuredClone(claimFixture.context), runRecord: async () => ({}), heartbeat: async () => ({}), activity: async () => ({}) };
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

/** A remote turn over a fake ACP port and board: the test speaks for the agent, and for whoever answers on the board. */
async function turnRig(agentOver: Partial<RemoteTurnDeps["agent"]> = {}, leaseDrift = 0) {
  const { attempt } = await remoteAttempt("working");
  const prompts: string[] = [];
  const answers: Array<{ seq: number; optionId: string }> = [];
  const posted: Array<Record<string, unknown>> = [];
  const elicitations: RunElicitation[] = [];
  let listener: ((event: AcpEvent) => void) | undefined;
  let seq = 0;
  const emit = (type: AcpEvent["type"], payload: unknown) => {
    listener?.({ sessionId: "acps_t", seq: ++seq, type, payload, createdAt: new Date().toISOString() });
    return seq;
  };
  const acp: AcpPort = { ...idleAcp, createSession: async () => ({ id: "acps_t", libraryTools: false }),
    promptSession: async (_user, _session, text) => { prompts.push(text); },
    subscribe: (_id, fn) => { listener = fn; return () => { listener = undefined; }; },
    endSession: async () => {}, answerPermission: async (_user, _session, requestSeq, optionId) => { answers.push({ seq: requestSeq, optionId }); } };
  const client: RemoteTurnClient = {
    // As the board does: while a question is open its run is waiting, not working, and the checkpoint context check refuses it.
    context: async () => {
      if (elicitations.some((e) => e.status === "pending")) throw new Error("Checkpoint claim refused: context");
      return { ...structuredClone(claimFixture.context), elicitations: structuredClone(elicitations) };
    },
    runRecord: async () => ({ ...structuredClone(claimFixture.context), run: { ...claimFixture.context.run, runId: attempt.claim.runId,
      leaseEpoch: attempt.claim.leaseEpoch + leaseDrift, status: elicitations.some((e) => e.status === "pending") ? "input-required" : "working" },
    card: { ...claimFixture.context.card, currentRunId: attempt.claim.runId }, elicitations: structuredClone(elicitations) }),
    heartbeat: async () => ({}),
    activity: async (_lease, activity) => {
      posted.push(asRecord(activity));
      if (activity.type === "elicitation") elicitations.push({ id: `elc_${elicitations.length + 1}`, question: "q", status: "pending", answer: null,
        createdAt: new Date().toISOString() });
      return {};
    },
  };
  const agent = { key: "fixture", boardId: "brd_ABC123", token: "spa_x", stationId: attempt.profile.target.station_id,
    hubUserId: "usr_x", mode: "ask" as const, ...agentOver };
  const turn = await startRemoteTurn({ acp, agent, tenantId: attempt.row.tenantId, client, permissionPollMs: 1 }, attempt, "/bounded/benches/card-1");
  let ended: RemoteTurnEnd | undefined;
  void (async () => { ended = await turn.done; })();
  return { turn, emit, prompts, answers, posted, elicitations, ended: async () => { await tick(); return ended; } };
}
const toolCall = (toolCallId: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ sessionUpdate: status === "pending" ? "tool_call" : "tool_call_update", toolCallId, status, ...extra });

test("an idle with a tool call still in flight does not end the remote turn; the agent is told to continue once it settles", async () => {
  const rig = await turnRig();
  rig.emit("agent-update", toolCall("call_1", "pending"));
  rig.emit("state", { status: "idle" });
  expect(await rig.ended()).toBeUndefined();
  rig.emit("agent-update", toolCall("call_1", "completed"));
  await tick();
  expect(rig.prompts.at(-1)).toBe(OWN_WORK_FINISHED_PROMPT);
  expect(await rig.ended()).toBeUndefined();
  rig.emit("state", { status: "idle" });
  expect((await rig.ended())?.stopReason).toBe("end_turn");
});

test("detached work holds the remote turn open until its wake goes quiet", async () => {
  const rig = await turnRig({ ownWorkQuietMs: 5, ownWorkTimeoutMs: 60_000 });
  rig.emit("agent-update", toolCall("call_bg", "pending"));
  rig.emit("agent-update", toolCall("call_bg", "completed", { rawOutput: { notify_on_complete: true, session_id: "proc_7" } }));
  rig.emit("state", { status: "idle" });
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  expect(await rig.ended()).toBeUndefined();
  // The detached process finished: Hermes wakes with a new message, then goes quiet.
  rig.emit("agent-update", { sessionUpdate: "agent_message_chunk", messageId: "msg_wake", content: { type: "text", text: "Tests pass." } });
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  expect((await rig.ended())?.stopReason).toBe("end_turn");
});

test("a permission request the roster's mode leaves open is asked on the board and its answer delivered", async () => {
  const rig = await turnRig({ permissionWaitMs: 60_000 });
  const options = [{ optionId: "allow_once", name: "Yes", kind: "allow_once" }, { optionId: "reject_once", name: "No", kind: "reject_once" }];
  // A request the hub answered itself under the mode is not a question.
  rig.emit("permission-request", { toolCall: { title: "Edit", kind: "edit" }, options, auto: true });
  await tick();
  expect(rig.posted).toEqual([]);
  const seq = rig.emit("permission-request", { toolCall: { title: "Run `make test`", kind: "execute" }, options });
  for (let i = 0; i < 20 && rig.elicitations.length === 0; i++) await tick();
  expect(rig.posted.some((a) => a.type === "elicitation")).toBe(true);
  const question = rig.elicitations[0];
  if (!question) throw new Error("no question asked");
  question.status = "answered"; question.answer = { option: "allow_once", answeredBy: "usr_board", answeredAt: new Date().toISOString() };
  for (let i = 0; i < 50 && rig.answers.length === 0; i++) await new Promise((resolve) => { setTimeout(resolve, 2); });
  expect(rig.answers).toEqual([{ seq, optionId: "allow_once" }]);
  expect(await rig.ended()).toBeUndefined();
});

test("a question the board shows the run waiting on is read from the run view, and its later answer delivered", async () => {
  const rig = await turnRig({ permissionWaitMs: 60_000 });
  const options = [{ optionId: "allow_once", name: "Yes", kind: "allow_once" }, { optionId: "reject_once", name: "No", kind: "reject_once" }];
  const seq = rig.emit("permission-request", { toolCall: { title: "Edit docs/question-check.md", kind: "edit" }, options });
  for (let i = 0; i < 20 && rig.elicitations.length === 0; i++) await tick();
  // Several polls while it is open: the run is waiting on it, and the checkpoint context check would refuse.
  await new Promise((resolve) => { setTimeout(resolve, 25); });
  expect(await rig.ended()).toBeUndefined();
  const question = rig.elicitations[0];
  if (!question) throw new Error("no question asked");
  question.status = "answered"; question.answer = { option: "allow_once", answeredBy: "usr_board", answeredAt: new Date().toISOString() };
  for (let i = 0; i < 50 && rig.answers.length === 0; i++) await new Promise((resolve) => { setTimeout(resolve, 2); });
  expect(rig.answers).toEqual([{ seq, optionId: "allow_once" }]);
  expect(await rig.ended()).toBeUndefined();
});

test("an answer on a run view of another lease is never delivered", async () => {
  const rig = await turnRig({ permissionWaitMs: 60_000 }, 1);
  rig.emit("permission-request", { toolCall: { title: "Edit docs/x.md", kind: "edit" },
    options: [{ optionId: "allow_once", name: "Yes", kind: "allow_once" }] });
  for (let i = 0; i < 20 && rig.elicitations.length === 0; i++) await tick();
  const question = rig.elicitations[0];
  if (!question) throw new Error("no question asked");
  question.status = "answered"; question.answer = { option: "allow_once", answeredBy: "usr_board", answeredAt: new Date().toISOString() };
  for (let i = 0; i < 50 && !(await rig.ended()); i++) await new Promise((resolve) => { setTimeout(resolve, 2); });
  expect((await rig.ended())?.stopReason).toBe("unanswered");
  expect(rig.answers).toEqual([]);
});

test("a question nobody answers in time ends the remote turn unanswered", async () => {
  const rig = await turnRig({ permissionWaitMs: 5 });
  rig.emit("permission-request", { toolCall: { title: "Run `rm -rf build`", kind: "execute" },
    options: [{ optionId: "allow_once", name: "Yes", kind: "allow_once" }] });
  for (let i = 0; i < 50 && !(await rig.ended()); i++) await new Promise((resolve) => { setTimeout(resolve, 2); });
  expect((await rig.ended())?.stopReason).toBe("unanswered");
  expect(rig.turn.alive()).toBe(false);
  expect(rig.answers).toEqual([]);
});

test("a remote turn whose card cannot be read ends the session it opened", async () => {
  const { attempt } = await remoteAttempt("working");
  const ended: string[] = [];
  const acp: AcpPort = { ...idleAcp, createSession: async () => ({ id: "acps_lost", libraryTools: false }),
    endSession: async (_user, session) => { ended.push(session); } };
  const client: RemoteTurnClient = { context: async () => { throw new Error("board unreachable"); }, runRecord: async () => ({}), heartbeat: async () => ({}),
    activity: async () => ({}) };
  const agent = { key: "fixture", boardId: "brd_ABC123", token: "spa_x", stationId: attempt.profile.target.station_id,
    hubUserId: "usr_x", mode: "full-auto" as const };
  await expect(startRemoteTurn({ acp, agent, tenantId: attempt.row.tenantId, client }, attempt, "/bounded/benches/card-1"))
    .rejects.toThrow("board unreachable");
  expect(ended).toEqual(["acps_lost"]);
});

// ─── lost agents, run ends, restarts, supersede and the detach sweep ────────────────────────────

/** The board's run view once the run ended: reclaimed after its heartbeat lapsed, or blocked through the board tools. */
const endedView = (attempt: RetainedCheckpointAttempt, status = "reclaimed") => ({
  run: { runId: attempt.claim.runId, cardId: attempt.claim.cardId, leaseEpoch: attempt.claim.leaseEpoch, status, outcome: null,
    endedAt: "2026-11-25T12:20:00Z" },
  card: { id: attempt.claim.cardId, currentRunId: null } });

test("a lost turn stops the heartbeat and leaves the run to be reclaimed", async () => {
  // The turn ended without the agent ending it (an error, a lost session, a cancel, an unanswered question).
  for (const lost of ["error", "ended", "cancelled", "unanswered"] as const) {
    resetRemoteTurnsForTests(); resetCheckpointActivityForTests();
    const { attempt } = await remoteAttempt();
    const h = harness(attempt);
    await h.drive();
    const beats = h.heartbeats();
    await h.turn().end(lost, {});
    for (let pass = 1; pass <= 3; pass++) {
      h.state.now = T0 + pass * 2 * REMOTE_HEARTBEAT_MS;
      expect((await h.drive())).toMatchObject({ status: "unreported" });
    }
    // Still working, never heartbeated again, and the hub said nothing of its own: SuperPipeline reclaims the run.
    expect(latestOf(h).row.phase).toBe("working");
    expect(h.heartbeats()).toBe(beats);
    expect(h.runVerbs()).toEqual([]);
    expect(h.state.failure).toBeUndefined();
    expect(h.state.retired).toEqual([]);
  }
  // The agent's node gone offline: the turn looks alive, but its node no longer holds the attachment.
  resetRemoteTurnsForTests();
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  await h.drive();
  const beats = h.heartbeats();
  h.state.status = { state: "refused", code: "unavailable", message: "node offline" };
  for (let pass = 1; pass <= 3; pass++) { h.state.now = T0 + pass * 2 * REMOTE_HEARTBEAT_MS; await h.drive(); }
  expect(h.heartbeats()).toBe(beats);
  expect(h.runVerbs()).toEqual([]);
  expect(latestOf(h).row.phase).toBe("working");
});

test("a reclaimed run makes the bench node release and the agent's node detach", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  await h.drive();
  await h.turn().end("error", {});
  const lost = h.turn();
  // Fifteen minutes without a heartbeat: SuperPipeline reclaimed the run. The bench host's node is not sure yet.
  h.state.now = T0 + 16 * 60_000;
  h.state.runView = endedView(attempt);
  h.state.statusReply = { state: "refused", code: "unavailable" };
  expect((await h.drive()).status).toBe("unreported");
  // Told: the node's current check now answers stale_owner. Its session is ended and its station detached;
  // the attempt stays until the bench host's node says it stopped and released.
  const told = h.calls.findIndex((c) => c.verb === BENCH_COORDINATOR_VERB && c.params.operation === "status");
  const detached = h.calls.findIndex((c) => c.verb === "bench.remote.detach");
  expect(told).toBeGreaterThan(-1);
  expect(detached).toBeGreaterThan(told);
  expect(h.calls[told]?.node).toBe(attempt.profile.target.node_id);
  expect(h.calls[detached]?.node).toBe(AGENT_NODE);
  expect(lost.state.cancelled).toBe(true);
  expect(parseRemoteState(latestOf(h).row.remote)).toMatchObject({ detached: true });
  expect(h.state.retired).toEqual([]);
  // A pass on which the board does not answer: the detached attempt is not resumed (no turn is in this process).
  h.state.runView = undefined;
  expect((await h.drive()).recheckMs).toBeUndefined();
  expect(h.state.starts).toHaveLength(1);
  h.state.runView = endedView(attempt);
  // Next pass: the node stopped the lease (cutting every session), released it and retired its record.
  h.state.statusReply = { state: "refused", code: "stale_owner" };
  expect((await h.drive()).status).toBe("released");
  expect(h.state.retired).toMatchObject([{ reason: "run_ended", by: "hub", phase: "working" }]);
  expect(String(h.state.retired[0]?.evidence)).toContain("stale_owner");
  // Detached once; the hub never failed or released the run itself.
  expect(h.sent("bench.remote.detach")).toHaveLength(1);
  expect(h.runVerbs()).toEqual([]);
  expect(h.state.failure).toBeUndefined();
});

test("a hub restart in working resumes the turn once, then stops heartbeating", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  await h.drive();
  expect(parseRemoteState(latestOf(h).row.remote)).toMatchObject({ resumed: false });
  // The restart: this process holds no turn. A permission wait is lost the same way (it is not in the dispatch ledger).
  resetRemoteTurnsForTests();
  h.state.now = T0 + 10 * 60_000;
  expect(await h.drive()).toMatchObject({ status: "unreported", recheckMs: 5_000 });
  expect(REMOTE_RESUME_PROMPT).toBe("Your previous turn was interrupted; the workspace still holds your work. Continue.");
  expect(h.state.starts).toHaveLength(2);
  expect(h.state.starts[1]).toEqual({ cwd: String(CREDENTIAL.working_directory), opening: `${REMOTE_TURN_PREFACE}\n\n${REMOTE_RESUME_PROMPT}` });
  // The station's sessions were confirmed closed first, so two agents never work in one bench.
  expect(h.state.stationCloses).toBe(1);
  expect(parseRemoteState(latestOf(h).row.remote)).toMatchObject({ resumed: true });
  // The resumed turn is heartbeated as any.
  const beats = h.heartbeats();
  h.state.now += REMOTE_HEARTBEAT_MS;
  await h.drive();
  expect(h.heartbeats()).toBe(beats + 1);
  // A second restart: it was resumed once. Nothing opens and nothing is heartbeated; the board reclaims the run.
  resetRemoteTurnsForTests();
  for (let pass = 1; pass <= 3; pass++) {
    h.state.now += REMOTE_HEARTBEAT_MS;
    expect((await h.drive()).recheckMs).toBeUndefined();
  }
  expect(h.state.starts).toHaveLength(2);
  expect(h.heartbeats()).toBe(beats + 1);
  expect(h.runVerbs()).toEqual([]);
  expect(latestOf(h).row.phase).toBe("working");
});

test("a hub restart resumes only while the station is online and the stage's time limit has time left", async () => {
  const { attempt } = await remoteAttempt();
  const offline = harness(attempt);
  await offline.drive();
  resetRemoteTurnsForTests();
  offline.state.stationReady = false;
  offline.state.now = T0 + 60_000;
  expect((await offline.drive()).recheckMs).toBeUndefined();
  expect(offline.state.starts).toHaveLength(1);
  expect(parseRemoteState(latestOf(offline).row.remote)).toMatchObject({ resumed: false });
  // Back online, still within the bound: resumed then, and the resumed turn keeps the first turn's bound.
  offline.state.stationReady = true;
  offline.state.now = T0 + 50 * 60_000;
  await offline.drive();
  expect(offline.state.starts).toHaveLength(2);
  offline.state.now = T0 + 3600_000;
  expect((await offline.drive()).recheckMs).toBeUndefined();
  expect(offline.turn().state.cancelled).toBe(true);

  // A resume whose session cannot open is still the one resume: written before the open.
  resetRemoteTurnsForTests();
  const failing = harness((await remoteAttempt()).attempt);
  await failing.drive();
  resetRemoteTurnsForTests();
  const start = failing.deps.remote?.start;
  if (!failing.deps.remote || !start) throw new Error("no start seam");
  failing.deps.remote.start = async () => { throw new Error("session refused"); };
  failing.state.now = T0 + 60_000;
  expect((await failing.drive()).recheckMs).toBeUndefined();
  failing.deps.remote.start = start;
  await failing.drive();
  expect(failing.state.starts).toHaveLength(1);
  expect(parseRemoteState(latestOf(failing).row.remote)).toMatchObject({ resumed: true });

  // The bound counts from the first turn's start, retained: a restart gets no fresh one.
  resetRemoteTurnsForTests();
  const spent = harness((await remoteAttempt()).attempt);
  await spent.drive();
  resetRemoteTurnsForTests();
  spent.state.now = T0 + 3600_000;
  expect((await spent.drive()).recheckMs).toBeUndefined();
  expect(spent.state.starts).toHaveLength(1);
  expect(parseRemoteState(latestOf(spent).row.remote)).toMatchObject({ resumed: false });
  expect(spent.heartbeats()).toBe(1);

  // A run the board already ended opens no session either: the drive ends it instead.
  resetRemoteTurnsForTests();
  const ended = harness((await remoteAttempt()).attempt);
  await ended.drive();
  resetRemoteTurnsForTests();
  ended.state.now = T0 + 60_000;
  ended.state.runView = endedView(attempt);
  expect((await ended.drive()).status).toBe("released");
  expect(ended.state.starts).toHaveLength(1);
  expect(ended.state.retired).toMatchObject([{ reason: "run_ended" }]);
  // No turn in this process: the station's sessions are ended.
  expect(ended.state.stationCloses).toBeGreaterThanOrEqual(1);
});

test("a run blocked through board tools ends without a checkpoint and detaches", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  await h.drive();
  // The agent blocked the card with the board tools, then ended its turn.
  h.state.runView = endedView(attempt, "blocked");
  await h.turn().end("end_turn", { summary: "Blocked: the spec is ambiguous." });
  const result = await h.drive();
  // No finish: nothing is checkpointed. The run end path tells the node, detaches and retires.
  expect(h.sent(BENCH_COORDINATOR_VERB, "finish")).toHaveLength(0);
  expect(h.state.phases).not.toContain("finish_pending");
  expect(h.sent(BENCH_COORDINATOR_VERB, "status")).toHaveLength(1);
  expect(h.sent("bench.remote.detach")).toHaveLength(1);
  expect(h.state.retired).toMatchObject([{ reason: "run_ended", phase: "working" }]);
  expect(result.status).toBe("released");
  expect(h.runVerbs()).toEqual([]);
});

test("superseded remote attempt detaches", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  await h.drive();
  const working = h.turn();
  const resolution = await resolveSupersededAttempt(latestOf(h), {
    status: async () => ({ state: "refused", code: "stale_owner" }),
    retire: async () => { throw new Error("an attempt past admission is never retired as superseded"); },
    detach: (a) => endRemoteWork(a, h.deps, "The bench stage's profile was replaced.") });
  // Still parked for an owner or admin (an effect is possible), but the agent stopped and its station is detached.
  expect(resolution).toEqual({ outcome: "parked", reason: "superseded.effect_possible" });
  expect(working.state.cancelled).toBe(true);
  expect(h.sent("bench.remote.detach")).toHaveLength(1);
  expect(h.sent("bench.remote.detach")[0]?.params).toEqual({ stationId: attempt.profile.target.station_id, attemptId: attempt.row.attemptId });
  expect(parseRemoteState(latestOf(h).row.remote)).toMatchObject({ detached: true });
  // A detach the agent's node does not answer is named and left to the sweep; the resolution is the same.
  resetRemoteTurnsForTests();
  const again = harness(attempt);
  await again.drive();
  again.state.agentDetach = () => ({ ok: false, error: "node offline" });
  expect(await resolveSupersededAttempt(latestOf(again), { status: async () => ({ state: "unknown" }), retire: async () => false,
    detach: (a) => endRemoteWork(a, again.deps, "replaced") })).toEqual({ outcome: "parked", reason: "superseded.effect_possible" });
  expect(parseRemoteState(latestOf(again).row.remote)).toMatchObject({ detached: false });
  // Even a detach that throws leaves the resolution as it was.
  expect(await resolveSupersededAttempt(latestOf(again), { status: async () => ({ state: "unknown" }), retire: async () => false,
    detach: async () => { throw new Error("state unreadable"); } })).toEqual({ outcome: "parked", reason: "superseded.effect_possible" });
});

test("detach sweep retries until the agent's node answers", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  await h.drive();
  const state = parseRemoteState(latestOf(h).row.remote);
  if (!state) throw new Error("no remote state");
  let n = 0;
  const row = (phase: string, remote: Record<string, unknown>, one = attempt): RetainedCheckpointAttempt =>
    ({ ...one, row: { ...one.row, attemptId: `attempt-sweep-${++n}`, phase, remote: canonicalCheckpoint({ ...state, ...remote }) } });
  const rows = [
    row("retired", { detached: false }),
    // An attach whose reply was lost, then the attempt failed: it may still be attached.
    row("failed", { attached: false, agentAttachSent: true, detached: false }),
    // Never sent, already detached, or still in progress (it detaches on its own way out): left alone.
    row("failed", { attached: false, agentAttachSent: false, detached: false }),
    row("reported", { detached: true }),
    row("working", { detached: false }),
  ];
  const asked: string[] = [];
  const recorded: Array<{ attemptId: string; remote: string }> = [];
  let answer: { ok: boolean; data?: unknown; error?: string } = { ok: false, error: "node offline" };
  const deps = { attempts: async () => rows.filter((r) => !recorded.some((x) => x.attemptId === r.row.attemptId)),
    request: async (node: string, verb: string, params: unknown) => {
      asked.push(`${node}:${verb}:${String(asRecord(params).attemptId)}`);
      return answer;
    },
    record: async (a: RetainedCheckpointAttempt, remote: string) => { recorded.push({ attemptId: a.row.attemptId, remote }); return true; } };
  // The agent's node is offline, then busy: nothing is recorded, the stations stay busy.
  expect(await sweepRemoteDetach(deps)).toBe(0);
  answer = { ok: true, data: { state: "refused", code: "unavailable", message: "busy" } };
  expect(await sweepRemoteDetach(deps)).toBe(0);
  expect(recorded).toEqual([]);
  expect(asked).toEqual([1, 2, 1, 2].map((i) => `${AGENT_NODE}:bench.remote.detach:attempt-sweep-${i}`));
  // It answers: both are recorded detached, and the next sweep asks nothing.
  answer = { ok: true, data: { state: "detached" } };
  expect(await sweepRemoteDetach(deps)).toBe(2);
  expect(recorded.map((r) => [r.attemptId, parseRemoteState(r.remote)?.detached])).toEqual([["attempt-sweep-1", true], ["attempt-sweep-2", true]]);
  asked.length = 0;
  expect(await sweepRemoteDetach(deps)).toBe(0);
  expect(asked).toEqual([]);
  // A ledger that cannot be read never throws.
  expect(await sweepRemoteDetach({ ...deps, attempts: async () => { throw new Error("db down"); } })).toBe(0);
});

test("after a hub restart a dirty retry keeps the stage's one time limit, and opens no session once it is spent", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  h.state.finishReplies.push(reply("finish-refused-dirty"));
  await h.drive();
  // The re-attach after the dirty finish cannot reach the agent's node: the retry is still owed.
  h.state.agentAttach = () => ({ ok: false, error: "request timed out" });
  await h.turn().end();
  await h.drive();
  expect(parseRemoteState(latestOf(h).row.remote)?.retryPrompt).toContain(REMOTE_DIRTY_PROMPT);
  const attaches = h.sent(BENCH_COORDINATOR_VERB, "attach").length;
  // The hub restarts after the stage's bound ran out, counted from the first turn's start.
  resetRemoteTurnsForTests();
  h.state.agentAttach = undefined;
  h.state.now = T0 + 3600_000;
  expect((await h.drive()).recheckMs).toBeUndefined();
  expect(h.sent(BENCH_COORDINATOR_VERB, "attach")).toHaveLength(attaches);
  expect(h.state.starts).toHaveLength(1);
});

test("a re-attach that keeps failing waits before it is tried again", async () => {
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  h.state.finishReplies.push(reply("finish-refused-dirty"));
  await h.drive();
  h.state.agentAttach = () => ({ ok: false, error: "request timed out" });
  await h.turn().end();
  await h.drive();
  const attaches = h.sent(BENCH_COORDINATOR_VERB, "attach").length;
  // Passes come every few seconds: none asks either node again until the wait is over.
  for (let pass = 1; pass <= 3; pass++) {
    h.state.now = T0 + pass * 5_000;
    await h.drive();
  }
  expect(h.sent(BENCH_COORDINATOR_VERB, "attach")).toHaveLength(attaches);
  expect(h.state.starts).toHaveLength(1);
  // The wait is over and the agent's node answers: attached again, in a fresh session.
  h.state.agentAttach = undefined;
  h.state.now = T0 + REMOTE_REATTACH_RETRY_MS + 1_000;
  expect(await h.drive()).toMatchObject({ recheckMs: 5_000 });
  expect(h.sent(BENCH_COORDINATOR_VERB, "attach")).toHaveLength(attaches + 1);
  expect(h.state.starts).toHaveLength(2);
  expect(parseRemoteState(latestOf(h).row.remote)?.retryPrompt).toBeUndefined();
});

test("a hub restart opens no session until the station's sessions are confirmed closed", async () => {
  // The interrupted agent process may still run on its node: a close nobody confirmed opens nothing.
  const { attempt } = await remoteAttempt();
  const h = harness(attempt);
  await h.drive();
  resetRemoteTurnsForTests();
  h.state.closeConfirmed = false;
  h.state.now = T0 + 60_000;
  for (let pass = 0; pass < 2; pass++) expect((await h.drive()).recheckMs).toBeUndefined();
  expect(h.state.starts).toHaveLength(1);
  expect(parseRemoteState(latestOf(h).row.remote)).toMatchObject({ resumed: false });
  expect(h.heartbeats()).toBe(1);
  // A port that cannot confirm closes at all opens nothing either.
  const acp = h.deps.remote?.turn.acp;
  if (!acp) throw new Error("no acp seam");
  const confirm = acp.closeStationSessions?.bind(acp);
  const without: typeof acp = { ...acp };
  delete without.closeStationSessions;
  if (h.deps.remote) h.deps.remote.turn.acp = without;
  h.state.closeConfirmed = true;
  await h.drive();
  expect(h.state.starts).toHaveLength(1);
  // Confirmed: resumed then.
  if (h.deps.remote && confirm) h.deps.remote.turn.acp = { ...without, closeStationSessions: confirm };
  await h.drive();
  expect(h.state.starts).toHaveLength(2);

  // The same for a dirty tree's re-attach after a restart.
  resetRemoteTurnsForTests();
  const dirty = harness((await remoteAttempt()).attempt);
  dirty.state.finishReplies.push(reply("finish-refused-dirty"));
  await dirty.drive();
  dirty.state.agentAttach = () => ({ ok: false, error: "request timed out" });
  await dirty.turn().end();
  await dirty.drive();
  resetRemoteTurnsForTests();
  dirty.state.agentAttach = undefined;
  dirty.state.closeConfirmed = false;
  dirty.state.now = T0 + 60_000;
  const attaches = dirty.sent(BENCH_COORDINATOR_VERB, "attach").length;
  expect((await dirty.drive()).recheckMs).toBeUndefined();
  expect(dirty.sent(BENCH_COORDINATOR_VERB, "attach")).toHaveLength(attaches);
  expect(dirty.state.starts).toHaveLength(1);
  dirty.state.closeConfirmed = true;
  dirty.state.now += REMOTE_REATTACH_RETRY_MS;
  await dirty.drive();
  expect(dirty.state.starts).toHaveLength(2);
});

test("a hub restart attaches the station again before it resumes, when its node no longer holds the attachment or the certificate is ending", async () => {
  // The agent's node detached the station meanwhile (its certificate lapsed during the downtime).
  const { attempt } = await remoteAttempt();
  const gone = harness(attempt);
  await gone.drive();
  resetRemoteTurnsForTests();
  gone.state.status = {};
  gone.state.now = T0 + 10 * 60_000;
  gone.state.certificateValidBefore = iso(T0 + 40 * 60_000);
  const startsAtAttach: number[] = [];
  gone.state.agentAttach = (params) => {
    startsAtAttach.push(gone.state.starts.length);
    return { ok: true, data: { state: "attached", validBefore: validBeforeOf(params.credential) } };
  };
  expect(await gone.drive()).toMatchObject({ recheckMs: 5_000 });
  // Certified again and attached on the agent's node before the session opened.
  expect(gone.sent(BENCH_COORDINATOR_VERB, "attach")).toHaveLength(2);
  expect(startsAtAttach).toEqual([1]);
  expect(gone.state.starts).toHaveLength(2);
  expect(parseRemoteState(latestOf(gone).row.remote)).toMatchObject({ resumed: true, validBefore: iso(T0 + 40 * 60_000) });

  // Still attached, but inside the renewal window: renewed first.
  resetRemoteTurnsForTests();
  const ending = harness((await remoteAttempt()).attempt);
  await ending.drive();
  resetRemoteTurnsForTests();
  ending.state.now = T0 + 25 * 60_000;
  await ending.drive();
  expect(ending.sent(BENCH_COORDINATOR_VERB, "attach")).toHaveLength(2);
  expect(ending.state.starts).toHaveLength(2);

  // The agent's node cannot be reached: nothing opens, and the resume is still owed.
  resetRemoteTurnsForTests();
  const unreachable = harness((await remoteAttempt()).attempt);
  await unreachable.drive();
  resetRemoteTurnsForTests();
  unreachable.state.status = {};
  unreachable.state.agentAttach = () => ({ ok: false, error: "request timed out" });
  unreachable.state.now = T0 + 60_000;
  expect((await unreachable.drive()).recheckMs).toBeUndefined();
  expect(unreachable.state.starts).toHaveLength(1);
  expect(parseRemoteState(latestOf(unreachable).row.remote)).toMatchObject({ resumed: false });

  // It refuses outright: the run fails, after a detach, and nothing opens.
  unreachable.state.agentAttach = () => ({ ok: true, data: { state: "refused", code: "terminal_in_use", message: "busy" } });
  await unreachable.drive();
  expect(unreachable.state.failure).toMatchObject({ code: "terminal_in_use", phase: "working" });
  expect(unreachable.state.starts).toHaveLength(1);
});

test("a detached attempt is never attached, resumed or finished again, whatever its phase", async () => {
  for (const phase of ["attach_pending", "working", "finish_pending"]) {
    resetRemoteTurnsForTests();
    const { attempt } = await remoteAttempt();
    const h = harness(attempt);
    await h.drive();
    const state = parseRemoteState(latestOf(h).row.remote);
    if (!state) throw new Error("no remote state");
    resetRemoteTurnsForTests();
    h.state.latest = { ...latestOf(h), row: { ...latestOf(h).row, phase,
      remote: canonicalCheckpoint({ ...state, detached: true, ...(phase === "finish_pending" ? { finishRequest: "{}" } : {}) }) } };
    const calls = h.calls.length, beats = h.heartbeats();
    expect((await h.drive()).recheckMs).toBeUndefined();
    expect(h.calls.slice(calls).filter((c) => c.verb !== BENCH_COORDINATOR_VERB || c.params.operation !== "status")).toEqual([]);
    expect(h.heartbeats()).toBe(beats);
    expect(h.state.starts).toHaveLength(1);
  }
});
