/** Proposed server-owned coordinator mapping; explicit private installation remains default off. */
import { z } from "zod";
import { BenchCoordinatorTarget } from "@agentpod/contract";
import type { PendingCheckpointClaim } from "./checkpoint-claim";
import type { BridgeCredentialRefusalReason } from "./plane-credential";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}(?![\s\S])/);
const principal = z.string().regex(/^prn_[a-f0-9]{20}(?![\s\S])/);
const sha = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);
const name = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}(?![\s\S])/);
const endpoint = z.string().refine((value) => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash &&
      u.origin === value;
  } catch { return false; }
});
const profileSchema = z.object({
  version: z.literal("agentpod.checkpoint-profile.v1"),
  organizationId: z.string().regex(/^org_[a-f0-9]{20}(?![\s\S])/),
  sourceTenantId: id, sourceOrigin: endpoint, sourceAudience: endpoint,
  reporterPrincipalId: principal, ownerPrincipalId: principal, occupantPrincipalId: principal,
  agentKey: id, profileKey: z.union([z.literal(""), id]), coordinatorProfileId: id.optional(), occupancyEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  target: BenchCoordinatorTarget,
  repositories: z.array(z.object({ name, repositorySHA256: sha,
    provider: z.enum(["forge", "github"]), repository: z.string().max(200)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/),
    objectFormat: z.enum(["sha1", "sha256"]),
  }).strict()).min(1).max(32),
  checkpointRepository: name,
  /**
   * `card`: each card chooses an ordered subset of `repositories`, the stage's allow-list
   * (`fleet bench stage --cards-choose`); its claims carry a selection (claim protocol v2). Absent: a
   * claim names exactly `repositories`, as before.
   */
  repositorySelection: z.literal("card").optional(),
  /** Only with `card`: what a card that names none gets (printed into the stage's `cardCheckpointPolicy`). */
  defaultRepositories: z.array(name).min(1).max(32).optional(),
  /**
   * Absent: a one-shot stage, whose task runs on the bench host (`target.node_id`). `remote`: the
   * station's agent works in the card's bench from its own node, `nodeId`, while `target.node_id`
   * stays the bench host's node, which serves the registry profile (launch `remote-v1`).
   */
  executor: z.object({ execution: z.literal("remote"), stationId: id, nodeId: id }).strict().optional(),
}).strict().refine((value) => (value.coordinatorProfileId ?? value.profileKey) !== "").refine((value) => value.repositories.every((member, index) => index === 0 ||
  (value.repositories[index - 1]?.name ?? "") < member.name) &&
  value.repositories.some((member) => member.name === value.checkpointRepository) &&
  new Set(value.repositories.map((member) => member.repositorySHA256)).size === value.repositories.length &&
  new Set(value.repositories.map((member) => member.provider + "/" + member.repository)).size === value.repositories.length)
  .refine((value) => value.executor === undefined || value.executor.stationId === value.target.station_id)
  .refine((value) => {
    // treaty run-checkpoint-policy.v2's relations: a sorted subset that resolves a start repository.
    const d = value.defaultRepositories;
    if (!d) return true;
    return value.repositorySelection === "card" && d.every((member, index) => index === 0 || (d[index - 1] ?? "") < member) &&
      d.every((member) => value.repositories.some((r) => r.name === member)) &&
      (d.length === 1 || d.includes(value.checkpointRepository));
  });
export type CheckpointProfile = z.infer<typeof profileSchema>;
export type CheckpointRefusalCode = "invalid" | "authority" | "unavailable" | "uncertain" | "source" | "stale";
/**
 * Why a selection was refused, for the Hub's own log only. A closed set of fixed words: no
 * identifier, token, path or raw exception ever enters it, and it never reaches the wire, where
 * the refusal stays its `code` alone. `node.state:` and `node.target.` take their suffix from the
 * contract's closed enums and the target schema's own field names.
 */
