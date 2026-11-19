/** Proposed real broker/service choreography. Every uncertain effect stays on
 * its original durable attempt; neither a child nor a request ID is replaced.
 */
import { createHash } from "node:crypto";
import { createLogger } from "../../utils/logger";
import { BENCH_COORDINATOR_VERB, BenchCoordinatorRequest, parseBenchCoordinatorResponse,
  type BenchCoordinatorResponse } from "@agentpod/contract";
import { request as nodeRequest } from "../broker";
import { canonicalCheckpoint, checkpointDigest, parseCheckpointJSON, parseCheckpointContextJSON } from "./checkpoint-json";
import { advanceCheckpointAttempt, type RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { retainedCheckpointSource } from "./checkpoint-current-decision";
import { readCheckpointAuthority } from "./checkpoint-current";
import { requireInstalledCheckpointProfile } from "./checkpoint-profiles";
import { CheckpointRefused } from "./checkpoint-profile";
import { createCheckpointServiceClient } from "./checkpoint-service-client";
import { parseSourceReceipt, requireActiveSource } from "./checkpoint-source";
import { buildCheckpointSettlement } from "./checkpoint-report";
import { checkpointRefusal } from "./checkpoint-refusal";
import { checkedCheckpointReceipt } from "./checkpoint-settlement-data";
import type { SuperpipelineClient } from "./superpipeline";
import type { DispatchResult } from "./dispatch-types";
import { createQuietLog, type QuietLog } from "./quiet-log";
import { errorFacts, nodeCallReason } from "./checkpoint-log";

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
const parked = (attempt: RetainedCheckpointAttempt, code: CheckpointRefused["code"] = "uncertain", error?: unknown): DispatchResult => {
  // The error that parked it, by class and redacted message (a refusal's own cause when it replaced one).
  const cause = error instanceof CheckpointRefused ? error.cause : error;
  const facts = cause === undefined ? undefined : errorFacts(cause);
  const reason = error instanceof CheckpointRefused ? error.reason : undefined;
  parkedLog([attempt.row.attemptId, attempt.row.phase, code, reason ?? "", facts?.errorClass ?? ""].join("\0"),
    "checkpoint dispatch parked for reconciliation", {
    tenantId: attempt.row.tenantId, boardId: attempt.row.boardId, runId: attempt.claim.runId,
    attemptId: attempt.row.attemptId, phase: attempt.row.phase, code, ...(reason === undefined ? {} : { reason }), ...facts });
  return { status: "unreported", externalRunId: attempt.claim.runId, attemptId: attempt.row.attemptId,
    reason: "Checkpoint dispatch requires reconciliation" };
};

/** Named terminal refusals keep the row parked but say why; nothing is re-sent. */
function refusedOrParked(attempt: RetainedCheckpointAttempt, response: BenchCoordinatorResponse): DispatchResult {
  const refusal = checkpointRefusal(response, { externalRunId: attempt.claim.runId, attemptId: attempt.row.attemptId });
  if (!refusal) return parked(attempt);
  log.warn("checkpoint dispatch refused", { tenantId: attempt.row.tenantId, boardId: attempt.row.boardId,
    runId: attempt.claim.runId, attemptId: attempt.row.attemptId, phase: attempt.row.phase, code: "capacity_exhausted" });
  return refusal;
}

async function current(attempt: RetainedCheckpointAttempt): Promise<void> {
  requireInstalledCheckpointProfile(attempt.profile);
  const authority = await readCheckpointAuthority(attempt.profile);
  requireInstalledCheckpointProfile(attempt.profile);
  if (canonicalCheckpoint(authority) !== attempt.row.authority) throw new CheckpointRefused("stale");
}

/** The Hub's effects, injectable so the phase logic can be tested without a broker or ledger database. */
export interface CheckpointDriveDeps {
  authority(attempt: RetainedCheckpointAttempt): Promise<void>;
  request: typeof nodeRequest;
  service: typeof createCheckpointServiceClient;
}
const defaultDeps: CheckpointDriveDeps = { authority: current, request: nodeRequest, service: createCheckpointServiceClient };

async function exchange(attempt: RetainedCheckpointAttempt, raw: string, deps: CheckpointDriveDeps): Promise<BenchCoordinatorResponse> {
  const sent = BenchCoordinatorRequest.parse(parseCheckpointJSON(encode(raw)));
  await deps.authority(attempt);
  // Broker correlates replies to the authenticated selected enrolled Node.
  // A timeout never causes this function to repeat the request.
  const result = await deps.request(attempt.profile.target.node_id, BENCH_COORDINATOR_VERB, sent, { timeoutMs: 15_000 });
  if (!result.ok) throw new CheckpointRefused("uncertain", nodeCallReason(result.error ?? ""), new Error(result.error ?? "no error"));
  const serialized = JSON.stringify(result.data);
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 262144) throw new CheckpointRefused("source");
  const response = await parseBenchCoordinatorResponse(encode(serialized), sent);
  await deps.authority(attempt);
  return response;
}

function statusRequest(attempt: RetainedCheckpointAttempt): string {
  return JSON.stringify(BenchCoordinatorRequest.parse({ version: attempt.request.version, operation: "status",
    identity: attempt.request.identity, target: attempt.request.target }));
}

/** One bounded pass through retained phases. sendPrepare is true only for the
 * successful original INSERT, never a lookup, restart or speculative retry.
 */
