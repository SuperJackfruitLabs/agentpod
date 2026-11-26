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
 *   The turn is bounded by the stage's task timeout, from the first turn's start across dirty retries
 *   and hub restarts; past it the session is ended and nothing more is heartbeated or renewed, so the
 *   board reclaims the run. A turn that ends any other way than the agent ending it, or whose
 *   agent's node stops holding the attachment, is not heartbeated either: the hub never fails or
 *   releases the run itself. After a hub restart there is no turn: the agent is told to continue in
 *   a fresh session once (`resumed`), and only while its station is online and the bound has time left.
 * - `finish_pending`: the bench host's node checkpoints, stops and releases (`finish`). A tree with
 *   uncommitted or untracked files is refused `dirty`, after the node fenced every session: the agent
 *   is attached again (a new certificate), given a fresh session and told, twice at most, then the
 *   run fails. A completion goes to `completed` exactly as a one-shot run's does; the station is
 *   detached, and the settlement is today's.
 *
 * A run the board ended (reclaimed, blocked or failed through the board tools, moved) is the
 * orchestrator's `endEndedRun`: the bench host's node is told, stops and releases, and
 * `endRemoteWork` ends the agent's session and detaches its station.
 *
 * The Hub never holds a lease token or a private key, and keeps no certificate: only the key's
 * fingerprint and where the bench is (checkpoint-remote-state.ts). From its claim until its station
 * is confirmed detached, a remote attempt's station takes no other board work (`stationBenchBusy`);
 * a detach that failed is asked again by the sweep (checkpoint-remote-sweep.ts).
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { BenchCoordinatorRequest, type BenchCoordinatorResponse } from "@agentpod/contract";
import { db } from "../../db/drizzle";
import { checkpointDispatches } from "../../db/schema/checkpoint-dispatch";
import { stations } from "../../db/schema/stations";
import { canonicalCheckpoint, parseCheckpointJSON } from "./checkpoint-json";
import { closeStationSessions } from "../acp";
import { CHECKPOINT_REMOTE_PHASES, CHECKPOINT_TERMINAL_PHASES, recordCheckpointRemoteDetached, updateCheckpointRemote, type advanceCheckpointAttempt, type failCheckpointAttempt,
  type RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { CheckpointRefused, isRemoteProfile, parseCheckpointProfile, type CheckpointProfile } from "./checkpoint-profile";
import { retainedCheckpointSource } from "./checkpoint-current-decision";
import { buildCheckpointSettlement } from "./checkpoint-report";
import { classifySettlementRefusal } from "./checkpoint-refusal";
import { noteCheckpoint, redact } from "./checkpoint-log";
import { agentAttachedTo, attachAgent, benchCall, detachAgent, ensureIdentity, type RemoteCallDeps } from "./checkpoint-remote-calls";
import { canonicalRemoteState, mayBeAttached, parseRemoteState, publicKeyFingerprint, type RemoteState } from "./checkpoint-remote-state";
import { readRunEnded } from "./checkpoint-run-ended";
import { REMOTE_TURN_PREFACE, startRemoteTurn, type RemoteTurn, type RemoteTurnDeps, type RemoteTurnEnd } from "./checkpoint-remote-turn";
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
/** The most of the agent's summary the report carries, across its turns (the settlement takes 8192 per value). */
export const REMOTE_SUMMARY_LIMIT = 8_000;
/** Said to the agent in the fresh session a hub restart opens, after the preface. */
export const REMOTE_RESUME_PROMPT = "Your previous turn was interrupted; the workspace still holds your work. Continue.";
/** After a re-attach failed, how long before it is tried again (each try asks both nodes and opens a session). */
export const REMOTE_REATTACH_RETRY_MS = 60_000;
/** From the claim to the finish: a remote attempt in one of these phases holds its station. */
// failure_pending too: a failed remote attempt whose bench is not yet released (held for an operator) keeps its station.
const HOLDING_PHASES = ["prepare_pending", "prepared", "source_pending", "admitted", ...CHECKPOINT_REMOTE_PHASES, "failure_pending"];

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

/**
 * The live turn of each working attempt in this process. A restart loses it (the attempt then parks).
 * `startedAt` is the first turn's start: dirty retries share the stage's one turn bound.
 */
interface Live { turn: RemoteTurn; lastBeat: number; startedAt: number; end?: RemoteTurnEnd }
const live = new Map<string, Live>();
/** When a re-attach that failed may be tried again, per attempt. */
const reattachAfter = new Map<string, number>();
const liveKey = (attempt: RetainedCheckpointAttempt) => `${attempt.row.tenantId}\0${attempt.row.attemptId}`;
function watch(entry: Live): void {
  const done = entry.turn.done;
  void (async () => {
    const end = await done;
    if (entry.turn.done === done) entry.end = end;
  })();
}
/** Test seam: forget every live turn. */
export function resetRemoteTurnsForTests(): void { live.clear(); reattachAfter.clear(); }

const meta = (attempt: RetainedCheckpointAttempt) => ({ tenantId: attempt.row.tenantId, boardId: attempt.row.boardId,
  runId: attempt.claim.runId, attemptId: attempt.row.attemptId, phase: attempt.row.phase });
const running = (attempt: RetainedCheckpointAttempt): DispatchResult => ({ status: "unreported", externalRunId: attempt.claim.runId,
  attemptId: attempt.row.attemptId, reason: "Checkpoint dispatch requires reconciliation", recheckMs: REMOTE_RECHECK_MS });
const said = (message: string) => { const text = redact(message).replace(/\s+/g, " ").trim().slice(0, 200); return text ? `: "${text}"` : ""; };
/** The stage's own task timeout bounds the agent's work, retries included. */
const turnBoundMs = (attempt: RetainedCheckpointAttempt) => attempt.request.task.timeout_seconds * 1000;
/** When the agent's first turn started, as retained. A state without it counts from the claim. */
function turnStart(attempt: RetainedCheckpointAttempt, state: RemoteState): number {
  const at = state.turnStartedAt ? Date.parse(state.turnStartedAt) : NaN;
  return Number.isFinite(at) ? at : attempt.row.createdAt.getTime();
}
/** No session is opened once the stage's bound is spent: the attempt parks unheartbeated, and the board reclaims the run. */
function requireTurnTime(attempt: RetainedCheckpointAttempt, startedAt: number, deps: RemoteDriveDeps): void {
  if (deps.now() - startedAt >= turnBoundMs(attempt)) throw new CheckpointRefused("uncertain", "remote.turn.timeout");
}

function requireState(attempt: RetainedCheckpointAttempt): RemoteState {
  const state = parseRemoteState(attempt.row.remote);
  if (!state) throw new CheckpointRefused("source", "remote.state");
  return state;
}
function without(state: RemoteState, field: "finishRequest" | "retryPrompt"): RemoteState {
  const { [field]: dropped, ...rest } = state;
  return dropped === undefined ? state : rest;
}
/** The agent's summary in a retained finish request, if it gave one. */
function summaryOf(retained: string | undefined): string | undefined {
  if (!retained) return undefined;
  const sent = BenchCoordinatorRequest.parse(parseCheckpointJSON(encode(retained)));
  const summary = sent.operation === "finish" ? sent.report.handoff.summary : undefined;
  return summary ? summary.slice(0, REMOTE_SUMMARY_LIMIT) : undefined;
}
const joined = (earlier: string | undefined, later: unknown) => [earlier, typeof later === "string" ? later : undefined]
  .filter((part): part is string => !!part).join("\n\n").slice(0, REMOTE_SUMMARY_LIMIT);

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
 * The agent's node's attach, under the station's session-open lock: no ordinary session on the
 * station opens while its terminal is being pointed at the bench (an open that waited re-checks busy).
 */
const underStationLock = <T>(seams: RemoteSeams, stationId: string, fn: () => Promise<T>): Promise<T> =>
  seams.turn.acp.withStationLock ? seams.turn.acp.withStationLock(stationId, fn) : fn();

/**
 * The certificate for the station's own key, asked of the bench host's node and installed by the
 * agent's. Parks on anything that is not a definite refusal; returns a definite one for the run to fail.
 * `retain` stores the attach request's digest before it is sent, because the node's current check names
 * it; `agentAttachSent` is stored before the agent's node is asked, so a lost reply still detaches.
 */
async function certify(attempt: RetainedCheckpointAttempt, deps: RemoteDriveDeps, seams: RemoteSeams, executor: Executor, step: string,
  retain: (state: Pick<RemoteState, "publicKeyFingerprint" | "attachRequestSHA256">) => Promise<RetainedCheckpointAttempt>):
  Promise<{ attempt: RetainedCheckpointAttempt; validBefore: string; credential: { user: string; address: string; workingDirectory: string } } |
    { attempt: RetainedCheckpointAttempt; refusal: Refusal }> {
  const station = { stationId: executor.stationId, stationKey: await (seams.stationKey ?? stationKeyOf)(attempt.row.tenantId, executor.stationId) };
  const key = await ensureIdentity(executor.nodeId, station, deps);
  if ("refused" in key) {
    if (key.refused.code === "unavailable") throw new CheckpointRefused("uncertain", `remote.${step}.identity.unavailable`);
    return { attempt, refusal: { code: key.refused.code, evidence: JSON.stringify(key.refused),
      reason: `Checkpoint failed: the agent's node has no bench identity for the station (${key.refused.code})${said(key.refused.message)}. Nothing ran.` } };
  }
  const { prepared } = await retainedCheckpointSource(attempt);
  const request = attachRequest(attempt, prepared.binding_sha256, key.ok);
  let current = await retain({ publicKeyFingerprint: publicKeyFingerprint(key.ok), attachRequestSHA256: hash(request) });
  const response = await benchCall(current, request, deps);
  if (response.state !== "attached") {
    if (response.state !== "refused" || !("code" in response) || BENCH_PARKED.has(response.code))
      throw new CheckpointRefused("uncertain", `remote.${step}:${why(response)}`);
    const message = "detail" in response && response.detail?.message ? said(response.detail.message) : "";
    return { attempt: current, refusal: { code: response.code, evidence: JSON.stringify(response),
      reason: `Checkpoint failed: the bench refused the agent's certificate (${response.code})${message}. Nothing was reported as a pass.` } };
  }
  const sending = requireState(current);
  if (!sending.agentAttachSent)
    current = await (seams.update ?? updateCheckpointRemote)(current, canonicalRemoteState({ ...sending, agentAttachSent: true }));
  const c = response.credential;
  const agent = await underStationLock(seams, executor.stationId,
    () => attachAgent(executor.nodeId, { ...station, attemptId: attempt.row.attemptId, credential: c }, deps));
  if ("refused" in agent) {
    if (agent.refused.code === "unavailable") throw new CheckpointRefused("uncertain", `remote.${step}.agent.unavailable`);
    return { attempt: current, refusal: { code: agent.refused.code, evidence: JSON.stringify(agent.refused),
      reason: `Checkpoint failed: the agent's node could not attach the station to the bench (${agent.refused.code})${said(agent.refused.message)}. Nothing was reported as a pass.` } };
  }
  return { attempt: current, validBefore: agent.ok.validBefore, credential: { user: c.user, address: c.address, workingDirectory: c.working_directory } };
}

/**
 * End the attempt's remote work in this process: the turn's session is ended and the station detached
 * whenever an attach may have applied, the state recording it. A detach that fails or is refused is
 * named, and the station stays busy (`stationBenchBusy`) until a later detach is confirmed.
 */
async function endRemote(attempt: RetainedCheckpointAttempt, deps: Pick<RemoteCallDeps, "request">, seams: Partial<RemoteSeams>,
  executor: Executor, reason: string): Promise<RetainedCheckpointAttempt> {
  const entry = live.get(liveKey(attempt));
  live.delete(liveKey(attempt));
  reattachAfter.delete(liveKey(attempt));
  if (entry) await entry.turn.cancel(reason);
  const state = parseRemoteState(attempt.row.remote);
  if (!state || !mayBeAttached(state)) return attempt;
  // No turn in this process (a hub restart, an operator's retirement): every session on the station is ended.
  if (!entry) {
    try { if (!await closeSessions(seams, attempt, executor, reason)) noteCheckpoint("remote", "remote.session.unclosed", meta(attempt)); }
    catch (error) { noteCheckpoint("remote", "remote.session.end", meta(attempt), error); }
  }
  try {
    const reply = await detachAgent(executor.nodeId, { stationId: executor.stationId, attemptId: attempt.row.attemptId }, deps);
    if ("refused" in reply) { noteCheckpoint("remote", `remote.detach.${reply.refused.code}`, meta(attempt)); return attempt; }
    return await (seams.update ?? writeRemote)(attempt, canonicalRemoteState({ ...state, detached: true }));
  } catch (error) {
    noteCheckpoint("remote", "remote.detach", meta(attempt), error);
    return attempt;
  }
}

/** The retained state written as the ledger allows in the attempt's phase: an ended attempt only records a detach. */
async function writeRemote(attempt: RetainedCheckpointAttempt, remote: string): Promise<RetainedCheckpointAttempt> {
  if (!CHECKPOINT_TERMINAL_PHASES.has(attempt.row.phase)) return updateCheckpointRemote(attempt, remote);
  if (!await recordCheckpointRemoteDetached(attempt, remote)) throw new CheckpointRefused("stale", "ledger.raced");
  return { ...attempt, row: { ...attempt.row, remote } };
}

/**
 * End every session on the station and confirm no agent process of theirs still runs: all of them
 * worked in the bench. False when that cannot be confirmed (checkpoint-remote's callers then open nothing).
 */
function closeSessions(seams: Partial<RemoteSeams>, attempt: RetainedCheckpointAttempt, executor: Executor, reason: string): Promise<boolean> {
  const input = { tenantId: attempt.row.tenantId, stationId: executor.stationId };
  // Outside a station's loop (an operator's retirement) the hub's own sessions are asked directly.
  if (!seams.turn) return closeStationSessions(input.tenantId, input.stationId, reason);
  return seams.turn.acp.closeStationSessions?.(input, reason) ?? Promise.resolve(false);
}

/**
 * Before a fresh session after a hub restart (a resume, or a dirty retry's re-attach): the sessions the
 * agent worked in are confirmed closed, or nothing opens and the attempt parks, unheartbeated.
 */
async function requireSessionsClosed(seams: RemoteSeams, attempt: RetainedCheckpointAttempt, executor: Executor): Promise<void> {
  if (!await closeSessions(seams, attempt, executor, "The hub restarted; the agent continues in a fresh session."))
    throw new CheckpointRefused("uncertain", "remote.session.unclosed");
}

/**
 * End a remote attempt's work from outside its phases (a run the board ended, a superseded profile):
 * the agent's session is ended and its station detached when an attach may have applied. Never
 * throws for a detach: one that fails is named and left to the sweep. A one-shot attempt is unchanged.
 */
export async function endRemoteWork(attempt: RetainedCheckpointAttempt, deps: Pick<RemoteCallDeps, "request"> & { remote?: RemoteSeams },
  reason: string): Promise<RetainedCheckpointAttempt> {
  const executor = attempt.profile.executor;
  if (!isRemoteProfile(attempt.profile) || !executor) return attempt;
  return endRemote(attempt, deps, deps.remote ?? {}, executor, reason);
}

async function failRemote(attempt: RetainedCheckpointAttempt, refusal: Refusal, deps: RemoteDriveDeps, seams: RemoteSeams,
  executor: Executor): Promise<DriveStep> {
  const ended = await endRemote(attempt, deps, seams, executor, "The remote bench stage failed.");
  return { attempt: (await deps.fail(ended, { ...refusal, disposition: "failed" })).attempt };
}

/** A fresh session in the bench for the agent (an open session keeps the terminal it started with). */
async function openTurn(attempt: RetainedCheckpointAttempt, client: SuperpipelineClient, deps: RemoteDriveDeps, seams: RemoteSeams,
  cwd: string, opening: string, startedAt: number): Promise<RemoteTurn> {
  const turn = await (seams.start ?? startRemoteTurn)({ ...seams.turn, client }, attempt, cwd, opening);
  const entry: Live = { turn, lastBeat: deps.now(), startedAt };
  live.set(liveKey(attempt), entry);
  watch(entry);
  return turn;
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
      agentAttachSent: false, attached: false, detached: false, dirtyTries: 0, resumed: false }));
  });
  if ("refusal" in issued) return failRemote(issued.attempt, issued.refusal, deps, seams, executor);
  const state = requireState(issued.attempt);
  const startedAt = deps.now();
  const next = await deps.advance(issued.attempt, { phase: "working", remote: canonicalRemoteState({ ...state, ...issued.credential,
    validBefore: issued.validBefore, attached: true, turnStartedAt: new Date(startedAt).toISOString() }) });
  // Opened only now: an open session keeps the terminal it started with, so it must start attached.
  if (next.send) await openTurn(next.attempt, client, deps, seams, issued.credential.workingDirectory, REMOTE_TURN_PREFACE, startedAt);
  return { attempt: next.attempt };
}

