/**
 * DELETE /api/nodes/:id — a retired machine leaving the fleet.
 *
 * The guards here are the point of the feature, so each is asserted from the
 * outside: a node that is not yours stays; a runtime's node is refused with the
 * command that does remove it; a removed node's credential is dead, so the
 * machine dialling back is refused and its old token cannot rejoin it.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { rawSql } from "../../src/db/drizzle";
import { createTestUser, deleteTestUsers } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createPrincipal, forgetPrincipals } from "../helpers/principals";
import { enrollNode, mintEnrollmentToken, verifyNodeCredential } from "../../src/services/enrollment";
import { listNodes } from "../../src/services/node-registry";
import { createNodeRoutes, nodeEnrollRoutes } from "../../src/routes/nodes";
import { gatewayRoutes } from "../../src/routes/gateway";
import { websocket } from "../../src/ws";
import { connectionManager } from "../../src/services/connection-manager";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { RemoveNodeRefusal, RemoveNodeResponse } from "@agentpod/contract";
import { pollUntil, waitForNodeOnline } from "../helpers/wait";

const OWNER = "test-user-node-remove-owner";
const OTHER = "test-user-node-remove-other";
const ADMIN = "test-user-node-remove-admin";

const HOST = { hostname: "noderm-host", os: "linux", arch: "amd64", cpuCount: 2 };

function api(userId: string) {
  return new Hono()
    .use("*", async (c, next) => {
      c.set("user", { id: userId, role: "user" } as never);
      await next();
    })
    .route("/api/nodes", createNodeRoutes())
    .route("/public/nodes", nodeEnrollRoutes)
    .route("/public/nodes", gatewayRoutes);
}

async function del(userId: string, nodeId: string, force = false) {
  return api(userId).request(`/api/nodes/${nodeId}${force ? "?force=1" : ""}`, { method: "DELETE" });
}

async function enrol(userId: string) {
  const { token } = await mintEnrollmentToken(userId);
  const creds = await enrollNode(token, HOST);
  return { token, ...creds };
}

async function nodeExists(nodeId: string): Promise<boolean> {
  const rows = await rawSql`SELECT 1 FROM nodes WHERE id = ${nodeId}`;
  return rows.length > 0;
}

async function addStation(userId: string, nodeId: string, key: string): Promise<string> {
  const id = `stn_${nodeId}_${key.replace(/[^a-z0-9]/gi, "")}`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name)
    VALUES (${id}, ${BOOTSTRAP_TENANT_ID}, ${userId}, ${nodeId}, 'hermes', ${key}, 'agent', ${key})`;
  return id;
}

function dial(port: number, nodeId: string, nodeSecret: string): WebSocket {
  return new WebSocket(`ws://localhost:${port}/public/nodes/gateway`, {
    headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
  } as RequestInit & { headers: Record<string, string> });
}

function closeOf(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((res) => {
    ws.onclose = (e) => res({ code: e.code, reason: e.reason });
  });
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: "noderm-owner@example.com", name: "Owner" });
  await createTestUser({ id: OTHER, email: "noderm-other@example.com", name: "Other" });
  await createTestUser({ id: ADMIN, email: "noderm-admin@example.com", name: "Admin", role: "admin" });
  await createPrincipal({ kind: "human", handle: "noderm-owner", userId: OWNER });
  await createPrincipal({ kind: "human", handle: "noderm-admin", userId: ADMIN });
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    const users = [OWNER, OTHER, ADMIN];
    await rawSql`DELETE FROM bridge_agents WHERE station_id IN (SELECT id FROM stations WHERE user_id = ANY(${users}))`;
    await rawSql`DELETE FROM provisioned_runtimes WHERE user_id = ANY(${users})`;
    await rawSql`DELETE FROM nodes WHERE user_id = ANY(${users})`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ANY(${users})`;
    await forgetPrincipals({ handles: ["noderm-owner", "noderm-admin"] });
    await deleteTestUsers(users);
  } catch {
    // cleanup only
  }
});

describe("who may remove a node", () => {
  test("a node that does not exist is 404", async () => {
    const res = await del(OWNER, "node_does_not_exist");
    expect(res.status).toBe(404);
  });

  test("a node someone else owns is 404 and stays", async () => {
    const { nodeId } = await enrol(OWNER);
    const res = await del(OTHER, nodeId);
    expect(res.status).toBe(404);
    expect(await nodeExists(nodeId)).toBe(true);
  });

  test("where the control pair is enforced, an owner who may not grow the fleet may not shrink it", async () => {
    const { nodeId } = await enrol(OWNER);
    process.env.ENFORCE_CONTROL_PAIR = "true";
    try {
      const res = await del(OWNER, nodeId);
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/remove machines/i);
      expect(await nodeExists(nodeId)).toBe(true);
      // ...and a stranger still cannot tell the id exists.
      expect((await del(OTHER, nodeId)).status).toBe(404);
    } finally {
      delete process.env.ENFORCE_CONTROL_PAIR;
    }
  });

  test("where the control pair is enforced, an admin owner may", async () => {
    const { nodeId } = await enrol(ADMIN);
    process.env.ENFORCE_CONTROL_PAIR = "true";
    try {
      const res = await del(ADMIN, nodeId);
      expect(res.status).toBe(200);
      expect(await nodeExists(nodeId)).toBe(false);
    } finally {
      delete process.env.ENFORCE_CONTROL_PAIR;
    }
  });
});

describe("what removal refuses", () => {
  test("a provisioned runtime's node is 409, pointing at fleet runtimes rm", async () => {
    const { nodeId } = await enrol(OWNER);
    const runtimeId = `rt_noderm_${Date.now().toString(36)}`;
    await rawSql`
      INSERT INTO provisioned_runtimes (id, tenant_id, user_id, provider, status, node_id, name)
      VALUES (${runtimeId}, ${BOOTSTRAP_TENANT_ID}, ${OWNER}, 'docker', 'online', ${nodeId}, 'noderm-runtime')`;

    const res = await del(OWNER, nodeId, true);
    expect(res.status).toBe(409);
    const body = RemoveNodeRefusal.parse(await res.json());
    expect(body.code).toBe("provisioned");
    expect(body.runtimeId).toBe(runtimeId);
    expect(body.error).toContain(`fleet runtimes rm ${runtimeId}`);
    expect(await nodeExists(nodeId)).toBe(true);
  });

  test("a node with a bridge agent on one of its stations is 409, naming the roster key", async () => {
    const { nodeId } = await enrol(OWNER);
    const stationId = await addStation(OWNER, nodeId, "hermes:bridged");
    await rawSql`
      INSERT INTO bridge_agents (tenant_id, key, board_id, station_id, token_encrypted)
      VALUES (${BOOTSTRAP_TENANT_ID}, 'noderm-bridge', 'brd_0123456789abcdef', ${stationId}, 'x')`;

    const res = await del(OWNER, nodeId);
    expect(res.status).toBe(409);
    const body = RemoveNodeRefusal.parse(await res.json());
    expect(body.code).toBe("bridged");
    expect(body.bridgeAgents).toEqual(["noderm-bridge"]);
    expect(body.error).toContain("fleet bridge rm noderm-bridge");
    expect(await nodeExists(nodeId)).toBe(true);
  });
});

describe("removing an offline node", () => {
  test("unregisters its stations, drops its node-level config, audits, and kills its credential", async () => {
    const { nodeId, nodeSecret, token } = await enrol(OWNER);
    await addStation(OWNER, nodeId, "hermes:one");
    await addStation(OWNER, nodeId, "pi:two");
    await rawSql`
      INSERT INTO declared_harness_config (id, tenant_id, setting_id, node_id, value, declared_by)
      VALUES (${`dcfg_${nodeId}`}, ${BOOTSTRAP_TENANT_ID}, 'noderm.setting', ${nodeId}, '1'::jsonb, ${OWNER})`;
    expect(await verifyNodeCredential(nodeId, nodeSecret)).toBe(true);

    const res = await del(OWNER, nodeId);
    expect(res.status).toBe(200);
    const body = RemoveNodeResponse.parse(await res.json());
    expect(body.node.id).toBe(nodeId);
    expect(body.disconnected).toBe(false);
    expect(body.stationsRemoved.map((s) => s.stationKey).sort()).toEqual(["hermes:one", "pi:two"]);

    expect((await listNodes(OWNER)).some((n) => n.id === nodeId)).toBe(false);
    expect(await rawSql`SELECT 1 FROM stations WHERE node_id = ${nodeId}`).toHaveLength(0);
    expect(await rawSql`SELECT 1 FROM declared_harness_config WHERE node_id = ${nodeId}`).toHaveLength(0);

    const audit = await rawSql`
      SELECT action, admin_user_id FROM admin_audit_log WHERE target_resource_id = ${nodeId}`;
    expect([...audit]).toEqual([{ action: "node_remove", admin_user_id: OWNER }]);

    // The credential is revoked: the node's own probe says so...
    expect(await verifyNodeCredential(nodeId, nodeSecret)).toBe(false);
    const probe = await api(OWNER).request("/public/nodes/credential-check", {
      headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
    });
    expect(probe.status).toBe(401);
    // ...and the token that enrolled it cannot bring it back.
    await expect(enrollNode(token, HOST)).rejects.toThrow(/invalid or expired/);

    // Removing it again is a 404, not a second success.
    expect((await del(OWNER, nodeId)).status).toBe(404);
  });
});

describe("removing a connected node", () => {
  test("is refused without force, and with force cuts the session and refuses the reconnect", async () => {
    const server = Bun.serve({ fetch: api(OWNER).fetch, websocket, port: 0 });
    const port = server.port!;
    try {
      const { nodeId, nodeSecret } = await enrol(OWNER);
      const ws = dial(port, nodeId, nodeSecret);
      await waitForNodeOnline(nodeId);
      const closed = closeOf(ws);

      const refused = await del(OWNER, nodeId);
      expect(refused.status).toBe(409);
      expect(RemoveNodeRefusal.parse(await refused.json()).code).toBe("online");
      expect(connectionManager.isOnline(nodeId)).toBe(true);
      expect(await nodeExists(nodeId)).toBe(true);

      const res = await del(OWNER, nodeId, true);
      expect(res.status).toBe(200);
      expect(RemoveNodeResponse.parse(await res.json()).disconnected).toBe(true);

      // The hub hung up on it.
      expect((await closed).reason).toBe("node removed");
      expect(connectionManager.isOnline(nodeId)).toBe(false);

      // The machine dials back with the credential it still holds: refused.
      const again = dial(port, nodeId, nodeSecret);
      const second = await closeOf(again);
      expect(second.code).toBe(1008);
      expect(second.reason).toBe("unauthorized");
      expect(connectionManager.isOnline(nodeId)).toBe(false);
      expect(await nodeExists(nodeId)).toBe(false);
      await pollUntil(async () => !(await listNodes(OWNER)).some((n) => n.id === nodeId));
    } finally {
      server.stop(true);
    }
  });
});
