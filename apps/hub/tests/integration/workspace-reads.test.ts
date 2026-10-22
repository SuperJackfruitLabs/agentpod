process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser, deleteTestUsers } from "../helpers/database";
import { signPlaneToken, TEST_ORG } from "../helpers/fake-plane";
import { rawSql } from "../../src/db/drizzle";
import { authMiddleware } from "../../src/auth/middleware";
import { tenantForOrg } from "../../src/auth/org-plane/tenant";
import { createNodeRoutes } from "../../src/routes/nodes";
import { stationRoutes } from "../../src/routes/stations";
import { runtimeRoutes } from "../../src/routes/runtimes";
import { stationAcpRoutes } from "../../src/routes/station-acp";
import { stationTranscriptionRoutes } from "../../src/routes/transcription-settings";
import { stationSpeechRoutes } from "../../src/routes/speech-settings";
import { stationAvatarRoutes } from "../../src/routes/station-avatar";
import { purposeRoutes } from "../../src/routes/purpose";
import { stationSetupRouter } from "../../src/routes/station-setup";
import { stationLifecycleRoutes } from "../../src/routes/station-lifecycle";
import { stationActivityRoutes } from "../../src/routes/station-activity";
import { stationCleanupRoutes } from "../../src/routes/station-cleanup";
import { stationWriteRoutes } from "../../src/routes/station-writes";
import { harnessConfigRoutes } from "../../src/routes/harness-config";
import { createStationGitIdentityRoutes } from "../../src/routes/station-git-identity";
import { createStationMatrixRoutes } from "../../src/routes/station-matrix";
import { createMcpProxyRoutes } from "../../src/routes/mcp-proxy";
import { createSkillManagementRoutes } from "../../src/routes/skill-management";
import type { TranscriptionSettings } from "../../src/services/transcription-settings";
import type { SpeechSettings } from "../../src/services/speech-settings";

/**
 * Workspace authority spec, step 4 (W4): a node, station or runtime belongs to the workspace, not
 * to the person who enrolled it. `user_id` is who enrolled or created it, and stops being a read
 * filter. Two things stay a person's own: ACP sessions (and their transcripts) and live-activity
 * tokens.
 *
 * Every request goes through the real `authMiddleware` with a real plane token, so the tenant and
 * role are the ones the token carried.
 */

const ORG_B = "org_33333333333333333333";
const RUN = crypto.randomUUID().slice(0, 8);
let ADMIN: string; // admin of A, enrolled everything
let MEMBER: string; // a second person in A, orgRole member
let OUTSIDER: string; // a member of B
let TENANT_A: string;
let TENANT_B: string;
const NODE = `node_wsr_${RUN}`;
const STATION = `station_wsr_${RUN}`;
const RUNTIME = `rt_wsr_${RUN}`;
const SESSION_ADMIN = `acps_wsr_admin_${RUN}`;
const SESSION_MEMBER = `acps_wsr_member_${RUN}`;

const stubTranscription = {
  getStationView: async () => ({ mode: "inherit" }),
  putStation: async () => ({ mode: "off" }),
} as unknown as TranscriptionSettings;
const stubSpeech = {
  getStationView: async () => ({ mode: "inherit" }),
  putStation: async () => ({ mode: "off" }),
} as unknown as SpeechSettings;

const app = new Hono()
  .use("/api/*", authMiddleware)
  .route("/api/nodes", createNodeRoutes({ request: async () => ({ ok: false, error: "offline" }) }))
  .route("/api/runtimes", runtimeRoutes)
  .route("/api", stationRoutes)
  .route("/api", stationAcpRoutes)
  .route("/api", stationTranscriptionRoutes({ settings: stubTranscription }))
  .route("/api", stationSpeechRoutes({ settings: stubSpeech }))
  .route("/api", stationAvatarRoutes({ brokerRequest: async () => ({ ok: false, error: "offline" }) }))
  .route("/api", purposeRoutes)
  .route("/api", stationSetupRouter)
  .route("/api", stationLifecycleRoutes)
  .route("/api", stationActivityRoutes)
  .route("/api", stationCleanupRoutes)
  .route("/api", stationWriteRoutes)
  .route("/api", harnessConfigRoutes)
  .route("/api", createStationGitIdentityRoutes({ forge: null }))
  .route(
    "/api",
    createStationMatrixRoutes({
      domain: "id.test",
      provisionStation: async () => {},
      credentials: { register: async () => ({ userId: "@x:id.test", accessToken: "t", deviceId: "d" }) as never },
    } as never),
  )
  .route("/api", createMcpProxyRoutes())
  .route("/api", createSkillManagementRoutes());