/** The same key and the same bytes again, for a new certificate; the agent's node is given it. */
async function recertify(attempt: RetainedCheckpointAttempt, state: RemoteState, deps: RemoteDriveDeps, seams: RemoteSeams,
  executor: Executor, step: string) {
  return certify(attempt, deps, seams, executor, step, async (key) => {
    // A renewal never attaches a second key.
    if (key.publicKeyFingerprint !== state.publicKeyFingerprint || key.attachRequestSHA256 !== state.attachRequestSHA256)
      throw new CheckpointRefused("stale", "remote.identity.changed");
    return attempt;
  });
}

async function renew(attempt: RetainedCheckpointAttempt, state: RemoteState, deps: RemoteDriveDeps, seams: RemoteSeams,
  executor: Executor): Promise<RetainedCheckpointAttempt> {
  const issued = await recertify(attempt, state, deps, seams, executor, "renew");
  if ("refusal" in issued) throw new CheckpointRefused("uncertain", `remote.renew:refused.${issued.refusal.code}`);
  return (seams.update ?? updateCheckpointRemote)(issued.attempt, canonicalRemoteState({ ...requireState(issued.attempt),
    validBefore: issued.validBefore }));
}

/**
 * After a dirty finish the node fenced every session and SuperBench retired the agent's certificate:
 * attach again (a new certificate, pushed to the agent's node), then a fresh session, then the prompt.
 * Until the prompt is sent `retryPrompt` stays retained, so a pass that stops part way starts again here.
 */
