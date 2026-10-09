/**
 * The per-board "Related prior work" switch: `PUT /api/admin/bridge/boards/:boardId`.
 *
 * The router alone, then once through `adminRouter` to prove where it is mounted and that it
 * sits behind the admin guard like `/bridge/agents`.
 *
 * DATABASE_URL must point at a pgvector test Postgres (root CLAUDE.md).
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";

import { config } from "../../src/config";
import { db } from "../../src/db/drizzle";
import { bridgeBoardSettings } from "../../src/db/schema/bridge";
import { hubOperators } from "../../src/db/schema/operators";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { adminRouter } from "../../src/routes/admin";
import { adminBridgeBoardsRouter } from "../../src/routes/admin-bridge-boards";
import { relatedWorkEnabled } from "../../src/services/superlibrary/related";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const BOARD = "brd_00000000000000b1";
const OTHER = "brd_00000000000000b2";

function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: "prn_000000000000000000a3", authType: "org_plane", tenantId: BOOTSTRAP_TENANT_ID });
    await next();
  });
  a.route("/bridge/boards", adminBridgeBoardsRouter);
  return a;
}
const put = (board: string, body: unknown, a: { request: Hono["request"] } = app(), headers: Record<string, string> = {}) =>
  a.request(`/bridge/boards/${board}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const clean = () =>
  db
    .delete(bridgeBoardSettings)
    .where(and(eq(bridgeBoardSettings.tenantId, BOOTSTRAP_TENANT_ID), inArray(bridgeBoardSettings.boardId, [BOARD, OTHER])));
let seatedOperator = false;
beforeAll(async () => {
  await ensurePgMigrations();
});
beforeEach(clean);
afterAll(async () => {
  await clean();
  if (seatedOperator) await db.delete(hubOperators).where(eq(hubOperators.principalId, config.defaultUserId));
});

test("a board with no row has the section on", async () => {
  expect(await relatedWorkEnabled(BOOTSTRAP_TENANT_ID, BOARD)).toBe(true);
});

test("off, then on again: the row is upserted and the next claim reads it", async () => {
  const off = await put(BOARD, { relatedWork: false });
  expect(off.status).toBe(200);
  expect(await off.json()).toEqual({ boardId: BOARD, relatedWork: false });
  expect(await relatedWorkEnabled(BOOTSTRAP_TENANT_ID, BOARD)).toBe(false);
  // Another board is untouched.
  expect(await relatedWorkEnabled(BOOTSTRAP_TENANT_ID, OTHER)).toBe(true);

  expect((await put(BOARD, { relatedWork: true })).status).toBe(200);
  expect(await relatedWorkEnabled(BOOTSTRAP_TENANT_ID, BOARD)).toBe(true);
  const rows = await db
    .select()
    .from(bridgeBoardSettings)
    .where(and(eq(bridgeBoardSettings.tenantId, BOOTSTRAP_TENANT_ID), eq(bridgeBoardSettings.boardId, BOARD)));
  expect(rows).toHaveLength(1);
});

test("a board id that is not superpipeline's is a 400, and nothing is written", async () => {
  expect((await put("not-a-board", { relatedWork: false })).status).toBe(400);
  expect(await db.select().from(bridgeBoardSettings).where(eq(bridgeBoardSettings.boardId, "not-a-board"))).toHaveLength(0);
});

test("a body that is not one boolean is a 400", async () => {
  for (const body of [{}, { relatedWork: "off" }, { relatedWork: false, extra: 1 }]) {
    expect((await put(BOARD, body)).status).toBe(400);
  }
});

test("mounted at /api/admin/bridge/boards, behind the admin guard", async () => {
  const mounted = new Hono().route("/api/admin", adminRouter);
  const at = (h: Record<string, string>) =>
    mounted.request(`/api/admin/bridge/boards/${BOARD}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...h },
      body: JSON.stringify({ relatedWork: false }),
    });
  expect((await at({})).status).toBe(401);
  expect(await relatedWorkEnabled(BOOTSTRAP_TENANT_ID, BOARD)).toBe(true);

  // The hub's API key is the default user; seat it as an operator for this one call.
  const [had] = await db.select().from(hubOperators).where(eq(hubOperators.principalId, config.defaultUserId));
  if (!had) {
    await db.insert(hubOperators).values({ principalId: config.defaultUserId });
    seatedOperator = true;
  }
  const res = await at({ Authorization: `Bearer ${config.auth.token}` });
  expect(res.status).toBe(200);
  expect(await relatedWorkEnabled(BOOTSTRAP_TENANT_ID, BOARD)).toBe(false);
});
