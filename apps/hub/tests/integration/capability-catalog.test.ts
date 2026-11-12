/**
 * The capability catalog's reads against Postgres: what each hub table contributes to a station's
 * facts, the newest row winning, dead rows left out, and the tenant boundary.
 *
 * DATABASE_URL must point at a test Postgres (CI: localhost:5434).
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "capability-catalog-test-key-0123456789";

import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { db, rawSql } from "../../src/db/drizzle";
import { acpRuns, acpSessions } from "../../src/db/schema/acp";
import { bridgeAgents } from "../../src/db/schema/bridge";
import type { ForgeApiProvider } from "@agentpod/contract";
import { stationForgeApiGrants, type ForgeGrantState } from "../../src/db/schema/forge-api-grants";
import { nodes, provisionedRuntimes } from "../../src/db/schema/nodes";
import { skillArtifacts, skillOperations, trustedSkillReleaseArtifacts, trustedSkillReleases } from "../../src/db/schema/skills";
import { stations } from "../../src/db/schema/stations";
import { BOOTSTRAP_TENANT_ID as TENANT, tenants } from "../../src/db/schema/tenants";
import { catalogFrom, stationCapabilities, stationFactsFor } from "../../src/services/catalog";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";

const HOST_NODE = "node_catalog_host";
const BOX_NODE = "node_catalog_box";
const OTHER_NODE = "node_catalog_other";
const OTHER_TENANT = "fleet_0000000000000000ca71";
const S_HOST = "station_catalog_host";
const S_BOX = "station_catalog_box";
const S_OTHER = "station_catalog_other";
const AGENT = "prn_0000000000000000ca01";
const RT_OLD = "rt_catalog_old";
const RT_NEW = "rt_catalog_new";
const RT_GONE = "rt_catalog_gone";
const SESSION = "acps_catalog_session";
const SHA_RELEASED = "a".repeat(64);
const SHA_UPLOADED = "b".repeat(64);
const ART_RELEASED = "0b5c6d4e-1f2a-4b3c-9d8e-7f6a5b4c3d21";
const ART_UPLOADED = "0b5c6d4e-1f2a-4b3c-9d8e-7f6a5b4c3d22";
const RELEASE = "0b5c6d4e-1f2a-4b3c-9d8e-7f6a5b4c3d23";
const [OP_ENG, OP_OPS, OP_BACK, OP_FAIL] = ["c".repeat(32), "d".repeat(32), "e".repeat(32), "f".repeat(31) + "0"];
const OPS = [OP_ENG, OP_OPS, OP_BACK, OP_FAIL];
const [G_GITHUB, G_FORGEJO, G_GITEA] = ["fga_catalog_1", "fga_catalog_2", "fga_catalog_3"];
const GRANTS = [G_GITHUB, G_FORGEJO, G_GITEA];
const ago = (min: number) => new Date(Date.now() - min * 60_000);

let userId: string;

async function cleanup() {
  await db.delete(stationForgeApiGrants).where(inArray(stationForgeApiGrants.id, GRANTS));
  await db.delete(bridgeAgents).where(inArray(bridgeAgents.stationId, [S_HOST, S_BOX]));
  await db.delete(skillOperations).where(inArray(skillOperations.id, OPS));
  await db.delete(trustedSkillReleases).where(eq(trustedSkillReleases.id, RELEASE));
  await db.delete(skillArtifacts).where(inArray(skillArtifacts.id, [ART_RELEASED, ART_UPLOADED]));
  await db.delete(acpSessions).where(eq(acpSessions.id, SESSION));
  await db.delete(provisionedRuntimes).where(inArray(provisionedRuntimes.id, [RT_OLD, RT_NEW, RT_GONE]));
  await db.delete(stations).where(inArray(stations.id, [S_HOST, S_BOX, S_OTHER]));
  await db.delete(nodes).where(inArray(nodes.id, [HOST_NODE, BOX_NODE, OTHER_NODE]));
}

const node = (id: string, tenantId = TENANT) => ({
  id, tenantId, userId, name: id, hostname: `${id}.test`, os: "linux", arch: "arm64", status: "offline" as const, secretHash: "x",
});
const station = (id: string, nodeId: string, harness: string, tenantId = TENANT, extra: Record<string, unknown> = {}) => ({
  id, tenantId, userId, nodeId, harness, stationKey: `${id}-key`, kind: "service", displayName: id, ...extra,
});
const runtime = (id: string, status: "online" | "destroyed", runtimeName: string | null, createdAt: Date) => ({
  id, tenantId: TENANT, userId, provider: "docker", status, nodeId: BOX_NODE, name: id, runtime: runtimeName, createdAt,
});
const fingerprint = (model: string, reportedBy: "harness" | "hub") => ({
  harness: "salaam", harness_version: "0.0.7", model, profile: "default", skill_release: "", reported_by: reportedBy,
});
/** A managed skill operation, written as SQL: its plan holds only the generation the reads look at. */
const op = (id: string, profile: string, sha: string | null, artifactId: string | null, updatedAt: Date, state = "applied") => {
  const plan = JSON.stringify({ after: sha === null ? null : { generation: id, archiveSHA256: sha, bundleDigest: sha } });
  return rawSql`
    INSERT INTO skill_operations (id, tenant_id, user_id, station_id, node_id, station_key, harness, profile, kind, action, artifact_id, state, plan, created_at, updated_at)
    VALUES (${id}, ${TENANT}, ${userId}, ${S_BOX}, ${BOX_NODE}, ${`${S_BOX}-key`}, 'codex', ${profile}, 'managed', ${artifactId ? "install" : "rollback"}, ${artifactId}, ${state}, ${plan}::jsonb, ${updatedAt.toISOString()}, ${updatedAt.toISOString()})`;
};
const grant = (id: string, provider: ForgeApiProvider, state: ForgeGrantState) => ({
  id, tenantId: TENANT, stationId: S_BOX, stationIdSnapshot: S_BOX, provider, instance: `https://${provider}.example.test`,
  mode: "minted" as const, account: "agent-x", repositories: ["org/repo"], preset: "read" as const, state, generation: 1, createdBy: userId,
  ...(state === "revoked" ? { revokedAt: new Date() } : {}),
});

