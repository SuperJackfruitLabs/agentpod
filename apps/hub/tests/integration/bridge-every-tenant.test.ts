/**
 * The superpipeline bridge runs every workspace's roster, each under its own tenant (workspace
 * authority spec, step 4).
 *
 * Until now the loop, the gate sweep and the elicitation sweep read only `BOOTSTRAP_TENANT_ID`'s
 * roster: a second workspace could roster a bridge agent in the console and nothing would ever
 * claim for it. Roster keys are unique per tenant only, so two workspaces may both call an agent
 * `coder`; the supervisor must run both, not let one shadow the other.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "bridge-every-tenant-key-0123456789";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { db, rawSql } from "../../src/db/drizzle";
import { bridgeAgents } from "../../src/db/schema/bridge";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { tenantForOrg } from "../../src/auth/org-plane/tenant";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser, deleteTestUsers } from "../helpers/database";
import { createBridgeAgent, readEveryBridgeRoster } from "../../src/services/bridge/roster";
import { startSuperpipelineBridge } from "../../src/services/bridge/loop";
import type { AcpPort } from "../../src/services/bridge/dispatch";
import { bridgeGateSweepDeps } from "../../src/services/matrix-as/gate-sweep";
import { bridgeElicitationSweepDeps } from "../../src/services/matrix-as/elicitation-sweep";

const RUN = crypto.randomUUID().slice(0, 8);
const KEY = `coder-${RUN}`;
let USER_A: string;
let USER_B: string;
let TENANT_B: string;
const NODE_A = `node_bet_a_${RUN}`;
const NODE_B = `node_bet_b_${RUN}`;
const STATION_A = `station_bet_a_${RUN}`;
const STATION_B = `station_bet_b_${RUN}`;
const BOARD_A = `brd_${"a".repeat(8)}${RUN}`;
const BOARD_B = `brd_${"b".repeat(8)}${RUN}`;
const TOKEN = `spa_${"a1b2c3d4".repeat(6)}`;

beforeAll(async () => {
  await ensurePgMigrations();
  USER_A = (await createTestUser({ email: `bet-a-${RUN}@example.com` })).id;
  USER_B = (await createTestUser({ email: `bet-b-${RUN}@example.com` })).id;
  const b = await tenantForOrg({ org: "org_55555555555555555555", ent: ["agentpod"] });
  if (!b.ok) throw new Error("tenant resolution refused");
  TENANT_B = b.tenantId;
  for (const [node, station, tenant, user] of [
    [NODE_A, STATION_A, BOOTSTRAP_TENANT_ID, USER_A],
    [NODE_B, STATION_B, TENANT_B, USER_B],
  ] as const) {
    await rawSql`
      INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
      VALUES (${node}, ${tenant}, ${user}, ${node}, 'h', 'linux', 'amd64', 2, 'offline', 'x', now())`;
    await rawSql`
      INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
      VALUES (${station}, ${tenant}, ${user}, ${node}, 'hermes', ${"hermes:" + station}, 'leaf', ${station}, '["acp"]'::jsonb, now(), now())`;
  }
  await createBridgeAgent({ tenantId: BOOTSTRAP_TENANT_ID, key: KEY, boardId: BOARD_A, stationId: STATION_A, token: TOKEN, createdBy: USER_A });
  await createBridgeAgent({ tenantId: TENANT_B, key: KEY, boardId: BOARD_B, stationId: STATION_B, token: TOKEN, createdBy: USER_B });
});

afterAll(async () => {
  await db.delete(bridgeAgents).where(inArray(bridgeAgents.stationId, [STATION_A, STATION_B]));
  await rawSql`DELETE FROM stations WHERE id IN (${STATION_A}, ${STATION_B})`;
  await rawSql`DELETE FROM nodes WHERE id IN (${NODE_A}, ${NODE_B})`;
  await deleteTestUsers([USER_A, USER_B]);
});

describe("every workspace's roster", () => {
  test("readEveryBridgeRoster returns both tenants' agents, each carrying its own tenant and station user", async () => {
    const mine = (await readEveryBridgeRoster()).filter((a) => a.key === KEY);
    const byTenant = new Map(mine.map((a) => [a.tenantId, a]));
    expect(byTenant.size).toBe(2);
    expect(byTenant.get(BOOTSTRAP_TENANT_ID)?.stationId).toBe(STATION_A);
    expect(byTenant.get(BOOTSTRAP_TENANT_ID)?.hubUserId).toBe(USER_A);
    expect(byTenant.get(TENANT_B)?.stationId).toBe(STATION_B);
    expect(byTenant.get(TENANT_B)?.hubUserId).toBe(USER_B);
  });

  test("the bridge loop runs both same-named agents, each asking only inside its own tenant", async () => {
    const prev = { on: process.env.ENABLE_SUPERPIPELINE_BRIDGE, url: process.env.SUPERPIPELINE_BASE_URL };
    process.env.ENABLE_SUPERPIPELINE_BRIDGE = "true";
    process.env.SUPERPIPELINE_BASE_URL = "http://127.0.0.1:9";
    const asked: Array<{ stationId: string; tenantId: string }> = [];
    let resolveBoth!: () => void;
    const both = new Promise<void>((r) => (resolveBoth = r));
    const acp = {
      // Not ready: the loop never claims, so nothing reaches the (absent) superpipeline.
      stationReady: async (i: { stationId: string; tenantId: string }) => {
        if (i.stationId === STATION_A || i.stationId === STATION_B) asked.push({ stationId: i.stationId, tenantId: i.tenantId });
        if (new Set(asked.map((a) => a.stationId)).size === 2) resolveBoth();
        return { ready: false, reason: "test: not ready" };
      },
      createSession: async () => {
        throw new Error("the bridge must not open a session in this test");
      },
      promptSession: async () => {},
    } as unknown as AcpPort;
    const handle = await startSuperpipelineBridge({ acp, log: () => {}, reconcileMs: 60_000 });
    try {
      expect(handle).not.toBeNull();
      const running = handle!.agents.filter((k) => k.endsWith(KEY));
      expect(running.length).toBe(2);
      await Promise.race([both, new Promise((_, rej) => setTimeout(() => rej(new Error("both agents were not asked")), 5_000))]);
      const a = asked.find((x) => x.stationId === STATION_A)!;
      const b = asked.find((x) => x.stationId === STATION_B)!;
      expect(a.tenantId).toBe(BOOTSTRAP_TENANT_ID);
      expect(b.tenantId).toBe(TENANT_B);
    } finally {
      await handle?.stop();
      process.env.ENABLE_SUPERPIPELINE_BRIDGE = prev.on;
      process.env.SUPERPIPELINE_BASE_URL = prev.url;
      if (prev.on === undefined) delete process.env.ENABLE_SUPERPIPELINE_BRIDGE;
      if (prev.url === undefined) delete process.env.SUPERPIPELINE_BASE_URL;
    }
  });

  test("the gate sweep asks both tenants' boards", async () => {
    const deps = bridgeGateSweepDeps({ baseUrl: "http://127.0.0.1:9" } as never, {} as never);
    const boards = await deps.boards();
    expect(boards).toContain(BOARD_A);
    expect(boards).toContain(BOARD_B);
  });

  test("the elicitation sweep asks both tenants' boards", async () => {
    const deps = bridgeElicitationSweepDeps({ baseUrl: "http://127.0.0.1:9" } as never, {} as never);
    const boards = await deps.boards();
    expect(boards).toContain(BOARD_A);
    expect(boards).toContain(BOARD_B);
  });
});
