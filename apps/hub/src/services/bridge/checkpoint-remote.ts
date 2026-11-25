/**
 * A remote bench stage's attempt, after its source is admitted (spec §4-§5, operator decisions 1, 2, 4):
 *
 * - `attach_pending`: the agent's node hands over the station's bench public key
 *   (`bench.identity.ensure`); the bench host's node asks SuperBench for a writer certificate for it
 *   (`attach`); the agent's node points the station's terminal at the bench (`bench.remote.attach`).
 * - `working`: one ACP turn on the station, in a session opened after the attach, whose cwd is the
 *   bench's workspace root. Each pass renews the certificate once less than ten minutes remain, and
 *   heartbeats the run at most once a minute, only while the agent is alive and its node still
 *   holds this attempt's attachment. The end of the agent's turn is "done".
 * - `finish_pending`: the bench host's node checkpoints, stops and releases (`finish`). A tree with
 *   uncommitted or untracked files is refused `dirty`: the agent is told, in the same session, twice
 *   at most, then the run fails. A completion goes to `completed` exactly as a one-shot run's does;
 *   the station is detached, and the settlement is today's.
 *
 * The Hub never holds a lease token or a private key, and keeps no certificate: only the key's
 * fingerprint and where the bench is (checkpoint-remote-state.ts). While any attempt on a station is
 * in one of these phases the station takes no other board work (`stationBenchBusy`).
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { BenchCoordinatorRequest, type BenchCoordinatorResponse } from "@agentpod/contract";
import { db } from "../../db/drizzle";
import { checkpointDispatches } from "../../db/schema/checkpoint-dispatch";
import { stations } from "../../db/schema/stations";
import { canonicalCheckpoint, parseCheckpointJSON } from "./checkpoint-json";
import { CHECKPOINT_REMOTE_PHASES, updateCheckpointRemote, type advanceCheckpointAttempt, type failCheckpointAttempt,
  type RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { CheckpointRefused, isRemoteProfile, parseCheckpointProfile, type CheckpointProfile } from "./checkpoint-profile";
import { retainedCheckpointSource } from "./checkpoint-current-decision";
import { buildCheckpointSettlement } from "./checkpoint-report";
import { classifySettlementRefusal } from "./checkpoint-refusal";
import { noteCheckpoint, redact } from "./checkpoint-log";
import { agentAttachedTo, attachAgent, benchCall, detachAgent, ensureIdentity, type RemoteCallDeps } from "./checkpoint-remote-calls";
import { canonicalRemoteState, parseRemoteState, publicKeyFingerprint, type RemoteState } from "./checkpoint-remote-state";
import { startRemoteTurn, type RemoteTurn, type RemoteTurnDeps, type RemoteTurnEnd } from "./checkpoint-remote-turn";
import type { DispatchResult } from "./dispatch-types";
import type { SuperpipelineClient } from "./superpipeline";

export type { RemoteState } from "./checkpoint-remote-state";
export const REMOTE_PHASES = CHECKPOINT_REMOTE_PHASES;
/** Renew the agent's certificate once less than this much of it is left (decision 6; certificates last 30 minutes). */
export const REMOTE_RENEW_BEFORE_MS = 600_000;
/** How many times the agent is told to commit a dirty tree before the run fails. */
export const REMOTE_DIRTY_RETRIES = 2;
/** The most often a working attempt heartbeats its run. */
export const REMOTE_HEARTBEAT_MS = 60_000;
/** How soon a working attempt is driven again: each pass renews, heartbeats and reads the turn. */
export const REMOTE_RECHECK_MS = 5_000;
/** Said to the agent when the bench refused its finish over a dirty tree, before SuperBench's own words. */
export const REMOTE_DIRTY_PROMPT = "The workspace has uncommitted or untracked files. Commit or remove them, then end your turn.";

/** The Hub's pieces a remote phase uses beyond the drive's: the station's ACP port, and seams for tests. */
export interface RemoteSeams {
  turn: RemoteTurnDeps;
  start?: typeof startRemoteTurn;
  update?: typeof updateCheckpointRemote;
  /** The station's key on its node (`stations.station_key`). */
  stationKey?: (tenantId: string, stationId: string) => Promise<string>;
}
export interface RemoteDriveDeps extends RemoteCallDeps {
  advance: typeof advanceCheckpointAttempt;
  fail: typeof failCheckpointAttempt;
  now(): number;
  remote?: RemoteSeams;
}
/** One remote phase's pass: the attempt as it now stands, for the drive to go on with, or the pass's result. */
export type DriveStep = { attempt: RetainedCheckpointAttempt } | { result: DispatchResult };
type Executor = NonNullable<CheckpointProfile["executor"]>;

