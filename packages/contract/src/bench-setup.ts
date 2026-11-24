/**
 * Bench setup: the hub's `fleet bench stage` and `fleet bench doctor` surfaces and the node verbs
 * behind them (`bench.registry.status|set|remove`, Go `internal/benchbridge/registry_manage.go`).
 *
 * The node's reply is its own report of the private registry it serves, including
 * `registry_sha256`, so no operator computes a digest. It never carries a clone identity or a
 * worker argument; those travel hub to node only, in a set request, and are stored nowhere else.
 */
import { z } from "zod";
import { BenchCoordinatorTarget } from "./bench-coordinator";

export const BENCH_REGISTRY_MANAGE_CAPABILITY = "bench.registry.manage";
export const BENCH_REGISTRY_STATUS_VERB = "bench.registry.status";
export const BENCH_REGISTRY_SET_VERB = "bench.registry.set";
export const BENCH_REGISTRY_REMOVE_VERB = "bench.registry.remove";

const sha = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);
const name = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}(?![\s\S])/);
/** The node registry's profile id, which is also the hub profile's `coordinatorProfileId`. */
export const BenchStageName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}(?![\s\S])/,
  "a stage name is letters, digits and . _ : - (up to 200), starting with a letter or digit");
const ownerRepo = z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/, "OWNER/REPO");

/** Why a node registry is not served, a closed set (Go `Problem*`). */
export const BenchRegistryProblem = z.enum(["unconfigured", "unreadable", "malformed", "worker_pin", "coordinator_pin", "invalid"]);
export type BenchRegistryProblem = z.infer<typeof BenchRegistryProblem>;

export const BenchRegistryProfileView = z.object({
  id: z.string(),
  checkpoint_repository: z.string(),
  repositories: z.array(z.object({ name: z.string(), repository_sha256: sha, object_format: z.enum(["sha1", "sha256"]),
    base: z.string().optional() })),
  launch: z.string().optional(),
  target: BenchCoordinatorTarget,
});
export type BenchRegistryProfileView = z.infer<typeof BenchRegistryProfileView>;

/** The reply to every `bench.registry.*` verb. */
export const BenchRegistryStatus = z.object({
  configured: z.boolean(),
  valid: z.boolean(),
  problem: BenchRegistryProblem.optional(),
  node_id: z.string(),
  host_id: z.string().optional(),
  registry_sha256: sha.optional(),
  worker_sha256: sha.optional(),
  worker_installed_sha256: sha.optional(),
  coordinator_implementation_sha256: sha.optional(),
  coordinator_installed_sha256: sha.optional(),
  benchd: z.object({ reachable: z.boolean(), managed: z.boolean(), data_free_bytes: z.number().nonnegative(),
    state_free_bytes: z.number().nonnegative() }).optional(),
  profiles: z.array(BenchRegistryProfileView),
});
export type BenchRegistryStatus = z.infer<typeof BenchRegistryStatus>;

/** One repository of a stage: its public identity, plus the clone identity the node fetches from. */
export const BenchStageRepository = z.object({
  name,
  provider: z.enum(["forge", "github"]),
  repository: ownerRepo,
  /** Sent to the node and nowhere else; the hub stores only its digest, from the node's reply. */
  cloneUrl: z.string().min(1).max(4096),
  base: z.string().min(1).max(255).optional(),
  objectFormat: z.enum(["sha1", "sha256"]).optional(),
}).strict();
export type BenchStageRepository = z.infer<typeof BenchStageRepository>;

export const BenchStageWorker = z.object({
  /** The worker command and its arguments; the first is an absolute path on the bench host. */
  arguments: z.array(z.string().min(1).max(8192)).min(1).max(128),
  environment: z.record(z.string(), z.string()).optional(),
  /** `registered-v1` (the default) or `grouped`, the older context-directory launch. */
  launch: z.enum(["registered-v1", "grouped"]).optional(),
}).strict();
export type BenchStageWorker = z.infer<typeof BenchStageWorker>;

const stageFields = {
  boardId: z.string().regex(/^brd_[0-9a-f]{16}$/, "a superpipeline board id looks like brd_<16 hex>"),
  stationId: z.string().min(1).max(200),
  /** The SuperPipeline board agent (`agt_`) linked to the station's occupant. */
  agentId: z.string().max(80).regex(/^agt_[A-Za-z0-9]{6,}(?![\s\S])/, "a superpipeline agent id looks like agt_…"),
  /** The SuperPipeline tenant (`tnt_`); defaults to the one this workspace's other stages use. */
  sourceTenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}(?![\s\S])/).optional(),
  /** The SuperPipeline stage this serves; only used to name it in the printed policy's next step. */
  stageId: z.string().min(1).max(200).optional(),
  /**
   * The stage's allow-list of repositories, in any order (stored sorted by name). A claim's
   * policy names exactly these, unless `cardsChoose`: then each card chooses a subset of them.
   */
  repositories: z.array(BenchStageRepository).min(1).max(32),
  checkpointRepository: name,
  /**
   * Each card chooses its repositories from the allow-list (treaty `run-checkpoint-policy.v2`,
   * `StageDef.cardCheckpointPolicy`). The hub's claims for the stage then ask for claim protocol v2,
   * and the node prepares each card's bench with only its choice.
   */
  cardsChoose: z.boolean().optional(),
  /** Only with `cardsChoose`: what a card that names none gets (the policy's `defaultRepositories`). */
  defaultRepositories: z.array(name).min(1).max(32).optional(),
  worker: BenchStageWorker,
  /** Re-pin the node registry's worker and coordinator digests to the bytes installed now. */
  repin: z.boolean().optional(),
  /** Keep a card's bench after its checkpoint settles, rather than reclaim it (the default). */
  keepBench: z.boolean().optional(),
};

