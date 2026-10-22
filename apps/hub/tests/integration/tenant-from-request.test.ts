process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { signPlaneToken, TEST_ORG } from "../helpers/fake-plane";
import { rawSql } from "../../src/db/drizzle";
import { authMiddleware } from "../../src/auth/middleware";
import { enrollmentTokenRoutes } from "../../src/routes/enrollment-tokens";
import { nodeEnrollRoutes, nodeRoutes } from "../../src/routes/nodes";
import { stationRoutes } from "../../src/routes/stations";
import { adoptStations } from "../../src/services/station-registry";
import { tenantForOrg } from "../../src/auth/org-plane/tenant";

/**
 * Workspace authority spec, W5: the tenant always comes from the request.
 *
 * One person, member of two workspaces, so the per-user filters (which stay until step 4) cannot
 * hide a tenant leak: only the tenant separates workspace A's view from workspace B's. Before W5
 * `resolveTenantForUser` sent every root row to the bootstrap tenant (mapped to TEST_ORG), so a
 * node enrolled from workspace B landed in A.
 */

const ORG_B = "org_11111111111111111111";
let ME: string;
let TENANT_A: string;
let TENANT_B: string;
let nodeId: string;

const app = new Hono()
  .route("/public/nodes", nodeEnrollRoutes)
  .use("/api/*", authMiddleware)
  .route("/api/enrollment-tokens", enrollmentTokenRoutes)
  .route("/api/nodes", nodeRoutes)
  .route("/api", stationRoutes);

// An admin of both workspaces: enrolling is a workspace admin's act (workspace authority spec).
const bearer = async (org: string) => ({ Authorization: `Bearer ${await signPlaneToken({ sub: ME, org, orgRole: "admin" })}` });

beforeAll(async () => {
  await ensurePgMigrations();
  ME = (await createTestUser({ email: "two-workspaces@example.com" })).id;
  const a = await tenantForOrg({ org: TEST_ORG, ent: ["agentpod"] });
  const b = await tenantForOrg({ org: ORG_B, ent: ["agentpod"] });
  if (!a.ok || !b.ok) throw new Error("tenant resolution refused");
  TENANT_A = a.tenantId;
  TENANT_B = b.tenantId;
});

afterAll(async () => {
  await rawSql`DELETE FROM stations WHERE user_id = ${ME}`;
  await rawSql`DELETE FROM nodes WHERE user_id = ${ME}`;
  await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${ME}`;
});

describe("W5: the tenant comes from the request", () => {
  test("the two workspaces are two tenants", () => {
    expect(TENANT_B).not.toBe(TENANT_A);
  });

  test("an enrollment token minted from workspace B is stored in B's tenant", async () => {
    const res = await app.request("/api/enrollment-tokens", { method: "POST", headers: await bearer(ORG_B) });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const [row] = await rawSql`
      SELECT tenant_id FROM enrollment_tokens WHERE user_id = ${ME} ORDER BY created_at DESC LIMIT 1`;
    expect(row?.tenant_id).toBe(TENANT_B);

    const enrolled = await app.request("/public/nodes/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, hostInfo: { hostname: "ws-b-box", os: "linux", arch: "amd64", cpuCount: 2 } }),
    });
    expect(enrolled.status).toBe(200);
    nodeId = ((await enrolled.json()) as { nodeId: string }).nodeId;
  });

  test("the node enrolled from it, and its stations, are in B's tenant", async () => {
    const [node] = await rawSql`SELECT tenant_id FROM nodes WHERE id = ${nodeId}`;
    expect(node?.tenant_id).toBe(TENANT_B);

    await adoptStations(ME, nodeId, ["hermes:ws-b"], [
      {
        key: "hermes:ws-b", harness: "hermes", kind: "leaf", displayName: "ws-b", parentKey: null,
        workspacePath: null, capabilities: [], adopted: false,
      },
    ]);
    const [station] = await rawSql`SELECT tenant_id FROM stations WHERE node_id = ${nodeId}`;
    expect(station?.tenant_id).toBe(TENANT_B);
  });

  test("workspace B sees its node and stations; workspace A sees neither", async () => {
    const asB = (await (await app.request("/api/nodes", { headers: await bearer(ORG_B) })).json()) as Array<{ id: string }>;
    expect(asB.map((n) => n.id)).toContain(nodeId);
    const asA = (await (await app.request("/api/nodes", { headers: await bearer(TEST_ORG) })).json()) as Array<{ id: string }>;
    expect(asA.map((n) => n.id)).not.toContain(nodeId);

    const stB = (await (await app.request(`/api/nodes/${nodeId}/stations`, { headers: await bearer(ORG_B) })).json()) as unknown[];
    expect(stB).toHaveLength(1);
    const stA = await app.request(`/api/nodes/${nodeId}/stations`, { headers: await bearer(TEST_ORG) });
    expect(stA.status === 404 || ((await stA.json()) as unknown[]).length === 0).toBe(true);
  });
});