beforeAll(async () => {
  await ensurePgMigrations();
  userId = (await createTestUser({ name: "capability-catalog" })).id;
  await cleanup();
  await db.insert(tenants).values({ id: OTHER_TENANT, name: "catalog other tenant" }).onConflictDoNothing();
  await db.insert(nodes).values([node(HOST_NODE), node(BOX_NODE), node(OTHER_NODE, OTHER_TENANT)]);
  await db.insert(stations).values([
    station(S_HOST, HOST_NODE, "hermes", TENANT, { principalId: AGENT }),
    station(S_BOX, BOX_NODE, "salaam", TENANT, { mcpProxy: true }),
    station(S_OTHER, OTHER_NODE, "codex", OTHER_TENANT),
  ]);
  // The box's node: an older docker runtime, a newer gVisor one, and a newest one destroyed.
  await db.insert(provisionedRuntimes).values([
    runtime(RT_OLD, "online", "", ago(30)),
    runtime(RT_NEW, "online", "runsc", ago(20)),
    runtime(RT_GONE, "destroyed", "", ago(10)),
  ]);
  await db.insert(acpSessions).values({
    id: SESSION, tenantId: TENANT, stationId: S_BOX, userId, mode: "full-auto", status: "idle", lastSeq: 0, createdAt: ago(60), lastEventAt: ago(1),
  });
  // An older run reported by the harness, a newer one reported by the hub, and a newest with no model.
  await db.insert(acpRuns).values([
    { id: "attempt_00000000-0000-4000-8000-0000000ca701", tenantId: TENANT, sessionId: SESSION, stationId: S_BOX, state: "completed", startSeq: 0, startedAt: ago(50), fingerprint: fingerprint("old-model", "harness"), fingerprintDigest: `sha256:${"9".repeat(64)}` },
    { id: "attempt_00000000-0000-4000-8000-0000000ca702", tenantId: TENANT, sessionId: SESSION, stationId: S_BOX, state: "completed", startSeq: 1, startedAt: ago(40), fingerprint: fingerprint("kimi-k2", "hub"), fingerprintDigest: `sha256:${"9".repeat(64)}` },
    { id: "attempt_00000000-0000-4000-8000-0000000ca703", tenantId: TENANT, sessionId: SESSION, stationId: S_BOX, state: "completed", startSeq: 2, startedAt: ago(30), fingerprint: fingerprint("", "hub"), fingerprintDigest: `sha256:${"9".repeat(64)}` },
  ]);
  await db.insert(skillArtifacts).values([
    { id: ART_RELEASED, tenantId: TENANT, userId, archiveSHA256: SHA_RELEASED, harness: "codex", profile: "engineering", size: 1, bytes: Buffer.from("x") },
    { id: ART_UPLOADED, tenantId: TENANT, userId, archiveSHA256: SHA_UPLOADED, harness: "codex", profile: "ops", size: 1, bytes: Buffer.from("y") },
  ]);
  await db.insert(trustedSkillReleases).values({ id: RELEASE, tenantId: TENANT, userId, version: "0.3.0", profile: "engineering", recordDigest: "1".repeat(64), record: {} });
  await db.insert(trustedSkillReleaseArtifacts).values({ releaseId: RELEASE, tenantId: TENANT, userId, artifactId: ART_RELEASED, harness: "codex", bundleDigest: "2".repeat(64) });
  await op(OP_ENG, "engineering", SHA_RELEASED, ART_RELEASED, ago(20));
  await op(OP_OPS, "ops", SHA_UPLOADED, ART_UPLOADED, ago(20));
  // "ops" was rolled back to nothing afterwards: no generation is in place.
  await op(OP_BACK, "ops", null, null, ago(10));
  // A failed attempt is not an applied one.
  await op(OP_FAIL, "design", SHA_UPLOADED, ART_UPLOADED, ago(5), "conflict");
  await db.insert(bridgeAgents).values([
    { tenantId: TENANT, key: "catalog-box", boardId: "brd_00000000000ca7b1", stationId: S_BOX, tokenEncrypted: "x", mcpTokenEncrypted: "y" },
    { tenantId: TENANT, key: "catalog-host-off", boardId: "brd_00000000000ca7b1", stationId: S_HOST, tokenEncrypted: "x", mcpTokenEncrypted: "y", enabled: false },
  ]);
  await db.insert(stationForgeApiGrants).values([
    grant(G_GITHUB, "github", "verified"),
    grant(G_FORGEJO, "forgejo", "revoked"),
    grant(G_GITEA, "gitea", "delivered"),
  ]);
});

