/** Proposed real broker/service choreography. Every uncertain effect stays on
 * its original durable attempt; neither a child nor a request ID is replaced.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { createLogger } from "../../utils/logger";
import { BENCH_COORDINATOR_VERB, BenchCoordinatorRequest, parseBenchCoordinatorResponse,
  BenchCoordinatorCompletion, BenchCoordinatorResponse } from "@agentpod/contract";
import { request as nodeRequest } from "../broker";
import { canonicalCheckpoint, checkpointDigest, parseCheckpointJSON, parseCheckpointContextJSON } from "./checkpoint-json";
import { advanceCheckpointAttempt, closeFailedCheckpointAttempt, failCheckpointAttempt, retireCheckpointAttempt,
  type CheckpointFailure, type CheckpointRetirementReason, type RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { readRunEnded, type RunEnded } from "./checkpoint-run-ended";
import { retainedCheckpointSource } from "./checkpoint-current-decision";
import { checkpointAuthorityMatches, readCheckpointAuthority } from "./checkpoint-current";
import { requireInstalledCheckpointProfile } from "./checkpoint-profiles";
import { CheckpointRefused, isRemoteProfile, type CheckpointRefusalReason } from "./checkpoint-profile";
import { driveRemotePhase, endRemoteWork, REMOTE_PHASES, type RemoteSeams } from "./checkpoint-remote";
import { createCheckpointServiceClient } from "./checkpoint-service-client";
import { parseSourceReceipt, requireActiveSource } from "./checkpoint-source";
import { buildCheckpointSettlement } from "./checkpoint-report";
import { benchMessage, classifyCheckpointRefusal, classifySettlementRefusal, type CheckpointRefusalRuling } from "./checkpoint-refusal";
import { checkedCheckpointReceipt } from "./checkpoint-settlement-data";
import { isLeaseSuperseded, type SuperpipelineClient } from "./superpipeline";
import type { DispatchResult } from "./dispatch-types";
import { createQuietLog, type QuietLog } from "./quiet-log";
import { errorFacts, nodeCallReason, noteCheckpoint } from "./checkpoint-log";
import { nodeCallTimeoutMs } from "./checkpoint-node-call";
import { checkpointActivity, postCheckpointActivity, stillRunning } from "./checkpoint-activity";
import { capacityCard, CAPACITY_RELEASE_CAP, type CapacityBackoff } from "./checkpoint-capacity-backoff";

const encode = (raw: string) => new TextEncoder().encode(raw);
const hash = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");
const log = createLogger("bridge-checkpoint");
/**
 * A parked attempt is re-checked every backoff until it resolves, so its line is said once per
 * attempt, phase and code, then once per interval with a count, never once per re-check.
 */
let parkedLog = createQuietLog((message, meta) => log.warn(message, meta));
/** A run still going is not a fault: logged at info, on its own key. */
let runningLog = createQuietLog((message, meta) => log.info(message, meta));
/**
 * How soon a checkpoint run still going after the execute wait is read again, by `status`. Short,
 * so a run longer than the wait costs seconds rather than the fault backoff.
 */
export const CHECKPOINT_RUNNING_RECHECK_MS = 5_000;
/** Test seam: a fresh rate limit with its own clock. Returns the restore. */
export function setParkedLogForTests(next: QuietLog): () => void {
  const prior = parkedLog;
  const priorRunning = runningLog;
  // One sink for both: a test reads every park, a fault or a run still going, in order.
  parkedLog = next;
  runningLog = next;
  return () => { parkedLog = prior; runningLog = priorRunning; };
}
/** Why each parked result parked, and the attempt as it parked, so the drive can say it on the card once. */
const parkFacts = new WeakMap<DispatchResult, { phase: string; code: string; reason?: string; attempt: RetainedCheckpointAttempt;
  held?: BenchCoordinatorResponse; running?: boolean }>();

/** The node says the attempt's own lease is still held because SuperBench refused its release. */
const leaseHeld = (response: BenchCoordinatorResponse | undefined): boolean =>
  !!response && "detail" in response && response.detail?.lease === "held";

/** The bench's key from the attempt's retained prepare, when it has one. Only for naming it to an operator. */
function retainedBenchKey(attempt: RetainedCheckpointAttempt): string | undefined {
  if (!attempt.row.prepared) return undefined;
  try {
    const value: unknown = JSON.parse(attempt.row.prepared);
    const binding: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "binding") : undefined;
    const key: unknown = typeof binding === "object" && binding !== null ? Reflect.get(binding, "bench_key") : undefined;
    return typeof key === "string" && /^cp_[a-f0-9]{64}$/.test(key) ? key : undefined;
  } catch (error) {
    noteCheckpoint("lease-held", "retained.prepared", { attemptId: attempt.row.attemptId }, error);
    return undefined;
  }
}