async function reattach(attempt: RetainedCheckpointAttempt, state: RemoteState, client: SuperpipelineClient, deps: RemoteDriveDeps,
  seams: RemoteSeams, executor: Executor): Promise<DriveStep> {
  const key = liveKey(attempt);
  const prior = live.get(key);
  if (prior?.turn.alive()) await prior.turn.cancel("The bench fenced this session; the agent continues in a fresh one.");
  // The stage's one bound, retained: a hub restart since the first turn gets no fresh one.
  const startedAt = prior?.startedAt ?? turnStart(attempt, state);
  requireTurnTime(attempt, startedAt, deps);
  // A re-attach that failed asks both nodes and opens a session: it waits before the next try.
  const after = reattachAfter.get(key);
  if (after !== undefined && deps.now() < after) return { result: running(attempt) };
  try {
    // After a hub restart the fenced session is not this process's: it is confirmed closed first.
    if (!prior) await requireSessionsClosed(seams, attempt, executor);
    const issued = await recertify(attempt, state, deps, seams, executor, "reattach");
    if ("refusal" in issued) return failRemote(issued.attempt, issued.refusal, deps, seams, executor);
    const update = seams.update ?? updateCheckpointRemote;
    let current = await update(issued.attempt, canonicalRemoteState({ ...requireState(issued.attempt), validBefore: issued.validBefore }));
    const opening = [REMOTE_TURN_PREFACE, state.retryPrompt, state.summary ? `Your earlier turn reported: ${state.summary}` : undefined]
      .filter((part): part is string => !!part).join("\n\n");
    await openTurn(current, client, deps, seams, state.workingDirectory, opening, startedAt);
    current = await update(current, canonicalRemoteState(without(requireState(current), "retryPrompt")));
    reattachAfter.delete(key);
    return { result: running(current) };
  } catch (error) {
    reattachAfter.set(key, deps.now() + REMOTE_REATTACH_RETRY_MS);
    throw error;
  }
}