async function as(sub: string, claims: Record<string, unknown> = {}) {
  return { Authorization: `Bearer ${await signPlaneToken({ sub, ...claims })}`, "Content-Type": "application/json" };
}
const asMember = () => as(MEMBER, { orgRole: "member" });
const asAdmin = () => as(ADMIN, { orgRole: "admin" });
const asOutsider = () => as(OUTSIDER, { org: ORG_B, orgRole: "owner" });

async function call(headers: Record<string, string>, method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}

beforeAll(async () => {
  await ensurePgMigrations();
  ADMIN = (await createTestUser({ email: `wsr-admin-${RUN}@example.com` })).id;
  MEMBER = (await createTestUser({ email: `wsr-member-${RUN}@example.com` })).id;
  OUTSIDER = (await createTestUser({ email: `wsr-out-${RUN}@example.com` })).id;
  const a = await tenantForOrg({ org: TEST_ORG, ent: ["agentpod"] });
  const b = await tenantForOrg({ org: ORG_B, ent: ["agentpod"] });
  if (!a.ok || !b.ok) throw new Error("tenant resolution refused");
  TENANT_A = a.tenantId;
  TENANT_B = b.tenantId;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${TENANT_A}, ${ADMIN}, ${NODE}, 'h', 'linux', 'amd64', 2, 'offline', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
    VALUES (${STATION}, ${TENANT_A}, ${ADMIN}, ${NODE}, 'hermes', ${"hermes:" + STATION}, 'leaf', ${STATION}, '["acp"]'::jsonb, now(), now())`;
  await rawSql`
    INSERT INTO provisioned_runtimes (id, tenant_id, user_id, provider, status, name, node_id, created_at)
    VALUES (${RUNTIME}, ${TENANT_A}, ${ADMIN}, 'docker', 'online', ${RUNTIME}, ${NODE}, now())`;
  for (const [id, user] of [
    [SESSION_ADMIN, ADMIN],
    [SESSION_MEMBER, MEMBER],
  ] as const) {
    await rawSql`
      INSERT INTO acp_sessions (id, tenant_id, station_id, user_id, mode, status, created_at, last_event_at)
      VALUES (${id}, ${TENANT_A}, ${STATION}, ${user}, 'ask', 'ended', now(), now())`;
  }
});

afterAll(async () => {
  await rawSql`DELETE FROM acp_sessions WHERE id IN (${SESSION_ADMIN}, ${SESSION_MEMBER})`;
  await rawSql`DELETE FROM provisioned_runtimes WHERE id = ${RUNTIME}`;
  await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await deleteTestUsers([ADMIN, MEMBER, OUTSIDER]);
  void TENANT_B;
});

describe("W4: a second member of the workspace sees the workspace's fleet", () => {
  test("nodes", async () => {
    const r = await call(await asMember(), "GET", "/api/nodes");
    expect(r.status).toBe(200);
    expect(r.json.map((n: any) => n.id)).toContain(NODE);
  });

  test("stations on a node, and the node's detail routes find the node", async () => {
    const r = await call(await asMember(), "GET", `/api/nodes/${NODE}/stations`);
    expect(r.status).toBe(200);
    expect(r.json.map((s: any) => s.id)).toEqual([STATION]);
  });

  test("runtimes", async () => {
    const r = await call(await asMember(), "GET", "/api/runtimes");
    expect(r.status).toBe(200);
    expect(r.json.map((x: any) => x.id)).toContain(RUNTIME);
  });

  test("per-station reads (setup, activity, transcription) answer the member", async () => {
    const h = await asMember();
    expect((await call(h, "GET", `/api/stations/${STATION}/setup`)).status).toBe(200);
    expect((await call(h, "GET", `/api/stations/${STATION}/activity`)).status).toBe(200);
    expect((await call(h, "GET", `/api/stations/${STATION}/transcription`)).status).toBe(200);
  });
});

describe("W4: a member of another workspace sees none of it", () => {
  test("nodes", async () => {
    const r = await call(await asOutsider(), "GET", "/api/nodes");
    expect(r.status).toBe(200);
    expect(r.json.map((n: any) => n.id)).not.toContain(NODE);
  });

  test("stations", async () => {
    const r = await call(await asOutsider(), "GET", `/api/nodes/${NODE}/stations`);
    expect(r.status).toBe(404);
  });

  test("runtimes", async () => {
    const r = await call(await asOutsider(), "GET", "/api/runtimes");
    expect(r.status).toBe(200);
    expect(r.json.map((x: any) => x.id)).not.toContain(RUNTIME);
  });

  test("per-station reads and writes", async () => {
    const h = await asOutsider();
    expect((await call(h, "GET", `/api/stations/${STATION}/setup`)).status).toBe(404);
    expect((await call(h, "GET", `/api/stations/${STATION}/transcription`)).status).toBe(404);
    expect((await call(h, "PUT", `/api/stations/${STATION}/transcription`, { mode: "off" })).status).toBe(404);
    expect((await call(h, "PUT", `/api/stations/${STATION}/purpose`, { purpose: "x" })).status).toBe(404);
    expect((await call(h, "DELETE", `/api/runtimes/${RUNTIME}`)).status).toBe(404);
    expect((await call(h, "POST", `/api/nodes/${NODE}/update`)).status).toBe(404);
    expect((await call(h, "GET", `/api/stations/${STATION}/activity`)).status).toBe(404);
  });
});

describe("W4: ACP sessions stay a person's own inside one workspace", () => {
  test("the member's session list holds only the member's session", async () => {
    const r = await call(await asMember(), "GET", `/api/stations/${STATION}/acp/sessions`);
    expect(r.status).toBe(200);
    const ids = r.json.map((s: any) => s.id);
    expect(ids).toContain(SESSION_MEMBER);
    expect(ids).not.toContain(SESSION_ADMIN);
  });

  test("the admin's list does not hold the member's session either", async () => {
    const r = await call(await asAdmin(), "GET", `/api/stations/${STATION}/acp/sessions`);
    expect(r.status).toBe(200);
    const ids = r.json.map((s: any) => s.id);
    expect(ids).toContain(SESSION_ADMIN);
    expect(ids).not.toContain(SESSION_MEMBER);
  });

  test("the member cannot end the admin's session", async () => {
    const r = await call(await asMember(), "DELETE", `/api/acp/sessions/${SESSION_ADMIN}`);
    expect(r.status).toBe(404);
    const [row] = await rawSql`SELECT ended_reason FROM acp_sessions WHERE id = ${SESSION_ADMIN}`;
    expect(row?.ended_reason ?? null).toBeNull();
  });
});

/**
 * Configuration that changes a station for everyone in the workspace is a workspace admin's
 * (spec W1: a member may see and use stations; an admin may change them).
 */
const STATION_CONFIG: Array<[string, () => string, unknown]> = [
  ["PUT", () => `/api/stations/${STATION}/transcription`, { mode: "off" }],
  ["POST", () => `/api/stations/${STATION}/transcription/apply`, undefined],
  ["PUT", () => `/api/stations/${STATION}/speech`, { mode: "off" }],
  ["POST", () => `/api/stations/${STATION}/speech/apply`, undefined],
  ["POST", () => `/api/stations/${STATION}/matrix-avatar`, { path: "avatar.png" }],
  ["PUT", () => `/api/stations/${STATION}/purpose`, { purpose: "ops" }],
  ["PUT", () => `/api/nodes/${NODE}/purpose`, { purpose: "ops" }],
  [
    "POST",
    () => `/api/stations/${STATION}/setup`,
    { requestId: crypto.randomUUID(), agent: { kind: "existing", principalId: "prn_00000000000000000000" }, dispatch: "none" },
  ],
  ["POST", () => `/api/stations/${STATION}/setup/matrix`, { principalId: "prn_00000000000000000000" }],
  ["DELETE", () => `/api/stations/${STATION}`, undefined],
  ["DELETE", () => `/api/runtimes/${RUNTIME}`, undefined],
  ["POST", () => `/api/runtimes/${RUNTIME}/start`, undefined],
  ["POST", () => `/api/runtimes/${RUNTIME}/stop`, undefined],
  ["POST", () => `/api/nodes/${NODE}/stations/adopt`, { keys: ["hermes:x"] }],
  ["POST", () => `/api/nodes/${NODE}/update`, undefined],
  ["POST", () => "/api/runtimes", { provider: "docker", name: "wsr" }],
  ["POST", () => `/api/stations/${STATION}/lifecycle`, { action: "restart" }],
  ["POST", () => `/api/stations/${STATION}/cleanup/plan`, undefined],
  ["POST", () => `/api/stations/${STATION}/cleanup/apply`, { paths: ["x"] }],
  ["POST", () => `/api/stations/${STATION}/fs/write`, { path: "x", content: "y", encoding: "utf8" }],
  ["POST", () => `/api/stations/${STATION}/fs/mkdir`, { path: "x" }],
  ["POST", () => `/api/stations/${STATION}/fs/move`, { from: "x", to: "y" }],
  ["POST", () => `/api/stations/${STATION}/fs/delete`, { path: "x" }],
  ["POST", () => `/api/stations/${STATION}/config/plan`, { settings: [{ settingId: "s" }] }],
  ["POST", () => `/api/stations/${STATION}/config/apply`, { operationId: "o", planDigest: "d" }],
  ["POST", () => `/api/stations/${STATION}/git-identity`, undefined],
  ["DELETE", () => `/api/stations/${STATION}/git-identity`, undefined],
  ["POST", () => `/api/stations/${STATION}/matrix/identity`, undefined],
  ["POST", () => `/api/stations/${STATION}/matrix/credentials`, undefined],
  ["POST", () => `/api/stations/${STATION}/matrix/authorize-move`, undefined],
  ["POST", () => "/api/fleet/mcp-proxy", { action: "enable", stationIds: [STATION] }],
  ["POST", () => "/api/fleet/mcp-proxy/rotate", { stationIds: [STATION] }],
  ["POST", () => `/api/stations/${STATION}/skills/plan`, {}],
  ["POST", () => `/api/stations/${STATION}/plugins/plan`, {}],
  ["POST", () => "/api/skills/catalog/releases", {}],
  ["POST", () => "/api/skills/catalog/cohorts", {}],
  ["DELETE", () => "/api/skills/artifacts/x", undefined],
];

describe("per-station configuration is a workspace admin's", () => {
  for (const [method, path, body] of STATION_CONFIG) {
    test(`member: ${method} ${path()} → 403 workspace_admin_required`, async () => {
      const r = await call(await asMember(), method, path(), body);
      expect(r.status).toBe(403);
      expect(r.json?.error).toBe("workspace_admin_required");
    });
  }

  test("the station and runtime are still there after every refused write", async () => {
    const [s] = await rawSql`SELECT purpose FROM stations WHERE id = ${STATION}`;
    expect(s).toBeDefined();
    expect(s!.purpose ?? null).toBeNull();
    const [rt] = await rawSql`SELECT status FROM provisioned_runtimes WHERE id = ${RUNTIME}`;
    expect(rt!.status).toBe("online");
  });

  test("admin: transcription and speech saves go through", async () => {
    const h = await asAdmin();
    expect((await call(h, "PUT", `/api/stations/${STATION}/transcription`, { mode: "off" })).status).toBe(200);
    expect((await call(h, "PUT", `/api/stations/${STATION}/speech`, { mode: "off" })).status).toBe(200);
  });

  test("admin: purpose is set", async () => {
    const r = await call(await asAdmin(), "PUT", `/api/stations/${STATION}/purpose`, { purpose: "ops" });
    expect(r.status).toBe(200);
    expect(r.json.purpose).toBe("ops");
    await rawSql`UPDATE stations SET purpose = NULL WHERE id = ${STATION}`;
  });

  test("admin: avatar passes the gate (no bridge on this hub → 503, not 403/404)", async () => {
    const r = await call(await asAdmin(), "POST", `/api/stations/${STATION}/matrix-avatar`, { path: "avatar.png" });
    expect(r.status).toBe(503);
  });

  test("an admin who did not enrol the node can still change its purpose", async () => {
    const other = (await createTestUser({ email: `wsr-admin2-${RUN}@example.com` })).id;
    try {
      const r = await call(await as(other, { orgRole: "owner" }), "PUT", `/api/nodes/${NODE}/purpose`, { purpose: null });
      expect(r.status).toBe(200);
    } finally {
      await deleteTestUsers([other]);
    }
  });
});