/** Say on the card, once per attempt, that its bench lease is held and what an operator must do. */
async function sayLeaseHeld(client: SuperpipelineClient, attempt: RetainedCheckpointAttempt, response: BenchCoordinatorResponse,
  phase: string): Promise<void> {
  const benchKey = retainedBenchKey(attempt);
  log.warn("checkpoint bench lease held after a refused release; operator action needed", { tenantId: attempt.row.tenantId,
    boardId: attempt.row.boardId, runId: attempt.claim.runId, attemptId: attempt.row.attemptId, phase, benchKey });
  await postCheckpointActivity(client, attempt, "lease_held", checkpointActivity("lease_held",
    { phase, benchKey, message: benchMessage(response) }));
}
// Every park passes the error that names it: there is no default, so a call site cannot park unnamed.
const parked = (attempt: RetainedCheckpointAttempt, code: CheckpointRefused["code"], error: unknown): DispatchResult => {
  // The error that parked it, by class and redacted message (a refusal's own cause when it replaced one).
  const cause = error instanceof CheckpointRefused ? error.cause : error;
  const facts = cause === undefined ? undefined : errorFacts(cause);
  // A refusal or error that names nothing still parks named: `drive.error`, with its class in the facts.
  const reason: CheckpointRefusalReason = (error instanceof CheckpointRefused ? error.reason : undefined) ?? "drive.error";
  const running = stillRunning({ phase: attempt.row.phase, code, reason }) ||
    attempt.row.phase === "execute_pending" && code === "uncertain" && reason === "node.state:pending";
  (running ? runningLog : parkedLog)([attempt.row.attemptId, attempt.row.phase, code, reason, facts?.errorClass ?? ""].join("\0"),
    running ? "checkpoint task still running; checking its status again shortly" : "checkpoint dispatch parked for reconciliation", {
    tenantId: attempt.row.tenantId, boardId: attempt.row.boardId, runId: attempt.claim.runId,
    attemptId: attempt.row.attemptId, phase: attempt.row.phase, code, reason, ...facts });
  const result: DispatchResult = { status: "unreported", externalRunId: attempt.claim.runId, attemptId: attempt.row.attemptId,
    reason: "Checkpoint dispatch requires reconciliation" };
  parkFacts.set(result, { phase: attempt.row.phase, code, reason, attempt });
  return result;
};

/**
 * A reply that is neither the phase's success nor a definite refusal parks on its phase, as before,
 * and always names the node's closed state: `node.state:<state>` (pending, unknown, superseded,
 * prepared, ...) or, for a refusal that does not prove the node's record terminal,
 * `node.state:refused.<code>` (checkpoint-refusal.ts). A park that names nothing reads as
 * `execute_pending`/`uncertain` with no reason, which is how a killed run sat unexplained.
 */
function parkedReply(attempt: RetainedCheckpointAttempt, response: BenchCoordinatorResponse): DispatchResult {
  const why = (response.state === "refused" && "code" in response ? `refused.${response.code}` : response.state) +
    (leaseHeld(response) ? ".lease_held" : "");
  const result = parked(attempt, "uncertain", new CheckpointRefused("uncertain", `node.state:${why}`));
  const facts = parkFacts.get(result);
  if (facts && leaseHeld(response)) facts.held = response;
  // A bare pending names no problem: the node's run is unresolved, which while executing means it is still going.
  if (facts && response.state === "pending" && !("detail" in response && response.detail)) facts.running = true;
  return result;
}

/** The failure a `failure_pending` or `failed` row holds. */
const heldFailureSchema = z.object({ version: z.literal("agentpod.checkpoint-failure.v1"), code: z.string().min(1),
  disposition: z.enum(["failed", "released"]), reason: z.string().min(1), phase: z.string(), by: z.literal("hub"),
  at: z.string(), evidence: z.string() }).strict();
function heldFailure(attempt: RetainedCheckpointAttempt): CheckpointFailure {
  if (!attempt.row.failure) throw new CheckpointRefused("source", "retained.failure");
  const parsed = heldFailureSchema.safeParse(parseCheckpointJSON(encode(attempt.row.failure)));
  if (!parsed.success) throw new CheckpointRefused("source", "retained.failure");
  return parsed.data;
}

/** The node reply a held failure was ruled on, when its evidence is one. */
function heldEvidence(failure: CheckpointFailure): BenchCoordinatorResponse | undefined {
  try {
    const value: unknown = JSON.parse(failure.evidence);
    const parsed = BenchCoordinatorResponse.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    noteCheckpoint("lease-held", "failure.evidence", {}, error);
    return undefined;
  }
}

async function current(attempt: RetainedCheckpointAttempt): Promise<void> {
  requireInstalledCheckpointProfile(attempt.profile);
  const authority = await readCheckpointAuthority(attempt.profile);
  requireInstalledCheckpointProfile(attempt.profile);
  if (!checkpointAuthorityMatches(authority, attempt.row.authority)) throw new CheckpointRefused("stale", "authority.changed");
}