/**
 * A hub restart left a working attempt with no turn in this process (a permission wait included: it
 * is not in the dispatch ledger). Once, while the station is online, its run not ended and the
 * stage's bound has time left, the agent is told to continue in a fresh session, and only:
 * - once every session on the station is confirmed closed (its node answered the close), so two
 *   agents never work in one bench;
 * - once the agent's node holds this attempt's attachment with a certificate outside the renewal
 *   window: otherwise the same key is certified again and attached (a definite refusal fails the run).
 * Anything short of that parks, unheartbeated, as for a lost agent, and the board reclaims the run.
 */
async function resume(attempt: RetainedCheckpointAttempt, state: RemoteState, client: SuperpipelineClient, deps: RemoteDriveDeps,
  seams: RemoteSeams, executor: Executor): Promise<DriveStep> {
  const startedAt = turnStart(attempt, state);
  requireTurnTime(attempt, startedAt, deps);
  if (state.resumed) throw new CheckpointRefused("uncertain", "remote.turn.absent");
  // A run the board ended takes no new session: the drive ends it (`endEndedRun`).
  if (await readRunEnded(client, attempt.claim)) throw new CheckpointRefused("uncertain", "remote.run_ended");
  const { acp, agent } = seams.turn;
  const station = await acp.stationReady({ stationId: executor.stationId, tenantId: attempt.row.tenantId, userId: agent.hubUserId });
  if (!station.ready) throw new CheckpointRefused("uncertain", "remote.turn.absent");
  await requireSessionsClosed(seams, attempt, executor);
  const update = seams.update ?? updateCheckpointRemote;
  let current = attempt;
  // An open session keeps the terminal it started with: it must start attached, with time on its certificate.
  const attached = await agentAttachedTo(executor.nodeId, executor.stationId, attempt.row.attemptId, deps);
  if (!attached || Date.parse(state.validBefore) - deps.now() < REMOTE_RENEW_BEFORE_MS) {
    const issued = await recertify(current, state, deps, seams, executor, "resume");
    if ("refusal" in issued) return failRemote(issued.attempt, issued.refusal, deps, seams, executor);
    current = await update(issued.attempt, canonicalRemoteState({ ...requireState(issued.attempt), validBefore: issued.validBefore }));
  }
  // Written before the open: however this pass ends, the turn is resumed at most once.
  current = await update(current, canonicalRemoteState({ ...requireState(current), resumed: true }));
  await openTurn(current, client, deps, seams, state.workingDirectory, `${REMOTE_TURN_PREFACE}\n\n${REMOTE_RESUME_PROMPT}`, startedAt);
  return { result: running(current) };
}