const encode = (raw: string) => new TextEncoder().encode(raw);
const hash = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");

/** The live turn of each working attempt in this process. A restart loses it (the attempt then parks). */
interface Live { turn: RemoteTurn; lastBeat: number; end?: RemoteTurnEnd }
const live = new Map<string, Live>();
const liveKey = (attempt: RetainedCheckpointAttempt) => `${attempt.row.tenantId}\0${attempt.row.attemptId}`;
function watch(entry: Live): void {
  const done = entry.turn.done;
  void (async () => {
    const end = await done;
    if (entry.turn.done === done) entry.end = end;
  })();
}
/** Test seam: forget every live turn. */
export function resetRemoteTurnsForTests(): void { live.clear(); }

const meta = (attempt: RetainedCheckpointAttempt) => ({ tenantId: attempt.row.tenantId, boardId: attempt.row.boardId,
  runId: attempt.claim.runId, attemptId: attempt.row.attemptId, phase: attempt.row.phase });
const running = (attempt: RetainedCheckpointAttempt): DispatchResult => ({ status: "unreported", externalRunId: attempt.claim.runId,
  attemptId: attempt.row.attemptId, reason: "Checkpoint dispatch requires reconciliation", recheckMs: REMOTE_RECHECK_MS });
const said = (message: string) => { const text = redact(message).replace(/\s+/g, " ").trim().slice(0, 200); return text ? `: "${text}"` : ""; };

function requireState(attempt: RetainedCheckpointAttempt): RemoteState {
  const state = parseRemoteState(attempt.row.remote);
  if (!state) throw new CheckpointRefused("source", "remote.state");
  return state;
}
function withoutFinish(state: RemoteState): RemoteState {
  const { finishRequest, ...rest } = state;
  return finishRequest === undefined ? state : rest;
}

async function stationKeyOf(tenantId: string, stationId: string): Promise<string> {
  const [row] = await db.select({ key: stations.stationKey }).from(stations).where(and(eq(stations.tenantId, tenantId), eq(stations.id, stationId)));
  if (!row) throw new CheckpointRefused("authority", "facts.row");
  return row.key;
}

const attachRequest = (attempt: RetainedCheckpointAttempt, binding: string, publicKey: string) => JSON.stringify(
  BenchCoordinatorRequest.parse({ version: attempt.request.version, operation: "attach", tenant_id: attempt.request.identity.tenant_id,
    board_id: attempt.request.identity.board_id, station_id: attempt.request.identity.station_id, identity: attempt.request.identity,
    target: attempt.request.target, binding_sha256: binding, public_key: publicKey }));
/** The report is an object of strings (the contract's handoff): any other value is sent as its JSON. */
const finishRequest = (attempt: RetainedCheckpointAttempt, binding: string, handoff: Record<string, unknown>) => JSON.stringify(
  BenchCoordinatorRequest.parse({ version: attempt.request.version, operation: "finish", tenant_id: attempt.request.identity.tenant_id,
    board_id: attempt.request.identity.board_id, station_id: attempt.request.identity.station_id, identity: attempt.request.identity,
    target: attempt.request.target, binding_sha256: binding, report: { outcome: "complete", handoff: Object.fromEntries(
      Object.entries(handoff).map(([field, value]) => [field, typeof value === "string" ? value : JSON.stringify(value) ?? ""])) } }));

/** A bench host's node refusal that is about the moment (its current check, an internal error): parked, never failed. */
const BENCH_PARKED: ReadonlySet<string> = new Set(["stale_owner", "unavailable", "pending"]);
const why = (response: BenchCoordinatorResponse) => response.state === "refused" && "code" in response ? `refused.${response.code}` : response.state;
type Refusal = { code: string; reason: string; evidence: string };

/**
 * The certificate for the station's own key, asked of the bench host's node and installed by the
 * agent's. Parks on anything that is not a definite refusal; returns a definite one for the run to fail.
 * `retain` stores the attach request's digest before it is sent, because the node's current check names it.
 */