export type CheckpointRefusalReason =
  | "authority.shape"
  | "facts.row" | "facts.enforcement" | "facts.tenant.source" | "facts.tenant.organization" | "facts.node"
  | "facts.principal" | "facts.owner" | "facts.epoch" | "facts.profile"
  | "node.status" | "node.offline" | "node.last_seen"
  | "issuer.occupant.missing" | "issuer.occupant.kind" | "issuer.occupant.suspended" | "issuer.occupant.organization"
  | "issuer.owner.missing" | "issuer.owner.suspended" | "issuer.owner.organization" | "issuer.grant"
  | "credential.missing" | "credential.principal" | "credential.organization" | "credential.audience"
  /** The exchanged grant was refused before any board request, e.g. `credential.claims.scope`. */
  | `credential.${BridgeCredentialRefusalReason}`
  /** Recovering this station's unresolved attempt threw; checkpoint claims wait, ordinary ones do not. */
  | `recover.${CheckpointRefusalCode}`
  /** This station's attempt is still unresolved: one per station, so new checkpoint claims wait. */
  | "attempt.unresolved"
  /** The station's checkpoint claims wait after a SuperBench capacity refusal (checkpoint-capacity-backoff.ts). */
  | "capacity.backoff"
  | "claim.tenant" | "claim.board" | "claim.agent" | "claim.reporter" | "claim.node" | "claim.checkpoint_repository"
  | "claim.executor" | "claim.repositories"
  /** A claim with a selection for a stage whose cards do not choose, or without one for a stage whose cards do. */
  | "claim.selection"
  | "selection.identity" | "selection.target" | "selection.shape" | "selection.current"
  /** The node call itself failed: the broker's timeout, an offline node, or another transport error. */
  | "node.call.timeout" | "node.call.offline" | "node.call.error"
  /** The agent client's bounded request to the source failed before a status was read. */
  | "http.timeout" | "http.network" | "http.encoding" | "http.size" | "http.body"
  | `current.${CheckpointRefusalCode}` | "current.error"
  /** SuperPipeline's checkpoint service refused with this HTTP status, timed out, or sent an encoded body. */
  | `service.status:${number}` | "service.timeout" | "service.encoding"
  | `node.state:${string}` | `node.target.${string}`
  /** The settlement's receipt was still absent after the submission: parked to read it again. */
  | "service.receipt.absent"
  /** The drive used every step of one pass without reaching a resting phase. */
  | "drive.steps"
  /** The drive threw something that names no reason; its class and redacted message are in the log facts. */
  | "drive.error"
  /** The node's reply is larger than the Hub reads. */
  | "node.reply.size"
  /**
   * The board ended the run after execute was sent; the node, told, has not yet confirmed its record
   * terminal (`run_ended.node:<state>[.<code>]`) or could not be reached. Told again on the next pass.
   */
  | "run_ended.node_unreachable" | `run_ended.node:${string}`
  /** Current authority no longer equals the attempt's retained authority. */
  | "authority.changed"
  /** The roster/occupancy facts changed between the two reads of one authority check. */
  | "authority.raced"
  /**
   * The settlement could not be built from the node's completed reply. Its inputs are the attempt's
   * immutable cells and the node's journaled completion, so each of these always fails for the attempt.
   */
  | `settlement.${CheckpointSettlementRefusal}`
  /** A retained cell of the attempt row is missing or does not hold what its phase requires. */
  | `retained.${"prepared" | "binding" | "source" | "source_receipt" | "execute" | "completion" | "settlement" | "receipt" | "failure" | "phase"}`
  /** SuperPipeline's source projection: its shape, its binding to the claim, or a run no longer working on it. */
  | "source.shape" | "source.binding" | "source.claim" | "source.inactive" | "source.receipt" | "source.admission"
  /** A settlement receipt that does not parse or does not match the retained submission. */
  | "receipt.shape" | "receipt.mismatch"
  /** The checkpoint service client refused before or after a request (not a status from the board). */
  | "service.body.length" | "service.body.reader" | "service.body.size" | "service.grant" | "service.grant.expired"
  | "service.claim" | "service.request.size" | "service.receipt_missing" | "service.error" | "service.retained_body"
  /** The attempt ledger: a phase that moved on, a raced write, an oversized cell or a broken row. */
  | "ledger.phase" | "ledger.raced" | "ledger.size" | "ledger.row" | "ledger.reservation" | "ledger.request" | "ledger.station";
/** Why a completed node reply cannot become a settlement. */
export type CheckpointSettlementRefusal =
  | "completion" | "retained_source" | "foreign_source" | "task_outcome" | "unchanged" | "foreign_member" | "shape" | "size";
export class CheckpointRefused extends Error {
  /**
   * `cause` is the error this refusal replaced, kept so the log can name its class and redacted
   * message (`checkpoint-log.ts`). It never reaches the wire.
   */
  constructor(readonly code: CheckpointRefusalCode, readonly reason?: CheckpointRefusalReason, cause?: unknown) {
    super(`Checkpoint refused: ${code}`, cause === undefined ? undefined : { cause });
    this.name = "CheckpointRefused";
  }
}
/** Only server configuration enters here; node fields, handoff and claim JSON never define this mapping. */
export function parseCheckpointProfile(value: unknown): CheckpointProfile {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) throw new CheckpointRefused("invalid");
  // A deep snapshot prevents post-await mutation of repository or identity pins.
  for (const member of parsed.data.repositories) Object.freeze(member);
  Object.freeze(parsed.data.repositories);
  Object.freeze(parsed.data.target);
  if (parsed.data.executor) Object.freeze(parsed.data.executor);
  return Object.freeze(parsed.data);
}
/** The first pin a claim breaks, or undefined when it is this profile's claim. Exported for tests. */
export function claimRefusal(profile: CheckpointProfile, claim: PendingCheckpointClaim): CheckpointRefusalReason | undefined {
  const t = profile.target; const p = claim.policy;
  const chooses = profile.repositorySelection === "card";
  if (claim.tenantId !== profile.sourceTenantId) return "claim.tenant";
  if (claim.boardId !== t.board_id) return "claim.board";
  if (claim.agentId !== t.agent_id) return "claim.agent";
  if (p.reporterPrincipalId !== profile.reporterPrincipalId) return "claim.reporter";
  if (p.nodeId !== t.node_id) return "claim.node";
  if ((claim.selection !== undefined) !== chooses) return "claim.selection";
  // A card may start in any repository it chose; a fixed stage starts where the profile says.
  if (chooses ? !p.repositories.some((r) => r.name === p.checkpointRepository) : p.checkpointRepository !== profile.checkpointRepository)
    return "claim.checkpoint_repository";
  if (!p.executors.some((executor) => executor.agentId === t.agent_id && executor.stationId === t.station_id)) return "claim.executor";
  if (!claimRepositoriesAllowed(profile.repositories, p.repositories)) return "claim.repositories";
  // A fixed stage's claim still names its whole allow-list.
  if (!chooses && p.repositories.length !== profile.repositories.length) return "claim.repositories";
  return undefined;
}