/** The Hub's effects, injectable so the phase logic can be tested without a broker or ledger database. */
export interface CheckpointDriveDeps {
  authority(attempt: RetainedCheckpointAttempt): Promise<void>;
  request: typeof nodeRequest;
  service: typeof createCheckpointServiceClient;
  advance: typeof advanceCheckpointAttempt;
  /** Hold a definite node refusal (`failure_pending`), and end it `failed` once the board is told. */
  fail: typeof failCheckpointAttempt;
  close: typeof closeFailedCheckpointAttempt;
  /** End an attempt whose run the board ended (`retired`, with the board's answer and the node's reply). */
  retire: typeof retireCheckpointAttempt;
  now(): number;
  /** The station's capacity backoff (checkpoint-capacity-backoff.ts). Without one, capacity releases are not counted. */
  capacity?: CapacityBackoff;
  /** A remote bench stage's station: its ACP port and roster row (checkpoint-remote.ts). Without it a remote phase parks. */
  remote?: RemoteSeams;
}
const defaultDeps: CheckpointDriveDeps = { authority: current, request: nodeRequest, service: createCheckpointServiceClient,
  advance: advanceCheckpointAttempt, fail: failCheckpointAttempt, close: closeFailedCheckpointAttempt,
  retire: retireCheckpointAttempt, now: Date.now };
/** The real effects, with a station's own pieces (its capacity backoff) added. */
export function checkpointDriveDeps(overrides: Partial<CheckpointDriveDeps> = {}): CheckpointDriveDeps {
  return { ...defaultDeps, ...overrides };
}

/**
 * The cap on capacity releases: the card's `CAPACITY_RELEASE_CAP`-th capacity refusal in a row is failed
 * instead of released, so the board's retry policy decides rather than the station re-claiming it.
 */
function capped(ruling: CheckpointRefusalRuling | undefined, attempt: RetainedCheckpointAttempt,
  deps: CheckpointDriveDeps): CheckpointRefusalRuling | undefined {
  if (ruling?.code !== "capacity_exhausted" || ruling.disposition !== "released" || !deps.capacity?.capped(capacityCard(attempt.claim)))
    return ruling;
  return { code: ruling.code, disposition: "failed", reason: `Checkpoint failed: SuperBench capacity was exhausted on ${CAPACITY_RELEASE_CAP} ` +
    "attempts in a row for this card, so it is failed rather than released again; the board's retry policy decides. Nothing ran." };
}

async function exchange(attempt: RetainedCheckpointAttempt, raw: string, deps: CheckpointDriveDeps): Promise<BenchCoordinatorResponse> {
  const sent = BenchCoordinatorRequest.parse(parseCheckpointJSON(encode(raw)));
  await deps.authority(attempt);
  // Broker correlates replies to the authenticated selected enrolled Node.
  // A timeout never causes this function to repeat the request.
  const result = await deps.request(attempt.profile.target.node_id, BENCH_COORDINATOR_VERB, sent, { timeoutMs: nodeCallTimeoutMs(sent.operation) });
  if (!result.ok) throw new CheckpointRefused("uncertain", nodeCallReason(result.error ?? ""), new Error(result.error ?? "no error"));
  const serialized = JSON.stringify(result.data);
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 262144) throw new CheckpointRefused("source", "node.reply.size");
  const response = await parseBenchCoordinatorResponse(encode(serialized), sent);
  await deps.authority(attempt);
  return response;
}

function statusRequest(attempt: RetainedCheckpointAttempt): string {
  return JSON.stringify(BenchCoordinatorRequest.parse({ version: attempt.request.version, operation: "status",
    identity: attempt.request.identity, target: attempt.request.target }));
}

/** One bounded pass through retained phases. sendPrepare is true only for the
 * successful original INSERT, never a lookup, restart or speculative retry. A
 * recovered prepare_pending re-sends the identical retained prepare only after
 * the node's status says it never finished it (`unknown` or `pending`).
 */
export async function driveCheckpointAttempt(initial: RetainedCheckpointAttempt, client: SuperpipelineClient,
  sendPrepare = false, deps: CheckpointDriveDeps = defaultDeps): Promise<DispatchResult> {
  const result = await drive(initial, client, sendPrepare, deps);
  const facts = parkFacts.get(result);
  // A pass that parks asks the board, read-only, whether the run has ended. If it has, parking would
  // wait forever (the run never comes back) and hold the station's checkpoint claims with it.
  if (facts && RUN_ENDABLE_PHASES.has(facts.attempt.row.phase)) {
    const ended = await readRunEnded(client, facts.attempt.claim);
    if (ended) return endEndedRun(facts.attempt, ended, deps, client);
  }
  // A park is said on the card once per attempt, phase and reason; the re-checks stay quiet. A run the
  // board ended returned above: it is never written to, since an activity on an unbound run heartbeats it.
  // A held lease is the more specific park: it alone is said, with the operator's path, not a generic one too.
  if (facts?.held) await sayLeaseHeld(client, facts.attempt, facts.held, facts.phase);
  // A run still going is said once, however its re-checks read (a timed-out wait, then a pending status).
  else if (facts) await postCheckpointActivity(client, initial, stillRunning(facts) ? `still_running:${facts.phase}`
    : `parked:${facts.phase}:${facts.code}:${facts.reason ?? ""}`, checkpointActivity("parked", facts));
  // The benign case: the run is still going. The loop re-reads it shortly rather than backing off.
  if (facts && !facts.held && stillRunning(facts)) return { ...result, recheckMs: CHECKPOINT_RUNNING_RECHECK_MS };
  return result;
}

