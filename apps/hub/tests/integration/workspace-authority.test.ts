process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser, deleteTestUsers } from "../helpers/database";
import { fakePlane, signPlaneToken, TEST_ORG } from "../helpers/fake-plane";
import { rawSql } from "../../src/db/drizzle";
import { authMiddleware } from "../../src/auth/middleware";
import { tenantForOrg } from "../../src/auth/org-plane/tenant";
import { adminRouter } from "../../src/routes/admin";
import { meRoutes } from "../../src/routes/me";
import { createNodeRoutes } from "../../src/routes/nodes";
import { enrollmentTokenRoutes } from "../../src/routes/enrollment-tokens";
import { createStationForgeApiRoutes } from "../../src/routes/station-forge-api";

/**
 * Workspace authority spec, step 3 (W1, W2): the hub answers to the caller's role in the
 * workspace their token names, and the hub operator seat covers only what no workspace owns.
 *
 * Everything goes through the real `authMiddleware` with a real plane token, so the role is the
 * one `orgRole` carried, not a stub's.
 */

const ORG_B = "org_22222222222222222222";
const RUN = crypto.randomUUID().slice(0, 8);
let MEMBER: string; // member of A (orgRole: member)
let ADMIN: string; // admin of A
let OWNER: string; // owner of A
let OLD: string; // a token minted before orgRole existed
let OPERATOR: string; // hub operator seat, member of A
let TENANT_A: string;
let TENANT_B: string;
const NODE_A = `node_wsa_a_${RUN}`;
const NODE_B = `node_wsa_b_${RUN}`;
const NODE_M = `node_wsa_m_${RUN}`; // a node in A that the member enrolled
const STATION_A = `station_wsa_a_${RUN}`;
const STATION_B = `station_wsa_b_${RUN}`;
const AUDIT_A = `audit_wsa_a_${RUN}`;
const AUDIT_B = `audit_wsa_b_${RUN}`;

const app = new Hono()
  .use("/api/*", authMiddleware)
  .route("/api/admin", adminRouter)
  .route("/api", meRoutes)
  .route("/api/enrollment-tokens", enrollmentTokenRoutes)
  // No broker: a node in these tests is never asked anything.
  .route("/api/nodes", createNodeRoutes({ request: async () => ({ ok: false, error: "offline" }) }))
  .route("/api", createStationForgeApiRoutes({ forge: null }));

async function as(sub: string, claims: Record<string, unknown> = {}) {
  return { Authorization: `Bearer ${await signPlaneToken({ sub, ...claims })}`, "Content-Type": "application/json" };
}

async function call(headers: Record<string, string>, method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}

/** Every route the gate map moved from the hub operator seat (or from nothing) to workspace admin. */
const WORKSPACE_ADMIN_ROUTES: Array<[string, string, unknown?]> = [
  ["GET", "/api/admin/stats"],
  ["GET", "/api/admin/principals"],
  ["POST", "/api/admin/agents", { handle: `wsa-${RUN}` }],
  ["PUT", `/api/admin/stations/${STATION_A}/agent`, { principalId: "prn_00000000000000000000" }],
  ["DELETE", `/api/admin/stations/${STATION_A}/agent`],
  ["GET", "/api/admin/bridge/agents"],
  ["PUT", "/api/admin/bridge/boards/brd_wsa", { relatedWork: true }],
  ["GET", "/api/nodes/telemetry"],
  ["POST", "/api/nodes/telemetry", { off: true }],
  ["POST", "/api/nodes/update-all", {}],
  ["POST", "/api/enrollment-tokens"],
  ["POST", `/api/stations/${STATION_A}/forge-api`, {}],
];