async function certify(attempt: RetainedCheckpointAttempt, deps: RemoteDriveDeps, seams: RemoteSeams, executor: Executor, step: string,
  retain: (state: Pick<RemoteState, "publicKeyFingerprint" | "attachRequestSHA256">) => Promise<RetainedCheckpointAttempt>):
  Promise<{ attempt: RetainedCheckpointAttempt; validBefore: string; credential: { user: string; address: string; workingDirectory: string } } | Refusal> {
  const station = { stationId: executor.stationId, stationKey: await (seams.stationKey ?? stationKeyOf)(attempt.row.tenantId, executor.stationId) };
  const key = await ensureIdentity(executor.nodeId, station, deps);
  if ("refused" in key) {
    if (key.refused.code === "unavailable") throw new CheckpointRefused("uncertain", `remote.${step}.identity.unavailable`);
    return { code: key.refused.code, evidence: JSON.stringify(key.refused),
      reason: `Checkpoint failed: the agent's node has no bench identity for the station (${key.refused.code})${said(key.refused.message)}. Nothing ran.` };
  }
  const { prepared } = await retainedCheckpointSource(attempt);
  const request = attachRequest(attempt, prepared.binding_sha256, key.ok);
  const current = await retain({ publicKeyFingerprint: publicKeyFingerprint(key.ok), attachRequestSHA256: hash(request) });
  const response = await benchCall(current, request, deps);
  if (response.state !== "attached") {
    if (response.state !== "refused" || !("code" in response) || BENCH_PARKED.has(response.code))
      throw new CheckpointRefused("uncertain", `remote.${step}:${why(response)}`);
    const message = "detail" in response && response.detail?.message ? said(response.detail.message) : "";
    return { code: response.code, evidence: JSON.stringify(response),
      reason: `Checkpoint failed: the bench refused the agent's certificate (${response.code})${message}. Nothing was reported as a pass.` };
  }
  const c = response.credential;
  const agent = await attachAgent(executor.nodeId, { ...station, attemptId: attempt.row.attemptId, credential: c }, deps);
  if ("refused" in agent) {
    if (agent.refused.code === "unavailable") throw new CheckpointRefused("uncertain", `remote.${step}.agent.unavailable`);
    return { code: agent.refused.code, evidence: JSON.stringify(agent.refused),
      reason: `Checkpoint failed: the agent's node could not attach the station to the bench (${agent.refused.code})${said(agent.refused.message)}. Nothing was reported as a pass.` };
  }
  return { attempt: current, validBefore: agent.ok.validBefore, credential: { user: c.user, address: c.address, workingDirectory: c.working_directory } };
}

/**
 * End the attempt's remote work in this process: the turn's session is ended and the station detached,
 * the state recording it. A detach that fails or is refused is only named; the attempt goes on.
 */
async function endRemote(attempt: RetainedCheckpointAttempt, deps: RemoteDriveDeps, seams: RemoteSeams, executor: Executor,
  reason: string): Promise<RetainedCheckpointAttempt> {
  const entry = live.get(liveKey(attempt));
  live.delete(liveKey(attempt));
  if (entry) await entry.turn.cancel(reason);
  const state = parseRemoteState(attempt.row.remote);
  if (!state?.attached || state.detached) return attempt;
  try {
    const reply = await detachAgent(executor.nodeId, { stationId: executor.stationId, attemptId: attempt.row.attemptId }, deps);
    if ("refused" in reply) { noteCheckpoint("remote", `remote.detach.${reply.refused.code}`, meta(attempt)); return attempt; }
    return await (seams.update ?? updateCheckpointRemote)(attempt, canonicalRemoteState({ ...state, detached: true }));
  } catch (error) {
    noteCheckpoint("remote", "remote.detach", meta(attempt), error);
    return attempt;
  }
}

async function failRemote(attempt: RetainedCheckpointAttempt, refusal: Refusal, deps: RemoteDriveDeps, seams: RemoteSeams,
  executor: Executor): Promise<DriveStep> {
  const ended = await endRemote(attempt, deps, seams, executor, "The remote bench stage failed.");
  return { attempt: (await deps.fail(ended, { ...refusal, disposition: "failed" })).attempt };
}