export async function driveCheckpointAttempt(initial: RetainedCheckpointAttempt, client: SuperpipelineClient,
  sendPrepare = false, deps: CheckpointDriveDeps = defaultDeps): Promise<DispatchResult> {
  let attempt = initial;
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
          const response = await exchange(attempt, sendPrepare ? attempt.row.prepareRequest : statusRequest(attempt), deps);
          sendPrepare = false;
          if (response.state !== "prepared") return refusedOrParked(attempt, response);
          const next = await advanceCheckpointAttempt(attempt, { phase: "prepared", prepared: canonicalCheckpoint(response.source) });
          attempt = next.attempt; break;
        }
        case "prepared": {
          const { source } = await retainedCheckpointSource(attempt);
          attempt = (await advanceCheckpointAttempt(attempt, { phase: "source_pending", source: canonicalCheckpoint(source) })).attempt;
          break;
        }
        case "source_pending": {
          // Source admission alone is idempotent, contains no child authority,
          // and is always replayed with the exact retained whole source.
          await client.context(attempt.claim.runId, attempt.claim);
          await client.heartbeat(attempt.claim);
          const { source } = await retainedCheckpointSource(attempt);
          if (attempt.row.source !== canonicalCheckpoint(source)) throw new CheckpointRefused("source");
          await deps.authority(attempt);
          const receipt = await service.admit(attempt.claim, source);
          await deps.authority(attempt);
          attempt = (await advanceCheckpointAttempt(attempt, { phase: "admitted", sourceReceipt: canonicalCheckpoint(receipt) })).attempt;
          break;
        }
        case "admitted": {
          const { prepared, source } = await retainedCheckpointSource(attempt);
          if (!attempt.row.sourceReceipt) throw new CheckpointRefused("source");
          const receipt = parseSourceReceipt(encode(attempt.row.sourceReceipt));
          if (receipt.runId !== attempt.claim.runId || receipt.leaseEpoch !== attempt.claim.leaseEpoch ||
            receipt.sourceDigest !== await checkpointDigest(source)) throw new CheckpointRefused("source");
          requireActiveSource(await service.source(attempt.claim), source);
          await deps.authority(attempt);
          const execution = JSON.stringify(BenchCoordinatorRequest.parse({ version: attempt.request.version, operation: "execute",
            identity: attempt.request.identity, target: attempt.request.target, binding_sha256: prepared.binding_sha256,
            source_receipt: { run_id: receipt.runId, epoch: receipt.leaseEpoch, source_digest: receipt.sourceDigest, admitted_at: receipt.admittedAt } }));
          const next = await advanceCheckpointAttempt(attempt, { phase: "execute_pending", executeRequest: execution, executeSHA256: hash(execution) });
          attempt = next.attempt; sendExecute = next.send; break;
        }
        case "execute_pending": {
          if (!attempt.row.executeRequest || hash(attempt.row.executeRequest) !== attempt.row.executeSHA256)
            throw new CheckpointRefused("source");
          await client.heartbeat(attempt.claim);
          const response = await exchange(attempt, sendExecute ? attempt.row.executeRequest : statusRequest(attempt), deps);
          sendExecute = false;
          if (response.state !== "completed") return refusedOrParked(attempt, response);
          // Strict DTO validation precedes storage; report joins separately
          // require the exact original start, task outcome and final vector.
          await buildCheckpointSettlement(attempt, response.completion);
          attempt = (await advanceCheckpointAttempt(attempt, { phase: "completed", completion: canonicalCheckpoint(response.completion) })).attempt;
          break;
        }
        case "completed": {
          if (!attempt.row.completion) throw new CheckpointRefused("source");
          const { source } = await retainedCheckpointSource(attempt);
          requireActiveSource(await service.source(attempt.claim), source);
          await deps.authority(attempt);
          const report = await buildCheckpointSettlement(attempt, parseCheckpointContextJSON(encode(attempt.row.completion)));
          const next = await advanceCheckpointAttempt(attempt, { phase: "submission_pending", settlementBody: report.body, settlementSHA256: report.sha256 });
          attempt = next.attempt; sendSettlement = next.send; break;
        }
        case "submission_pending": {
          if (!attempt.row.settlementBody || hash(attempt.row.settlementBody) !== attempt.row.settlementSHA256)
            throw new CheckpointRefused("source");
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
            if (!attempt.row.completion) throw new CheckpointRefused("source");
            const report = await buildCheckpointSettlement(attempt, parseCheckpointContextJSON(encode(attempt.row.completion)));
            if (report.body !== body || report.sha256 !== attempt.row.settlementSHA256) throw new CheckpointRefused("source");
            const snapshot = await service.source(attempt.claim);
            requireActiveSource(snapshot, source);
            await deps.authority(attempt);
            requireActiveSource(snapshot, source);
            receipt = await service.settle(attempt.claim, body);
          }
          sendSettlement = false;
          if (!receipt) return parked(attempt);
          await deps.authority(attempt);
          attempt = (await advanceCheckpointAttempt(attempt, { phase: "reported", settlementReceipt: canonicalCheckpoint(receipt) })).attempt;
          break;
        }
        case "reported": {
          if (!attempt.row.settlementReceipt || !attempt.row.settlementBody) throw new CheckpointRefused("source");
          checkedCheckpointReceipt(encode(attempt.row.settlementReceipt), attempt.row.settlementBody, attempt.profile.reporterPrincipalId);
          return { status: "reported", externalRunId: attempt.claim.runId, attemptId: attempt.row.attemptId };
        }
        default: throw new CheckpointRefused("source");
      }
    }
    return attempt.row.phase === "reported" ? { status: "reported", externalRunId: attempt.claim.runId,
      attemptId: attempt.row.attemptId } : parked(attempt);
  } catch (error) { return parked(attempt, error instanceof CheckpointRefused ? error.code : "unavailable", error); }
}