async function work(initial: RetainedCheckpointAttempt, client: SuperpipelineClient, deps: RemoteDriveDeps, seams: RemoteSeams,
  executor: Executor): Promise<DriveStep> {
  let attempt = initial;
  let state = requireState(attempt);
  if (state.retryPrompt !== undefined) return reattach(attempt, state, client, deps, seams, executor);
  const entry = live.get(liveKey(attempt));
  // No turn here: the hub restarted while the agent worked.
  if (!entry) return resume(attempt, state, client, deps, seams, executor);
  const now = deps.now();
  // Past the stage's bound the session is ended: nothing more is heartbeated or renewed, and the board reclaims the run.
  if (!entry.end && now - entry.startedAt >= turnBoundMs(attempt)) {
    await entry.turn.cancel("The remote bench stage's turn outlived its time limit.");
    entry.end = { stopReason: "timeout", handoff: {} };
  }
  if (entry.end?.stopReason === "end_turn") {
    // An agent that blocked or failed the run through the board tools ended it: no checkpoint is made.
    // Parked here, the drive reads the same answer and ends the run (`endEndedRun`), which detaches.
    if (await readRunEnded(client, attempt.claim)) throw new CheckpointRefused("uncertain", "remote.run_ended");
    const { prepared } = await retainedCheckpointSource(attempt);
    const handoff = { ...entry.end.handoff, ...(state.summary ? { summary: joined(state.summary, entry.end.handoff.summary) } : {}) };
    const next = await deps.advance(attempt, { phase: "finish_pending", remote: canonicalRemoteState({ ...state,
      finishRequest: finishRequest(attempt, prepared.binding_sha256, handoff) }) });
    return { attempt: next.attempt };
  }
  // The turn ended without the agent ending it: nothing more is heartbeated, and the board reclaims the run.
  if (entry.end) throw new CheckpointRefused("uncertain", `remote.turn.${entry.end.stopReason}`);
  if (Date.parse(state.validBefore) - now < REMOTE_RENEW_BEFORE_MS) {
    try { attempt = await renew(attempt, state, deps, seams, executor); state = requireState(attempt); }
    catch (error) { noteCheckpoint("remote", "remote.renew", meta(attempt), error); }
  }
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
    // The fenced session is over; the next pass attaches again and opens a fresh one (`reattach`).
    const fenced = live.get(liveKey(attempt));
    if (fenced) await fenced.turn.cancel("The bench fenced this session to check the workspace.");
    const summary = summaryOf(state.finishRequest);
    const next = await deps.advance(attempt, { phase: "working", remote: canonicalRemoteState({ ...without(state, "finishRequest"),
      dirtyTries: state.dirtyTries + 1, retryPrompt: message ? `${REMOTE_DIRTY_PROMPT} SuperBench said: ${message}` : REMOTE_DIRTY_PROMPT,
      ...(summary ? { summary } : {}) }) });
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
  // Detached (its run ended, its profile was replaced): the agent's work is over. Nothing attaches, resumes or finishes it.
  if (parseRemoteState(attempt.row.remote)?.detached) throw new CheckpointRefused("uncertain", "remote.detached");
  switch (attempt.row.phase) {
    case "attach_pending": return attach(attempt, client, deps, seams, executor);
    case "working": return work(attempt, client, deps, seams, executor);
    case "finish_pending": return finish(attempt, client, deps, seams, executor);
    default: throw new CheckpointRefused("source", "retained.phase");
  }
}