async function attach(attempt: RetainedCheckpointAttempt, client: SuperpipelineClient, deps: RemoteDriveDeps, seams: RemoteSeams,
  executor: Executor): Promise<DriveStep> {
  await client.heartbeat(attempt.claim);
  const update = seams.update ?? updateCheckpointRemote;
  const prior = parseRemoteState(attempt.row.remote);
  const issued = await certify(attempt, deps, seams, executor, "attach", async (key) => {
    if (prior && prior.publicKeyFingerprint !== key.publicKeyFingerprint) throw new CheckpointRefused("stale", "remote.identity.changed");
    if (prior?.attachRequestSHA256 === key.attachRequestSHA256) return attempt;
    return update(attempt, canonicalRemoteState({ ...key, user: "", address: "", workingDirectory: "", validBefore: "",
      attached: false, detached: false, dirtyTries: 0, resumed: false }));
  });
  if ("code" in issued) return failRemote(attempt, issued, deps, seams, executor);
  const state = requireState(issued.attempt);
  const next = await deps.advance(issued.attempt, { phase: "working", remote: canonicalRemoteState({ ...state, ...issued.credential,
    validBefore: issued.validBefore, attached: true }) });
  // Opened only now: an open session keeps the terminal it started with, so it must start attached.
  if (next.send) {
    const turn = await (seams.start ?? startRemoteTurn)({ ...seams.turn, client }, next.attempt, issued.credential.workingDirectory);
    const entry: Live = { turn, lastBeat: deps.now() };
    live.set(liveKey(next.attempt), entry);
    watch(entry);
  }
  return { attempt: next.attempt };
}

async function renew(attempt: RetainedCheckpointAttempt, state: RemoteState, deps: RemoteDriveDeps, seams: RemoteSeams,
  executor: Executor): Promise<RetainedCheckpointAttempt> {
  const issued = await certify(attempt, deps, seams, executor, "renew", async (key) => {
    // The same key and the same bytes, or nothing is sent: a renewal never attaches a second key.
    if (key.publicKeyFingerprint !== state.publicKeyFingerprint || key.attachRequestSHA256 !== state.attachRequestSHA256)
      throw new CheckpointRefused("stale", "remote.identity.changed");
    return attempt;
  });
  if ("code" in issued) throw new CheckpointRefused("uncertain", `remote.renew:refused.${issued.code}`);
  return (seams.update ?? updateCheckpointRemote)(attempt, canonicalRemoteState({ ...state, validBefore: issued.validBefore }));
}

async function work(initial: RetainedCheckpointAttempt, client: SuperpipelineClient, deps: RemoteDriveDeps, seams: RemoteSeams,
  executor: Executor): Promise<DriveStep> {
  let attempt = initial;
  const entry = live.get(liveKey(attempt));
  // No turn here: the hub restarted while the agent worked. Nothing is heartbeated, so the board reclaims the run.
  if (!entry) throw new CheckpointRefused("uncertain", "remote.turn.absent");
  let state = requireState(attempt);
  const now = deps.now();
  if (Date.parse(state.validBefore) - now < REMOTE_RENEW_BEFORE_MS) {
    try { attempt = await renew(attempt, state, deps, seams, executor); state = requireState(attempt); }
    catch (error) { noteCheckpoint("remote", "remote.renew", meta(attempt), error); }
  }
  if (entry.end?.stopReason === "end_turn") {
    const { prepared } = await retainedCheckpointSource(attempt);
    const next = await deps.advance(attempt, { phase: "finish_pending", remote: canonicalRemoteState({ ...state,
      finishRequest: finishRequest(attempt, prepared.binding_sha256, entry.end.handoff) }) });
    return { attempt: next.attempt };
  }
  // The turn ended without the agent ending it: nothing more is heartbeated, and the board reclaims the run.
  if (entry.end) throw new CheckpointRefused("uncertain", `remote.turn.${entry.end.stopReason}`);
  // Only while the agent is alive and its node still holds this attempt's attachment.
  if (now - entry.lastBeat >= REMOTE_HEARTBEAT_MS && entry.turn.alive() &&
    await agentAttachedTo(executor.nodeId, executor.stationId, attempt.row.attemptId, deps)) {
    await client.heartbeat(attempt.claim);
    entry.lastBeat = now;
  }
  return { result: running(attempt) };
}