const distinctRepositories = (v: { repositories?: BenchStageRepository[]; checkpointRepository?: string }) =>
  !v.repositories || (new Set(v.repositories.map((r) => r.name)).size === v.repositories.length &&
    new Set(v.repositories.map((r) => `${r.provider}/${r.repository}`)).size === v.repositories.length);

const defaultsNeedChoice = (v: { cardsChoose?: boolean; defaultRepositories?: string[] }) =>
  !v.defaultRepositories?.length || v.cardsChoose === true;

export const BenchStageAddRequest = z.object({
  name: BenchStageName,
  /** The roster key for the stage's bridge row; default: the station's row on the board, else `name`. */
  bridgeKey: z.string().min(1).max(64).optional(),
  ...stageFields,
}).strict()
  .refine(distinctRepositories, "each repository appears once, by name and by OWNER/REPO")
  .refine(defaultsNeedChoice, "default repositories are for a stage whose cards choose (--cards-choose)")
  .refine((v) => v.repositories.some((r) => r.name === v.checkpointRepository), "the checkpoint repository is one of the repositories");
export type BenchStageAddRequest = z.infer<typeof BenchStageAddRequest>;

export const BenchStageSetRequest = z.object({
  boardId: stageFields.boardId.optional(),
  stationId: stageFields.stationId.optional(),
  agentId: stageFields.agentId.optional(),
  sourceTenantId: stageFields.sourceTenantId,
  stageId: stageFields.stageId,
  repositories: stageFields.repositories.optional(),
  checkpointRepository: name.optional(),
  /** Turn per-card choice on or off. Off also drops the default. */
  cardsChoose: z.boolean().optional(),
  /** Replace the default; an empty list removes it. */
  defaultRepositories: z.array(name).max(32).optional(),
  worker: BenchStageWorker.optional(),
  repin: z.boolean().optional(),
  keepBench: z.boolean().optional(),
  /** Re-derive the hub's pins (occupant, owner, epoch, roster, reporter) and the node's target, changing nothing else. */
  refresh: z.boolean().optional(),
}).strict().refine(distinctRepositories, "each repository appears once, by name and by OWNER/REPO");
export type BenchStageSetRequest = z.infer<typeof BenchStageSetRequest>;

/** Whether the node serves a stage exactly as the hub pins it. */
export const BenchStageServed = z.enum(["served", "drifted", "missing", "unknown"]);

export const BenchStageView = z.object({
  name: z.string(),
  origin: z.enum(["fleet", "file", "file-only"]),
  boardId: z.string(),
  stationId: z.string(),
  nodeId: z.string(),
  stageId: z.string().nullable(),
  agentKey: z.string(),
  agentId: z.string(),
  checkpointRepository: z.string(),
  repositories: z.array(z.object({ name: z.string(), provider: z.string(), repository: z.string(), repositorySHA256: sha })),
  /** Whether each card chooses a subset of `repositories`, and its default when it names none. */
  cardsChoose: z.boolean(),
  defaultRepositories: z.array(z.string()).optional(),
  registrySHA256: sha,
  /** Whether the hub never clears this stage's benches (`--keep-bench`), even once a card is done, cancelled or dormant. */
  keepBench: z.boolean(),
  served: BenchStageServed,
  /** For `drifted`: the target fields that differ. For `unknown`: why the node was not asked. */
  detail: z.string().optional(),
});
export type BenchStageView = z.infer<typeof BenchStageView>;

/** One doctor line. `ok: null` is a check that could not run because an earlier one failed. */
export const BenchDoctorCheck = z.object({
  check: z.string(),
  ok: z.boolean().nullable(),
  detail: z.string(),
  next: z.string().optional(),
  /** With `ok: null`: not a failure, but something the operator should fix (printed WARN). */
  warn: z.boolean().optional(),
});
export type BenchDoctorCheck = z.infer<typeof BenchDoctorCheck>;

/** `bench.reclaim`: the hub asks the node to reclaim one card's bench once the card is done, cancelled or dormant (Go `benchbridge.ReclaimRequest`). */
export const BenchReclaimRequest = z.object({
  tenant_id: z.string(), board_id: z.string(), station_id: z.string(), card_id: z.string(),
}).strict();
export type BenchReclaimRequest = z.infer<typeof BenchReclaimRequest>;
/** The node's answer: reclaimed, absent (nothing left to reclaim) or refused with a closed code. */
export const BenchReclaimReply = z.object({
  state: z.enum(["reclaimed", "absent", "refused"]),
  code: z.enum(["unsettled", "lease_held", "not_ready", "unsupported", "conflict", "forbidden", "unavailable"]).optional(),
  bench_id: z.string().optional(),
});
export type BenchReclaimReply = z.infer<typeof BenchReclaimReply>;