/**
 * Whether a remote attempt holds this station (operator decision 2): from its claim until its finish,
 * and, whatever its phase, while the agent's node may still point the station at the bench (an attach
 * was sent and no detach is confirmed). Every roster loop for a held station skips its claims, and an
 * ordinary session refuses to open on it. A row that cannot be read counts as busy.
 */
export async function stationBenchBusy(tenantId: string, stationId: string): Promise<boolean> {
  const rows = await db.select({ profile: checkpointDispatches.profile, phase: checkpointDispatches.phase, remote: checkpointDispatches.remote })
    .from(checkpointDispatches).where(and(eq(checkpointDispatches.tenantId, tenantId), or(inArray(checkpointDispatches.phase, HOLDING_PHASES),
      sql`${checkpointDispatches.remote} IS NOT NULL AND (${checkpointDispatches.remote}::jsonb ->> 'detached') = 'false'`)));
  return rows.some((row) => {
    try {
      const profile = parseCheckpointProfile(parseCheckpointJSON(encode(row.profile)));
      if (profile.target.station_id !== stationId || !isRemoteProfile(profile)) return false;
      return HOLDING_PHASES.includes(row.phase) || mayBeAttached(parseRemoteState(row.remote));
    } catch (error) { noteCheckpoint("remote", "remote.busy.profile", { tenantId, stationId }, error); return true; }
  });
}
