/**
 * `fleet bench stage add|set|list|rm` and `fleet bench doctor`, through the admin routes, against a
 * fake node that keeps a registry the way the Go node does (`internal/benchbridge/registry_manage.go`):
 * it merges a profile change, refuses unknown fields, and answers with its own `registry_sha256`.
 *
 * What these hold:
 * - a stage is selected on the next cycle with no restart, pinned to the digest the NODE reported;
 * - moving a stage's board is one PATCH: the node gets the selector only, the roster row follows;
 * - an existing file-based install keeps working with an empty table, and its profiles are adopted
 *   (re-pinned to the node's new digest) the first time the hub rewrites that node's registry;
 * - no response or audit row carries a clone URL or a worker argument;
 * - a node refusal changes nothing on the hub.
 */
process.env.DATABASE_URL ||= "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";
process.env.ENCRYPTION_KEY ||= "bench-stages-test-key-0123456789";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { BenchDoctorCheck, BenchStageView, HelloMsg } from "@agentpod/contract";
import { setNodeCapabilities } from "../../src/services/nodes/registry";
import { stageKeepsBench as keepFor } from "../../src/services/bridge/checkpoint-reclaim";


import { db } from "../../src/db/drizzle";
import { tenants } from "../../src/db/schema/tenants";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { bridgeAgents } from "../../src/db/schema/bridge";
import { benchStages } from "../../src/db/schema/bench-stages";
import { stationAudit } from "../../src/db/schema/audit";
import { adminBenchRouter } from "../../src/routes/admin-bench";
import { connectionManager, handleNodeMessage } from "../../src/services/broker";
import { installedCheckpointProfiles } from "../../src/services/bridge/checkpoint-profiles";
import { parseCheckpointProfile, type CheckpointProfile } from "../../src/services/bridge/checkpoint-profile";
import { checkpointRuntime, checkpointRuntimeResolver } from "../../src/services/bridge/checkpoint-port";
import { reloadStageProfiles } from "../../src/services/bridge/bench-stage-store";
import { setOrgPlaneClientForTests } from "../../src/auth/org-plane/client";
import { TEST_PLANE } from "../../src/auth/org-plane/config";
import { fakePlane, fakePlaneJwks, signPlaneToken } from "../helpers/fake-plane";
import { createTestUser, deleteTestUsers } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, n);
const suffix = hex(20);
const organizationId = "org_" + suffix;
const tenantId = "fleet_" + suffix, nodeId = "node_" + suffix, stationId = "station_" + suffix;
const owner = "prn_" + hex(20), occupant = "prn_" + hex(20), reporter = "prn_" + hex(20);
const BOARD = "brd_" + hex(16), BOARD2 = "brd_" + hex(16), LEGACY_BOARD = "brd_" + hex(16);
const AUDIENCE = "https://staging-app.superpipeline.dev";
const CLONE = "ssh://git@forge.test:2222/example/app.git";
const WORKER = "/usr/local/libexec/bench-worker-" + suffix;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const envKeys = ["PROPOSED_CHECKPOINT_COORDINATOR", "PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE", "ENFORCE_CONTROL_PAIR",
  "SUPERPIPELINE_BASE_URL"] as const;
const priorEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

// ── a node that keeps its registry as the Go node does ───────────────────────

/** Go's `ProfileChange` and `SetRequest`: the node decodes with DisallowUnknownFields, so strict here too. */
const Repo = z.object({ name: z.string(), repository: z.string(), base: z.string().optional(), object_format: z.string() }).strict();
const Change = z.object({ id: z.string(), tenant_id: z.string(), board_id: z.string(), agent_id: z.string(), station_id: z.string(),
  checkpoint_repository: z.string().optional(), repositories: z.array(Repo).optional(), arguments: z.array(z.string()).optional(),
  environment: z.record(z.string(), z.string()).optional(), launch: z.string().optional() }).strict();
const SetParams = z.object({ profile: Change.optional(), repin: z.boolean().optional() }).strict();
const RemoveParams = z.object({ id: z.string() }).strict();
type LocalProfile = { id: string; tenant_id: string; board_id: string; agent_id: string; station_id: string;
  checkpoint_repository: string; repositories: z.infer<typeof Repo>[]; arguments: string[]; environment: Record<string, string>;
  launch?: string };
