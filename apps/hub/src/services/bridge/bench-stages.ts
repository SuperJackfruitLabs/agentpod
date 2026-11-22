/**
 * `fleet bench stage add|set|list|rm`: one bench stage set up from the hub, with no database edit,
 * no hand-written JSON, no digest computed by hand and no restart.
 *
 * A stage is two records that must agree: the node's private registry profile (repositories with
 * their clone identities, the worker command, the launch) and the hub's checkpoint profile (the
 * pins every claim is checked against). `add` and `set` write the node's half first, through
 * `bench.registry.set`, and build the hub's half from the node's own reply: its target, its
 * `registry_sha256` and its repository digests. Then the selection snapshot is reinstalled.
 *
 * Safety is where it was. Every route is a workspace owner's or admin's (the admin guard), every
 * node write is audited before the node is asked, the clone identities and arguments are never
 * stored or echoed, and every claim still runs the full current-authority check before an effect.
 * An attempt already running keeps its retained authority; a changed pin retires it through the
 * existing `authority.changed` / `stale_owner` paths.
 *
 * A node's registry digest covers every profile it serves, so a write changes the target of each
 * stage on that node. Every other stage row on the node is re-pinned to the node's new target in
 * the same write, and a profile still coming from the legacy file is adopted into the table then.
 */
import { and, eq } from "drizzle-orm";
import type {
  BenchRegistryProfileView,
  BenchRegistryStatus,
  BenchStageAddRequest,
  BenchStageRepository,
  BenchStageSetRequest,
  BenchStageView,
  BenchStageWorker,
} from "@agentpod/contract";

import { db } from "../../db/drizzle";
import { bridgeAgents } from "../../db/schema/bridge";
import { stations } from "../../db/schema/stations";
import { tenants } from "../../db/schema/tenants";
import { tenantScope } from "../../db/tenant-scope";
import { recordAudit } from "../audit";
import { deploymentSuperpipelineAudience } from "./credential-audience";
import { ensureBridgeDispatchGrant } from "./dispatch-grant";
import { createBridgeAgent, updateBridgeAgent } from "./roster";
import { CheckpointRefused, normalizeRosterProfileKey, parseCheckpointProfile, type CheckpointProfile } from "./checkpoint-profile";
import { installedFileCheckpointProfiles } from "./checkpoint-profiles";
import { nodeRegistryRemove, nodeRegistrySet, nodeRegistryStatus, type NodeAnswer, type NodeProfileChange } from "./bench-node";
import { deleteStage, readStage, readStages, reloadStageProfiles, serialised, upsertStage, type StoredStage } from "./bench-stage-store";
import { serviceGrant } from "./bench-service-grant";

export interface StageResult {
  status: 200 | 201 | 400 | 404 | 409 | 502;
  body: Record<string, unknown>;
}

/** A refusal with an operator sentence, raised before anything is written. */
class StageRefusal extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502, message: string) {
    super(message);
  }
}

const refuse = (status: 400 | 404 | 409 | 502, message: string): never => {
  throw new StageRefusal(status, message);
};

