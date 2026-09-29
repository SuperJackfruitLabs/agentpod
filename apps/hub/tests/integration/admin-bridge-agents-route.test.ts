/**
 * The operator surface that replaces editing `hub.env` and restarting.
 *
 * What earns a test here is the property the routes exist to hold: **no response ever carries a
 * credential.** The roster holds two `spa_` tokens per agent, and the whole reason they moved into
 * an encrypted column rather than a file is that a file is readable by anything that can read the
 * unit. A read surface that echoed them back would have given that away again through HTTP.
 *
 * Mounted under `/api/admin` in production, behind the same auth + admin middleware as every other
 * admin route; the guard is asserted at its mount site, so this exercises the router itself.
 *
 * DATABASE_URL must point at the local Docker test-postgres on localhost:5434.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "bridge-routes-test-key-0123456789";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { db } from "../../src/db/drizzle";
import { bridgeAgents } from "../../src/db/schema/bridge";
import { stations } from "../../src/db/schema/stations";
import { nodes } from "../../src/db/schema/nodes";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { adminBridgeAgentsRouter } from "../../src/routes/admin-bridge-agents";
import { readBridgeRoster } from "../../src/services/bridge/roster";
import { createTestUser } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const NODE_ID = "node_bridge_routes_test";
const STATION_ID = "station_bridge_routes_test";
const BOARD_ID = "brd_6a899b0f0d054046";
const TOKEN = `spa_${"a1b2c3d4".repeat(6)}`;
const MCP_TOKEN = `spa_${"f0e1d2c3".repeat(6)}`;

let userId: string;

function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: userId, role: "admin" });
    await next();
  });
  a.route("/bridge/agents", adminBridgeAgentsRouter);
  return a;
}

const post = (body: unknown) =>
  app().request("/bridge/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const patch = (key: string, body: unknown) =>
  app().request(`/bridge/agents/${key}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const valid = () => ({ key: "coder-kai", boardId: BOARD_ID, stationId: STATION_ID, token: TOKEN });

beforeAll(async () => {
  await ensurePgMigrations();
  userId = (await createTestUser({ name: "bridge-routes" })).id;

  await db
    .insert(nodes)
    .values({
      id: NODE_ID,
      tenantId: BOOTSTRAP_TENANT_ID,
      userId,
      name: "bridge-routes-node",
      hostname: "bridge-routes.test",
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
      stationKey: "bridge-routes-station",
      kind: "service",
      displayName: "Routes Station",
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

describe("no response carries a credential", () => {
  test("not the create that was given one", async () => {
    const res = await post({ ...valid(), mcpToken: MCP_TOKEN });
    expect(res.status).toBe(201);

    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(MCP_TOKEN);
    expect(JSON.parse(text).agent).toMatchObject({ hasToken: true, hasMcpToken: true });
  });

  test("not the list", async () => {
    await post({ ...valid(), mcpToken: MCP_TOKEN });
    const text = await (await app().request("/bridge/agents")).text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(MCP_TOKEN);
  });

  test("not the patch that rotated one", async () => {
    await post(valid());
    const rotated = `spa_${"9876543a".repeat(6)}`;
    const text = await (await patch("coder-kai", { token: rotated })).text();
    expect(text).not.toContain(rotated);
    // It really did rotate — the bridge's own read surface sees the new one.
    expect((await readBridgeRoster(BOOTSTRAP_TENANT_ID))[0]!.token).toBe(rotated);
  });
});

describe("what a create refuses, in words an operator can act on", () => {
  test("a station in no workspace of this tenant", async () => {
    const res = await post({ ...valid(), stationId: "station_does_not_exist" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no such station in this workspace");
  });

  test("a duplicate key, which would make the ledger unreadable", async () => {
    await post(valid());
    const res = await post(valid());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("already exists");
  });

  test("a refusal never carries the ciphertext the failed insert was holding", async () => {
    // Drizzle's error message includes the bound parameters, and for this table one of them is the
    // ENCRYPTED credential. Returning the raw text — which the first version of `refusal()` did as
    // its fallback — published ciphertext to anyone who could provoke an insert error.
    const res = await post({ ...valid(), stationId: "station_does_not_exist", mcpToken: MCP_TOKEN });
    const text = await res.text();
    expect(text).not.toContain("token_encrypted");
    expect(text).not.toContain("Failed query");
    expect(text).not.toContain("insert into");
  });

  test("a board id of the wrong grammar, before the database is asked", async () => {
    const res = await post({ ...valid(), boardId: "brd_NOTHEX" });
    expect(res.status).toBe(400);
  });

  test("a token that is not a superpipeline agent token", async () => {
    const res = await post({ ...valid(), token: "kbn_something_else" });
    expect(res.status).toBe(400);
  });
});

describe("editing one", () => {
  test("an unknown key is a 404, not a silent success", async () => {
    expect((await patch("nobody", { mode: "ask" })).status).toBe(404);
  });

  test("an empty patch is refused — it is a mistake, not a no-op", async () => {
    await post(valid());
    expect((await patch("coder-kai", {})).status).toBe(400);
  });

  test("disabling stops it being rostered without destroying its credential", async () => {
    await post({ ...valid(), mcpToken: MCP_TOKEN });
    const res = await patch("coder-kai", { enabled: false });

    expect(res.status).toBe(200);
    expect((await res.json()).agent).toMatchObject({ enabled: false, hasToken: true, hasMcpToken: true });
    expect(await readBridgeRoster(BOOTSTRAP_TENANT_ID)).toHaveLength(0);
  });

  test("clearing the mcp token takes the board tools away and leaves the agent", async () => {
    await post({ ...valid(), mcpToken: MCP_TOKEN });
    const res = await patch("coder-kai", { mcpToken: null });

    expect((await res.json()).agent).toMatchObject({ hasToken: true, hasMcpToken: false });
    expect((await readBridgeRoster(BOOTSTRAP_TENANT_ID))[0]!.mcpToken).toBeNull();
  });
});

describe("removing one", () => {
  test("it goes, and says so", async () => {
    await post(valid());
    const res = await app().request("/bridge/agents/coder-kai", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await readBridgeRoster(BOOTSTRAP_TENANT_ID)).toHaveLength(0);
  });

  test("removing one that is not there is a 404", async () => {
    expect((await app().request("/bridge/agents/nobody", { method: "DELETE" })).status).toBe(404);
  });
});
