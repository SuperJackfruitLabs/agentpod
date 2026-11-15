/** Proposed authenticated Node callback. No request hash or node statement creates authority. */
import { createHash } from "node:crypto";
import { BenchCoordinatorCurrentResponse, BenchCoordinatorPrepared, benchCoordinatorBindingDigest, parseBenchCoordinatorCurrentRequest,
  parseBenchCoordinatorRequest } from "@agentpod/contract";
import { canonicalCheckpoint, checkpointDigest, parseCheckpointJSON } from "./checkpoint-json";
import { readCheckpointAttempt, type RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { CheckpointRefused } from "./checkpoint-profile";
import { requireInstalledCheckpointProfile } from "./checkpoint-profiles";
import { readCheckpointAuthority } from "./checkpoint-current";
import { checkpointAgentClient } from "./checkpoint-agent-client";
import { createCheckpointServiceClient } from "./checkpoint-service-client";
import { parseCheckpointSource, parseSourceReceipt, requireActiveSource, type CheckpointSourceSnapshot } from "./checkpoint-source";

const encode = (raw: string) => new TextEncoder().encode(raw);
const hash = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");

/** Only the validated selected-node preparation can supply these source facts. */
export async function retainedCheckpointSource(attempt: RetainedCheckpointAttempt) {
  if (!attempt.row.prepared) throw new CheckpointRefused("source");
  const prepared = BenchCoordinatorPrepared.parse(parseCheckpointJSON(encode(attempt.row.prepared)));
  const b = prepared.binding; const i = b.identity;
  if (await benchCoordinatorBindingDigest(b) !== prepared.binding_sha256 || prepared.checkpoint_repository !== attempt.profile.checkpointRepository ||
    canonicalCheckpoint(i) !== canonicalCheckpoint(attempt.request.identity) ||
    b.host_id !== attempt.profile.target.host_id || b.worker_sha256 !== attempt.profile.target.worker_sha256 ||
    b.members.length !== attempt.profile.repositories.length || b.members.some((m, index) => {
      const pin = attempt.profile.repositories[index];
      return !pin || m.name !== pin.name || m.repository_sha256 !== pin.repositorySHA256 || m.object_format !== pin.objectFormat;
    })) throw new CheckpointRefused("source");
  return { prepared, source: parseCheckpointSource({ binding: { boardId: i.board_id, cardId: i.card_id,
    stageKey: i.stage_id, runId: i.run_id, leaseEpoch: i.epoch, agentId: i.agent_id, stationId: i.station_id,
    nodeId: i.node_id, attemptId: i.attempt_id }, start: b.sources.map((m) => ({ name: m.name, commit: m.commit })),
    benchKey: b.bench_key, benchId: b.bench_id, requestId: prepared.request_id,
    sourceRequestSha256: prepared.source_request_sha256, workerContextSha256: b.context_sha256 }) };
}

export async function checkpointCurrentDecision(nodeId: string, raw: Uint8Array) {
  const request = parseBenchCoordinatorCurrentRequest(raw);
  const base = { version: request.version, nonce: request.nonce, request_sha256: hash(raw) };
  const refused = (code: "unauthorized" | "stale_owner" | "unavailable" | "pending" | "invalid") => {
    const now = Date.now();
    return BenchCoordinatorCurrentResponse.parse({ ...base, issued_at_ms: now, expires_at_ms: now + 1000, decision: "refused", code });
  };
  try {
    if (nodeId !== request.identity.node_id || nodeId !== request.target.node_id) return refused("unauthorized");
    const attempt = await readCheckpointAttempt(request.identity.tenant_id, request.identity.attempt_id);
    if (!attempt || canonicalCheckpoint(request.identity) !== canonicalCheckpoint(attempt.request.identity) ||
      canonicalCheckpoint(request.target) !== canonicalCheckpoint(attempt.request.target) ||
      request.profile_id !== attempt.profile.profileKey || request.prepare_request_sha256 !== attempt.row.prepareSHA256)
      return refused("stale_owner");
    requireInstalledCheckpointProfile(attempt.profile);
    const authority = await readCheckpointAuthority(attempt.profile);
    if (canonicalCheckpoint(authority) !== attempt.row.authority) return refused("stale_owner");
    let expires = Date.now() + 5000;
    let active: { snapshot: CheckpointSourceSnapshot; source: ReturnType<typeof parseCheckpointSource> } | undefined;
    if (request.phase === "execute" || attempt.row.sourceReceipt !== null) {
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
    if (canonicalCheckpoint(finalAuthority) !== attempt.row.authority || !final ||
      JSON.stringify(final.row) !== JSON.stringify(attempt.row)) return refused("stale_owner");
    const now = Date.now();
    if (active) requireActiveSource(active.snapshot, active.source, now);
    if (expires <= now) return refused("unavailable");
    return BenchCoordinatorCurrentResponse.parse({ ...base, issued_at_ms: now, expires_at_ms: Math.min(expires, now + 2000), decision: "current" });
  } catch { return refused("unavailable"); }
}
