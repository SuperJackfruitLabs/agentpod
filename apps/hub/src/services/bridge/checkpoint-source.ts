/** Strict proposed source API projection. A historical snapshot is not a current execution lease. */
import { z } from "zod";
import { parsePendingCheckpointClaim, type PendingCheckpointClaim } from "./checkpoint-claim";
import { canonicalCheckpoint, parseCheckpointJSON } from "./checkpoint-json";
import { CheckpointRefused, claimedRepositories, type CheckpointProfile } from "./checkpoint-profile";

const id = z.string().min(1).max(128);
const sha = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}(?![\s\S])/);
const binding = z.object({ boardId: id, cardId: id, stageKey: id, runId: id, leaseEpoch: integer.min(1),
  agentId: id, stationId: id, nodeId: id, attemptId: id }).strict();
const sourceShape = {
  binding, start: z.array(z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}(?![\s\S])/),
    commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/),
  }).strict()).min(1).max(32), benchKey: key, benchId: z.string().regex(/^[a-f0-9]{32}(?![\s\S])/),
  requestId: key, sourceRequestSha256: sha, workerContextSha256: sha,
};
const sourceSchema = z.object(sourceShape).strict();
// `selection`: the claim's frozen selection, for a stage whose cards choose (claim protocol v2).
const snapshotSchema = z.object({ ...sourceShape, tenantId: id, policy: z.unknown(), policyDigest: sha,
  selection: z.unknown().optional(), status: z.string().min(1).max(80), lastHeartbeatMs: integer }).strict();
const receiptSchema = z.object({ runId: id, leaseEpoch: integer.min(1), sourceDigest: sha, admittedAt: integer }).strict();
export type CheckpointSource = z.infer<typeof sourceSchema>;
export type CheckpointSourceSnapshot = z.infer<typeof snapshotSchema>;
export type CheckpointSourceReceipt = z.infer<typeof receiptSchema>;

export function parseCheckpointSource(value: unknown): CheckpointSource {
  const parsed = sourceSchema.safeParse(value);
  if (!parsed.success) throw new CheckpointRefused("source", "source.shape");
  return parsed.data;
}
export function sourceOf(snapshot: CheckpointSourceSnapshot): CheckpointSource {
  return parseCheckpointSource(Object.fromEntries(Object.keys(sourceShape).map((name) => [name, Reflect.get(snapshot, name)])));
}
export function requireSourceBinding(profile: CheckpointProfile, claim: PendingCheckpointClaim, source: CheckpointSource): void {
  // The profile's pins for the claim's own repositories: the stage's whole list, or the card's choice.
  const pins = claimedRepositories(profile, claim);
  const b = source.binding;
  if (b.boardId !== claim.boardId || b.cardId !== claim.cardId || b.stageKey !== claim.stageKey ||
    b.runId !== claim.runId || b.leaseEpoch !== claim.leaseEpoch || b.agentId !== claim.agentId ||
    b.stationId !== profile.target.station_id || b.nodeId !== profile.target.node_id ||
    source.start.length !== pins.length || source.start.some((member, index) => {
      const pin = pins[index];
      return pin?.name !== member.name || member.commit.length !== (pin.objectFormat === "sha1" ? 40 : 64);
    })) throw new CheckpointRefused("source", "source.binding");
}
export function parseSourceSnapshot(raw: Uint8Array, profile: CheckpointProfile, claim: PendingCheckpointClaim): CheckpointSourceSnapshot {
  const parsed = snapshotSchema.safeParse(parseCheckpointJSON(raw));
  if (!parsed.success) throw new CheckpointRefused("source", "source.shape");
  const value = parsed.data;
  const actual = parsePendingCheckpointClaim({ version: claim.version, admissionState: "pending",
    tenantId: value.tenantId, boardId: value.binding.boardId, cardId: value.binding.cardId,
    stageKey: value.binding.stageKey, agentId: value.binding.agentId, runId: value.binding.runId,
    leaseEpoch: value.binding.leaseEpoch, policy: value.policy, policyDigest: value.policyDigest,
    ...(value.selection === undefined ? {} : { selection: value.selection }) });
  requireSourceBinding(profile, actual, sourceOf(value));
  if (canonicalCheckpoint(actual) !== canonicalCheckpoint(claim)) throw new CheckpointRefused("stale", "source.claim");
  return value;
}
/** Only first publication uses this gate; an ended historical GET must never renew authority. */
export function requireActiveSource(snapshot: CheckpointSourceSnapshot, expected: CheckpointSource, nowMs = Date.now()): void {
  if (snapshot.status !== "working" || !Number.isSafeInteger(nowMs) || nowMs < snapshot.lastHeartbeatMs ||
    nowMs - snapshot.lastHeartbeatMs >= 15 * 60 * 1000 ||
    canonicalCheckpoint(sourceOf(snapshot)) !== canonicalCheckpoint(expected)) throw new CheckpointRefused("stale", "source.inactive");
}
export function parseSourceReceipt(raw: Uint8Array): CheckpointSourceReceipt {
  const parsed = receiptSchema.safeParse(parseCheckpointJSON(raw));
  if (!parsed.success) throw new CheckpointRefused("source", "source.receipt");
  return parsed.data;
}
