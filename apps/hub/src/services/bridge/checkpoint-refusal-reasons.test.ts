/**
 * Every `authority` refusal from checkpoint selection names a closed sub-reason in the Hub's log.
 * The wire code stays `authority`; the reason is a fixed word and never carries an identifier,
 * token or raw exception. Each case below breaks exactly one pin of an otherwise-current fixture.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as broker from "../broker";
import * as currentAuthority from "./checkpoint-current";
import { parseBenchCoordinatorResponse } from "@agentpod/contract";
import corpus from "../../../../../packages/contract/src/fixtures/bench-coordinator-v1.json";
import fixture from "./checkpoint-contract/claim.fixture.json";
import { connectionManager } from "../broker";
import type { PlaneKind, PlanePrincipal } from "../../auth/org-plane/client";
import { factsRefusal, issuerRefusal, type RosterFacts } from "./checkpoint-current";
import { credentialRefusal } from "./checkpoint-agent-client";
import { checkpointRuntime, currentRefusalReason, readyReplyRefusal } from "./checkpoint-port";
import { claimRefusal, CheckpointRefused, parseCheckpointProfile, requireCheckpointProfileClaim,
  type CheckpointRefusalReason } from "./checkpoint-profile";
import { parsePendingCheckpointClaim, type PendingCheckpointClaim } from "./checkpoint-claim";
import { createCheckpointRefusalLog } from "./checkpoint-isolation";
import { setCheckpointLogForTests } from "./checkpoint-log";
import { createQuietLog } from "./quiet-log";

const envKeys = ["ENFORCE_CONTROL_PAIR", "PROPOSED_CHECKPOINT_COORDINATOR", "PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE"] as const;
const priorEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
const roots: string[] = [];
afterEach(() => {
  for (const k of envKeys) { const v = priorEnv[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const readyRequest = corpus.requests.find((item) => item.name === "ready")?.value;
const prepareRequest = corpus.requests.find((item) => item.name === "prepare")?.value;
if (!prepareRequest || !("target" in prepareRequest) || !prepareRequest.target) throw new Error("fixture target missing");
const profileConfig = { version: "agentpod.checkpoint-profile.v1", organizationId: "org_" + "a".repeat(20),
  sourceTenantId: "tnt_source", sourceOrigin: "https://pipeline.test", sourceAudience: "https://app.superpipeline.dev",
  reporterPrincipalId: "prn_" + "b".repeat(20), ownerPrincipalId: "prn_" + "c".repeat(20),
  occupantPrincipalId: "prn_" + "d".repeat(20), agentKey: "fixture", profileKey: "", coordinatorProfileId: "coord", occupancyEpoch: 2,
  target: prepareRequest.target, checkpointRepository: "api",
  repositories: [{ name: "api", provider: "forge", repository: "example/api", repositorySHA256: "e".repeat(64), objectFormat: "sha1" }] };
const profile = parseCheckpointProfile(profileConfig);

// ─── roster facts ───────────────────────────────────────────────────────────
const facts: RosterFacts = { organizationId: profile.organizationId, source: "org-plane", nodeId: profile.target.node_id,
  principalId: profile.occupantPrincipalId, ownerPrincipalId: profile.ownerPrincipalId, occupancyEpoch: profile.occupancyEpoch,
  profileKey: null, nodeStatus: "online", lastSeenAt: new Date(1_000_000) };
function factsReason(change: Partial<RosterFacts>, opts: { enforce?: boolean; online?: boolean; now?: number } = {}) {
  if (opts.enforce === false) delete process.env.ENFORCE_CONTROL_PAIR; else process.env.ENFORCE_CONTROL_PAIR = "true";
  const online = spyOn(connectionManager, "isOnline").mockImplementation((id) => (opts.online ?? true) && id === profile.target.node_id);
  try { return factsRefusal({ ...facts, ...change }, profile, opts.now ?? 1_005_000); } finally { online.mockRestore(); }
}

test("current roster facts name no reason", () => {
  expect(factsReason({})).toBeUndefined();
});
test.each([
  ["facts.tenant.source", { source: "hub" }],
  ["facts.tenant.organization", { organizationId: "org_" + "f".repeat(20) }],
  ["facts.node", { nodeId: "node-other" }],
  ["facts.principal", { principalId: "prn_" + "f".repeat(20) }],
  ["facts.owner", { ownerPrincipalId: "prn_" + "f".repeat(20) }],
  ["facts.epoch", { occupancyEpoch: 3 }],
  ["facts.profile", { profileKey: "named" }],
  ["node.status", { nodeStatus: "offline" }],
  ["node.last_seen", { lastSeenAt: null }],
] as const)("roster facts name %s", (reason, change) => {
  expect(factsReason(change)).toBe(reason);
});
test("no joined roster row names facts.row", () => {
  expect(factsRefusal(undefined, profile, 1_005_000)).toBe("facts.row");
});
test("facts name enforcement, a broker without the node, and a stale or future heartbeat", () => {
  expect(factsReason({}, { enforce: false })).toBe("facts.enforcement");
  expect(factsReason({}, { online: false })).toBe("node.offline");
  expect(factsReason({}, { now: 1_000_000 + 45_001 })).toBe("node.last_seen");
  expect(factsReason({}, { now: 999_999 })).toBe("node.last_seen");
});
test("the broker is asked by node id, not by station or agent id", () => {
  process.env.ENFORCE_CONTROL_PAIR = "true";
  const asked: string[] = [];
  const online = spyOn(connectionManager, "isOnline").mockImplementation((id) => { asked.push(id); return true; });
  try { factsRefusal(facts, profile, 1_005_000); } finally { online.mockRestore(); }
  expect(asked).toEqual([profile.target.node_id]);
});

// ─── issuer ─────────────────────────────────────────────────────────────────
function principal(id: string, kind: PlaneKind, change: Partial<PlanePrincipal> = {}): PlanePrincipal {
  return { id, kind, handle: "h", displayName: null, organizationId: profile.organizationId, suspended: false, grant: null, ...change };
}
const occupant = principal(profile.occupantPrincipalId, "agent");
const owner = principal(profile.ownerPrincipalId, "human", { grant: { mayDispatch: [profile.occupantPrincipalId], mayGrantReach: false, scopes: [] } });
test("standing issuer principals name no reason", () => {
  expect(issuerRefusal(profile, occupant, owner)).toBeUndefined();
});
test.each<[CheckpointRefusalReason, PlanePrincipal | null, PlanePrincipal | null]>([
  ["issuer.occupant.missing", null, owner],
  ["issuer.occupant.missing", { ...occupant, id: "prn_" + "f".repeat(20) }, owner],
  ["issuer.occupant.kind", { ...occupant, kind: "service" }, owner],
  ["issuer.occupant.suspended", { ...occupant, suspended: true }, owner],
  ["issuer.occupant.organization", { ...occupant, organizationId: "org_" + "f".repeat(20) }, owner],
  ["issuer.owner.missing", occupant, null],
  ["issuer.owner.missing", occupant, { ...owner, id: "prn_" + "f".repeat(20) }],
  ["issuer.owner.suspended", occupant, { ...owner, suspended: true }],
  ["issuer.owner.organization", occupant, { ...owner, organizationId: null }],
  ["issuer.grant", occupant, { ...owner, grant: { mayDispatch: [], mayGrantReach: false, scopes: [] } }],
  ["issuer.grant", occupant, { ...owner, grant: null }],
])("the issuer names %s", (reason, who, by) => {
  expect(issuerRefusal(profile, who, by)).toBe(reason);
});

// ─── roster credential source ───────────────────────────────────────────────
const DEPLOYMENT = "https://app.superpipeline.dev";
const STAGING = "https://staging-app.superpipeline.dev";
const source = { version: 1, kind: "station-plane", principalId: profile.occupantPrincipalId,
  organizationId: profile.organizationId, audience: DEPLOYMENT } as const;
test("a matching plane credential source names no reason", () => {
  expect(credentialRefusal(profile, source, DEPLOYMENT)).toBeUndefined();
});
test("a staging deployment admits its own audience", () => {
  const staging = { ...profile, sourceAudience: STAGING };
  expect(credentialRefusal(staging, { ...source, audience: STAGING }, STAGING)).toBeUndefined();
});
test("the credential source names missing, principal, organization and audience", () => {
  expect(credentialRefusal(profile, undefined, DEPLOYMENT)).toBe("credential.missing");
  expect(credentialRefusal(profile, undefined, null)).toBe("credential.missing");
  expect(credentialRefusal(profile, { ...source, principalId: "prn_" + "f".repeat(20) }, DEPLOYMENT)).toBe("credential.principal");
  expect(credentialRefusal(profile, { ...source, organizationId: "org_" + "f".repeat(20) }, DEPLOYMENT)).toBe("credential.organization");
  expect(credentialRefusal({ ...profile, sourceAudience: "https://other.example" }, source, DEPLOYMENT)).toBe("credential.audience");
});
test("the audience must be the configured deployment's, whatever the profile says", () => {
  // A production-audience source on a staging hub, even with a profile that agrees with the source.
  expect(credentialRefusal(profile, source, STAGING)).toBe("credential.audience");
  // A profile and source that agree on a plane this hub is not configured for.
  const other = { ...profile, sourceAudience: "https://attacker.test" };
  expect(credentialRefusal(other, { ...source, audience: "https://attacker.test" }, DEPLOYMENT)).toBe("credential.audience");
  // An unconfigured hub admits no source at all.
  expect(credentialRefusal(profile, source, null)).toBe("credential.audience");
});

// ─── claim pins ─────────────────────────────────────────────────────────────
const parsedClaim = parsePendingCheckpointClaim(fixture.pending);
const t = profile.target;
const claim = { ...parsedClaim, tenantId: profile.sourceTenantId, boardId: t.board_id, agentId: t.agent_id,
  policy: { ...parsedClaim.policy, reporterPrincipalId: profile.reporterPrincipalId, nodeId: t.node_id,
    checkpointRepository: profile.checkpointRepository, executors: [{ agentId: t.agent_id, stationId: t.station_id }],
    repositories: profile.repositories.map((r) => ({ name: r.name, provider: r.provider, repository: r.repository })) } };
test("this profile's claim names no reason and is accepted", () => {
  expect(claimRefusal(profile, claim)).toBeUndefined();
  expect(() => requireCheckpointProfileClaim(profile, claim)).not.toThrow();
});
test.each<[CheckpointRefusalReason, PendingCheckpointClaim]>([
  ["claim.tenant", { ...claim, tenantId: "tnt_other" }],
  ["claim.board", { ...claim, boardId: "brd_other" }],
  ["claim.agent", { ...claim, agentId: "agt_other" }],
  ["claim.reporter", { ...claim, policy: { ...claim.policy, reporterPrincipalId: "prn_other1" } }],
  ["claim.node", { ...claim, policy: { ...claim.policy, nodeId: "node-other" } }],
  ["claim.checkpoint_repository", { ...claim, policy: { ...claim.policy, checkpointRepository: "web" } }],
  ["claim.executor", { ...claim, policy: { ...claim.policy, executors: [{ agentId: t.agent_id, stationId: "station-other" }] } }],
  ["claim.repositories", { ...claim, policy: { ...claim.policy, repositories: [{ name: "api", provider: "github" as const, repository: "example/api" }] } }],
])("a claim names %s and still refuses as authority", (reason, broken) => {
  expect(claimRefusal(profile, broken)).toBe(reason);
  expect(() => requireCheckpointProfileClaim(profile, broken)).toThrow(expect.objectContaining({ code: "authority", reason }));
});

// ─── the node's ready reply ─────────────────────────────────────────────────
async function reply(value: unknown) {
  return parseBenchCoordinatorResponse(new TextEncoder().encode(JSON.stringify(value)), readyRequest);
}
const available = corpus.responses.find((item) => item.name === "ready")?.value;
test("an available reply with the pinned target names no reason", async () => {
  expect(readyReplyRefusal(await reply({ ...available, target: profile.target }), profile)).toBeUndefined();
});
test("a node refusal or unavailability names its closed state and code", async () => {
  const base = { version: "agentpod.bench-coordinator.v1", operation: "ready" };
  expect(readyReplyRefusal(await reply({ ...base, state: "refused", code: "unavailable" }), profile)).toBe("node.state:refused.unavailable");
  expect(readyReplyRefusal(await reply({ ...base, state: "unavailable", code: "unverified" }), profile)).toBe("node.state:unavailable.unverified");
});
test.each(["registry_sha256", "coordinator_implementation_sha256", "worker_sha256", "host_id"] as const)(
  "a target that differs in %s names that field", async (field) => {
    const target = { ...profile.target, [field]: field === "host_id" ? "host-other" : "f".repeat(64) };
    expect(readyReplyRefusal(await reply({ ...available, target }), profile)).toBe(`node.target.${field}`);
  });

// ─── re-read failures and the log ──────────────────────────────────────────
test("a failed current re-read keeps an authority reason and names anything else by code alone", () => {
  expect(currentRefusalReason(new CheckpointRefused("authority", "facts.epoch"))).toBe("facts.epoch");
  expect(currentRefusalReason(new CheckpointRefused("stale"))).toBe("current.stale");
  expect(currentRefusalReason(new CheckpointRefused("authority"))).toBe("current.authority");
  expect(currentRefusalReason(new Error("token spa_secret at https://x"))).toBe("current.error");
});
test("each sub-reason is logged once, beside the unchanged code, and rate-limited on its own", () => {
  let now = 0;
  const lines: Record<string, unknown>[] = [];
  const refused = createCheckpointRefusalLog((_m, meta) => lines.push(meta ?? {}), { now: () => now, relogMs: 60_000 });
  for (let i = 0; i < 10; i++) { refused(new CheckpointRefused("authority", "node.state:refused.unavailable")); now += 5_000; }
  refused(new CheckpointRefused("authority", "credential.audience"));
  expect(lines).toEqual([{ code: "authority", reason: "node.state:refused.unavailable" }, { code: "authority", reason: "credential.audience" }]);
  now += 60_000;
  refused(new CheckpointRefused("authority", "node.state:refused.unavailable"));
  expect(lines.at(-1)).toEqual({ code: "authority", reason: "node.state:refused.unavailable", suppressed: 9 });
  // A reasonless refusal logs exactly as before.
  refused(new CheckpointRefused("authority"));
  expect(lines.at(-1)).toEqual({ code: "authority" });
});
test("the wire message stays the code alone", () => {
  expect(new CheckpointRefused("authority", "facts.epoch").message).toBe("Checkpoint refused: authority");
});

// ─── the port carries the reason out of ready ──────────────────────────────
function installedRuntime() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "checkpoint-reasons-"))); roots.push(root); chmodSync(root, 0o700);
  const file = join(root, "profiles.json");
  writeFileSync(file, JSON.stringify({ version: "agentpod.checkpoint-profiles.v1", profiles: [profileConfig] }), { mode: 0o600 });
  process.env.PROPOSED_CHECKPOINT_COORDINATOR = "true";
  process.env.PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE = file;
  process.env.ENFORCE_CONTROL_PAIR = "true";
  const info = spyOn(console, "log").mockImplementation(() => {});
  try {
    const runtime = checkpointRuntime(t.tenant_id, t.board_id, t.station_id, profile.agentKey);
    if (!runtime) throw new Error("profile not installed");
    return runtime;
  } finally { info.mockRestore(); }
}
const identity = { tenantId: t.tenant_id, boardId: t.board_id, stationId: t.station_id };
async function readyRefusal(nodeReply: unknown, authority: () => Promise<currentAuthority.CheckpointAuthority>) {
  const runtime = installedRuntime();
  const read = spyOn(currentAuthority, "readCheckpointAuthority").mockImplementation(authority);
  const request = spyOn(broker, "request").mockImplementation(async () => ({ ok: true, data: nodeReply }));
  try { await runtime.port.ready(identity); return undefined; }
  catch (error) { return error; }
  finally { read.mockRestore(); request.mockRestore(); }
}
const authorized = async (): Promise<currentAuthority.CheckpointAuthority> => ({ organizationId: profile.organizationId,
  tenantId: t.tenant_id, sourceTenantId: profile.sourceTenantId, stationId: t.station_id, nodeId: t.node_id,
  occupancyEpoch: profile.occupancyEpoch, principalId: profile.occupantPrincipalId, ownerPrincipalId: profile.ownerPrincipalId,
  agentKey: profile.agentKey, profileKey: profile.profileKey, rosterRevision: "2026-01-01T00:00:00.000Z",
  authorizationSnapshotId: "selected-auth:" + "0".repeat(64) });
test("ready refuses a node's refusal as authority on the wire, naming its state", async () => {
  const error = await readyRefusal({ version: "agentpod.bench-coordinator.v1", operation: "ready", state: "refused", code: "unavailable" }, authorized);
  expect(error).toBeInstanceOf(CheckpointRefused);
  expect(error).toMatchObject({ code: "authority", reason: "node.state:refused.unavailable", message: "Checkpoint refused: authority" });
});
test("ready refuses a different advertised target, naming the field", async () => {
  const error = await readyRefusal({ ...available, target: { ...profile.target, registry_sha256: "f".repeat(64) } }, authorized);
  expect(error).toMatchObject({ code: "authority", reason: "node.target.registry_sha256" });
});
test("ready refuses a failed authority re-read with that re-read's reason", async () => {
  const error = await readyRefusal({ ...available, target: profile.target },
    async () => { throw new CheckpointRefused("authority", "node.offline"); });
  expect(error).toMatchObject({ code: "authority", reason: "node.offline" });
});
test("ready refuses another station's identity before asking the node", async () => {
  const runtime = installedRuntime();
  const request = spyOn(broker, "request");
  try {
    await expect(runtime.port.ready({ ...identity, stationId: "station-other" })).rejects.toMatchObject({ code: "authority", reason: "selection.identity" });
    expect(request).not.toHaveBeenCalled();
  } finally { request.mockRestore(); }
});
test("ready with the pinned target and current authority selects it", async () => {
  expect(await readyRefusal({ ...available, target: profile.target }, authorized)).toBeUndefined();
});

// ─── a current re-read never answers a bare false ───────────────────────────
test("a current re-read that refuses names its reason, and an unexpected error its class", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const restore = setCheckpointLogForTests(createQuietLog((_m, meta) => lines.push(meta ?? {}), { now: () => 0 }));
  const runtime = installedRuntime();
  const selected = { tenantId: t.tenant_id, sourceTenantId: profile.sourceTenantId, boardId: t.board_id, agentId: t.agent_id,
    stationId: t.station_id, nodeId: t.node_id, hostId: t.host_id, registryRevision: t.registry_sha256,
    benchProtocol: t.bench_protocol, coordinatorImplementationSHA256: t.coordinator_implementation_sha256,
    executionMode: t.execution_mode, workerVersion: t.worker_version, workerSHA256: t.worker_sha256 };
  let failure: Error = new CheckpointRefused("authority", "node.last_seen");
  const read = spyOn(currentAuthority, "readCheckpointAuthority").mockImplementation(async () => { throw failure; });
  try {
    expect(await runtime.port.current(selected)).toBe(false);
    expect(lines).toContainEqual(expect.objectContaining({ site: "current", reason: "node.last_seen" }));
    failure = new Error("connection reset by peer");
    expect(await runtime.port.current(selected)).toBe(false);
    expect(lines).toContainEqual(expect.objectContaining({ site: "current", reason: "current.error", errorClass: "Error",
      error: "connection reset by peer" }));
  } finally { read.mockRestore(); restore(); }
});
