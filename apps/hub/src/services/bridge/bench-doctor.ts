/**
 * `fleet bench doctor`: everything that must hold before a stage's first card, checked in the
 * order an operator would fix it, each line pass or fail with the one next step. It changes
 * nothing: no grant is widened, no registry written, no row added. What stays manual (Accounts and
 * SuperPipeline steps the hub has no authority for) is printed as steps, not checked as failures
 * the hub could fix.
 */
import { and, eq } from "drizzle-orm";
import type { BenchDoctorCheck, BenchRegistryStatus } from "@agentpod/contract";

import { db } from "../../db/drizzle";
import { bridgeAgents } from "../../db/schema/bridge";
import { nodes } from "../../db/schema/nodes";
import { stations } from "../../db/schema/stations";
import { tenants } from "../../db/schema/tenants";
import { tenantScope } from "../../db/tenant-scope";
import { CHECKPOINT_COORDINATOR_FLAG } from "./checkpoint-profiles";
import { normalizeRosterProfileKey, type CheckpointProfile } from "./checkpoint-profile";
import { deploymentSuperpipelineAudience, parseDeploymentCredentialSource } from "./credential-audience";
import { checkBridgeDispatchGrant } from "./dispatch-grant";
import { trialAgentGrant } from "./roster";
import { nodeRegistryStatus } from "./bench-node";
import { CHECKPOINT_SERVICE_SCOPES, serviceGrant } from "./bench-service-grant";
import { checkpointPolicyFor, stageProfile, targetDifference } from "./bench-stages";

/** Below this much free space on either bench volume the doctor fails the storage line. */
export const MIN_FREE_BYTES = 1024 ** 3;