const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`${what} missing`);
  return value;
};
const node = {
  profiles: new Map<string, LocalProfile>(),
  worker: "e".repeat(64), coordinator: "f".repeat(64), host: "host_" + suffix,
  requests: new Array<{ verb: string; params: unknown }>(),
  refuse: "",
  /** A registry problem the node reports instead of serving (Go `Problem*`); empty serves. */
  problem: "",
  // The whole file, pins included, as the Go node hashes its registry bytes.
  digest() { return sha(JSON.stringify([this.worker, this.coordinator, [...this.profiles.values()]])); },
  status() {
    const digest = this.digest();
    return { configured: true, valid: true, node_id: nodeId, host_id: this.host, registry_sha256: digest,
      worker_sha256: this.worker, worker_installed_sha256: this.worker,
      coordinator_implementation_sha256: this.coordinator, coordinator_installed_sha256: this.coordinator,
      benchd: { reachable: true, managed: true, data_free_bytes: 8 * 1024 ** 3, state_free_bytes: 4 * 1024 ** 3 },
      profiles: [...this.profiles.values()].map((p) => ({ id: p.id, checkpoint_repository: p.checkpoint_repository, launch: p.launch,
        repositories: p.repositories.map((r) => ({ name: r.name, repository_sha256: sha(r.repository), object_format: r.object_format,
          ...(r.base ? { base: r.base } : {}) })),
        target: { tenant_id: p.tenant_id, board_id: p.board_id, agent_id: p.agent_id, station_id: p.station_id, node_id: nodeId,
          host_id: this.host, registry_sha256: digest, coordinator_implementation_sha256: this.coordinator,
          execution_mode: "linux-cgroup-v2", bench_protocol: "superbench.v2", worker_version: "agentpod.superbench-worker.v2",
          worker_sha256: this.worker } })) };
  },
  answer(verb: string, params: unknown): unknown {
    this.requests.push({ verb, params });
    if (this.refuse) throw new Error(this.refuse);
    if (verb === "bench.registry.status")
      return this.problem ? { ...this.status(), valid: false, problem: this.problem, registry_sha256: undefined, profiles: [] } : this.status();
    if (verb === "bench.registry.remove") {
      if (!this.profiles.delete(RemoveParams.parse(params).id)) throw new Error("not_found: the node's registry has no profile with that id");
      return this.status();
    }
    const parsed = SetParams.safeParse(params);
    if (!parsed.success) throw new Error("invalid_request: not a registry change");
    const change = parsed.data.profile;
    if (change) {
      const before = this.profiles.get(change.id);
      const repositories = change.repositories ?? before?.repositories;
      const args = change.arguments ?? before?.arguments;
      const checkpoint = change.checkpoint_repository ?? before?.checkpoint_repository;
      if (!repositories || !args || !checkpoint)
        throw new Error("invalid_request: a new profile needs its repositories, checkpoint repository and worker arguments");
      this.profiles.set(change.id, { ...before, ...change, environment: change.environment ?? before?.environment ?? {},
        repositories: repositories.toSorted((a, b) => (a.name < b.name ? -1 : 1)), arguments: args, checkpoint_repository: checkpoint });
    }
    return this.status();
  },
};

