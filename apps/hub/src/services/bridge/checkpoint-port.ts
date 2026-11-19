/** Proposed default-off production port. No profile, grant or capability is installed here. */
import { BENCH_COORDINATOR_VERB, CARD_PROMPT_VERSION, CardPrompt, CardPromptComment,
  BenchCoordinatorRequest, parseBenchCoordinatorResponse, renderCardPrompt, type BenchCoordinatorResponse } from "@agentpod/contract";
import { request as nodeRequest } from "../broker";
import { canonicalCheckpoint } from "./checkpoint-json";
import { readCheckpointAuthority } from "./checkpoint-current";
import { installedCheckpointProfiles, requireInstalledCheckpointProfile } from "./checkpoint-profiles";
import { checkpointProfileId, CheckpointRefused, requireCheckpointProfileClaim, type CheckpointProfile,
  type CheckpointRefusalReason } from "./checkpoint-profile";
import { checkpointAgentClient } from "./checkpoint-agent-client";
import { pendingCheckpointAttempt, reserveCheckpointAttempt } from "./checkpoint-ledger";
import { driveCheckpointAttempt } from "./checkpoint-orchestrator";
import type { CheckpointDispatchPort, CheckpointTarget } from "./checkpoint-dispatch";
import type { SuperpipelineClient } from "./superpipeline";

function target(profile: CheckpointProfile): CheckpointTarget {
  const t = profile.target;
  return Object.freeze({ tenantId: t.tenant_id, sourceTenantId: profile.sourceTenantId, boardId: t.board_id,
    agentId: t.agent_id, stationId: t.station_id, nodeId: t.node_id, hostId: t.host_id, registryRevision: t.registry_sha256,
    benchProtocol: t.bench_protocol, coordinatorImplementationSHA256: t.coordinator_implementation_sha256,
    executionMode: t.execution_mode, workerVersion: t.worker_version, workerSHA256: t.worker_sha256 });
}

/**
 * Why a current-authority re-read failed. An authority refusal keeps its own reason; any other
 * refusal or error is named by its code alone, never by its text. Exported for tests.
 */
export function currentRefusalReason(error: unknown): CheckpointRefusalReason {
  if (!(error instanceof CheckpointRefused)) return "current.error";
  return error.reason ?? `current.${error.code}`;
}

/**
 * Why the selected node's ready reply does not make this profile's target available, or
 * undefined when it does. The node's refusal state and code are the contract's closed enums,
 * and a target field is named by the target schema's own key. Exported for tests.
 */
export function readyReplyRefusal(reply: BenchCoordinatorResponse, profile: CheckpointProfile): CheckpointRefusalReason | undefined {
  if (reply.state !== "available" || reply.operation !== "ready")
    return `node.state:${reply.state}${"code" in reply ? "." + reply.code : ""}`;
  if (canonicalCheckpoint(reply.target) === canonicalCheckpoint(profile.target)) return undefined;
  const pinned: Record<string, unknown> = profile.target;
  const advertised: Record<string, unknown> = reply.target;
  const field = Object.keys(pinned).find((key) => canonicalCheckpoint(pinned[key]) !== canonicalCheckpoint(advertised[key]));
  return field ? `node.target.${field}` : "node.target.shape";
}

/** Called for the actual selected roster row. No ACP readiness, station label,
 * caller URL, or advertised health is used to infer this installation.
 */
export function checkpointRuntime(tenantId: string, boardId: string, stationId: string, agentKey: string): {
  client(): Promise<SuperpipelineClient>; port: CheckpointDispatchPort;
} | undefined {
  const found = installedCheckpointProfiles().find((p) => p.target.tenant_id === tenantId &&
    p.target.board_id === boardId && p.target.station_id === stationId && p.agentKey === agentKey);
  if (!found) return undefined;
  const profile: CheckpointProfile = found;
  const selected = target(profile);
  async function refusal(value: CheckpointTarget): Promise<CheckpointRefusalReason | undefined> {
    try {
      if (canonicalCheckpoint(value) !== canonicalCheckpoint(selected)) return "selection.target";
      requireInstalledCheckpointProfile(profile);
      await readCheckpointAuthority(profile);
      requireInstalledCheckpointProfile(profile);
      return undefined;
    } catch (error) { return currentRefusalReason(error); }
  }
  async function current(value: CheckpointTarget): Promise<boolean> {
    return await refusal(value) === undefined;
  }
  /** The wire code stays `authority`; the reason is for the Hub's log. */
  async function requireCurrent(value: CheckpointTarget): Promise<void> {
    const reason = await refusal(value);
    if (reason) throw new CheckpointRefused("authority", reason);
  }
  return { client: () => checkpointAgentClient(profile), port: {
    current,
    ready: async (identity) => {
      if (identity.tenantId !== tenantId || identity.boardId !== boardId || identity.stationId !== stationId)
        throw new CheckpointRefused("authority", "selection.identity");
      await requireCurrent(selected);
      const request = BenchCoordinatorRequest.parse({ version: "agentpod.bench-coordinator.v1", operation: "ready",
        tenant_id: tenantId, board_id: boardId, station_id: stationId });
      const reply = await nodeRequest(profile.target.node_id, BENCH_COORDINATOR_VERB, request, { timeoutMs: 5000 });
      if (!reply.ok) throw new CheckpointRefused("unavailable");
      const raw = JSON.stringify(reply.data);
      if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 262144) throw new CheckpointRefused("invalid");
      const parsed = await parseBenchCoordinatorResponse(new TextEncoder().encode(raw), request);
      const node = readyReplyRefusal(parsed, profile);
      if (node) throw new CheckpointRefused("authority", node);
      await requireCurrent(selected);
      return selected;
    },
    recover: async () => {
      await requireCurrent(selected);
      const pending = await pendingCheckpointAttempt(profile);
      return pending ? driveCheckpointAttempt(pending, await checkpointAgentClient(profile)) : undefined;
    },
    dispatch: async ({ target: chosen, claim }) => {
      requireCheckpointProfileClaim(profile, claim);
      await requireCurrent(chosen);
      const client = await checkpointAgentClient(profile);
      const context = await client.context(claim.runId, claim);
      const prompt = renderCardPrompt(CardPrompt.parse({ version: CARD_PROMPT_VERSION, source: "superpipeline",
        boardId, externalRunId: claim.runId, card: context.card, stage: context.stage,
        handoff: context.handoff, references: context.references, attempt: { number: context.card.attemptCount ?? 1 },
        comments: (context.comments ?? []).map((comment) => CardPromptComment.parse(comment)),
        ...(context.commentsOmitted === undefined ? {} : { commentsOmitted: context.commentsOmitted }),
        run: null, libraryTools: false }));
      await requireCurrent(chosen);
      const reserved = await reserveCheckpointAttempt(profile, claim, { profile_id: checkpointProfileId(profile),
        prompt, timeout_seconds: 1800 });
      return driveCheckpointAttempt(reserved.attempt, client, reserved.send);
    },
  } };
}
