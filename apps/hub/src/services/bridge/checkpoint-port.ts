/** Proposed default-off production port. No profile, grant or capability is installed here. */
import { BENCH_COORDINATOR_VERB, CARD_PROMPT_VERSION, CardPrompt, CardPromptComment,
  BenchCoordinatorRequest, parseBenchCoordinatorResponse, renderCardPrompt, type BenchCoordinatorResponse } from "@agentpod/contract";
import { request as nodeRequest } from "../broker";
import { canonicalCheckpoint } from "./checkpoint-json";
import { readCheckpointAuthority } from "./checkpoint-current";
import { installedCheckpointProfiles, requireInstalledCheckpointProfile } from "./checkpoint-profiles";
import { checkpointTask, CheckpointRefused, requireCheckpointProfileClaim, type CheckpointProfile,
  type CheckpointRefusalReason } from "./checkpoint-profile";
import { checkpointAgentClient } from "./checkpoint-agent-client";
import { pendingCheckpointAttempt, reserveCheckpointAttempt } from "./checkpoint-ledger";
import { checkpointDriveDeps, driveCheckpointAttempt, endEndedRun, RUN_ENDABLE_PHASES } from "./checkpoint-orchestrator";
import { capacityHold, createCapacityBackoff } from "./checkpoint-capacity-backoff";
import { readRunEnded } from "./checkpoint-run-ended";
import { resolveSupersededAttempt } from "./checkpoint-supersede";
import { createAttemptBackoff } from "./checkpoint-recover-backoff";
import { createLogger } from "../../utils/logger";
import { createQuietLog } from "./quiet-log";

const log = createLogger("bridge-checkpoint");
/** A superseded attempt that stays parked is named once per attempt and reason, then once per interval. */
const supersededLog = createQuietLog((message, meta) => log.warn(message, meta));
/** What recover returns while an attempt waits out its backoff: unresolved, so checkpoint claims stay held. */
const held = (attemptId: string, runId: string) => ({ status: "unreported" as const, externalRunId: runId, attemptId,
  reason: "Checkpoint dispatch requires reconciliation" });
import type { CheckpointDispatchPort, CheckpointTarget } from "./checkpoint-dispatch";
import type { SuperpipelineClient } from "./superpipeline";
import { nodeCallReason, noteCheckpoint } from "./checkpoint-log";
import { nodeCallTimeoutMs } from "./checkpoint-node-call";

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

export type CheckpointRuntime = { client(): Promise<SuperpipelineClient>; port: CheckpointDispatchPort };

function installedFor(tenantId: string, boardId: string, stationId: string, agentKey: string): CheckpointProfile | undefined {
  return installedCheckpointProfiles().find((p) => p.target.tenant_id === tenantId &&
    p.target.board_id === boardId && p.target.station_id === stationId && p.agentKey === agentKey);
}

/** Called for the actual selected roster row. No ACP readiness, station label,
 * caller URL, or advertised health is used to infer this installation.
 */
export function checkpointRuntime(tenantId: string, boardId: string, stationId: string, agentKey: string): CheckpointRuntime | undefined {
  const found = installedFor(tenantId, boardId, stationId, agentKey);
  return found ? runtimeFor(found, tenantId, boardId, stationId) : undefined;
}

/**
 * The runtime for a roster row's loop, looked up again at the start of every claim cycle.
 *
 * A loop lives as long as its roster row, but a stage's profile does not: `fleet bench stage set`
 * (or `--repin`) installs a new one with no restart. A runtime built once at loop start kept the
 * old profile, and every later cycle refused it as `current.stale`, so no bench card was claimed
 * again until the hub restarted. The same runtime is returned while the installed profile is
 * unchanged, so its backoffs hold across cycles; a changed profile gets a new runtime at the next
 * cycle's start. A cycle never swaps the port it is using, and an attempt reserved under the old
 * profile is found by the new runtime's `recover` as superseded and resolved by that path.
 */
export function checkpointRuntimeResolver(tenantId: string, boardId: string, stationId: string, agentKey: string):
  () => CheckpointRuntime | undefined {
  let cached: { pin: string; runtime: CheckpointRuntime } | undefined;
  return () => {
    const found = installedFor(tenantId, boardId, stationId, agentKey);
    if (!found) { cached = undefined; return undefined; }
    const pin = canonicalCheckpoint(found);
    if (cached?.pin !== pin) cached = { pin, runtime: runtimeFor(found, tenantId, boardId, stationId) };
    return cached.runtime;
  };
}

