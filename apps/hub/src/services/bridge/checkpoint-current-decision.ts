/** Proposed authenticated Node callback. No request hash or node statement creates authority. */
import { createHash } from "node:crypto";
import { BenchCoordinatorCurrentResponse, BenchCoordinatorPrepared, benchCoordinatorBindingDigest, parseBenchCoordinatorCurrentRequest,
  parseBenchCoordinatorRequest } from "@agentpod/contract";
import { canonicalCheckpoint, checkpointDigest, parseCheckpointJSON } from "./checkpoint-json";
import { readCheckpointAttempt, type RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { checkpointProfileId, claimedRepositories, CheckpointRefused } from "./checkpoint-profile";
import { checkpointProfileSuperseded, requireInstalledCheckpointProfile } from "./checkpoint-profiles";
import { checkpointAuthorityMatches, readCheckpointAuthority } from "./checkpoint-current";
import { checkpointAgentClient } from "./checkpoint-agent-client";
import { noteCheckpoint } from "./checkpoint-log";
import { createCheckpointServiceClient } from "./checkpoint-service-client";
import { parseCheckpointSource, parseSourceReceipt, requireActiveSource, type CheckpointSourceSnapshot } from "./checkpoint-source";
import { readRunEnded } from "./checkpoint-run-ended";
import { remoteDecision } from "./checkpoint-remote-state";

const encode = (raw: string) => new TextEncoder().encode(raw);
const hash = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");

/** Only the validated selected-node preparation can supply these source facts. */
export async function retainedCheckpointSource(attempt: RetainedCheckpointAttempt) {
  if (!attempt.row.prepared) throw new CheckpointRefused("source", "retained.prepared");
  const prepared = BenchCoordinatorPrepared.parse(parseCheckpointJSON(encode(attempt.row.prepared)));
  const b = prepared.binding; const i = b.identity;
  // The pins of the claim's own repositories: the stage's whole list, or the card's choice.
  let pins: ReturnType<typeof claimedRepositories>;
  try { pins = claimedRepositories(attempt.profile, attempt.claim); }
  catch (error) { throw new CheckpointRefused("source", "retained.binding", error); }
  if (await benchCoordinatorBindingDigest(b) !== prepared.binding_sha256 || prepared.checkpoint_repository !== attempt.claim.policy.checkpointRepository ||
    canonicalCheckpoint(i) !== canonicalCheckpoint(attempt.request.identity) ||
    b.host_id !== attempt.profile.target.host_id || b.worker_sha256 !== attempt.profile.target.worker_sha256 ||
    b.members.length !== pins.length || b.members.some((m, index) => {
      const pin = pins[index];
      return !pin || m.name !== pin.name || m.repository_sha256 !== pin.repositorySHA256 || m.object_format !== pin.objectFormat;
    })) throw new CheckpointRefused("source", "retained.binding");
  return { prepared, source: parseCheckpointSource({ binding: { boardId: i.board_id, cardId: i.card_id,
    stageKey: i.stage_id, runId: i.run_id, leaseEpoch: i.epoch, agentId: i.agent_id, stationId: i.station_id,
    nodeId: i.node_id, attemptId: i.attempt_id }, start: b.sources.map((m) => ({ name: m.name, commit: m.commit })),
    benchKey: b.bench_key, benchId: b.bench_id, requestId: prepared.request_id,
    sourceRequestSha256: prepared.source_request_sha256, workerContextSha256: b.context_sha256 }) };
}

type AttemptRow = RetainedCheckpointAttempt["row"];
/**
 * The second read of the attempt row. stale_owner lets a Node retire its own
 * attempt, so it is reserved for a definite change: the row is gone, or its run,
 * epoch, attempt or owner authority differ. Any other difference (the Hub moving
 * the row on between its two reads) is a race and stays retryable.
 */
export function finalRowDecision(initial: AttemptRow, final: AttemptRow | undefined): "current" | "stale_owner" | "unavailable" {
  if (!final || final.tenantId !== initial.tenantId || final.attemptId !== initial.attemptId || final.runId !== initial.runId ||
    final.leaseEpoch !== initial.leaseEpoch || final.authority !== initial.authority) return "stale_owner";
  return JSON.stringify(final) === JSON.stringify(initial) ? "current" : "unavailable";
}

/**
 * Whether the board definitively ended the attempt's run. Asked only after a decision failed on an
 * attempt whose identity matched; any failure to ask is not an answer. Injectable for tests.
 */
export type RunEndedCheck = (attempt: RetainedCheckpointAttempt) => Promise<boolean>;
const boardEndedRun: RunEndedCheck = async (attempt) =>
  (await readRunEnded(await checkpointAgentClient(attempt.profile), attempt.claim)) !== undefined;

/**
 * What a decision that failed answers. A run the board definitively ended (a card moved off the
 * stage, cancelled, deleted or reclaimed) never comes back, so `unavailable` would have the node
 * retry for ever: the staging sequence where every decision refused `context` and the node answered
 * refused/unavailable. `stale_owner` lets the node retire its own record: it releases what the record
 * holds and cancels a launched run, and never runs. Only the board's explicit answer counts, and only
 * for a request already proven to be for exactly this attempt; a board that cannot be asked, or an
 * unmatched request, stays `unavailable`. Exported for tests.
 */
export async function failedDecision<A extends { row: { attemptId: string }; claim: { runId: string } }>(nodeId: string,
  matched: A | undefined, runEnded: (attempt: A) => Promise<boolean>): Promise<"stale_owner" | "unavailable"> {
  if (!matched) return "unavailable";
  try {
    if (!await runEnded(matched)) return "unavailable";
  } catch (error) {
    noteCheckpoint("current-decision", "decision.run_ended.unread", { nodeId }, error);
    return "unavailable";
  }
  noteCheckpoint("current-decision", "decision.run_ended", { nodeId, runId: matched.claim.runId, attemptId: matched.row.attemptId });
  return "stale_owner";
}

export async function checkpointCurrentDecision(nodeId: string, raw: Uint8Array, runEnded: RunEndedCheck = boardEndedRun) {
  const request = parseBenchCoordinatorCurrentRequest(raw);
  const base = { version: request.version, nonce: request.nonce, request_sha256: hash(raw) };
  const refused = (code: "unauthorized" | "stale_owner" | "unavailable" | "pending" | "invalid") => {
    const now = Date.now();
    return BenchCoordinatorCurrentResponse.parse({ ...base, issued_at_ms: now, expires_at_ms: now + 1000, decision: "refused", code });
  };
  /** The attempt, once the request is proven to be for exactly it. */
  let matched: RetainedCheckpointAttempt | undefined;
  try {
    if (nodeId !== request.identity.node_id || nodeId !== request.target.node_id) return refused("unauthorized");
    const attempt = await readCheckpointAttempt(request.identity.tenant_id, request.identity.attempt_id);
    if (!attempt || canonicalCheckpoint(request.identity) !== canonicalCheckpoint(attempt.request.identity) ||
      canonicalCheckpoint(request.target) !== canonicalCheckpoint(attempt.request.target) ||
      request.profile_id !== checkpointProfileId(attempt.profile) || request.prepare_request_sha256 !== attempt.row.prepareSHA256)
      return refused("stale_owner");
    matched = attempt;
    // A loaded installation that replaced this attempt's profile is a definite change: no installed
    // profile can ever authorize it again. stale_owner lets the node retire its own record (release
    // what it holds, never run). An unreadable installation stays `unavailable` below.
    if (attempt.row.phase === "retired" || checkpointProfileSuperseded(attempt.profile)) return refused("stale_owner");
    requireInstalledCheckpointProfile(attempt.profile);
    const authority = await readCheckpointAuthority(attempt.profile);
    if (!checkpointAuthorityMatches(authority, attempt.row.authority)) return refused("stale_owner");
    let expires = Date.now() + 5000;
    let active: { snapshot: CheckpointSourceSnapshot; source: ReturnType<typeof parseCheckpointSource> } | undefined;
    // A remote stage's attach or finish (the bench node's remote-v1 launch) is decided as execute is: on
    // the admitted source, the retained binding and the exact request bytes the Hub retained for it.
    const remote = request.phase === "attach" || request.phase === "finish" ? request.phase : undefined;
    if (request.phase === "execute" || remote || attempt.row.sourceReceipt !== null) {
      const { prepared, source } = await retainedCheckpointSource(attempt);
      if (!attempt.row.source || !attempt.row.sourceReceipt || canonicalCheckpoint(source) !== attempt.row.source)
        return refused("pending");
      const receipt = parseSourceReceipt(encode(attempt.row.sourceReceipt));
      const digest = await checkpointDigest(source);
      if (receipt.runId !== attempt.claim.runId || receipt.leaseEpoch !== attempt.claim.leaseEpoch || receipt.sourceDigest !== digest ||
        (request.binding_sha256 !== undefined && request.binding_sha256 !== prepared.binding_sha256) ||
        (request.source_digest !== undefined && request.source_digest !== digest)) return refused("stale_owner");
      if (request.phase === "execute") {
        if (!attempt.row.executeRequest || request.execute_request_sha256 !== attempt.row.executeSHA256 ||
          hash(encode(attempt.row.executeRequest)) !== request.execute_request_sha256) return refused("pending");
        const execution = parseBenchCoordinatorRequest(encode(attempt.row.executeRequest));
        if (execution.operation !== "execute" || execution.binding_sha256 !== prepared.binding_sha256 ||
          canonicalCheckpoint(execution.source_receipt) !== canonicalCheckpoint({ run_id: receipt.runId, epoch: receipt.leaseEpoch,
            source_digest: receipt.sourceDigest, admitted_at: receipt.admittedAt })) return refused("stale_owner");
      }
      if (remote) {
        // Its binding was matched to the retained preparation above (a mismatch is a stale owner).
        const decided = remoteDecision(attempt, remote, request.execute_request_sha256, prepared.binding_sha256);
        if (decided) return refused(decided);
      }
      const evidence = await createCheckpointServiceClient(attempt.profile).sourceEvidence(attempt.claim);
      if (request.phase !== "observe") { requireActiveSource(evidence.snapshot, source); active = { snapshot: evidence.snapshot, source }; }
      else if (canonicalCheckpoint(source) !== canonicalCheckpoint({ binding: evidence.snapshot.binding, start: evidence.snapshot.start,
        benchKey: evidence.snapshot.benchKey, benchId: evidence.snapshot.benchId, requestId: evidence.snapshot.requestId,
        sourceRequestSha256: evidence.snapshot.sourceRequestSha256, workerContextSha256: evidence.snapshot.workerContextSha256 })) return refused("stale_owner");
      expires = Math.min(expires, evidence.reporterExpiresAtMs);
    } else {
      const client = await checkpointAgentClient(attempt.profile);
      await client.context(attempt.claim.runId, attempt.claim);
    }
    // Every awaited authorization/source operation is followed by actual local
    // and issuer rechecks. A changed reservation/config never receives a grant.
    requireInstalledCheckpointProfile(attempt.profile);
    const finalAuthority = await readCheckpointAuthority(attempt.profile);
    const final = await readCheckpointAttempt(request.identity.tenant_id, request.identity.attempt_id);
    requireInstalledCheckpointProfile(attempt.profile);
    if (!checkpointAuthorityMatches(finalAuthority, attempt.row.authority)) return refused("stale_owner");
    const reread = finalRowDecision(attempt.row, final?.row);
    if (reread !== "current") return refused(reread);
    const now = Date.now();
    if (active) requireActiveSource(active.snapshot, active.source, now);
    if (expires <= now) return refused("unavailable");
    return BenchCoordinatorCurrentResponse.parse({ ...base, issued_at_ms: now, expires_at_ms: Math.min(expires, now + 2000), decision: "current" });
  } catch (error) {
    // `unavailable` lets the node retry; the error behind it is named here, never on the wire.
    noteCheckpoint("current-decision", "decision.error", { nodeId }, error);
    return refused(await failedDecision(nodeId, matched, runEnded));
  }
}