function attachNode() {
  connectionManager.register(nodeId, (message) => {
    if (message.type !== "req") return;
    if (message.verb === "bench.coordinator") {
      // The coordinator's `ready`: it advertises the target its registry serves for the selector.
      const ready = z.object({ operation: z.literal("ready"), tenant_id: z.string(), board_id: z.string(), station_id: z.string() })
        .loose().parse(message.params);
      const served = node.status().profiles.find((p) => p.target.tenant_id === ready.tenant_id &&
        p.target.board_id === ready.board_id && p.target.station_id === ready.station_id);
      handleNodeMessage(nodeId, { type: "res", id: message.id, ok: true, data: served
        ? { version: "agentpod.bench-coordinator.v1", operation: "ready", state: "available", target: served.target }
        : { version: "agentpod.bench-coordinator.v1", operation: "ready", state: "refused", code: "unavailable" } });
      return;
    }
    if (!message.verb.startsWith("bench.registry.")) return;
    try {
      const data = node.answer(message.verb, message.params ?? {});
      handleNodeMessage(nodeId, { type: "res", id: message.id, ok: true, data });
    } catch (error) {
      handleNodeMessage(nodeId, { type: "res", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

// ── the hub ──────────────────────────────────────────────────────────────────

let userId = "";
let root = "";
const app = () => new Hono().use("*", async (c, next) => {
  c.set("user", { id: userId, authType: "org_plane", tenantId, workspaceRole: "admin" });
  await next();
}).route("/bench", adminBenchRouter);
const call = (method: string, path: string, body?: unknown) => app().request(`/bench${path}`, {
  method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const addBody = (over: Record<string, unknown> = {}) => ({
  name: "review", boardId: BOARD, stationId, agentId: "agt_" + suffix.slice(0, 12), sourceTenantId: "tnt_" + suffix.slice(0, 16),
  stageId: "stg_review", repositories: [{ name: "app", provider: "forge", repository: "example/app", cloneUrl: CLONE, base: "main" }],
  checkpointRepository: "app", worker: { arguments: [WORKER, "--quiet"] }, ...over,
});

const installedFor = (name: string) => installedCheckpointProfiles().find((p) => p.target.tenant_id === tenantId &&
  (p.coordinatorProfileId ?? p.profileKey) === name);

let restorePlane: () => void = () => {};
let serviceScope = "checkpoints:submit checkpoints:read";
const realFetch = globalThis.fetch;

beforeAll(async () => {
  await ensurePgMigrations();
  userId = (await createTestUser({ name: "bench-stages" })).id;
  root = realpathSync(mkdtempSync(join(tmpdir(), "bench-stages-"))); chmodSync(root, 0o700);
  Object.assign(process.env, { ENFORCE_CONTROL_PAIR: "true", PROPOSED_CHECKPOINT_COORDINATOR: "true", SUPERPIPELINE_BASE_URL: AUDIENCE });
  delete process.env.PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE;
  fakePlane.addAgent({ id: occupant }); fakePlane.addHuman({ id: owner, grant: { mayDispatch: [occupant] } });
  for (const id of [occupant, owner]) must(fakePlane.principals.get(id), "fixture principal").organizationId = organizationId;
  restorePlane = setOrgPlaneClientForTests({
    ...fakePlane,
    agentToken: async (principal, aud) => ({ expiresIn: 300, accessToken: await signPlaneToken({ sub: principal, principalKind: "agent",
      aud, ent: ["superpipeline"], org: organizationId, scope: "claim run" }) }),
    serviceToken: async (aud) => ({ expiresIn: 300, accessToken: await signPlaneToken({ sub: reporter, principalKind: "service",
      aud, ent: ["superpipeline"], org: organizationId, scope: serviceScope }) }),
  });
  globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    return address === TEST_PLANE.jwksUrl ? Response.json(await fakePlaneJwks()) : realFetch(url, init);
  }, { preconnect: realFetch.preconnect });
  await db.insert(tenants).values({ id: tenantId, name: "bench stages fixture", externalSource: "org-plane", externalId: organizationId });
  await db.insert(nodes).values({ id: nodeId, tenantId, userId: owner, name: "bench", hostname: "bench", os: "linux", arch: "amd64",
    secretHash: "x", status: "online", lastSeenAt: new Date() });
  // Through the hello frame's own parse, as the gateway stores it: a capability the contract does
  // not know is filtered there, and seeding the row directly hid exactly that.
  const hello = HelloMsg.parse({ type: "hello", hostInfo: { hostname: "bench", os: "linux", arch: "amd64", cpuCount: 2 },
    capabilities: ["posture", "frames.large", "bench.registry.manage"] });
  await setNodeCapabilities(nodeId, hello.capabilities ?? null);
  await db.insert(stations).values({ id: stationId, tenantId, userId: owner, principalId: occupant, occupancyEpoch: 3,
    nodeId, stationKey: "bench:" + suffix, kind: "leaf", displayName: "bench", harness: "hermes", workspacePath: "/bench" });
  attachNode();
});

beforeEach(() => {
  node.refuse = "";
  node.requests = [];
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  restorePlane();
  connectionManager.unregister(nodeId);
  await db.delete(benchStages).where(eq(benchStages.tenantId, tenantId));
  await db.delete(stationAudit).where(eq(stationAudit.tenantId, tenantId));
  await db.delete(bridgeAgents).where(eq(bridgeAgents.tenantId, tenantId));
  await db.delete(stations).where(eq(stations.tenantId, tenantId));
  await db.delete(nodes).where(eq(nodes.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await reloadStageProfiles();
  await deleteTestUsers([userId]);
  fakePlane.remove(occupant); fakePlane.remove(owner);
  rmSync(root, { recursive: true, force: true });
  for (const k of envKeys) { const v = priorEnv[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

function legacyProfile(registrySHA256: string): CheckpointProfile {
  return parseCheckpointProfile({ version: "agentpod.checkpoint-profile.v1", organizationId, sourceTenantId: "tnt_" + suffix.slice(0, 16),
    sourceOrigin: AUDIENCE, sourceAudience: AUDIENCE, reporterPrincipalId: reporter, ownerPrincipalId: owner, occupantPrincipalId: occupant,
    agentKey: "legacy-row", profileKey: "", coordinatorProfileId: "legacy", occupancyEpoch: 3,
    target: { tenant_id: tenantId, board_id: LEGACY_BOARD, agent_id: "agt_legacy01", station_id: stationId, node_id: nodeId,
      host_id: node.host, registry_sha256: registrySHA256, coordinator_implementation_sha256: node.coordinator,
      execution_mode: "linux-cgroup-v2", bench_protocol: "superbench.v2", worker_version: "agentpod.superbench-worker.v2", worker_sha256: node.worker },
    repositories: [{ name: "sandbox", repositorySHA256: sha("/srv/legacy.git"), provider: "forge", repository: "example/legacy", objectFormat: "sha1" }],
    checkpointRepository: "sandbox" });
}

describe("upgrading a file-based install", () => {
  test("with the table empty, the file's profiles are served exactly as before; the first registry write adopts them", async () => {
    // The pilot as it stands: a hand-written node registry and a hand-written hub profile file.
    node.profiles.set("legacy", { id: "legacy", tenant_id: tenantId, board_id: LEGACY_BOARD, agent_id: "agt_legacy01", station_id: stationId,
      checkpoint_repository: "sandbox", repositories: [{ name: "sandbox", repository: "/srv/legacy.git", base: "main", object_format: "sha1" }],
      arguments: ["/usr/local/libexec/legacy-harness"], environment: {}, launch: "registered-v1" });
    await db.insert(bridgeAgents).values({ tenantId, key: "legacy-row", boardId: LEGACY_BOARD, stationId, profileKey: "",
      tokenEncrypted: "", credentialSource: { version: 1, kind: "station-plane", principalId: occupant, organizationId, audience: AUDIENCE } });
    const before = legacyProfile(node.digest());
    const file = join(root, "checkpoint-profiles.json");
    writeFileSync(file, JSON.stringify({ version: "agentpod.checkpoint-profiles.v1", profiles: [before] }), { mode: 0o600 });
    process.env.PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE = file;
    await reloadStageProfiles();
    expect(installedFor("legacy")).toEqual(before);

    // `fleet bench stage add` on the same node: the node's digest changes for every profile it serves.
    const res = await call("POST", "/stages", addBody());
    expect(res.status).toBe(201);
    const body = z.object({ otherStagesRepinned: z.array(z.string()) }).parse(await res.json());
    expect(body.otherStagesRepinned).toEqual(["legacy"]);
    const adopted = must(installedFor("legacy"), "adopted profile");
    expect(adopted.target.registry_sha256).toBe(node.digest());
    expect(adopted.target.registry_sha256).not.toBe(before.target.registry_sha256);
    expect({ ...adopted, target: { ...adopted.target, registry_sha256: "" } })
      .toEqual({ ...before, target: { ...before.target, registry_sha256: "" } });
    const [row] = await db.select().from(benchStages).where(and(eq(benchStages.tenantId, tenantId), eq(benchStages.name, "legacy")));
    expect(row?.origin).toBe("file");
    // The stale file copy is never served next to it.
    expect(installedCheckpointProfiles().filter((p) => p.target.board_id === LEGACY_BOARD)).toHaveLength(1);
  });
});

describe("a stage set up from the hub", () => {
  test("add pins the node's own digest, creates a source roster row, and is selected with no restart", async () => {
    const profile = must(installedFor("review"), "stage profile");
    expect(profile.target.registry_sha256).toBe(node.digest());
    expect(profile.repositories).toEqual([{ name: "app", repositorySHA256: sha(CLONE), provider: "forge", repository: "example/app",
      objectFormat: "sha1" }]);
    expect(profile).toMatchObject({ reporterPrincipalId: reporter, ownerPrincipalId: owner, occupantPrincipalId: occupant,
      occupancyEpoch: 3, organizationId, sourceAudience: AUDIENCE, agentKey: "review", profileKey: "", coordinatorProfileId: "review" });
    const [roster] = await db.select().from(bridgeAgents).where(and(eq(bridgeAgents.tenantId, tenantId), eq(bridgeAgents.key, "review")));
    expect(roster).toMatchObject({ boardId: BOARD, stationId, tokenEncrypted: "", enabled: true });
    expect(roster?.credentialSource).toMatchObject({ kind: "station-plane", principalId: occupant, organizationId, audience: AUDIENCE });
    expect(checkpointRuntime(tenantId, BOARD, stationId, "review")).toBeDefined();
    // The clone identity and the worker went to the node, and only there.
    expect(node.profiles.get("review")).toMatchObject({ arguments: [WORKER, "--quiet"], launch: "registered-v1",
      repositories: [{ name: "app", repository: CLONE, base: "main", object_format: "sha1" }] });
  });

  test("no response, audit row or stored profile carries a clone URL or a worker argument", async () => {
    const list = await (await call("GET", "/stages")).text();
    const stored = JSON.stringify(await db.select().from(benchStages).where(eq(benchStages.tenantId, tenantId)));
    const audits = JSON.stringify(await db.select().from(stationAudit).where(eq(stationAudit.tenantId, tenantId)));
    for (const text of [list, stored, audits]) {
      expect(text).not.toContain(CLONE);
      expect(text).not.toContain(WORKER);
    }
    expect(audits).toContain("bench.registry.set");
  });

  test("list says the node serves each stage exactly as pinned, and names a drifted field", async () => {
    const List = z.object({ stages: z.array(BenchStageView) });
    const { stages } = List.parse(await (await call("GET", "/stages")).json());
    expect(stages.map((s) => [s.name, s.served, s.origin])).toEqual([["legacy", "served", "file"], ["review", "served", "fleet"]]);
    node.worker = "d".repeat(64);
    const drifted = List.parse(await (await call("GET", "/stages")).json());
    expect(drifted.stages[0]).toMatchObject({ served: "drifted", detail: "registry_sha256, worker_sha256" });
    node.worker = "e".repeat(64);
  });

  test("moving a stage to another board is one PATCH: the node gets the selector only, the roster row follows", async () => {
    const before = must(installedFor("review"), "stage profile");
    const res = await call("PATCH", "/stages/review", { boardId: BOARD2 });
    expect(res.status).toBe(200);
    const set = SetParams.parse(must(node.requests.find((r) => r.verb === "bench.registry.set"), "registry write").params);
    expect(Object.keys(must(set.profile, "profile change")).toSorted()).toEqual(["agent_id", "board_id", "id", "station_id", "tenant_id"]);
    expect(node.profiles.get("review")?.repositories[0]?.repository).toBe(CLONE);
    const after = must(installedFor("review"), "moved profile");
    expect(after.target.board_id).toBe(BOARD2);
    expect(after.target.registry_sha256).toBe(node.digest());
    expect(after.target.registry_sha256).not.toBe(before.target.registry_sha256);
    expect(installedFor("legacy")?.target.registry_sha256).toBe(node.digest());
    const [roster] = await db.select().from(bridgeAgents).where(and(eq(bridgeAgents.tenantId, tenantId), eq(bridgeAgents.key, "review")));
    expect(roster?.boardId).toBe(BOARD2);
    expect(checkpointRuntime(tenantId, BOARD, stationId, "review")).toBeUndefined();
    expect(checkpointRuntime(tenantId, BOARD2, stationId, "review")).toBeDefined();
  });

  test("a running loop's next cycle dispatches under the changed stage, with no restart", async () => {
    // What a bridge loop holds: one resolver per roster row, asked at every cycle's start.
    const resolve = checkpointRuntimeResolver(tenantId, BOARD2, stationId, "review");
    const identity = { tenantId, boardId: BOARD2, stationId };
    const first = must(resolve(), "runtime before the change");
    const before = must(await first.port.ready(identity), "ready before the change");
    expect(resolve()).toBe(first);

    // A worker update, then `fleet bench stage set review --repin`: a new profile, same selector.
    node.worker = "a".repeat(64);
    const repinned = await call("PATCH", "/stages/review", { repin: true });
    expect(repinned.status).toBe(200);
    // The reply names this stage's own re-pinned fields, not only the other stages it moved.
    const PinChange = z.object({ from: z.string(), to: z.string() });
    const { changed, otherStagesRepinned } = z.object({ changed: z.record(z.string(), PinChange),
      otherStagesRepinned: z.array(z.string()) }).parse(await repinned.json());
    expect(Object.keys(changed).toSorted()).toEqual(["registry_sha256", "worker_sha256"]);
    // The other stage on the node (adopted from the file) moved to the new digest with it.
    expect(otherStagesRepinned).toEqual(["legacy"]);
    expect(changed.worker_sha256).toEqual({ from: "e".repeat(64), to: "a".repeat(64) });
    // The runtime kept from before refuses as stale; that is what a loop built once was stuck on.
    expect(await first.port.current(before)).toBe(false);
    const next = must(resolve(), "runtime after the change");
    expect(next).not.toBe(first);
    const after = must(await next.port.ready(identity), "ready after the change");
    expect(after.workerSHA256).toBe("a".repeat(64));
    expect(await next.port.current(after)).toBe(true);
  });

  test("a stage's benches are cleared by the hub unless it is set --keep-bench, and a re-pin keeps the choice", async () => {
    const List = z.object({ stages: z.array(BenchStageView) });
    const keep = async () => List.parse(await (await call("GET", "/stages")).json()).stages.find((st) => st.name === "review")?.keepBench;
    // The reply's `changed` names the flip, as it names a pin: it answered `changed: {}`.
    const Changed = z.object({ changed: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })) });
    const set = async (name: string, body: Record<string, unknown>) => {
      const res = await call("PATCH", `/stages/${name}`, body);
      expect(res.status).toBe(200);
      return Changed.parse(await res.json()).changed;
    };
    expect(await keep()).toBe(false);
    expect(await keepFor(must(installedFor("review"), "review"))).toBe(false);
    expect((await set("review", { keepBench: true })).keepBench).toEqual({ from: false, to: true });
    expect(await keep()).toBe(true);
    expect(await keepFor(must(installedFor("review"), "review"))).toBe(true);
    // Another stage's write re-pins this one and leaves its choice alone.
    expect(await set("legacy", { refresh: true })).not.toHaveProperty("keepBench");
    expect(await keep()).toBe(true);
    expect((await set("review", { keepBench: false })).keepBench).toEqual({ from: true, to: false });
    expect(await keep()).toBe(false);
    // Asked for what it already is, nothing flipped and nothing is claimed.
    expect(await set("review", { keepBench: false })).not.toHaveProperty("keepBench");
    // A stage served only from the profile file has no row: it reclaims, the default.
    expect(await keepFor({ ...must(installedFor("review"), "review"), coordinatorProfileId: "file-only" })).toBe(false);
  });

  test("a stage whose cards choose: claims ask for v2, and the printed policy is its cardCheckpointPolicy", async () => {
    // The policy is printed under the SuperPipeline stage field it goes in, because a person copies
    // the key with the value: a v2 policy under `checkpointPolicy` lands where SuperPipeline refuses it.
    const Policy = z.object({ version: z.string() }).loose();
    const Reply = z.object({ checkpointPolicy: Policy.optional(), cardCheckpointPolicy: Policy.optional(),
      nextSteps: z.array(z.string()), stage: BenchStageView });
    const on = Reply.parse(await (await call("PATCH", "/stages/review", { cardsChoose: true, defaultRepositories: ["app"] })).json());
    expect(on.cardCheckpointPolicy).toMatchObject({ version: "superpipeline.checkpoint-policy.v2", repositorySelection: "card",
      defaultRepositories: ["app"], repositories: [{ name: "app", provider: "forge", repository: "example/app" }], checkpointRepository: "app" });
    expect(on.checkpointPolicy).toBeUndefined();
    expect(on.stage).toMatchObject({ cardsChoose: true, defaultRepositories: ["app"] });
    const step = on.nextSteps.find((s) => s.includes("set the stage's"));
    expect(step).toContain("set the stage's cardCheckpointPolicy to the cardCheckpointPolicy above");
    expect(step).toContain('"checkpointPolicy": null');
    // The doctor names it the same way, in its report and in its manual step.
    const doctor = z.object({ manual: z.array(z.string()), checkpointPolicy: Policy.optional(), cardCheckpointPolicy: Policy.optional() })
      .parse(await (await call("GET", "/doctor?stage=review")).json());
    expect(doctor.cardCheckpointPolicy?.version).toBe("superpipeline.checkpoint-policy.v2");
    expect(doctor.checkpointPolicy).toBeUndefined();
    expect(doctor.manual.join("\n")).toContain("(see cardCheckpointPolicy)");
    expect(must(installedFor("review"), "card profile")).toMatchObject({ repositorySelection: "card", defaultRepositories: ["app"] });
    expect(checkpointRuntime(tenantId, BOARD2, stationId, "review")?.port.choosesRepositories).toBe(true);
    // The node's registry keeps the allow-list as it was: the choice is per prepare.
    expect(node.profiles.get("review")?.repositories.map((r) => r.name)).toEqual(["app"]);

    const off = Reply.parse(await (await call("PATCH", "/stages/review", { cardsChoose: false })).json());
    expect(off.checkpointPolicy?.version).toBe("superpipeline.checkpoint-policy.v1");
    expect(off.cardCheckpointPolicy).toBeUndefined();
    expect(off.nextSteps.join("\n")).toContain("set the stage's checkpointPolicy to the checkpointPolicy above");
    expect(off.stage.cardsChoose).toBe(false);
    const fixed = must(installedFor("review"), "fixed profile");
    expect(fixed.repositorySelection).toBeUndefined();
    expect(fixed.defaultRepositories).toBeUndefined();
    expect(checkpointRuntime(tenantId, BOARD2, stationId, "review")?.port.choosesRepositories).toBeUndefined();
    // A default without per-card choice is refused before the node is asked.
    node.requests = [];
    expect((await call("PATCH", "/stages/review", { defaultRepositories: ["app"] })).status).toBe(400);
    expect(node.requests).toEqual([]);
  });

  test("a stage taken over from the file becomes the table's", async () => {
    const res = await call("PATCH", "/stages/legacy", { refresh: true });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(benchStages).where(and(eq(benchStages.tenantId, tenantId), eq(benchStages.name, "legacy")));
    expect(row?.origin).toBe("fleet");
  });

  test("a node refusal changes nothing on the hub", async () => {
    const before = JSON.stringify(installedCheckpointProfiles());
    node.refuse = "invalid: the new registry would not validate (invalid); nothing was written";
    const res = await call("PATCH", "/stages/review", { checkpointRepository: "app" });
    expect(res.status).toBe(502);
    expect(z.object({ error: z.string() }).parse(await res.json()).error).toContain("nothing was written");
    expect(JSON.stringify(installedCheckpointProfiles())).toBe(before);
    const dup = await call("POST", "/stages", addBody({ name: "review" }));
    expect(dup.status).toBe(409);
  });

  test("the request grammar refuses a half stage before anything is asked", async () => {
    for (const body of [addBody({ worker: undefined }), addBody({ checkpointRepository: "docs" }),
      addBody({ repositories: [{ name: "app", provider: "forge", repository: "example/app" }] }), { ...addBody(), token: "spa_x" }]) {
      const res = await call("POST", "/stages", body);
      expect(res.status).toBe(400);
    }
    expect(node.requests).toHaveLength(0);
  });
});

const Doctor = z.object({ ok: z.boolean(), checks: z.array(BenchDoctorCheck) });

describe("fleet bench doctor", () => {
  test("passes every check for a served stage and prints what stays manual", async () => {
    await db.update(bridgeAgents).set({ mcpTokenEncrypted: "fixture-ciphertext" })
      .where(and(eq(bridgeAgents.tenantId, tenantId), eq(bridgeAgents.key, "review")));
    const report = Doctor.extend({ manual: z.array(z.string()),
      checkpointPolicy: z.object({ nodeId: z.string(), reporterPrincipalId: z.string() }).loose() })
      .parse(await (await call("GET", "/doctor?stage=review")).json());
    expect(report.checks.filter((c) => c.ok !== true)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.manual.join("\n")).toContain("SuperPipeline");
    expect(report.checkpointPolicy).toMatchObject({ nodeId, reporterPrincipalId: reporter });
  });

  test("fails the service grant and the stage's node target, each with a next step", async () => {
    serviceScope = "checkpoints:read";
    node.coordinator = "0".repeat(64);
    try {
      const report = Doctor.parse(await (await call("GET", "/doctor?stage=review")).json());
      expect(report.ok).toBe(false);
      const failed = Object.fromEntries(report.checks.filter((c) => c.ok === false).map((c) => [c.check, c]));
      expect(failed["service grant: checkpoint scopes"]?.detail).toBe("missing scope checkpoints:submit");
      expect(failed["service grant: checkpoint scopes"]?.next).toContain("Accounts");
      expect(failed["stage: node serves it"]?.detail).toContain("coordinator_implementation_sha256");
      // Moved installed bytes are fixed by a repin, not a refresh.
      expect(failed["stage: node serves it"]?.next).toBe("If the worker or node update was intended: fleet bench stage set review --repin");
    } finally {
      serviceScope = "checkpoints:submit checkpoints:read";
      node.coordinator = "f".repeat(64);
    }
  });

  test("before a repin the node serves nothing, and the next step is the repin", async () => {
    node.problem = "coordinator_pin";
    try {
      const report = Doctor.parse(await (await call("GET", "/doctor?stage=review")).json());
      const line = must(report.checks.find((c) => c.check === "stage: node serves it"), "served line");
      expect(line).toMatchObject({ ok: false, detail: "the node's registry is not served (coordinator_pin)",
        next: "If the worker or node update was intended: fleet bench stage set review --repin" });
    } finally { node.problem = ""; }
  });

  test("a stage adopted from the file has no SuperPipeline stage id: a warning that names the flag", async () => {
    const report = Doctor.parse(await (await call("GET", "/doctor?stage=legacy")).json());
    const line = must(report.checks.find((c) => c.check === "stage: SuperPipeline stage"), "stage id line");
    expect(line).toMatchObject({ ok: null, warn: true, next: "fleet bench stage set legacy --stage-id STAGE_ID" });
    const review = Doctor.parse(await (await call("GET", "/doctor?stage=review")).json());
    expect(review.checks.find((c) => c.check === "stage: SuperPipeline stage")).toMatchObject({ ok: true, detail: "stg_review" });
  });

  test("a station with no stage yet is checked too", async () => {
    const res = await call("GET", `/doctor?station=${stationId}`);
    expect(res.status).toBe(200);
    const report = Doctor.parse(await res.json());
    expect(report.checks.map((c) => c.check)).toContain("benchd: storage");
    expect((await call("GET", "/doctor")).status).toBe(400);
    expect((await call("GET", "/doctor?stage=missing")).status).toBe(404);
  });
});

describe("removing a stage", () => {
  test("rm removes the node's profile and the hub's, keeps the roster row, and re-pins the rest", async () => {
    const res = await call("DELETE", "/stages/review");
    expect(res.status).toBe(200);
    expect(node.profiles.has("review")).toBe(false);
    expect(installedFor("review")).toBeUndefined();
    expect(installedFor("legacy")?.target.registry_sha256).toBe(node.digest());
    const [roster] = await db.select().from(bridgeAgents).where(and(eq(bridgeAgents.tenantId, tenantId), eq(bridgeAgents.key, "review")));
    expect(roster).toBeDefined();
    expect((await call("DELETE", "/stages/review")).status).toBe(404);
  });
});