async function finish(attempt: RetainedCheckpointAttempt, client: SuperpipelineClient, deps: RemoteDriveDeps, seams: RemoteSeams,
  executor: Executor): Promise<DriveStep> {
  const state = requireState(attempt);
  if (!state.finishRequest) throw new CheckpointRefused("source", "remote.state");
  await client.heartbeat(attempt.claim);
  // Safe to repeat: a finish whose reply was lost answers its completion again.
  const response = await benchCall(attempt, state.finishRequest, deps);
  if (response.state === "completed") {
    // As for a one-shot run: a completion that can never become a pass fails the run rather than parking.
    try { await buildCheckpointSettlement(attempt, response.completion); }
    catch (error) {
      const ruling = classifySettlementRefusal(error, response.completion);
      if (!ruling) throw error;
      return failRemote(attempt, { code: ruling.code, reason: ruling.reason, evidence: JSON.stringify(response) }, deps, seams, executor);
    }
    const done = await deps.advance(attempt, { phase: "completed", completion: canonicalCheckpoint(response.completion) });
    if (!done.send) return { attempt: done.attempt };
    // A fresh session for whatever the station does next: the one that worked in the bench is ended.
    return { attempt: await endRemote(done.attempt, deps, seams, executor, "The remote bench stage is finished.") };
  }
  if (response.state === "refused" && "code" in response && response.code === "dirty") {
    const message = "detail" in response && response.detail?.message ? redact(response.detail.message) : "";
    if (state.dirtyTries >= REMOTE_DIRTY_RETRIES) return failRemote(attempt, { code: "remote.dirty", evidence: JSON.stringify(response),
      reason: `Checkpoint failed: the agent ended its turn ${REMOTE_DIRTY_RETRIES + 1} times with uncommitted or untracked files ` +
        `in the workspace, so the bench could not be checkpointed${said(message)}. Nothing was reported as a pass.` }, deps, seams, executor);
    const entry = live.get(liveKey(attempt));
    if (!entry?.turn.alive()) throw new CheckpointRefused("uncertain", "remote.turn.absent");
    const next = await deps.advance(attempt, { phase: "working", remote: canonicalRemoteState({ ...withoutFinish(state),
      dirtyTries: state.dirtyTries + 1 }) });
    if (next.send) {
      entry.end = undefined;
      await entry.turn.send(message ? `${REMOTE_DIRTY_PROMPT} SuperBench said: ${message}` : REMOTE_DIRTY_PROMPT);
      watch(entry);
    }
    return { attempt: next.attempt };
  }
  if (response.state === "refused" && "code" in response && !BENCH_PARKED.has(response.code)) {
    const message = "detail" in response && response.detail?.message ? said(response.detail.message) : "";
    return failRemote(attempt, { code: response.code, evidence: JSON.stringify(response),
      reason: `Checkpoint failed: the bench refused to checkpoint the agent's work (${response.code})${message}. Nothing was reported as a pass.` },
    deps, seams, executor);
  }
  throw new CheckpointRefused("uncertain", `remote.finish:${why(response)}`);
}

/** One pass of a remote phase (`attach_pending`, `working`, `finish_pending`). Only a remote profile has one. */
export async function driveRemotePhase(attempt: RetainedCheckpointAttempt, client: SuperpipelineClient, deps: RemoteDriveDeps): Promise<DriveStep> {
  const executor = attempt.profile.executor;
  if (!isRemoteProfile(attempt.profile) || !executor) throw new CheckpointRefused("source", "retained.phase");
  const seams = deps.remote;
  if (!seams) throw new CheckpointRefused("unavailable", "remote.unconfigured");
  switch (attempt.row.phase) {
    case "attach_pending": return attach(attempt, client, deps, seams, executor);
    case "working": return work(attempt, client, deps, seams, executor);
    case "finish_pending": return finish(attempt, client, deps, seams, executor);
    default: throw new CheckpointRefused("source", "retained.phase");
  }
}

/**
 * Whether any attempt on this station is in a remote phase (operator decision 2): the station's terminal
 * points at a bench, so every roster loop for it skips its claims. A row that cannot be read counts as busy.
 */
export async function stationBenchBusy(tenantId: string, stationId: string): Promise<boolean> {
  const rows = await db.select({ profile: checkpointDispatches.profile }).from(checkpointDispatches)
    .where(and(eq(checkpointDispatches.tenantId, tenantId), inArray(checkpointDispatches.phase, [...REMOTE_PHASES])));
  return rows.some((row) => {
    try { return parseCheckpointProfile(parseCheckpointJSON(encode(row.profile))).target.station_id === stationId; }
    catch (error) { noteCheckpoint("remote", "remote.busy.profile", { tenantId, stationId }, error); return true; }
  });
}
