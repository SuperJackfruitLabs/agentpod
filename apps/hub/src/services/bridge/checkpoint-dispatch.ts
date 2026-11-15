/** Private proposed selection seam. No production constructor advertises or implements it. */
import { z } from "zod";
import { CHECKPOINT_CLAIM_PROTOCOL, parsePendingCheckpointClaim, type PendingCheckpointClaim } from "./checkpoint-claim";
import type { DispatchResult } from "./dispatch-types";
import type { SuperpipelineClient } from "./superpipeline";

function scalars(value: string): boolean {
  for (const part of value) {
    const code = part.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}
const opaque = z.string().min(1).max(128).refine(scalars);
const targetSchema = z.object({
  tenantId: opaque, sourceTenantId: opaque, boardId: opaque, agentId: opaque, stationId: opaque, nodeId: opaque,
  hostId: opaque, registryRevision: opaque,
  coordinatorVersion: z.literal("superbench.v2"),
  workerVersion: z.literal("agentpod.superbench-worker.v2"),
  workerSHA256: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/),
}).strict();
/** Server-selected Hub and source tenant IDs remain distinct; the source pin comes only from trusted org-plane configuration.
 * Observed registry selection is never a source attestation or execution grant. */
export type CheckpointTarget = Readonly<z.infer<typeof targetSchema>>;
export interface CheckpointSelectionIdentity { tenantId: string; boardId: string; stationId: string }
export interface CheckpointDispatchPort {
  /** Must actually verify packaged worker, registry, host and control pair; ACP health is insufficient. */
  ready(identity: Readonly<CheckpointSelectionIdentity>): Promise<CheckpointTarget | undefined>;
  /** Fresh trusted lookup of the exact immutable target, not a caller-provided readiness boolean. */
  current(target: CheckpointTarget): Promise<boolean>;
  /** Owns operation-bound execution/repair/settlement. No generic ACP or private proposal bytes here. */
  dispatch(input: Readonly<{ target: CheckpointTarget; claim: PendingCheckpointClaim }>): Promise<DispatchResult>;
}
export interface CheckpointSelection {
  readonly protocol: typeof CHECKPOINT_CLAIM_PROTOCOL;
  dispatch(client: SuperpipelineClient, claim: PendingCheckpointClaim): Promise<DispatchResult>;
}
const parked = (): DispatchResult => ({ status: "unreported", reason: "Checkpoint dispatch requires reconciliation" });

function matches(target: CheckpointTarget, claim: PendingCheckpointClaim): boolean {
  return claim.tenantId === target.sourceTenantId && claim.boardId === target.boardId && claim.agentId === target.agentId &&
    claim.policy.nodeId === target.nodeId && claim.policy.executors.some((executor) =>
      executor.agentId === target.agentId && executor.stationId === target.stationId);
}
/** No port means no opt-in. Captures copies before any subsequent await can mutate registry output. */
export async function selectCheckpointDispatch(port: CheckpointDispatchPort | undefined,
  identity: CheckpointSelectionIdentity): Promise<CheckpointSelection | undefined> {
  if (!port) return undefined;
  const expected = Object.freeze({ ...identity });
  const raw = await port.ready(expected);
  if (raw === undefined) return undefined;
  const parsed = targetSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Checkpoint target unavailable");
  const target = Object.freeze(parsed.data);
  if (target.tenantId !== expected.tenantId || target.boardId !== expected.boardId || target.stationId !== expected.stationId ||
    !await port.current(target)) throw new Error("Checkpoint target unavailable");
  return Object.freeze({
    protocol: CHECKPOINT_CLAIM_PROTOCOL,
    async dispatch(client: SuperpipelineClient, value: PendingCheckpointClaim): Promise<DispatchResult> {
      // Once claimed, never release/stop/report on uncertain ownership, and never select ACP as a fallback.
      try {
        const claim = parsePendingCheckpointClaim(value);
        if (!matches(target, claim) || !await port.current(target)) return parked();
        await client.context(claim.runId, claim);
        if (!await port.current(target)) return parked();
        // Fresh parsed copy: a callback cannot mutate the client's retained pending observation.
        return await port.dispatch(Object.freeze({ target, claim: parsePendingCheckpointClaim(claim) }));
      } catch { return parked(); }
    },
  });
}