/**
 * Phases whose run the board may end while the attempt waits. A park in one of them asks the board.
 * `failure_pending` asks before it tells the board anything; `submission_pending` asks only after an
 * authenticated missing receipt, because a settlement that landed ends the run too.
 */
export const RUN_ENDABLE_PHASES: ReadonlySet<string> = new Set(["prepare_pending", "prepared", "source_pending", "admitted",
  "execute_pending", "completed", ...REMOTE_PHASES]);
/** Nothing of the attempt is running: execute was never sent, or (`completed`) the node's run already finished. */
const NOTHING_RUNNING_PHASES: ReadonlySet<string> = new Set(["prepare_pending", "prepared", "source_pending", "admitted", "completed"]);
/**
 * A node status that proves its record terminal: retired by the Hub's `stale_owner` decision (it sent
 * one cancel for a launched run and released the lease), or ended by its own terminal refusal.
 */
const NODE_TERMINAL_CODES: ReadonlySet<string> = new Set(["stale_owner", "verification_failed", "unsupported", "capacity_exhausted"]);
/** After execute: how long past the task's own timeout the Hub waits for the node to confirm it stopped. */
export const RUN_ENDED_GRACE_MS = 15 * 60_000;
/** Past the task's own timeout plus the grace period since the row last changed: a node that never answers stops holding the station. */
const pastRunEndedBound = (attempt: RetainedCheckpointAttempt, deps: CheckpointDriveDeps): boolean =>
  deps.now() >= attempt.row.updatedAt.getTime() + attempt.request.task.timeout_seconds * 1000 + RUN_ENDED_GRACE_MS;

/**
 * Tell the node the run ended: one `status` for the attempt's exact retained identity. The node asks
 * the Hub's current decision, which now answers `stale_owner`, so it retires its own record: it
 * releases what the record holds and, for a launched run, sends one cancel (BENCH_REGISTERED_LAUNCH.md,
 * "Stale attempts clean up after themselves"). Read-only on the wire; never prepare, never execute.
 */
async function tellNode(attempt: RetainedCheckpointAttempt, deps: CheckpointDriveDeps): Promise<
  { reply: BenchCoordinatorResponse; error?: undefined } | { reply?: undefined; error: string }> {
  const sent = BenchCoordinatorRequest.parse(parseCheckpointJSON(encode(statusRequest(attempt))));
  const meta = { boardId: attempt.row.boardId, runId: attempt.claim.runId, attemptId: attempt.row.attemptId };
  try {
    const result = await deps.request(attempt.profile.target.node_id, BENCH_COORDINATOR_VERB, sent, { timeoutMs: nodeCallTimeoutMs("status") });
    if (!result.ok) {
      const reason = nodeCallReason(result.error ?? "");
      noteCheckpoint("run-ended", reason, meta, new Error(result.error ?? "no error"));
      return { error: reason };
    }
    const serialized = JSON.stringify(result.data);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 262144) return { error: "node.reply.size" };
    return { reply: await parseBenchCoordinatorResponse(encode(serialized), sent) };
  } catch (error) {
    noteCheckpoint("run-ended", "node.reply", meta, error);
    return { error: "node.reply" };
  }
}

/** How SuperBench begins its refusal of a dirty tree, which the bench host's node carries as the held lease's message. */
const DIRTY_MESSAGE = "workspace has uncommitted or untracked files";
/** What a remote attempt's bench host's node said after the attempt ended. */
type RemoteRelease = { state: "released" | "held" | "unknown"; reason: CheckpointRefusalReason; node: Awaited<ReturnType<typeof tellNode>> };

/**
 * A remote attempt that failed or whose run ended (operator ruling, 2026-11-26): its bench host's node
 * is told, and retires its record. A clean tree is checkpointed there (the agent's commits are kept)
 * and the lease released: `released`. A dirty tree is never discarded: SuperBench refuses the release
 * and the lease stays held for an operator, `held`, said once on the card with the operator's steps and
 * at warn here. Anything else (no reply, a reply that proves nothing) is `unknown` and asked again. The
 * attempt's failure stays its own: the checkpoint only frees the lease.
 */