type RepositoryIdentity = { name: string; provider: string; repository: string };
const sameRepository = (a: RepositoryIdentity, b: RepositoryIdentity) =>
  a.name === b.name && a.provider === b.provider && a.repository === b.repository;

/**
 * Whether a claim's repositories may run under the profile's. The profile's list is the stage's
 * allow-list (`fleet bench stage --repo`): a claim names a non-empty subset of it, in its order
 * (sorted by name), each with the same provider and repository. A card that chose repositories
 * (treaty `StageDef.cardCheckpointPolicy` and the claim `selection`) names its subset; a fixed stage
 * names the whole list, which `claimRefusal` also requires. `registry_sha256` pins the whole
 * allow-list, so a card can only select what the node serves. Exported for tests.
 */
export function claimRepositoriesAllowed(allowed: readonly RepositoryIdentity[], claimed: readonly RepositoryIdentity[]): boolean {
  if (claimed.length === 0 || claimed.length > allowed.length) return false;
  let next = 0;
  return claimed.every((member) => {
    while (next < allowed.length && allowed[next]?.name !== member.name) next++;
    const pin = allowed[next++];
    return pin !== undefined && sameRepository(pin, member);
  });
}

/**
 * The profile's pins for exactly the claim's repositories, in the claim's order: what the bench is
 * prepared with and what every source, report and settlement check compares against. Refuses a
 * claim that is not this profile's (`claimRefusal`).
 */
export function claimedRepositories(profile: CheckpointProfile, claim: PendingCheckpointClaim): CheckpointProfile["repositories"] {
  requireCheckpointProfileClaim(profile, claim);
  return claim.policy.repositories.map((member) => {
    const pin = profile.repositories.find((r) => r.name === member.name);
    if (!pin) throw new CheckpointRefused("authority", "claim.repositories");
    return pin;
  });
}
export function requireCheckpointProfileClaim(profile: CheckpointProfile, claim: PendingCheckpointClaim): void {
  const reason = claimRefusal(profile, claim);
  if (reason) throw new CheckpointRefused("authority", reason);
}

/** Whether the stage's agent works in the bench from its own node (`executor`), not as a one-shot task on the bench host. */
export function isRemoteProfile(p: CheckpointProfile): boolean {
  return p.executor?.execution === "remote";
}

/** Select the Node coordinator independently of the bridge harness profile. */
export function checkpointProfileId(profile: CheckpointProfile): string {
  return profile.coordinatorProfileId ?? profile.profileKey;
}

/** The task's own timeout: the producer stops a run at it, and the Hub's run-ended grace counts from it. */
export const CHECKPOINT_TASK_TIMEOUT_SECONDS = 1800;

/**
 * The bench task for a claimed card. `repository_name` is the claim's checkpoint repository: the
 * node's worker starts the harness inside that member, and without it in the workspace root, where a
 * harness writes files outside every repository and leaves the bench's tree dirty, so checkpoint and
 * release are refused. For a fixed stage that is the profile's own checkpoint repository
 * (`claimRefusal` requires it). For a stage whose cards choose, `repository_names` is the card's
 * selection, and the node prepares the bench with only those members of its registry profile.
 * A fixed stage's task carries no `repository_names`, so its bytes are what they always were.
 */
export function checkpointTask(profile: CheckpointProfile, claim: PendingCheckpointClaim, prompt: string): {
  profile_id: string; prompt: string; timeout_seconds: number; repository_name: string; repository_names?: string[];
} {
  const repositories = claimedRepositories(profile, claim);
  return { profile_id: checkpointProfileId(profile), prompt, timeout_seconds: CHECKPOINT_TASK_TIMEOUT_SECONDS,
    repository_name: claim.policy.checkpointRepository,
    ...(profile.repositorySelection === "card" ? { repository_names: repositories.map((r) => r.name) } : {}) };
}

/**
 * The roster stores a default harness profile as NULL (the admin API cannot store ""),
 * while a checkpoint profile spells the same default as "". One definition of "same profile".
 */
export function normalizeRosterProfileKey(key: string | null | undefined): string {
  return key ?? "";
}
