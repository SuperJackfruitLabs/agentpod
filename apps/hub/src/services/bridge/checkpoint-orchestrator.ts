/** Proposed real broker/service choreography. Every uncertain effect stays on
 * its original durable attempt; neither a child nor a request ID is replaced.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { createLogger } from "../../utils/logger";
import { BENCH_COORDINATOR_VERB, BenchCoordinatorRequest, parseBenchCoordinatorResponse,
  type BenchCoordinatorResponse } from "@agentpod/contract";
import { request as nodeRequest } from "../broker";
import { canonicalCheckpoint, checkpointDigest, parseCheckpointJSON, parseCheckpointContextJSON } from "./checkpoint-json";
import { advanceCheckpointAttempt, closeFailedCheckpointAttempt, failCheckpointAttempt, type CheckpointFailure,
  type RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { retainedCheckpointSource } from "./checkpoint-current-decision";
import { readCheckpointAuthority } from "./checkpoint-current";
import { requireInstalledCheckpointProfile } from "./checkpoint-profiles";
import { CheckpointRefused, type CheckpointRefusalReason } from "./checkpoint-profile";
import { createCheckpointServiceClient } from "./checkpoint-service-client";
import { parseSourceReceipt, requireActiveSource } from "./checkpoint-source";
import { buildCheckpointSettlement } from "./checkpoint-report";
import { classifyCheckpointRefusal, classifySettlementRefusal } from "./checkpoint-refusal";
import { checkedCheckpointReceipt } from "./checkpoint-settlement-data";
import { isLeaseSuperseded, type SuperpipelineClient } from "./superpipeline";
import type { DispatchResult } from "./dispatch-types";
import { createQuietLog, type QuietLog } from "./quiet-log";
import { errorFacts, nodeCallReason } from "./checkpoint-log";
import { nodeCallTimeoutMs } from "./checkpoint-node-call";
import { checkpointActivity, postCheckpointActivity } from "./checkpoint-activity";

const encode = (raw: string) => new TextEncoder().encode(raw);
const hash = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");
const log = createLogger("bridge-checkpoint");
/**
 * A parked attempt is re-checked every backoff until it resolves, so its line is said once per
 * attempt, phase and code, then once per interval with a count, never once per re-check.
 */
let parkedLog = createQuietLog((message, meta) => log.warn(message, meta));
/** Test seam: a fresh rate limit with its own clock. Returns the restore. */
export function setParkedLogForTests(next: QuietLog): () => void {
  const prior = parkedLog;
  parkedLog = next;
  return () => { parkedLog = prior; };
}
/** Why each parked result parked, so the drive can say it on the card once. */
const parkFacts = new WeakMap<DispatchResult, { phase: string; code: string; reason?: string }>();
// Every park passes the error that names it: there is no default, so a call site cannot park unnamed.
const parked = (attempt: RetainedCheckpointAttempt, code: CheckpointRefused["code"], error: unknown): DispatchResult => {
  // The error that parked it, by class and redacted message (a refusal's own cause when it replaced one).
  const cause = error instanceof CheckpointRefused ? error.cause : error;
  const facts = cause === undefined ? undefined : errorFacts(cause);
  // A refusal or error that names nothing still parks named: `drive.error`, with its class in the facts.
  const reason: CheckpointRefusalReason = (error instanceof CheckpointRefused ? error.reason : undefined) ?? "drive.error";
  parkedLog([attempt.row.attemptId, attempt.row.phase, code, reason, facts?.errorClass ?? ""].join("\0"),
    "checkpoint dispatch parked for reconciliation", {
    tenantId: attempt.row.tenantId, boardId: attempt.row.boardId, runId: attempt.claim.runId,
    attemptId: attempt.row.attemptId, phase: attempt.row.phase, code, reason, ...facts });
  const result: DispatchResult = { status: "unreported", externalRunId: attempt.claim.runId, attemptId: attempt.row.attemptId,
    reason: "Checkpoint dispatch requires reconciliation" };
  parkFacts.set(result, { phase: attempt.row.phase, code, reason });
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
  const why = response.state === "refused" && "code" in response ? `refused.${response.code}` : response.state;
  return parked(attempt, "uncertain", new CheckpointRefused("uncertain", `node.state:${why}`));
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

async function current(attempt: RetainedCheckpointAttempt): Promise<void> {
  requireInstalledCheckpointProfile(attempt.profile);
  const authority = await readCheckpointAuthority(attempt.profile);
  requireInstalledCheckpointProfile(attempt.profile);
  if (canonicalCheckpoint(authority) !== attempt.row.authority) throw new CheckpointRefused("stale", "authority.changed");
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
}
const defaultDeps: CheckpointDriveDeps = { authority: current, request: nodeRequest, service: createCheckpointServiceClient,
  advance: advanceCheckpointAttempt, fail: failCheckpointAttempt, close: closeFailedCheckpointAttempt };

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
  // A park is said on the card once per attempt, phase and reason; the re-checks stay quiet.
  const facts = parkFacts.get(result);
  if (facts) await postCheckpointActivity(client, initial, `parked:${facts.phase}:${facts.code}:${facts.reason ?? ""}`,
    checkpointActivity("parked", facts));
  return result;
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
            const ruling = classifyCheckpointRefusal(attempt.row.phase, response);
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
            const ruling = classifyCheckpointRefusal(attempt.row.phase, response);
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
          break;
        }
        case "failure_pending": {
          // Said on the card while the lease is still ours, then the run is told. A lost reply is told
          // again on the next pass; a run the board already ended (STALE_LEASE) is not ours to tell.
          const failure = heldFailure(attempt);
          await postCheckpointActivity(client, attempt, failure.disposition,
            checkpointActivity(failure.disposition, { phase: failure.phase, code: failure.code, reason: failure.reason }));
          let outcome: "fail" | "release" | "lease_ended";
          try {
            if (failure.disposition === "failed") await client.fail(attempt.claim, failure.reason);
            else await client.release(attempt.claim);
            outcome = failure.disposition === "failed" ? "fail" : "release";
          } catch (error) {
            if (!isLeaseSuperseded(error)) throw error;
            outcome = "lease_ended";
          }
          attempt = (await deps.close(attempt, outcome)).attempt;
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
          return { status: "reported", externalRunId: attempt.claim.runId, attemptId: attempt.row.attemptId };
        }
        default: throw new CheckpointRefused("source", "retained.phase");
      }
    }
    return attempt.row.phase === "reported" ? { status: "reported", externalRunId: attempt.claim.runId,
      attemptId: attempt.row.attemptId } : parked(attempt, "uncertain", new CheckpointRefused("uncertain", "drive.steps"));
  } catch (error) { return parked(attempt, error instanceof CheckpointRefused ? error.code : "unavailable", error); }
}
