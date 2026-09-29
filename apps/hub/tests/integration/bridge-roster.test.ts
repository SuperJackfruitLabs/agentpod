/**
 * The bridge roster, as a table rather than an environment variable.
 *
 * What earns a test here is everything the env var could not check:
 *
 *   - a station that does not exist, or belongs to another tenant, cannot be named
 *   - the credentials go in encrypted and never come back out of the read surface
 *   - `hubUserId` is DERIVED from the station, so it cannot disagree with it
 *   - an edit moves `updatedAt`, which is what makes a running loop restart
 *
 * DATABASE_URL must point at the local Docker test-postgres on localhost:5434.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "bridge-roster-test-key-0123456789";

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";

import { db } from "../../src/db/drizzle";
import { bridgeAgents } from "../../src/db/schema/bridge";
import { stations } from "../../src/db/schema/stations";
import { nodes } from "../../src/db/schema/nodes";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import {
  createBridgeAgent,
  deleteBridgeAgent,
  listBridgeAgents,
  readBridgeRoster,
  updateBridgeAgent,
} from "../../src/services/bridge/roster";

const NODE_ID = "node_bridge_roster_test";
const STATION_ID = "station_bridge_roster_test";
const BOARD_ID = "brd_6a899b0f0d054046";
const TOKEN = `spa_${"a1b2c3d4".repeat(6)}`;
const MCP_TOKEN = `spa_${"f0e1d2c3".repeat(6)}`;

let userId: string;

beforeAll(async () => {
  await ensurePgMigrations();
  userId = (await createTestUser({ name: "bridge-roster" })).id;

  await db
    .insert(nodes)
    .values({
      id: NODE_ID,
      tenantId: BOOTSTRAP_TENANT_ID,
      userId,
      name: "bridge-roster-node",
      hostname: "bridge-roster.test",
      os: "linux",
      arch: "arm64",
      status: "offline",
      secretHash: "x",
    })
    .onConflictDoNothing();

  await db
    .insert(stations)
    .values({
      id: STATION_ID,
      tenantId: BOOTSTRAP_TENANT_ID,
      userId,
      nodeId: NODE_ID,
      harness: "hermes",
      stationKey: "bridge-roster-station",
      kind: "service",
      displayName: "Roster Station",
    })
    .onConflictDoNothing();
});

beforeEach(async () => {
  await db.delete(bridgeAgents).where(eq(bridgeAgents.tenantId, BOOTSTRAP_TENANT_ID));
});

afterAll(async () => {
  await db.delete(bridgeAgents).where(eq(bridgeAgents.tenantId, BOOTSTRAP_TENANT_ID));
  await db.delete(stations).where(eq(stations.id, STATION_ID));
  await db.delete(nodes).where(eq(nodes.id, NODE_ID));
});

const base = () => ({
  tenantId: BOOTSTRAP_TENANT_ID,
  key: "coder-kai",
  boardId: BOARD_ID,
  stationId: STATION_ID,
  token: TOKEN,
  createdBy: userId,
});

describe("what the env var could never check", () => {
  test("a station that does not exist cannot be rostered", async () => {
    await expect(createBridgeAgent({ ...base(), stationId: "station_nope" })).rejects.toThrow();
  });

  test("a board id of the wrong grammar is refused by the database, not by a parser", async () => {
    // The env var was parsed by zod at boot; a typo there produced a hub that claimed nothing.
    await expect(createBridgeAgent({ ...base(), boardId: "brd_NOTHEX" })).rejects.toThrow();
  });

  test("a permission wait of zero is refused — it is not a policy, it is a bug", async () => {
    await expect(createBridgeAgent({ ...base(), permissionWaitMs: 0 })).rejects.toThrow();
  });

  test("two agents cannot share a key within a tenant", async () => {
    await createBridgeAgent(base());
    await expect(createBridgeAgent(base())).rejects.toThrow();
  });
});

describe("the credentials", () => {
  test("go in encrypted — the plaintext is not in the row", async () => {
    await createBridgeAgent({ ...base(), mcpToken: MCP_TOKEN });

    const [row] = await db
      .select()
      .from(bridgeAgents)
      .where(and(eq(bridgeAgents.tenantId, BOOTSTRAP_TENANT_ID), eq(bridgeAgents.key, "coder-kai")));

    expect(row!.tokenEncrypted).not.toContain(TOKEN);
    expect(row!.mcpTokenEncrypted).not.toContain(MCP_TOKEN);
    expect(row!.tokenEncrypted.length).toBeGreaterThan(0);
  });

  test("never come back out of the read surface — only whether they are set", async () => {
    await createBridgeAgent({ ...base(), mcpToken: MCP_TOKEN });

    const listed = await listBridgeAgents(BOOTSTRAP_TENANT_ID);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ key: "coder-kai", hasToken: true, hasMcpToken: true });
    expect(JSON.stringify(listed)).not.toContain(TOKEN);
    expect(JSON.stringify(listed)).not.toContain(MCP_TOKEN);
  });

  test("an agent with no mcpToken reports so, rather than reporting an empty one", async () => {
    await createBridgeAgent(base());
    const [listed] = await listBridgeAgents(BOOTSTRAP_TENANT_ID);
    expect(listed!.hasMcpToken).toBe(false);
  });

  test("come back decrypted for the bridge itself, which is the one caller that needs them", async () => {
    await createBridgeAgent({ ...base(), mcpToken: MCP_TOKEN });

    const roster = await readBridgeRoster(BOOTSTRAP_TENANT_ID);
    expect(roster).toHaveLength(1);
    expect(roster[0]!.token).toBe(TOKEN);
    expect(roster[0]!.mcpToken).toBe(MCP_TOKEN);
  });
});

describe("hubUserId is derived, so it cannot disagree with the station", () => {
  test("the roster reads the session owner off the station", async () => {
    await createBridgeAgent(base());
    const [agent] = await readBridgeRoster(BOOTSTRAP_TENANT_ID);
    // `getStation(userId, stationId)` filters on `stations.userId`; any other value here would
    // fail every ACP call as "Station not found", which is why it is not a stored field.
    expect(agent!.hubUserId).toBe(userId);
  });

  test("there is no way to set it — the create surface does not take one", async () => {
    await createBridgeAgent({ ...base(), hubUserId: "usr_someone_else" } as never);
    const [agent] = await readBridgeRoster(BOOTSTRAP_TENANT_ID);
    expect(agent!.hubUserId).toBe(userId);
  });
});

describe("what the reconciler reads", () => {
  test("a disabled agent is absent from the roster but present in the list", async () => {
    await createBridgeAgent(base());
    await updateBridgeAgent(BOOTSTRAP_TENANT_ID, "coder-kai", { enabled: false });

    expect(await readBridgeRoster(BOOTSTRAP_TENANT_ID)).toHaveLength(0);
    // Still visible to a human: disabling is not deleting, and the credential is still there.
    const listed = await listBridgeAgents(BOOTSTRAP_TENANT_ID);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ enabled: false, hasToken: true });
  });

  test("an edit changes the revision — which is the whole signal a loop restarts on", async () => {
    await createBridgeAgent(base());
    const before = (await readBridgeRoster(BOOTSTRAP_TENANT_ID))[0]!.revision;

    await updateBridgeAgent(BOOTSTRAP_TENANT_ID, "coder-kai", { mode: "ask" });

    const after = (await readBridgeRoster(BOOTSTRAP_TENANT_ID))[0]!;
    expect(after.mode).toBe("ask");
    expect(after.revision).not.toBe(before);
  });

  test("rotating a token changes it too, so the running loop picks the new one up", async () => {
    await createBridgeAgent(base());
    const before = (await readBridgeRoster(BOOTSTRAP_TENANT_ID))[0]!.revision;

    const rotated = `spa_${"9876543a".repeat(6)}`;
    await updateBridgeAgent(BOOTSTRAP_TENANT_ID, "coder-kai", { token: rotated });

    const after = (await readBridgeRoster(BOOTSTRAP_TENANT_ID))[0]!;
    expect(after.token).toBe(rotated);
    expect(after.revision).not.toBe(before);
  });

  test("reading twice without an edit gives the same revision — it is not a nonce", async () => {
    // A digest that changed on every read would restart every loop on every tick.
    await createBridgeAgent(base());
    const a = (await readBridgeRoster(BOOTSTRAP_TENANT_ID))[0]!.revision;
    const b = (await readBridgeRoster(BOOTSTRAP_TENANT_ID))[0]!.revision;
    expect(a).toBe(b);
  });

  test("deleting one removes it", async () => {
    await createBridgeAgent(base());
    await deleteBridgeAgent(BOOTSTRAP_TENANT_ID, "coder-kai");
    expect(await listBridgeAgents(BOOTSTRAP_TENANT_ID)).toHaveLength(0);
  });
});

describe("the roster is tenant-scoped, which the env var had no way to be", () => {
  test("a read for another tenant sees nothing", async () => {
    await createBridgeAgent(base());
    expect(await readBridgeRoster("fleet_ffffffffffffffffffff")).toHaveLength(0);
    expect(await listBridgeAgents("fleet_ffffffffffffffffffff")).toHaveLength(0);
  });
});