async function remoteRelease(attempt: RetainedCheckpointAttempt, deps: CheckpointDriveDeps, client: SuperpipelineClient | undefined): Promise<RemoteRelease> {
  const node = await tellNode(attempt, deps);
  if (node.reply?.state === "refused" && "code" in node.reply && NODE_TERMINAL_CODES.has(node.reply.code)) return { state: "released", reason: "remote.released", node };
  if (leaseHeld(node.reply)) {
    const message = node.reply && "detail" in node.reply ? node.reply.detail?.message ?? "" : "";
    const reason: CheckpointRefusalReason = message.startsWith(DIRTY_MESSAGE) ? "remote.held_dirty" : "remote.lease_held";
    if (client && node.reply) await sayLeaseHeld(client, attempt, node.reply, attempt.row.phase);
    else log.warn("checkpoint bench lease held after a refused release; operator action needed", { tenantId: attempt.row.tenantId,
      attemptId: attempt.row.attemptId, phase: attempt.row.phase, benchKey: retainedBenchKey(attempt) });
    return { state: "held", reason, node };
  }
  return { state: "unknown", reason: node.reply ? `remote.release.${node.reply.state}` : "remote.release.unreachable", node };
}

/**
 * End an attempt whose run the board definitively ended (checkpoint-run-ended.ts), instead of parking
 * it forever. Never reports a pass, and sends no run verb: a run verb on a run whose card moved on
 * would act on the card where it is now. Two activities are the only writes to the card after its run
 * ended (operator rulings): `stopped_saved`, and a remote stage's held bench (`lease_held`, once per
 * hub process, through remoteRelease).
 *
 * - `failure_pending`: the held failure closes `failed`, outcome `run_ended`, with the board's answer.
 * - Nothing running (before execute, or `completed`): the node is told, and the attempt ends `retired`
 *   (`run_ended`) with the board's answer and the node's reply, whatever it was.
 * - `execute_pending`: an effect is possible. The node is told (it cancels and releases), and the attempt
 *   ends `retired` (`run_ended.stopped`) once its reply proves the record terminal. Until then it parks,
 *   named, and is told again on the next pass; past the task's own timeout plus a grace period it ends
 *   `run_ended.unconfirmed`, so one run the board ended cannot hold the station for ever.
 * - `submission_pending` (after an authenticated missing receipt): `run_ended.unsettled`.
 * - A remote phase: as `execute_pending`, ending `run_ended`; the agent's session is ended and its station detached.
 */
export async function endEndedRun(initial: RetainedCheckpointAttempt, ended: RunEnded,
  deps: CheckpointDriveDeps = defaultDeps, client?: SuperpipelineClient): Promise<DispatchResult> {
  const attempt = initial;
  const phase = attempt.row.phase;
  const ids = { externalRunId: attempt.claim.runId, attemptId: attempt.row.attemptId };
  const meta = { tenantId: attempt.row.tenantId, boardId: attempt.row.boardId, runId: attempt.claim.runId,
    attemptId: attempt.row.attemptId, phase, board: ended.reason };
  try {
    if (phase === "failure_pending") {
      // A remote attempt's bench is released, or held for an operator, before the failure closes: a held
      // one keeps the attempt (and so its station) until an operator has released the lease.
      if (isRemoteProfile(attempt.profile)) {
        const release = await remoteRelease(attempt, deps, client);
        if (release.state === "held" || release.state === "unknown" && !pastRunEndedBound(attempt, deps))
          return parked(attempt, "uncertain", new CheckpointRefused("uncertain", release.reason));
      }
      const closed = (await deps.close(attempt, "run_ended", ended)).attempt;
      const failure = heldFailure(closed);
      log.info("checkpoint run ended on the board; the held failure is closed and nothing was sent to the board", meta);
      return { status: failure.disposition, ...ids, reason: failure.reason };
    }
    if (!RUN_ENDABLE_PHASES.has(phase) && phase !== "submission_pending") throw new CheckpointRefused("source", "retained.phase");
    const remote = (REMOTE_PHASES as readonly string[]).includes(phase);
    // A remote stage's bench is released (a clean tree checkpointed first) or held for an operator.
    const release = remote ? await remoteRelease(attempt, deps, client) : undefined;
    const node = release ? release.node : await tellNode(attempt, deps);
    // A remote stage's agent stops with its run: its session ends and its station is detached (a failed detach is the sweep's).
    if (remote) await endRemoteWork(attempt, deps, "The card's run ended on the board.");
    // A held bench is never timed out: the attempt keeps its station until an operator released the lease.
    if (release?.state === "held") return parked(attempt, "uncertain", new CheckpointRefused("uncertain", release.reason));
    const terminal = release ? release.state === "released"
      : node.reply?.state === "refused" && "code" in node.reply && NODE_TERMINAL_CODES.has(node.reply.code);
    let reason: CheckpointRetirementReason;
    if (phase === "submission_pending") reason = "run_ended.unsettled";
    else if (NOTHING_RUNNING_PHASES.has(phase)) reason = "run_ended";
    else if (terminal) reason = remote ? "run_ended" : "run_ended.stopped";
    // execute_pending committed this row's last update, so updatedAt is when execute was sent at the latest.
    else if (pastRunEndedBound(attempt, deps)) reason = "run_ended.unconfirmed";
    else {
      const why = node.reply ? `${node.reply.state}${"code" in node.reply ? "." + node.reply.code : ""}${leaseHeld(node.reply) ? ".lease_held" : ""}` : undefined;
      // A one-shot attempt's card is not written to (an activity would heartbeat the unbound run), so the log
      // names the operator's path. A remote stage's held bench was said on the card by remoteRelease.
      if (leaseHeld(node.reply)) log.warn("checkpoint run ended on the board, but its bench lease is held after a refused release; operator action needed",
        { ...meta, benchKey: retainedBenchKey(attempt) });
      return parked(attempt, "uncertain", new CheckpointRefused("uncertain", why ? `run_ended.node:${why}` : "run_ended.node_unreachable"));
    }
    const evidence = JSON.stringify({ board: ended, node: node.reply ?? { error: node.error } });
    if (!await deps.retire(attempt, { reason, by: "hub", evidence }))
      return parked(attempt, "stale", new CheckpointRefused("stale", "ledger.raced"));
    log.info("checkpoint run ended on the board; the attempt is retired and the station is free", { ...meta, reason });
    // The one write to the card after its run ended (an operator ruling): when the bench had already pushed
    // this card's work, the card says where it is. A board that refuses it changes nothing here.
    const completion = savedWork(attempt, node.reply);
    if (client && completion) await postCheckpointActivity(client, attempt, "stopped_saved",
      checkpointActivity("stopped_saved", { completion, ended: ended.reason,
        outcome: typeof ended.board.outcome === "string" ? ended.board.outcome : null }));
    return { status: "released", ...ids, reason: `Checkpoint run ended on the board (${ended.reason}); the attempt is retired (${reason})` };
  } catch (error) { return parked(attempt, error instanceof CheckpointRefused ? error.code : "unavailable", error); }
}

