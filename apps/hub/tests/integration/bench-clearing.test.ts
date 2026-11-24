/**
 * The clearing sweep on the real ledger: which cards it judges, and that a cleared card is never
 * judged again until it comes back with a new attempt.
 */
process.env.DATABASE_URL ||= "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/drizzle";
import { tenants } from "../../src/db/schema/tenants";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { bridgeAgents } from "../../src/db/schema/bridge";
import { benchClearances } from "../../src/db/schema/bench-clearances";
import { connectionManager } from "../../src/services/broker";
import { checkpointProfileId, parseCheckpointProfile } from "../../src/services/bridge/checkpoint-profile";
import { reserveCheckpointAttempt, retireCheckpointAttempt, type RetainedCheckpointAttempt } from "../../src/services/bridge/checkpoint-ledger";
import { checkpointPolicyDigest, parsePendingCheckpointClaim } from "../../src/services/bridge/checkpoint-claim";
import { clearingDeps, sweepBenchClearing, type CardRead, type ClearingDeps } from "../../src/services/bridge/bench-clearing";
import type { ReclaimTarget } from "../../src/services/bridge/checkpoint-reclaim";
import { fakePlane } from "../helpers/fake-plane";
import { createTestUser, deleteTestUsers } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import claimFixture from "../../src/services/bridge/checkpoint-contract/claim.fixture.json";

const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
const organizationId = "org_" + suffix;
const tenantId = "fleet_" + suffix, nodeId = "node_" + suffix, stationId = "station_" + suffix;
const owner = "prn_" + suffix, occupant = "prn_" + suffix.slice(1) + "f";
const agentKey = "bench-clearing-" + suffix;
const envKeys = ["PROPOSED_CHECKPOINT_COORDINATOR", "ENFORCE_CONTROL_PAIR"] as const;
const priorEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

const profile = parseCheckpointProfile({ version: "agentpod.checkpoint-profile.v1", organizationId,
  sourceTenantId: claimFixture.pending.tenantId, sourceOrigin: "https://pipeline.test", sourceAudience: "https://app.superpipeline.dev",
  reporterPrincipalId: "prn_" + "c".repeat(20), ownerPrincipalId: owner, occupantPrincipalId: occupant,
  agentKey, profileKey: "", coordinatorProfileId: "fixture-profile", occupancyEpoch: 1,
  target: { tenant_id: tenantId, board_id: claimFixture.pending.boardId, agent_id: claimFixture.pending.agentId,
    station_id: stationId, node_id: nodeId, host_id: "host_fixture", registry_sha256: "a".repeat(64),
    coordinator_implementation_sha256: "b".repeat(64), execution_mode: "linux-cgroup-v2", bench_protocol: "superbench.v2",
    worker_version: "agentpod.superbench-worker.v2", worker_sha256: "c".repeat(64) },
  repositories: [{ ...claimFixture.pending.policy.repositories[0], repositorySHA256: "d".repeat(64), objectFormat: "sha1" }],
  checkpointRepository: "app" });
const policy = { ...claimFixture.pending.policy, reporterPrincipalId: profile.reporterPrincipalId, nodeId,
  executors: [{ agentId: profile.target.agent_id, stationId }] };
const claimFor = (run: string) => parsePendingCheckpointClaim({ ...claimFixture.pending, runId: "run_" + suffix + run,
  policy, policyDigest: checkpointPolicyDigest(policy) });
const task = { profile_id: checkpointProfileId(profile), prompt: "fixture", timeout_seconds: 60 };
let userId = "";


const claimOn = (card: string, run: string) => parsePendingCheckpointClaim({ ...claimFor(run), cardId: card });

/** An attempt on `card` that the board ended: final (`retired`), so it no longer owns the bench. */
async function ended(card: string, run: string): Promise<RetainedCheckpointAttempt> {
  const { attempt } = await reserveCheckpointAttempt(profile, claimOn(card, run), task);
  expect(await retireCheckpointAttempt(attempt, { reason: "operator", by: "hub", evidence: "fixture" })).toBe(true);
  return attempt;
}

/** The real ledger and clearances, with the board and the node faked. */
function sweep(state: (card: string) => CardRead) {
  const reclaimed: ReclaimTarget[] = [];
  const real = clearingDeps();
  const deps: ClearingDeps = { ...real, keepBench: async () => false,
    cards: async () => (await real.cards()).filter((c) => c.attempts[0]?.tenantId === tenantId),
    readCard: async (a) => state(a.cardId),
    reclaim: async (target) => { reclaimed.push(target); return "reclaimed"; } };
  return { run: () => sweepBenchClearing(deps), reclaimed };
}