async function guarded(work: () => Promise<StageResult>): Promise<StageResult> {
  try {
    return await serialised(work);
  } catch (error) {
    if (error instanceof StageRefusal) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}

// ─── facts the hub derives ───────────────────────────────────────────────────

interface StationFacts {
  id: string; nodeId: string; stationKey: string; principalId: string; ownerPrincipalId: string; occupancyEpoch: number;
}

async function stationFacts(tenantId: string, stationId: string): Promise<StationFacts> {
  const [s] = await db.select().from(stations).where(tenantScope(stations, tenantId, eq(stations.id, stationId)));
  if (!s) return refuse(404, "no such station in this workspace");
  if (!s.principalId)
    return refuse(409, "the station has no occupant: staff it with its agent principal first (fleet staff), then add the stage");
  return { id: s.id, nodeId: s.nodeId, stationKey: s.stationKey, principalId: s.principalId, ownerPrincipalId: s.userId,
    occupancyEpoch: s.occupancyEpoch };
}

async function organizationOf(tenantId: string): Promise<string> {
  const [t] = await db.select({ externalId: tenants.externalId, externalSource: tenants.externalSource })
    .from(tenants).where(eq(tenants.id, tenantId));
  if (t?.externalSource !== "org-plane" || !t.externalId)
    return refuse(409, "this workspace is not mapped to the organization plane, so it has no checkpoint authority");
  return t.externalId;
}

function audience(): string {
  return deploymentSuperpipelineAudience() ??
    refuse(409, "SUPERPIPELINE_BASE_URL is not an https origin on this hub, so it has no SuperPipeline audience");
}

async function reporter(at: string): Promise<string> {
  const grant = await serviceGrant(at);
  if (!grant.ok)
    return refuse(502, `the hub could not read its own service grant at ${at} (${grant.error}); ` +
      "`fleet bench doctor` reports the same check");
  return grant.sub;
}

/** The SuperPipeline tenant, from the request or from this workspace's other stages. */
function sourceTenant(tenantId: string, given: string | undefined, stages: StoredStage[]): string {
  if (given) return given;
  const known = [...stages.map((s) => s.profile), ...installedFileCheckpointProfiles()]
    .find((p) => p.target.tenant_id === tenantId)?.sourceTenantId;
  return known ?? refuse(400, "--source-tenant is required for this workspace's first stage (its SuperPipeline tnt_ id)");
}

/** The bridge row the stage dispatches through, made a station-plane source row if it is not one. */
async function rosterRow(userId: string, tenantId: string, name: string, stationId: string, boardId: string, bridgeKey?: string) {
  const rows = await db.select().from(bridgeAgents)
    .where(and(eq(bridgeAgents.tenantId, tenantId), eq(bridgeAgents.stationId, stationId)));
  let row = bridgeKey ? rows.find((r) => r.key === bridgeKey) : rows.find((r) => r.boardId === boardId);
  if (bridgeKey && row && row.boardId !== boardId)
    return refuse(409, `roster row ${bridgeKey} claims from another board; give another --bridge-key or move it with fleet bridge set`);
  try {
    if (!row) {
      await createBridgeAgent({ tenantId, key: bridgeKey ?? name, boardId, stationId, createdBy: userId,
        credentialSource: { version: 1, kind: "station-plane" }, enabled: true });
    } else if (!row.credentialSource) {
      await updateBridgeAgent(tenantId, row.key, { credentialSource: { version: 1, kind: "station-plane" } });
    }
  } catch (error) {
    return refuse(400, `the stage's roster row: ${error instanceof Error ? error.message : String(error)}`);
  }
  [row] = await db.select().from(bridgeAgents)
    .where(and(eq(bridgeAgents.tenantId, tenantId), eq(bridgeAgents.key, row?.key ?? bridgeKey ?? name)));
  if (!row) return refuse(502, "the stage's roster row was not stored");
  if (row.enabled) await ensureBridgeDispatchGrant(tenantId, stationId);
  return row;
}

// ─── node half ───────────────────────────────────────────────────────────────

function nodeRepositories(repos: BenchStageRepository[]) {
  return repos.map((r) => ({ name: r.name, repository: r.cloneUrl, ...(r.base ? { base: r.base } : {}),
    object_format: r.objectFormat ?? "sha1" }));
}

function nodeWorker(worker: BenchStageWorker | undefined): Partial<NodeProfileChange> {
  if (!worker) return {};
  return { arguments: worker.arguments, environment: worker.environment ?? {},
    launch: worker.launch === "grouped" ? "" : "registered-v1" };
}

function expectAnswer(answer: NodeAnswer): BenchRegistryStatus {
  if (answer.ok) return answer.status;
  return refuse(answer.soft ? 409 : 502, `the node refused or could not be asked: ${answer.error}; nothing was changed on the hub`);
}

// ─── hub half ────────────────────────────────────────────────────────────────

interface PublicRepository { name: string; provider: "forge" | "github"; repository: string }

/** Whether each card chooses its repositories from the stage's allow-list, and its default. */
interface StageChoice { cardsChoose: boolean; defaultRepositories?: string[] }

/** The stage's choice after a `set`: what it was, with what the request changes. Off drops the default. */
function choiceAfter(before: CheckpointProfile, req: BenchStageSetRequest): StageChoice {
  const cardsChoose = req.cardsChoose ?? before.repositorySelection === "card";
  if (!cardsChoose) {
    if (req.defaultRepositories?.length) refuse(400, "default repositories are for a stage whose cards choose (--cards-choose)");
    return { cardsChoose };
  }
  const defaults = req.defaultRepositories ?? before.defaultRepositories;
  return { cardsChoose, ...(defaults?.length ? { defaultRepositories: [...defaults] } : {}) };
}

function buildProfile(f: {
  name: string; tenantId: string; organizationId: string; sourceTenantId: string; audience: string; reporter: string;
  station: StationFacts; agentKey: string; profileKey: string | null; served: BenchRegistryProfileView;
  repositories: PublicRepository[]; checkpointRepository: string; choice: StageChoice;
}): CheckpointProfile {
  const t = f.served.target;
  if (t.tenant_id !== f.tenantId || t.station_id !== f.station.id || t.node_id !== f.station.nodeId)
    return refuse(502, "the node serves this stage under another workspace, station or node; nothing was changed on the hub");
  const digests = new Map(f.served.repositories.map((r) => [r.name, r]));
  const repositories = f.repositories.toSorted((a, b) => (a.name < b.name ? -1 : 1)).map((r) => {
    const served = digests.get(r.name) ?? refuse(502, `the node does not serve repository ${r.name} for this stage`);
    return { name: r.name, repositorySHA256: served.repository_sha256, provider: r.provider, repository: r.repository,
      objectFormat: served.object_format };
  });
  try {
    return parseCheckpointProfile({
      version: "agentpod.checkpoint-profile.v1", organizationId: f.organizationId, sourceTenantId: f.sourceTenantId,
      sourceOrigin: f.audience, sourceAudience: f.audience, reporterPrincipalId: f.reporter,
      ownerPrincipalId: f.station.ownerPrincipalId, occupantPrincipalId: f.station.principalId,
      agentKey: f.agentKey, profileKey: normalizeRosterProfileKey(f.profileKey), coordinatorProfileId: f.name,
      occupancyEpoch: f.station.occupancyEpoch, target: t, repositories, checkpointRepository: f.checkpointRepository,
      ...(f.choice.cardsChoose ? { repositorySelection: "card" } : {}),
      ...(f.choice.cardsChoose && f.choice.defaultRepositories?.length
        ? { defaultRepositories: f.choice.defaultRepositories.toSorted() } : {}),
    });
  } catch (error) {
    if (error instanceof CheckpointRefused)
      return refuse(400, "the stage does not make a valid checkpoint profile (check the repository names, " +
        "the checkpoint repository, that each default repository is one of them and holds the checkpoint " +
        "repository unless it is the only one, and that the station's owner and occupant are plane principals)");
    throw error;
  }
}

/**
 * After a node's registry changed, every other stage it serves has a new target. Re-pin each
 * table row to the node's own reply, and adopt each still-file-based profile on the node.
 */
async function repinNode(tenantId: string, nodeId: string, status: BenchRegistryStatus, except: string): Promise<string[]> {
  const repinned: string[] = [];
  const served = new Map(status.profiles.map((p) => [p.id, p]));
  const rows = (await readStages()).filter((s) => s.profile.target.node_id === nodeId && !(s.row.tenantId === tenantId && s.row.name === except));
  const repin = async (profile: CheckpointProfile, tenant: string, origin: "fleet" | "file") => {
    const name = profile.coordinatorProfileId ?? profile.profileKey;
    const servedProfile = served.get(name);
    if (!servedProfile) return;
    const next = parseCheckpointProfile({ ...profile, target: servedProfile.target });
    await upsertStage({ tenantId: tenant, name, profile: next, origin });
    repinned.push(name);
  };
  for (const s of rows) await repin(s.profile, s.row.tenantId, s.row.origin === "file" ? "file" : "fleet");
  const taken = new Set((await readStages()).map((s) => `${s.row.tenantId}\0${s.row.name}`));
  for (const p of installedFileCheckpointProfiles()) {
    const name = p.coordinatorProfileId ?? p.profileKey;
    if (p.target.node_id !== nodeId || taken.has(`${p.target.tenant_id}\0${name}`) || name === except) continue;
    await repin(p, p.target.tenant_id, "file");
  }
  return repinned;
}

// ─── views ───────────────────────────────────────────────────────────────────

const TARGET_FIELDS = ["tenant_id", "board_id", "agent_id", "station_id", "node_id", "host_id", "registry_sha256",
  "coordinator_implementation_sha256", "execution_mode", "bench_protocol", "worker_version", "worker_sha256"] as const;

/** The target fields the node serves differently from the hub's pin; empty when they agree. */
export function targetDifference(served: CheckpointProfile["target"], pinned: CheckpointProfile["target"]): (typeof TARGET_FIELDS)[number][] {
  return TARGET_FIELDS.filter((k) => served[k] !== pinned[k]);
}

function view(profile: CheckpointProfile, origin: BenchStageView["origin"], stageId: string | null,
  node: NodeAnswer | undefined, keepBench = false): BenchStageView {
  const name = profile.coordinatorProfileId ?? profile.profileKey;
  let served: BenchStageView["served"] = "unknown";
  let detail: string | undefined;
  if (!node) detail = "not asked";
  else if (!node.ok) detail = node.error;
  else {
    const p = node.status.profiles.find((x) => x.id === name);
    if (!node.status.valid) { served = "missing"; detail = `the node's registry is not served (${node.status.problem ?? "invalid"})`; }
    else if (!p) served = "missing";
    else {
      const differ = targetDifference(p.target, profile.target);
      served = differ.length === 0 ? "served" : "drifted";
      if (differ.length) detail = differ.join(", ");
    }
  }
  return { name, origin, boardId: profile.target.board_id, stationId: profile.target.station_id, nodeId: profile.target.node_id,
    stageId, agentKey: profile.agentKey, agentId: profile.target.agent_id, checkpointRepository: profile.checkpointRepository,
    repositories: profile.repositories.map((r) => ({ name: r.name, provider: r.provider, repository: r.repository,
      repositorySHA256: r.repositorySHA256 })),
    cardsChoose: profile.repositorySelection === "card",
    ...(profile.defaultRepositories ? { defaultRepositories: [...profile.defaultRepositories] } : {}),
    registrySHA256: profile.target.registry_sha256, keepBench, served, ...(detail ? { detail } : {}) };
}

/**
 * The policy the SuperPipeline stage needs, for the operator to apply (no service route yet): its
 * `checkpointPolicy` (v1), or for a stage whose cards choose its `cardCheckpointPolicy` (v2), whose
 * `repositories` is the allow-list.
 */
export function checkpointPolicyFor(profile: CheckpointProfile) {
  const common = {
    kind: "superbench", allowUnchanged: false,
    repositories: profile.repositories.map((r) => ({ name: r.name, provider: r.provider, repository: r.repository })),
    checkpointRepository: profile.checkpointRepository, reporterPrincipalId: profile.reporterPrincipalId,
    nodeId: profile.target.node_id, executors: [{ agentId: profile.target.agent_id, stationId: profile.target.station_id }],
  };
  if (profile.repositorySelection !== "card") return { version: "superpipeline.checkpoint-policy.v1", ...common };
  return { version: "superpipeline.checkpoint-policy.v2", repositorySelection: "card", ...common,
    ...(profile.defaultRepositories ? { defaultRepositories: [...profile.defaultRepositories] } : {}) };
}

/** The stage field the printed policy belongs in. */
const policyField = (profile: CheckpointProfile) => profile.repositorySelection === "card" ? "cardCheckpointPolicy" : "checkpointPolicy";

function nextSteps(profile: CheckpointProfile, stageId: string | null, hasMcpToken: boolean): string[] {
  const steps = [
    `SuperPipeline: link the board agent ${profile.target.agent_id} to the agent principal ${profile.occupantPrincipalId} (a person does this in SuperPipeline).`,
    `SuperPipeline: set the stage's ${policyField(profile)} to the policy above (PATCH the stage ${stageId ?? "STAGE"} on board ${profile.target.board_id}).`,
    "Accounts: the hub's service principal needs the checkpoints:submit and checkpoints:read scopes (once per deployment).",
  ];
  if (!hasMcpToken)
    steps.push(`Give the agent its run-only board tools: fleet bridge set ${profile.agentKey} --mcp-token spa_… (a run-scoped token).`);
  steps.push(`Then: fleet bench doctor ${profile.coordinatorProfileId ?? profile.profileKey}`);
  return steps;
}

/** This stage's own pins that a write changed, by field, with the value before and after. */
function pinChanges(before: CheckpointProfile | undefined, after: CheckpointProfile): Record<string, { from: string; to: string }> {
  if (!before) return {};
  return Object.fromEntries(targetDifference(after.target, before.target)
    .map((k) => [k, { from: before.target[k], to: after.target[k] }]));
}

async function finish(userId: string, tenantId: string, name: string, profile: CheckpointProfile, stageId: string | null,
  status: BenchRegistryStatus, created: boolean, rosterKey: string, before?: CheckpointProfile,
  keepBench?: boolean): Promise<StageResult> {
  await upsertStage({ tenantId, name, profile, stageId, origin: "fleet", createdBy: userId, ...(keepBench === undefined ? {} : { keepBench }) });
  const kept = (await readStage(tenantId, name))?.row.keepBench ?? false;
  const repinned = await repinNode(tenantId, profile.target.node_id, status, name);
  await reloadStageProfiles();
  const [row] = await db.select({ mcp: bridgeAgents.mcpTokenEncrypted }).from(bridgeAgents)
    .where(and(eq(bridgeAgents.tenantId, tenantId), eq(bridgeAgents.key, rosterKey)));
  return {
    status: created ? 201 : 200,
    // `changed` is this stage's own pins; `otherStagesRepinned` names the other stages on the node that
    // were moved to its new digest. Named so: a bare `repinned: []` read as "nothing was repinned".
    body: { stage: view(profile, "fleet", stageId, { ok: true, status }, kept), changed: pinChanges(before, profile),
      otherStagesRepinned: repinned,
      checkpointPolicy: checkpointPolicyFor(profile),
      nextSteps: nextSteps(profile, stageId, Boolean(row?.mcp)) },
  };
}

async function audited<T extends NodeAnswer>(userId: string, tenantId: string, station: StationFacts, verb: string,
  params: Record<string, unknown>, send: () => Promise<T>): Promise<T> {
  // Before the node is asked, so a write that then fails still leaves its record. No clone
  // identity or argument is in `params`.
  const audit = await recordAudit(db, { tenantId, userId, nodeId: station.nodeId, stationKey: station.stationKey, verb, params });
  const answer = await send();
  await audit.done(answer.ok ? "ok" : "error", answer.ok ? undefined : answer.error).catch(() => {});
  return answer;
}

// ─── the verbs ───────────────────────────────────────────────────────────────

export function addBenchStage(userId: string, tenantId: string, req: BenchStageAddRequest): Promise<StageResult> {
  return guarded(async () => {
    const stages = await readStages(tenantId);
    if (stages.some((s) => s.row.name === req.name)) refuse(409, `stage ${req.name} exists; change it with fleet bench stage set`);
    if (stages.some((s) => s.row.boardId === req.boardId && s.row.stationId === req.stationId))
      refuse(409, "another stage already serves this board on this station");
    const station = await stationFacts(tenantId, req.stationId);
    const organizationId = await organizationOf(tenantId);
    const at = audience();
    const sourceTenantId = sourceTenant(tenantId, req.sourceTenantId, stages);
    const reporterId = await reporter(at);
    const roster = await rosterRow(userId, tenantId, req.name, req.stationId, req.boardId, req.bridgeKey);
    const change: NodeProfileChange = { id: req.name, tenant_id: tenantId, board_id: req.boardId, agent_id: req.agentId,
      station_id: req.stationId, checkpoint_repository: req.checkpointRepository, repositories: nodeRepositories(req.repositories),
      ...nodeWorker(req.worker) };
    const status = expectAnswer(await audited(userId, tenantId, station, "bench.registry.set",
      { stage: req.name, boardId: req.boardId, action: "add" }, () => nodeRegistrySet(station.nodeId, change, req.repin ?? false)));
    const served = status.profiles.find((p) => p.id === req.name) ?? refuse(502, "the node did not serve the stage it was given");
    const profile = buildProfile({ name: req.name, tenantId, organizationId, sourceTenantId, audience: at, reporter: reporterId, station,
      agentKey: roster.key, profileKey: roster.profileKey, served, repositories: req.repositories, checkpointRepository: req.checkpointRepository,
      choice: { cardsChoose: req.cardsChoose === true, ...(req.defaultRepositories ? { defaultRepositories: req.defaultRepositories } : {}) } });
    return finish(userId, tenantId, req.name, profile, req.stageId ?? null, status, true, roster.key, undefined, req.keepBench ?? false);
  });
}

/** The stage's current profile: a table row, or a profile still served from the legacy file. */
async function currentStage(tenantId: string, name: string): Promise<{ profile: CheckpointProfile; stageId: string | null }> {
  const stored = await readStage(tenantId, name);
  if (stored) return { profile: stored.profile, stageId: stored.row.stageId };
  const file = installedFileCheckpointProfiles().find((p) => p.target.tenant_id === tenantId && (p.coordinatorProfileId ?? p.profileKey) === name);
  return file ? { profile: file, stageId: null } : refuse(404, `no stage named ${name} in this workspace`);
}

export function setBenchStage(userId: string, tenantId: string, name: string, req: BenchStageSetRequest): Promise<StageResult> {
  return guarded(async () => {
    if (Object.keys(req).length === 0) refuse(400, "nothing to change");
    const { profile: before, stageId } = await currentStage(tenantId, name);
    const choice = choiceAfter(before, req);
    const boardId = req.boardId ?? before.target.board_id;
    const stationId = req.stationId ?? before.target.station_id;
    const station = await stationFacts(tenantId, stationId);
    const moved = station.nodeId !== before.target.node_id;
    if (moved && (!req.repositories || !req.worker))
      refuse(400, "the stage moves to a station on another node: give its --repo list and --worker again, which only the old node holds");
    const organizationId = await organizationOf(tenantId);
    const at = audience();
    const reporterId = await reporter(at);
    const others = (await readStages(tenantId)).filter((s) => s.row.name !== name);
    if (others.some((s) => s.row.boardId === boardId && s.row.stationId === stationId))
      refuse(409, "another stage already serves this board on this station");
    // The roster row follows the stage: same board, same station.
    if (boardId !== before.target.board_id || stationId !== before.target.station_id) {
      try {
        const done = await updateBridgeAgent(tenantId, before.agentKey, { boardId, stationId });
        if (!done) refuse(409, `the stage's roster row ${before.agentKey} is gone; add it again with fleet bridge add`);
      } catch (error) {
        if (error instanceof StageRefusal) throw error;
        refuse(400, `the stage's roster row: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const [roster] = await db.select().from(bridgeAgents)
      .where(and(eq(bridgeAgents.tenantId, tenantId), eq(bridgeAgents.key, before.agentKey)));
    if (!roster) return refuse(409, `the stage's roster row ${before.agentKey} is gone; add it again with fleet bridge add`);
    const change: NodeProfileChange = { id: name, tenant_id: tenantId, board_id: boardId, agent_id: req.agentId ?? before.target.agent_id,
      station_id: stationId, ...(req.checkpointRepository ? { checkpoint_repository: req.checkpointRepository } : {}),
      ...(req.repositories ? { repositories: nodeRepositories(req.repositories) } : {}), ...nodeWorker(req.worker) };
    const status = expectAnswer(await audited(userId, tenantId, station, "bench.registry.set",
      { stage: name, boardId, action: "set" }, () => nodeRegistrySet(station.nodeId, change, req.repin ?? false)));
    if (moved) {
      // The new node serves it; the old one stops. A failure here leaves a profile the hub no
      // longer pins, which `stage list` on that node shows and nothing selects.
      const old = await nodeRegistryRemove(before.target.node_id, name);
      if (old.ok) await repinNode(tenantId, before.target.node_id, old.status, name);
    }
    const served = status.profiles.find((p) => p.id === name) ?? refuse(502, "the node did not serve the stage it was given");
    const profile = buildProfile({ name, tenantId, organizationId, sourceTenantId: req.sourceTenantId ?? before.sourceTenantId,
      audience: at, reporter: reporterId, station, agentKey: roster.key, profileKey: roster.profileKey, served,
      repositories: req.repositories ?? before.repositories, checkpointRepository: req.checkpointRepository ?? before.checkpointRepository,
      choice });
    return finish(userId, tenantId, name, profile, req.stageId ?? stageId, status, false, roster.key, before, req.keepBench);
  });
}

export function removeBenchStage(userId: string, tenantId: string, name: string): Promise<StageResult> {
  return guarded(async () => {
    const { profile } = await currentStage(tenantId, name);
    const [s] = await db.select().from(stations).where(tenantScope(stations, tenantId, eq(stations.id, profile.target.station_id)));
    const station: StationFacts = { id: profile.target.station_id, nodeId: profile.target.node_id, stationKey: s?.stationKey ?? "",
      principalId: profile.occupantPrincipalId, ownerPrincipalId: profile.ownerPrincipalId, occupancyEpoch: profile.occupancyEpoch };
    const answer = await audited(userId, tenantId, station, "bench.registry.remove", { stage: name },
      () => nodeRegistryRemove(profile.target.node_id, name));
    // A node that no longer has the profile has nothing to remove; any other refusal keeps the row.
    if (!answer.ok && !answer.error.startsWith("not_found")) expectAnswer(answer);
    await deleteStage(tenantId, name);
    const repinned = answer.ok ? await repinNode(tenantId, profile.target.node_id, answer.status, name) : [];
    await reloadStageProfiles();
    const fileStillDeclares = installedFileCheckpointProfiles()
      .some((p) => p.target.tenant_id === tenantId && (p.coordinatorProfileId ?? p.profileKey) === name);
    return { status: 200, body: { removed: name, otherStagesRepinned: repinned, fileStillDeclares,
      nextSteps: [`The roster row ${profile.agentKey} is kept; remove it with fleet bridge rm ${profile.agentKey} if the agent should stop claiming.`,
        ...(fileStillDeclares ? ["The legacy profile file still declares this stage; remove it there too, or it is served from the file again after its node registry matches."] : [])] } };
  });
}

export async function listBenchStages(tenantId: string): Promise<{ stages: BenchStageView[] }> {
  const stages = await readStages(tenantId);
  const names = new Set(stages.map((s) => s.row.name));
  const fileOnly = installedFileCheckpointProfiles().filter((p) => p.target.tenant_id === tenantId &&
    !names.has(p.coordinatorProfileId ?? p.profileKey) &&
    !stages.some((s) => s.row.boardId === p.target.board_id && s.row.stationId === p.target.station_id));
  const nodeIds = new Set([...stages.map((s) => s.profile.target.node_id), ...fileOnly.map((p) => p.target.node_id)]);
  const answers = new Map<string, NodeAnswer>();
  await Promise.all([...nodeIds].map(async (id) => answers.set(id, await nodeRegistryStatus(id))));
  const out = [
    ...stages.map((s) => view(s.profile, s.row.origin === "file" ? "file" : "fleet", s.row.stageId, answers.get(s.profile.target.node_id),
      s.row.keepBench)),
    ...fileOnly.map((p) => view(p, "file-only", null, answers.get(p.target.node_id))),
  ];
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { stages: out };
}

/** For the doctor: the stage's pinned profile, from the table or the file. */
export async function stageProfile(tenantId: string, name: string):
  Promise<{ profile: CheckpointProfile; origin: string; stageId: string | null } | undefined> {
  const stored = await readStage(tenantId, name);
  if (stored) return { profile: stored.profile, origin: stored.row.origin, stageId: stored.row.stageId };
  const file = installedFileCheckpointProfiles().find((p) => p.target.tenant_id === tenantId && (p.coordinatorProfileId ?? p.profileKey) === name);
  return file ? { profile: file, origin: "file-only", stageId: null } : undefined;
}
