process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { db } from "../../src/db/drizzle";
import { bridgeDispatches } from "../../src/db/schema/bridge";
import { tenants } from "../../src/db/schema/tenants";
import { existingTenantForOrg } from "../../src/auth/org-plane/tenant";
import { tenantsForBoard } from "../../src/services/board-chat/gate-reads";
import { ensurePgMigrations } from "../helpers/pg-migrations";

/**
 * The reads the SuperPipeline relay's tenant rule rests on (review of #845): every tenant that knows
 * a board, so a board known to several is never relayed; and an org's tenant looked up, never made.
 */
const RUN = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const A = `fleet_relay_a_${RUN}`;
const B = `fleet_relay_b_${RUN}`;
const ORG = `org_${RUN}0000`;
const SHARED = `brd_${RUN}`;
const MINE = `brd_${RUN.split("").toReversed().join("")}`;

function dispatch(tenantId: string, boardId: string, n: number) {
  const now = new Date();
  return {
    externalSource: "superpipeline",
    externalRunId: `run_${RUN}_${n}`,
    tenantId,
    boardId,
    externalCardId: `card_${n}`,
    agentKey: "k",
    stationId: "st",
    leaseEpoch: 1,
    outcome: "released",
    startedAt: now,
    updatedAt: now,
  };
}

beforeAll(async () => {
  await ensurePgMigrations();
  await db.insert(tenants).values([
    { id: A, name: "relay a", externalSource: "org-plane", externalId: ORG },
    { id: B, name: "relay b" },
  ]);
  await db.insert(bridgeDispatches).values([dispatch(A, SHARED, 1), dispatch(B, SHARED, 2), dispatch(A, MINE, 3), dispatch(A, MINE, 4)]);
});

afterAll(async () => {
  await db.delete(bridgeDispatches).where(inArray(bridgeDispatches.tenantId, [A, B]));
  await db.delete(tenants).where(inArray(tenants.id, [A, B]));
});

describe("which tenants know a board", () => {
  test("every tenant that worked it, once each", async () => {
    expect(await tenantsForBoard(SHARED)).toEqual([A, B].toSorted());
    expect(await tenantsForBoard(MINE)).toEqual([A]);
    expect(await tenantsForBoard("brd_ffffffffffffffff")).toEqual([]);
  });

  test("an org's tenant is looked up, never created", async () => {
    expect(await existingTenantForOrg(ORG)).toBe(A);
    expect(await existingTenantForOrg(`org_${RUN}ffff`)).toBeNull();
    expect(await db.select().from(tenants).where(inArray(tenants.externalId, [`org_${RUN}ffff`]))).toHaveLength(0);
  });
});