beforeAll(async () => {
  await ensurePgMigrations();
  userId = (await createTestUser({ name: "bench-clearing" })).id;
  process.env.ENFORCE_CONTROL_PAIR = "true";
  process.env.PROPOSED_CHECKPOINT_COORDINATOR = "true";
  fakePlane.addAgent({ id: occupant }); fakePlane.addHuman({ id: owner, grant: { mayDispatch: [occupant] } });
  for (const id of [occupant, owner]) {
    const principal = fakePlane.principals.get(id);
    if (!principal) throw new Error("fixture principal missing");
    principal.organizationId = organizationId;
  }
  await db.insert(tenants).values({ id: tenantId, name: "bench clearing fixture", externalSource: "org-plane", externalId: organizationId });
  await db.insert(nodes).values({ id: nodeId, tenantId, userId: owner, name: "fixture", hostname: "fixture", os: "linux", arch: "amd64",
    secretHash: await Bun.password.hash("fixture-node-secret-" + suffix), status: "online", lastSeenAt: new Date() });
  await db.insert(stations).values({ id: stationId, tenantId, userId: owner, principalId: occupant, occupancyEpoch: 1,
    nodeId, stationKey: "fixture:" + suffix, kind: "leaf", displayName: "fixture", harness: "hermes", workspacePath: "/fixture" });
  await db.insert(bridgeAgents).values({ tenantId, key: agentKey, boardId: profile.target.board_id, stationId, profileKey: "",
    tokenEncrypted: "", credentialSource: { version: 1, kind: "station-plane", principalId: occupant, organizationId,
      audience: "https://app.superpipeline.dev" } });
  connectionManager.register(nodeId, () => {});
});
afterAll(async () => {
  connectionManager.unregister(nodeId);
  // Attempt rows are immutable and retained, as in production; the test database is disposable.
  await db.delete(bridgeAgents).where(eq(bridgeAgents.tenantId, tenantId));
  await db.delete(stations).where(eq(stations.tenantId, tenantId));
  await db.delete(nodes).where(eq(nodes.tenantId, tenantId));
  fakePlane.remove(owner); fakePlane.remove(occupant);
  await deleteTestUsers([userId]);
  for (const k of envKeys) { const v = priorEnv[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test("a done card's bench is cleared once for all its attempts; a card still in progress or still active is left warm", async () => {
  const done = "card_done" + suffix, active = "card_active" + suffix, working = "card_working" + suffix;
  await ended(done, "d1"); await ended(done, "d2");
  await ended(active, "a1");
  await ended(working, "w1");
  await reserveCheckpointAttempt(profile, claimOn(working, "w2"), task); // in progress: owns the bench

  const states: Record<string, CardRead> = { [done]: { kind: "card", state: "completed", archived: false },
    [active]: { kind: "card", state: "input-required", archived: false, updatedAtMs: Date.now() },
    [working]: { kind: "card", state: "completed", archived: false } };
  const first = sweep((card) => states[card] ?? { kind: "unknown" });
  const results = await first.run();
  expect(first.reclaimed).toEqual([{ nodeId, tenantId, boardId: profile.target.board_id, stationId, cardId: done }]);
  expect(Object.fromEntries(results.map((r) => [r.cardId, r.outcome]))).toEqual({ [done]: "cleared", [active]: "warm", [working]: "unsettled" });
  const rows = await db.select().from(benchClearances).where(eq(benchClearances.tenantId, tenantId));
  expect(rows.map((r) => [r.cardId, r.reason, r.outcome])).toEqual([[done, "completed", "reclaimed"], [done, "completed", "reclaimed"]]);

  // Judged once: the next sweep does not ask for the done card again.
  const second = sweep((card) => states[card] ?? { kind: "unknown" });
  await second.run();
  expect(second.reclaimed).toEqual([]);

  // A card that comes back after its bench was cleared has a new attempt, and is judged afresh.
  await ended(done, "d3");
  const third = sweep((card) => states[card] ?? { kind: "unknown" });
  await third.run();
  expect(third.reclaimed.map((t) => t.cardId)).toEqual([done]);
});