function runtimeFor(profile: CheckpointProfile, tenantId: string, boardId: string, stationId: string): CheckpointRuntime {
  const selected = target(profile);
  const backoff = createAttemptBackoff();
  /** After a capacity refusal this station's checkpoint claims wait, growing per card and bounded. */
  const capacity = createCapacityBackoff();
  const deps = checkpointDriveDeps({ capacity });
  async function refusal(value: CheckpointTarget): Promise<CheckpointRefusalReason | undefined> {
    try {
      if (canonicalCheckpoint(value) !== canonicalCheckpoint(selected)) return "selection.target";
      requireInstalledCheckpointProfile(profile);
      await readCheckpointAuthority(profile);
      requireInstalledCheckpointProfile(profile);
      return undefined;
    } catch (error) {
      const reason = currentRefusalReason(error);
      // A refusal names itself; anything else is named by class and redacted message here.
      if (!(error instanceof CheckpointRefused)) noteCheckpoint("current", reason, { stationId }, error);
      return reason;
    }
  }
  async function current(value: CheckpointTarget): Promise<boolean> {
    const reason = await refusal(value);
    // A boolean answer used to drop the reason: the dispatch parked with nothing said.
    if (reason) noteCheckpoint("current", reason, { stationId });
    return reason === undefined;
  }
  /** The wire code stays `authority`; the reason is for the Hub's log. */
  async function requireCurrent(value: CheckpointTarget): Promise<void> {
    const reason = await refusal(value);
    if (reason) throw new CheckpointRefused("authority", reason);
  }
  return { client: () => checkpointAgentClient(profile), port: {
    // A stage whose cards choose its repositories claims with protocol v2; every other stage as before.
    ...(profile.repositorySelection === "card" ? { choosesRepositories: true } : {}),
    current,
    ready: async (identity) => {
      if (identity.tenantId !== tenantId || identity.boardId !== boardId || identity.stationId !== stationId)
        throw new CheckpointRefused("authority", "selection.identity");
      await requireCurrent(selected);
      const request = BenchCoordinatorRequest.parse({ version: "agentpod.bench-coordinator.v1", operation: "ready",
        tenant_id: tenantId, board_id: boardId, station_id: stationId });
      const reply = await nodeRequest(profile.target.node_id, BENCH_COORDINATOR_VERB, request, { timeoutMs: nodeCallTimeoutMs("ready") });
      if (!reply.ok) {
        const reason = nodeCallReason(reply.error ?? "");
        noteCheckpoint("ready", reason, { nodeId: profile.target.node_id }, new Error(reply.error ?? "no error"));
        throw new CheckpointRefused("unavailable", reason);
      }
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
      if (!pending) {
        backoff.clear();
        // A card SuperBench just refused for capacity would be claimed straight back (the board offers it
        // again at once): the station's checkpoint claims wait out its backoff instead. Ordinary claims go on.
        return capacityHold(capacity);
      }
      const { attempt } = pending;
      const key = `${attempt.row.attemptId}:${attempt.row.phase}`;
      if (!backoff.due(key)) {
        // A run still going is waited on for seconds, and says so; a fault keeps its backoff.
        const recheckMs = backoff.recheckIn(key);
        return recheckMs === undefined ? held(attempt.row.attemptId, attempt.claim.runId)
          : { ...held(attempt.row.attemptId, attempt.claim.runId), recheckMs };
      }
      // A client that cannot be built (no plane credential source, for one) asks nothing: a superseded
      // attempt is still resolved below without it, and the drive builds and refuses as before.
      const client = await checkpointAgentClient(profile).catch((error: unknown) => {
        noteCheckpoint("recover", "board.client", { stationId, attemptId: attempt.row.attemptId }, error);
        return undefined;
      });
      // First, read-only: has the board ended this attempt's run? A card moved off the stage, cancelled,
      // deleted or reclaimed never comes back, so the attempt is ended rather than re-driven: no
      // heartbeat keeps an unbound run alive, and the station is free for the next card's claim. This
      // holds for a superseded attempt too, which is otherwise parked past `prepared` for an operator.
      if (client && (RUN_ENDABLE_PHASES.has(attempt.row.phase) || attempt.row.phase === "failure_pending")) {
        const ended = await readRunEnded(client, attempt.claim);
        if (ended) {
          const result = await endEndedRun(attempt, ended, deps, client);
          if (result.status === "unreported") { backoff.parked(key); return result; }
          backoff.clear();
          return undefined;
        }
      }
      if (pending.superseded) {
        // Made under a profile this installation has replaced: it can never be driven again, only
        // resolved. Retired with the node's evidence when that proves nothing is outstanding;
        // otherwise parked, named, for an owner or admin to settle (`/api/admin/checkpoint/attempts`).
        const resolution = await resolveSupersededAttempt(attempt);
        const meta = { tenantId: attempt.row.tenantId, boardId: attempt.row.boardId, runId: attempt.claim.runId,
          attemptId: attempt.row.attemptId, phase: attempt.row.phase, reason: resolution.reason,
          ...(resolution.outcome === "parked" && resolution.error ? resolution.error : {}) };
        if (resolution.outcome === "retired") {
          log.info("superseded checkpoint attempt retired; the station is free for a fresh claim", meta);
          backoff.clear();
          return undefined;
        }
        supersededLog(`${attempt.row.attemptId}:${resolution.reason}`,
          "superseded checkpoint attempt parked; an owner or admin can settle it", meta);
        backoff.parked(key);
        return held(attempt.row.attemptId, attempt.claim.runId);
      }
      const result = await driveCheckpointAttempt(attempt, client ?? await checkpointAgentClient(profile), false, deps);
      if (result.status === "unreported") backoff.parked(key, result.recheckMs); else backoff.clear();
      return result;
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
      const reserved = await reserveCheckpointAttempt(profile, claim, checkpointTask(profile, claim, prompt));
      return driveCheckpointAttempt(reserved.attempt, client, reserved.send, deps);
    },
  } };
}