/**
 * The work the bench pushed for this card before its run ended: the node's completed reply, else the
 * completion the attempt retained (`completed`, `submission_pending`). Undefined when nothing was pushed.
 */
function savedWork(attempt: RetainedCheckpointAttempt, reply: BenchCoordinatorResponse | undefined): BenchCoordinatorCompletion | undefined {
  if (reply?.state === "completed" && "completion" in reply) return reply.completion;
  if (!attempt.row.completion) return undefined;
  try { return BenchCoordinatorCompletion.parse(parseCheckpointJSON(encode(attempt.row.completion))); }
  catch (error) {
    noteCheckpoint("run-ended", "retained.completion", { attemptId: attempt.row.attemptId }, error);
    return undefined;
  }
}

async function drive(initial: RetainedCheckpointAttempt, client: SuperpipelineClient,
  sendPrepare: boolean, deps: CheckpointDriveDeps): Promise<DispatchResult> {
  let attempt = initial;
  /** Said only by the pass whose compare-and-set committed the phase, after the commit. */
  const say = async (committed: boolean, event: Parameters<typeof checkpointActivity>[0], facts?: Parameters<typeof checkpointActivity>[1]) => {
    if (committed) await postCheckpointActivity(client, attempt, event, checkpointActivity(event, facts));
  };
  let sendExecute = false; let sendSettlement = false;
  const service = deps.service(attempt.profile);
  try {
    // There are eight durable phases. No polling loop, timer or background
    // child is created by the Hub; subsequent cycles resume this same row.
    for (let step = 0; step < 8; step++) {
      await deps.authority(attempt);
      switch (attempt.row.phase) {
        case "prepare_pending": {
          await client.heartbeat(attempt.claim);
          let response = await exchange(attempt, sendPrepare ? attempt.row.prepareRequest : statusRequest(attempt), deps);
          if (!sendPrepare && (response.state === "unknown" || response.state === "pending")) {
            // The node never finished this prepare. `unknown`: it holds the exact prepare but never
            // resolved it (its own current check or read-only choice failed), so it invoked no
            // source effect. `pending`: it resolved it, but its launch stopped part way, for
            // instance on its own current check after the reservation, before any bench call.
            // Only the identical retained bytes are re-sent: the node accepts no other prepare for
            // the attempt, resolves it once, hands off its effects once, and a registered launch
            // resumes its journaled steps, never sending one twice. Both sides gate it on current.
            response = await exchange(attempt, attempt.row.prepareRequest, deps);
          }
          sendPrepare = false;
          if (response.state !== "prepared") {
            const ruling = capped(classifyCheckpointRefusal(attempt.row.phase, response), attempt, deps);
            if (!ruling) return parkedReply(attempt, response);
            attempt = (await deps.fail(attempt, { ...ruling, evidence: JSON.stringify(response) })).attempt; break;
          }
          const next = await deps.advance(attempt, { phase: "prepared", prepared: canonicalCheckpoint(response.source) });
          attempt = next.attempt; await say(next.send, "prepared"); break;
        }
        case "prepared": {
          const { source } = await retainedCheckpointSource(attempt);
          attempt = (await deps.advance(attempt, { phase: "source_pending", source: canonicalCheckpoint(source) })).attempt;
          break;
        }
        case "source_pending": {
          // Source admission alone is idempotent, contains no child authority,
          // and is always replayed with the exact retained whole source.
          await client.context(attempt.claim.runId, attempt.claim);
          await client.heartbeat(attempt.claim);
          const { source } = await retainedCheckpointSource(attempt);
          if (attempt.row.source !== canonicalCheckpoint(source)) throw new CheckpointRefused("source", "retained.source");
          await deps.authority(attempt);
          const receipt = await service.admit(attempt.claim, source);
          await deps.authority(attempt);
          attempt = (await deps.advance(attempt, { phase: "admitted", sourceReceipt: canonicalCheckpoint(receipt) })).attempt;
          break;
        }
        case "admitted": {
          const { prepared, source } = await retainedCheckpointSource(attempt);
          if (!attempt.row.sourceReceipt) throw new CheckpointRefused("source", "retained.source_receipt");
          const receipt = parseSourceReceipt(encode(attempt.row.sourceReceipt));
          if (receipt.runId !== attempt.claim.runId || receipt.leaseEpoch !== attempt.claim.leaseEpoch ||
            receipt.sourceDigest !== await checkpointDigest(source)) throw new CheckpointRefused("source", "retained.source_receipt");
          requireActiveSource(await service.source(attempt.claim), source);
          await deps.authority(attempt);
          // A remote stage never executes: its station's agent attaches and works in the bench instead.
          if (isRemoteProfile(attempt.profile)) { attempt = (await deps.advance(attempt, { phase: "attach_pending" })).attempt; break; }
          const execution = JSON.stringify(BenchCoordinatorRequest.parse({ version: attempt.request.version, operation: "execute",
            identity: attempt.request.identity, target: attempt.request.target, binding_sha256: prepared.binding_sha256,
            source_receipt: { run_id: receipt.runId, epoch: receipt.leaseEpoch, source_digest: receipt.sourceDigest, admitted_at: receipt.admittedAt } }));
          const next = await deps.advance(attempt, { phase: "execute_pending", executeRequest: execution, executeSHA256: hash(execution) });
          attempt = next.attempt; sendExecute = next.send; await say(next.send, "running"); break;
        }
        case "execute_pending": {
          if (!attempt.row.executeRequest || hash(attempt.row.executeRequest) !== attempt.row.executeSHA256)
            throw new CheckpointRefused("source", "retained.execute");
          await client.heartbeat(attempt.claim);
          const response = await exchange(attempt, sendExecute ? attempt.row.executeRequest : statusRequest(attempt), deps);
          sendExecute = false;
          if (response.state !== "completed") {
            // A worker crash ends here: the node journaled the run refused and released its lease, so
            // no later status can ever complete it. Held first, then the board is told (failure_pending).
            const ruling = capped(classifyCheckpointRefusal(attempt.row.phase, response), attempt, deps);
            if (!ruling) return parkedReply(attempt, response);
            attempt = (await deps.fail(attempt, { ...ruling, evidence: JSON.stringify(response) })).attempt; break;
          }
          // Strict DTO validation precedes storage; report joins separately
          // require the exact original start, task outcome and final vector. The build reads only
          // immutable inputs, so a refusal here always recurs: the run finished but cannot become a
          // pass. It ends the attempt failed, as a definite node refusal does, never parked forever.
          try { await buildCheckpointSettlement(attempt, response.completion); }
          catch (error) {
            const ruling = classifySettlementRefusal(error, response.completion);
            if (!ruling) throw error;
            attempt = (await deps.fail(attempt, { ...ruling, evidence: JSON.stringify(response) })).attempt; break;
          }
          const done = await deps.advance(attempt, { phase: "completed", completion: canonicalCheckpoint(response.completion) });
          attempt = done.attempt;
          await say(done.send, "completed");
          await say(done.send, "pushed", { completion: response.completion });
          break;
        }
        case "completed": {
          if (!attempt.row.completion) throw new CheckpointRefused("source", "retained.completion");
          const { source } = await retainedCheckpointSource(attempt);
          requireActiveSource(await service.source(attempt.claim), source);
          await deps.authority(attempt);
          const report = await buildCheckpointSettlement(attempt, parseCheckpointContextJSON(encode(attempt.row.completion)));
          const next = await deps.advance(attempt, { phase: "submission_pending", settlementBody: report.body, settlementSHA256: report.sha256 });
          attempt = next.attempt; sendSettlement = next.send; await say(next.send, "submitting"); break;
        }
        case "submission_pending": {
          if (!attempt.row.settlementBody || hash(attempt.row.settlementBody) !== attempt.row.settlementSHA256)
            throw new CheckpointRefused("source", "retained.settlement");
          const body = attempt.row.settlementBody;
          // Recover an existing effect first. Only the exact authenticated
          // missing-receipt response permits a new settlement attempt.
          let receipt = sendSettlement ? undefined : await service.receipt(attempt.claim, body);
          if (!receipt && !sendSettlement) {
            // The board holds no receipt (an authenticated CHECKPOINT_RECEIPT_MISSING). If it also ended
            // the run, the settlement can never land: end the attempt instead of parking it forever.
            const ended = await readRunEnded(client, attempt.claim);
            if (ended) return endEndedRun(attempt, ended, deps, client);
          }
          if (!receipt) {
            // T37 settlement is idempotent by the complete retained submission.
            // This reconciles a crash before POST, or an uncertain POST whose
            // receipt is still absent. It never repeats Prepare or Execute.
            await client.context(attempt.claim.runId, attempt.claim);
            await client.heartbeat(attempt.claim);
            const { source } = await retainedCheckpointSource(attempt);
            if (!attempt.row.completion) throw new CheckpointRefused("source", "retained.completion");
            const report = await buildCheckpointSettlement(attempt, parseCheckpointContextJSON(encode(attempt.row.completion)));
            if (report.body !== body || report.sha256 !== attempt.row.settlementSHA256) throw new CheckpointRefused("source", "retained.settlement");
            const snapshot = await service.source(attempt.claim);
            requireActiveSource(snapshot, source);
            await deps.authority(attempt);
            requireActiveSource(snapshot, source);
            receipt = await service.settle(attempt.claim, body);
          }
          sendSettlement = false;
          if (!receipt) return parked(attempt, "uncertain", new CheckpointRefused("uncertain", "service.receipt.absent"));
          await deps.authority(attempt);
          attempt = (await deps.advance(attempt, { phase: "reported", settlementReceipt: canonicalCheckpoint(receipt) })).attempt;
          // Settled, and the bench stays: one card keeps one bench from stage to stage and across review
          // bounces. It is cleared when the card is done, cancelled or dormant (bench-clearing.ts), never here.
          break;
        }
        case "attach_pending": case "working": case "finish_pending": {
          const remote = await driveRemotePhase(attempt, client, deps);
          if ("result" in remote) return remote.result;
          attempt = remote.attempt; break;
        }
        case "failure_pending": {
          // Said on the card while the lease is still ours, then the run is told. A lost reply is told
          // again on the next pass; a run the board already ended (STALE_LEASE) is not ours to tell.
          const failure = heldFailure(attempt);
          // Asked first: a run the board ended takes no verb. Its card may have moved on, and `fail` or
          // `release` on that run would act on the card where it is now.
          const ended = await readRunEnded(client, attempt.claim);
          if (ended) return endEndedRun(attempt, ended, deps, client);
          await postCheckpointActivity(client, attempt, failure.disposition,
            checkpointActivity(failure.disposition, { phase: failure.phase, code: failure.code, reason: failure.reason }));
          // The node ended its record but could not release the bench: say what an operator must do, while the lease is ours.
          const evidence = heldEvidence(failure);
          if (evidence && leaseHeld(evidence)) await sayLeaseHeld(client, attempt, evidence, failure.phase);
          // A remote stage's bench host's node is told while the run is still ours, so a held bench is said on the card.
          const release = isRemoteProfile(attempt.profile) ? await remoteRelease(attempt, deps, client) : undefined;
          let outcome: "fail" | "release" | "lease_ended";
          try {
            if (failure.disposition === "failed") await client.fail(attempt.claim, failure.reason);
            else await client.release(attempt.claim);
            outcome = failure.disposition === "failed" ? "fail" : "release";
          } catch (error) {
            if (!isLeaseSuperseded(error)) throw error;
            outcome = "lease_ended";
          }
          // The board has the failure; a bench not yet released keeps the attempt open (the run-ended branch asks again).
          if (release && release.state !== "released") return parked(attempt, "uncertain", new CheckpointRefused("uncertain", release.reason));
          attempt = (await deps.close(attempt, outcome)).attempt;
          // A capacity refusal holds the station's checkpoint claims for a while; anything else forgets the card.
          if (failure.code === "capacity_exhausted") deps.capacity?.refused(capacityCard(attempt.claim), failure.disposition === "failed");
          else deps.capacity?.clear(capacityCard(attempt.claim));
          break;
        }
        case "failed": {
          const failure = heldFailure(attempt);
          return { status: failure.disposition, externalRunId: attempt.claim.runId, attemptId: attempt.row.attemptId,
            reason: failure.reason };
        }
        case "reported": {
          if (!attempt.row.settlementReceipt || !attempt.row.settlementBody) throw new CheckpointRefused("source", "retained.receipt");
          checkedCheckpointReceipt(encode(attempt.row.settlementReceipt), attempt.row.settlementBody, attempt.profile.reporterPrincipalId);
          deps.capacity?.clear(capacityCard(attempt.claim));
          return { status: "reported", externalRunId: attempt.claim.runId, attemptId: attempt.row.attemptId };
        }
        default: throw new CheckpointRefused("source", "retained.phase");
      }
    }
    return attempt.row.phase === "reported" ? { status: "reported", externalRunId: attempt.claim.runId,
      attemptId: attempt.row.attemptId } : parked(attempt, "uncertain", new CheckpointRefused("uncertain", "drive.steps"));
  } catch (error) { return parked(attempt, error instanceof CheckpointRefused ? error.code : "unavailable", error); }
}