beforeAll(async () => {
  await ensurePgMigrations();
  MEMBER = (await createTestUser({ email: `wsa-member-${RUN}@example.com` })).id;
  ADMIN = (await createTestUser({ email: `wsa-admin-${RUN}@example.com` })).id;
  OWNER = (await createTestUser({ email: `wsa-owner-${RUN}@example.com` })).id;
  OLD = (await createTestUser({ email: `wsa-old-${RUN}@example.com` })).id;
  OPERATOR = (await createTestUser({ email: `wsa-op-${RUN}@example.com`, role: "admin" })).id;
  const a = await tenantForOrg({ org: TEST_ORG, ent: ["agentpod"] });
  const b = await tenantForOrg({ org: ORG_B, ent: ["agentpod"] });
  if (!a.ok || !b.ok) throw new Error("tenant resolution refused");
  TENANT_A = a.tenantId;
  TENANT_B = b.tenantId;
  for (const [node, tenant, station] of [
    [NODE_A, TENANT_A, STATION_A],
    [NODE_B, TENANT_B, STATION_B],
  ] as const) {
    await rawSql`
      INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
      VALUES (${node}, ${tenant}, ${ADMIN}, ${node}, 'h', 'linux', 'amd64', 2, 'offline', 'x', now())`;
    await rawSql`
      INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
      VALUES (${station}, ${tenant}, ${ADMIN}, ${node}, 'claude-code', ${"claude-code:" + station}, 'leaf', ${station}, '["acp"]'::jsonb, now(), now())`;
  }
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE_M}, ${TENANT_A}, ${MEMBER}, ${NODE_M}, 'h', 'linux', 'amd64', 2, 'offline', 'x', now())`;
  await rawSql`
    INSERT INTO admin_audit_log (id, tenant_id, admin_user_id, action) VALUES
      (${AUDIT_A}, ${TENANT_A}, ${ADMIN}, 'node_remove'),
      (${AUDIT_B}, ${TENANT_B}, ${ADMIN}, 'node_remove')`;
});

afterAll(async () => {
  await rawSql`DELETE FROM admin_audit_log WHERE id IN (${AUDIT_A}, ${AUDIT_B})`;
  await rawSql`DELETE FROM stations WHERE id IN (${STATION_A}, ${STATION_B})`;
  await rawSql`DELETE FROM nodes WHERE id IN (${NODE_A}, ${NODE_B}, ${NODE_M})`;
  await deleteTestUsers([MEMBER, ADMIN, OWNER, OLD, OPERATOR]);
});

describe("W1: a member is refused every workspace-admin route", () => {
  for (const [method, path, body] of WORKSPACE_ADMIN_ROUTES) {
    test(`${method} ${path} → 403 workspace_admin_required`, async () => {
      const r = await call(await as(MEMBER, { orgRole: "member" }), method, path, body);
      expect(r.status).toBe(403);
      expect(r.json?.error).toBe("workspace_admin_required");
    });
  }

  test("DELETE /api/nodes/:id of the member's own node → 403 workspace_admin_required, node kept", async () => {
    const r = await call(await as(MEMBER, { orgRole: "member" }), "DELETE", `/api/nodes/${NODE_M}`);
    expect(r.status).toBe(403);
    expect(r.json?.error).toBe("workspace_admin_required");
    const [row] = await rawSql`SELECT id FROM nodes WHERE id = ${NODE_M}`;
    expect(row?.id).toBe(NODE_M);
  });

  test("a token without orgRole is a member: refused, and /api/me says member", async () => {
    const h = await as(OLD);
    for (const [method, path, body] of WORKSPACE_ADMIN_ROUTES) {
      const r = await call(h, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json?.error).toBe("workspace_admin_required");
    }
    const me = await call(h, "GET", "/api/me");
    expect(me.json).toMatchObject({ workspaceRole: "member", isWorkspaceAdmin: false, isAdmin: false });
  });

  test("an unknown orgRole is a member", async () => {
    const r = await call(await as(OLD, { orgRole: "superuser" }), "GET", "/api/admin/stats");
    expect(r.status).toBe(403);
  });
});

describe("W1: an owner or admin of the workspace passes the gate", () => {
  for (const role of ["owner", "admin"] as const) {
    for (const [method, path, body] of WORKSPACE_ADMIN_ROUTES) {
      test(`${role}: ${method} ${path} is not refused by the gate`, async () => {
        const who = role === "owner" ? OWNER : ADMIN;
        const r = await call(await as(who, { orgRole: role }), method, path, body);
        expect(r.json?.error).not.toBe("workspace_admin_required");
        expect(r.status).not.toBe(401);
        // The forge-api mutation passes the gate and stops at the unconfigured forge.
        if (path.includes("forge-api")) expect(r.status).toBe(503);
      });
    }
  }

  test("update-all answers a rollout for a workspace admin", async () => {
    const r = await call(await as(ADMIN, { orgRole: "admin" }), "POST", "/api/nodes/update-all", {});
    expect(r.status).toBe(200);
    expect(r.json?.ok).toBe(true);
  });
});

describe("W2: the hub operator seat is the hub's, not every workspace's", () => {
  test("an operator who is a member of A is refused A's workspace-admin routes", async () => {
    const h = await as(OPERATOR, { orgRole: "member" });
    for (const [method, path, body] of WORKSPACE_ADMIN_ROUTES) {
      const r = await call(h, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json?.error).toBe("workspace_admin_required");
    }
  });

  test("…and is not an admin of workspace B either", async () => {
    const r = await call(await as(OPERATOR, { org: ORG_B, orgRole: "member" }), "GET", "/api/admin/stats");
    expect(r.status).toBe(403);
  });

  test("…but reaches the hub-wide settings", async () => {
    const h = await as(OPERATOR, { orgRole: "member" });
    expect((await call(h, "GET", "/api/admin/settings")).status).toBe(200);
    expect((await call(h, "GET", "/api/admin/settings/transcription")).status).toBe(200);
    expect((await call(h, "GET", "/api/admin/settings/speech")).status).toBe(200);
  });

  test("a workspace admin who holds no seat is refused the hub-wide settings", async () => {
    const h = await as(ADMIN, { orgRole: "owner" });
    for (const path of ["/api/admin/settings", "/api/admin/settings/transcription", "/api/admin/settings/speech"]) {
      expect((await call(h, "GET", path)).status, path).toBe(403);
    }
  });
});

describe("W2: a workspace admin of A cannot act on B's rows", () => {
  test("the audit log shows A's rows to A's admin, never B's", async () => {
    const r = await call(await as(ADMIN, { orgRole: "admin" }), "GET", "/api/admin/audit-log?limit=500");
    expect(r.status).toBe(200);
    const ids = (r.json.entries as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain(AUDIT_A);
    expect(ids).not.toContain(AUDIT_B);
  });

  test("a hub operator reads the whole audit log", async () => {
    const r = await call(await as(OPERATOR, { orgRole: "member" }), "GET", "/api/admin/audit-log?limit=500");
    expect(r.status).toBe(200);
    const ids = (r.json.entries as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining([AUDIT_A, AUDIT_B]));
  });

  test("assigning or unassigning an agent in B's station is 404 for A's admin", async () => {
    const h = await as(ADMIN, { orgRole: "admin" });
    // A real agent of A's, so the only thing that can refuse the assignment is the station's tenant.
    const agent = fakePlane.addAgent({ handle: `wsa-agent-${RUN}` });
    const put = await call(h, "PUT", `/api/admin/stations/${STATION_B}/agent`, { principalId: agent });
    expect(put.status).toBe(404);
    const [row] = await rawSql`SELECT principal_id FROM stations WHERE id = ${STATION_B}`;
    expect(row?.principal_id).toBeNull();
    fakePlane.remove(agent);
    const del = await call(h, "DELETE", `/api/admin/stations/${STATION_B}/agent`);
    expect(del.status).toBe(404);
  });

  test("A's admin cannot move B's agent into A's station (it would vacate B's)", async () => {
    const agent = fakePlane.addAgent({ handle: `wsa-b-agent-${RUN}` });
    fakePlane.principals.get(agent)!.organizationId = ORG_B;
    try {
      const r = await call(await as(ADMIN, { orgRole: "admin" }), "PUT", `/api/admin/stations/${STATION_A}/agent`, {
        principalId: agent,
      });
      expect(r.status).toBe(404);
      const [row] = await rawSql`SELECT principal_id FROM stations WHERE id = ${STATION_A}`;
      expect(row?.principal_id).toBeNull();
    } finally {
      fakePlane.remove(agent);
    }
  });

  test("removing B's node is 404 for A's admin", async () => {
    const r = await call(await as(ADMIN, { orgRole: "admin" }), "DELETE", `/api/nodes/${NODE_B}`);
    expect(r.status).toBe(404);
    const [row] = await rawSql`SELECT id FROM nodes WHERE id = ${NODE_B}`;
    expect(row?.id).toBe(NODE_B);
  });

  test("B's station forge access is 404 for A's admin, read or write", async () => {
    const h = await as(ADMIN, { orgRole: "admin" });
    expect((await call(h, "GET", `/api/stations/${STATION_B}/forge-api`)).status).toBe(404);
    expect((await call(h, "POST", `/api/stations/${STATION_B}/forge-api`, {})).status).toBe(404);
  });
});

describe("station forge-api reads are a workspace member's", () => {
  test("a member who does not own the station reads its forge access", async () => {
    const r = await call(await as(MEMBER, { orgRole: "member" }), "GET", `/api/stations/${STATION_A}/forge-api`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ grants: [] });
  });
});

describe("GET /api/me", () => {
  test("a member", async () => {
    const r = await call(await as(MEMBER, { orgRole: "member" }), "GET", "/api/me");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      id: MEMBER,
      org: TEST_ORG,
      workspaceRole: "member",
      isWorkspaceAdmin: false,
      isHubOperator: false,
      isAdmin: false,
      issuer: "org-plane",
    });
    expect("email" in r.json).toBe(true);
  });

  test("an admin of the workspace", async () => {
    const r = await call(await as(ADMIN, { orgRole: "admin" }), "GET", "/api/me");
    expect(r.json).toMatchObject({ workspaceRole: "admin", isWorkspaceAdmin: true, isHubOperator: false, isAdmin: true });
  });

  test("an owner of workspace B", async () => {
    const r = await call(await as(OWNER, { org: ORG_B, orgRole: "owner" }), "GET", "/api/me");
    expect(r.json).toMatchObject({ org: ORG_B, workspaceRole: "owner", isWorkspaceAdmin: true, isAdmin: true });
  });

  test("a hub operator who is a member", async () => {
    const r = await call(await as(OPERATOR, { orgRole: "member" }), "GET", "/api/me");
    expect(r.json).toMatchObject({ workspaceRole: "member", isWorkspaceAdmin: false, isHubOperator: true, isAdmin: true });
  });
});