const gib = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GiB`;

export interface DoctorReport {
  ok: boolean;
  stage?: string;
  stationId?: string;
  checks: BenchDoctorCheck[];
  manual: string[];
  checkpointPolicy?: ReturnType<typeof checkpointPolicyFor>;
}

const REGISTRY_NEXT: Record<string, string> = {
  unconfigured: "Host step: install the coordinator registry on the bench host and set proposedCheckpointRegistry in the node config (an absolute path to a 0600 file in a 0700 directory); it may hold no stage yet. Restart the node once.",
  unreadable: "Host step: the registry file must be 0600 in a 0700 directory owned by the node's user, with no symlink in its path.",
  malformed: "Host step: the registry file is not agentpod.private-coordinator-registry.v1 for this node id; reinstall it.",
  worker_pin: "The installed worker's bytes differ from the pinned worker_sha256 (a worker update). If the update was intended: fleet bench stage set NAME --repin.",
  coordinator_pin: "This node binary differs from the pinned coordinator_implementation_sha256 (a node update). If the update was intended: fleet bench stage set NAME --repin.",
  invalid: "A root, profile or repository in the registry fails validation; check the private roots exist (0700) under no data root.",
};

export async function benchDoctor(tenantId: string, q: { name?: string; stationId?: string }): Promise<DoctorReport | null> {
  const checks: BenchDoctorCheck[] = [];
  const add = (check: string, ok: boolean | null, detail: string, next?: string, warn = false) =>
    checks.push({ check, ok, detail, ...(next && ok !== true ? { next } : {}), ...(warn ? { warn: true } : {}) });

  const stage = q.name ? await stageProfile(tenantId, q.name) : undefined;
  if (q.name && !stage) return null;
  const profile: CheckpointProfile | undefined = stage?.profile;
  const stationId = q.stationId ?? profile?.target.station_id;
  if (!stationId) return null;

  // ── this hub ──
  const flag = process.env[CHECKPOINT_COORDINATOR_FLAG] === "true";
  add("hub: checkpoint coordinator", flag, flag ? `${CHECKPOINT_COORDINATOR_FLAG}=true` : `${CHECKPOINT_COORDINATOR_FLAG} is not true`,
    `Set ${CHECKPOINT_COORDINATOR_FLAG}=true in the hub's environment (the master switch; no profile file is needed).`);
  const pair = process.env.ENFORCE_CONTROL_PAIR === "true";
  add("hub: control pair", pair, pair ? "ENFORCE_CONTROL_PAIR=true" : "ENFORCE_CONTROL_PAIR is not true; no checkpoint profile is served",
    "Set ENFORCE_CONTROL_PAIR=true in the hub's environment.");
  const audience = deploymentSuperpipelineAudience();
  add("hub: SuperPipeline audience", audience !== null, audience ?? "SUPERPIPELINE_BASE_URL is unset or not https",
    "Set SUPERPIPELINE_BASE_URL to this deployment's SuperPipeline origin.");

  // ── the station and its node ──
  const [s] = await db.select().from(stations).where(tenantScope(stations, tenantId, eq(stations.id, stationId)));
  if (!s) return null;
  add("station: occupant", s.principalId !== null, s.principalId ? `occupied by ${s.principalId}` : "the station has no occupant",
    "Create the agent principal in the Accounts console, then staff the station with it (fleet staff).");
  const [n] = await db.select().from(nodes).where(eq(nodes.id, s.nodeId));
  const online = n?.status === "online";
  add("node: online", online, online ? `${s.nodeId} is online` : `${s.nodeId} is ${n?.status ?? "unknown"}`, "Start the node (apn start on the bench host).");
  const answer = await nodeRegistryStatus(s.nodeId);
  let registry: BenchRegistryStatus | undefined;
  if (!answer.ok) add("node: registry verbs", false, answer.error, answer.error.includes("update it") ? "fleet nodes update" : undefined);
  else {
    registry = answer.status;
    add("node: registry", registry.valid, registry.valid ? `served, registry_sha256 ${registry.registry_sha256}` :
      `not served (${registry.problem ?? "invalid"})`, REGISTRY_NEXT[registry.problem ?? "invalid"]);
    const benchd = registry.benchd;
    if (!registry.configured || !benchd) add("benchd: reachable", null, "no registry, so no socket to ask");
    else {
      add("benchd: reachable", benchd.reachable && benchd.managed,
        !benchd.reachable ? "the bench daemon did not answer on the registry's socket" : benchd.managed ? "answers, cgroup-managed host" : "answers, but the host is not managed",
        "Host step: install and start SuperBench's benchd on the bench host with its socket at the registry's path (out of scope for fleet).");
      if (benchd.reachable) {
        const enough = benchd.data_free_bytes >= MIN_FREE_BYTES && benchd.state_free_bytes >= MIN_FREE_BYTES;
        add("benchd: storage", enough, `data ${gib(benchd.data_free_bytes)} free, state ${gib(benchd.state_free_bytes)} free`,
          `Host step: free space on the bench volumes (at least ${gib(MIN_FREE_BYTES)} each).`);
      }
    }
    if (registry.worker_sha256) {
      const same = registry.worker_sha256 === registry.worker_installed_sha256;
      add("worker: sha256", same, same ? `pinned ${registry.worker_sha256} is installed` :
        `pinned ${registry.worker_sha256}, installed ${registry.worker_installed_sha256 ?? "unreadable"}`, REGISTRY_NEXT.worker_pin);
      const own = registry.coordinator_implementation_sha256 === registry.coordinator_installed_sha256;
      add("node: coordinator sha256", own, own ? "pinned node binary is installed" : "the node binary changed since the pin", REGISTRY_NEXT.coordinator_pin);
    }
  }

  // ── the agent's roster row and grants ──
  const rows = await db.select().from(bridgeAgents).where(and(eq(bridgeAgents.tenantId, tenantId), eq(bridgeAgents.stationId, stationId)));
  const row = profile ? rows.find((r) => r.key === profile.agentKey) : rows.find((r) => r.credentialSource) ?? rows[0];
  const keyHint = row?.key ?? profile?.agentKey ?? "KEY";
  if (!row) add("roster: row", false, "no roster row dispatches this station", `fleet bridge add --key ${keyHint} --board brd_… --station ${stationId} --credential-source station-plane`);
  else {
    add("roster: row", row.enabled && (!profile || row.boardId === profile.target.board_id),
      `${row.key} on ${row.boardId}${row.enabled ? "" : " (disabled)"}`,
      row.enabled ? `fleet bench stage set ${profile?.coordinatorProfileId ?? "NAME"} --board ${row.boardId} (or move the row)` : `fleet bridge set ${row.key} --enabled true`);
    let source;
    try { source = row.credentialSource ? parseDeploymentCredentialSource(row.credentialSource) : undefined; } catch { source = undefined; }
    add("roster: credential source", source !== undefined, source ? `station-plane, audience ${source.audience}` :
      row.credentialSource ? "the stored source names another audience than this hub's" : "a legacy token row",
      `fleet bridge set ${row.key} --credential-source station-plane`);
    if (source) {
      const trial = await trialAgentGrant(source);
      add("agent grant: claim and run", trial.ok, trial.ok ? "a trial exchange verified with both scopes" :
        !trial.exchanged ? "the plane would not exchange a grant for the occupant at this audience" :
          trial.missing.length ? `missing scope ${trial.missing.join(" and ")}` : `refused (${trial.reason})`,
        "Accounts console: give the agent principal's grant the claim and run scopes, entitled to superpipeline.");
    }
    add("roster: run-only MCP token", row.mcpTokenEncrypted !== null, row.mcpTokenEncrypted ? "kept for the harness's board tools" : "none",
      `Mint a run-scoped token for the agent in SuperPipeline, then: fleet bridge set ${row.key} --mcp-token spa_…`);
  }
  const dispatch = await checkBridgeDispatchGrant(tenantId, stationId);
  add("owner: may dispatch", dispatch.state === "present", `dispatch grant ${dispatch.state}`,
    "Re-save the roster row (fleet bridge set KEY --enabled true) to record the owner's mayDispatch, or grant it in Accounts.");

  // ── the hub's service grant ──
  let reporter: string | undefined;
  if (audience) {
    const grant = await serviceGrant(audience);
    if (!grant.ok) add("service grant", false, grant.error, "Accounts: the hub's service principal must be able to exchange a grant at this audience.");
    else {
      reporter = grant.sub;
      const [t] = await db.select({ org: tenants.externalId }).from(tenants).where(eq(tenants.id, tenantId));
      const ok = grant.entitled && grant.missing.length === 0 && grant.org === t?.org;
      add("service grant: checkpoint scopes", ok, ok ? `reporter ${grant.sub} holds ${CHECKPOINT_SERVICE_SCOPES.join(" and ")}` :
        grant.org !== t?.org ? "the service grant is for another organization" : !grant.entitled ? "not entitled to superpipeline" :
          `missing scope ${grant.missing.join(" and ")}`,
        `Accounts: add ${CHECKPOINT_SERVICE_SCOPES.join(" and ")} to the hub's service principal (once per deployment; add, do not replace, its scopes).`);
    }
  }

  // ── the stage itself ──
  if (profile) {
    const pins: string[] = [];
    if (audience && profile.sourceAudience !== audience) pins.push("audience");
    if (reporter && profile.reporterPrincipalId !== reporter) pins.push("reporter");
    if (s.principalId !== profile.occupantPrincipalId) pins.push("occupant");
    if (s.userId !== profile.ownerPrincipalId) pins.push("owner");
    if (s.occupancyEpoch !== profile.occupancyEpoch) pins.push("occupancy epoch");
    if (row && normalizeRosterProfileKey(row.profileKey) !== profile.profileKey) pins.push("roster profile");
    const name = profile.coordinatorProfileId ?? profile.profileKey;
    add("stage: hub pins", pins.length === 0, pins.length ? `stale: ${pins.join(", ")}` : `${stage?.origin} profile matches the station, roster and grants`,
      `fleet bench stage set ${name} --refresh`);
    if (registry) {
      const served = registry.profiles.find((p) => p.id === name);
      const differ = served ? targetDifference(served.target, profile.target) : [];
      const same = served !== undefined && differ.length === 0;
      // The next step follows the cause. Installed bytes that moved (a worker or node update) are
      // fixed only by a repin; the node then serves the stage again, at a new digest.
      const pinProblem = !registry.valid && (registry.problem === "worker_pin" || registry.problem === "coordinator_pin");
      const bytesMoved = differ.some((k) => k === "worker_sha256" || k === "coordinator_implementation_sha256");
      add("stage: node serves it", same,
        !served ? (pinProblem ? `the node's registry is not served (${registry.problem})` : "the node's registry has no such profile")
          : same ? "the node advertises exactly the pinned target" : `the node advertises another ${differ.join(", ")} than the hub pins`,
        pinProblem || bytesMoved ? `If the worker or node update was intended: fleet bench stage set ${name} --repin`
          : `fleet bench stage set ${name} --refresh`);
    }
    if (stage?.stageId) add("stage: SuperPipeline stage", true, stage.stageId);
    else add("stage: SuperPipeline stage", null,
      "no SuperPipeline stage id is recorded (a stage adopted from the profile file has none), so the printed policy command cannot name it",
      `fleet bench stage set ${name} --stage-id STAGE_ID`, true);
  }

  const failed = checks.some((c) => c.ok === false);
  const manual = [
    "Accounts console: the agent principal exists, occupies the station, and its grant has the claim and run scopes.",
    `Accounts: the hub's service principal holds ${CHECKPOINT_SERVICE_SCOPES.join(" and ")} (once per deployment).`,
    `SuperPipeline: the board agent${profile ? ` ${profile.target.agent_id}` : ""} is linked to the agent principal (a person does this).`,
    profile?.repositorySelection === "card"
      ? "SuperPipeline: the stage's cardCheckpointPolicy names this node, station and agent, and the stage's allow-list (see checkpointPolicy); each card chooses from it."
      : "SuperPipeline: the stage's checkpointPolicy names this node, station and agent, and the stage's repositories (see checkpointPolicy).",
  ];
  return { ok: !failed, ...(q.name ? { stage: q.name } : {}), stationId, checks, manual,
    ...(profile ? { checkpointPolicy: checkpointPolicyFor(profile) } : {}) };
}