afterAll(cleanup);

test("a station's facts come from each of the hub's tables, newest first, dead rows left out", async () => {
  const facts = await stationFactsFor(TENANT, [S_HOST, S_BOX]);
  expect(facts).toEqual([
    {
      stationId: S_BOX,
      principalId: null,
      harness: "salaam",
      runtime: { provider: "docker", runtime: "runsc" },
      fingerprint: { model: "kimi-k2", harnessVersion: "0.0.7", reportedBy: "hub" },
      skills: [{ profile: "engineering", releaseVersion: "0.3.0" }],
      mcpProxy: true,
      boardTools: true,
      forgeGrants: [
        { provider: "gitea", instance: "https://gitea.example.test", state: "delivered" },
        { provider: "github", instance: "https://github.example.test", state: "verified" },
      ],
    },
    {
      stationId: S_HOST,
      principalId: AGENT,
      harness: "hermes",
      runtime: null,
      fingerprint: null,
      skills: [],
      mcpProxy: null,
      boardTools: false,
      forgeGrants: [],
    },
  ]);
});

test("the registry row and the catalog read from those facts", async () => {
  const facts = await stationFactsFor(TENANT, [S_HOST, S_BOX]);
  const [boxFacts] = facts;
  if (!boxFacts) throw new Error("the box station was not read");
  const box = stationCapabilities(boxFacts);
  expect(box.isolation).toEqual({ level: "sandbox", runtime: "runsc", proof: "installed" });
  expect(box.model).toEqual({ id: "kimi-k2", proof: "declared" });
  expect(box.credentials.map((c) => c.name)).toEqual(["forge:gitea", "forge:github"]);
  const ids = catalogFrom(facts).map((e) => e.id);
  expect(ids).toEqual([
    "cli:stk",
    "harness:hermes",
    "harness:salaam",
    "mcp:agentpod-proxy",
    "mcp:superpipeline",
    "service:forge-api",
    "skill:engineering",
  ]);
});

test("another workspace's stations are never read", async () => {
  const ids = (await stationFactsFor(TENANT)).map((f) => f.stationId);
  expect(ids).toContain(S_BOX);
  expect(ids).not.toContain(S_OTHER);
  expect(await stationFactsFor(TENANT, [S_OTHER])).toEqual([]);
  expect((await stationFactsFor(OTHER_TENANT, [S_BOX, S_OTHER])).map((f) => f.stationId)).toEqual([S_OTHER]);
});
