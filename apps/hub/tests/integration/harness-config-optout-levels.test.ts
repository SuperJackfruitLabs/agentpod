/**
 * Integration Test: the opt-out register has two levels, and no duplicates
 * at either one.
 *
 * `harness_config_opt_out` shipped with `station_key NOT NULL` and
 * `unique(tenant_id, station_key, setting_id)` — station-level only. This
 * task makes `station_key` nullable so a row can instead name a `node_id`
 * (D9: there is no fleet level here — `fleet config unset` already covers
 * that case), while keeping duplicates impossible at both levels.
 *
 * The trap: Postgres treats NULL as distinct from NULL, so the moment
 * `station_key` can be null, the shipped unique constraint stops catching
 * duplicate NODE-level rows — two rows with `station_key IS NULL` for the
 * same `(tenant, node, setting)` both insert under a plain unique
 * constraint. This exact defect hit `declared_harness_config` in an earlier
 * plan and needed a partial unique index (`declared_cfg_fleet`); this file's
 * third test is the regression test for the same defect here.
 *
 * Uses the local Docker test-postgres (localhost:5434).
 * DATABASE_URL must be set before any src/ modules are imported.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import type { DetectedStation } from "@agentpod/contract";

// src/ imports — DB URL is already set above
import { rawSql } from "../../src/db/drizzle";
import { createTestUser } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { waitForNodeOnline } from "../helpers/wait";
import { setOptOut, clearOptOut, resolveOptOuts, listOptOuts } from "../../src/services/harness-config";
import { mintEnrollmentToken, enrollNode } from "../../src/services/enrollment";
import { adoptStations } from "../../src/services/station-registry";
import { createPrincipal } from "../../src/services/principals";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/tenant-scope";
import { gatewayRoutes } from "../../src/routes/gateway";
import { harnessConfigRoutes } from "../../src/routes/harness-config";
import { websocket } from "../../src/ws";
import type { AuthUser } from "../../src/auth/middleware";

// ─── Constants ────────────────────────────────────────────────────────────────

// A real AgentPod tenant id (`fleet_<20 hex>`) — "tnt_test" fails the
// `tenants_id_is_agentpod_fleet` CHECK constraint at insert.
const TENANT_ID = "fleet_c0f9014400000000001a";
// A second tenant, used only by the cross-tenant isolation test below —
// never shares a row with TENANT_ID.
const TENANT_ID_2 = "fleet_c0f9014400000000002b";
const TEST_USER = "test-user-cfgoptlvl-001";
const SETTING = "hermes.approvals.timeout";

function rid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function insertOptOut(row: {
  stationKey?: string | null;
  nodeId?: string | null;
  settingId?: string;
  id?: string;
}): Promise<string> {
  const id = row.id ?? rid("cfgoo");
  await rawSql`
    INSERT INTO harness_config_opt_out
      (id, tenant_id, station_key, node_id, setting_id, opted_out, opted_out_by)
    VALUES
      (${id}, ${TENANT_ID}, ${row.stationKey ?? null}, ${row.nodeId ?? null},
       ${row.settingId ?? SETTING}, true, ${TEST_USER})
  `;
  return id;
}

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await rawSql`
    INSERT INTO tenants (id, name) VALUES (${TENANT_ID}, 'Opt-out levels test')
    ON CONFLICT (id) DO NOTHING
  `;
  await rawSql`
    INSERT INTO tenants (id, name) VALUES (${TENANT_ID_2}, 'Opt-out levels test (other tenant)')
    ON CONFLICT (id) DO NOTHING
  `;
  await rawSql`
    INSERT INTO "user" (id, email, name, email_verified, role, created_at, updated_at)
    VALUES (${TEST_USER}, 'cfgoptlvl-test@example.com', 'Opt-out Levels Test User', true, 'user', now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM applied_harness_config WHERE tenant_id IN (${TENANT_ID}, ${TENANT_ID_2})`;
    await rawSql`DELETE FROM harness_config_opt_out  WHERE tenant_id IN (${TENANT_ID}, ${TENANT_ID_2})`;
    await rawSql`DELETE FROM stations                WHERE tenant_id = ${TENANT_ID}`;
    await rawSql`DELETE FROM nodes                    WHERE tenant_id = ${TENANT_ID}`;
    await rawSql`DELETE FROM "user"                  WHERE id = ${TEST_USER}`;
    await rawSql`DELETE FROM tenants                  WHERE id IN (${TENANT_ID}, ${TENANT_ID_2})`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Helpers for the FK test ───────────────────────────────────────────────────

async function createStationFixture(suffix: string): Promise<{ stationId: string; nodeId: string }> {
  const nodeId = rid(`node-${suffix}`);
  const stationId = rid(`stn-${suffix}`);
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, secret_hash)
    VALUES (${nodeId}, ${TENANT_ID}, ${TEST_USER}, ${"node-" + suffix}, ${"host-" + suffix}, 'linux', 'amd64', 'fake-hash')
  `;
  await rawSql`
    INSERT INTO stations
      (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name)
    VALUES
      (${stationId}, ${TENANT_ID}, ${TEST_USER}, ${nodeId}, 'hermes', ${"station-key-" + suffix}, 'leaf', ${"Station " + suffix})
  `;
  return { stationId, nodeId };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("the opt-out register has two levels and no duplicates", () => {
  test("a station row and a node row for the same setting coexist", async () => {
    const stationKey = "coexist-station";
    const nodeId = "coexist-node";

    await insertOptOut({ stationKey, nodeId: null, settingId: SETTING });
    await insertOptOut({ stationKey: null, nodeId, settingId: SETTING });

    const rows = await rawSql`
      SELECT station_key, node_id FROM harness_config_opt_out
      WHERE tenant_id = ${TENANT_ID} AND setting_id = ${SETTING}
        AND (station_key = ${stationKey} OR node_id = ${nodeId})
    `;
    expect(rows.length).toBe(2);
  });

  test("two station rows for the same (tenant, station, setting) cannot both exist", async () => {
    const stationKey = "dup-station";
    await insertOptOut({ stationKey, nodeId: null, settingId: SETTING });

    await expect(insertOptOut({ stationKey, nodeId: null, settingId: SETTING })).rejects.toThrow();
  });

  test("two NODE rows for the same (tenant, node, setting) cannot both exist", async () => {
    // THE REGRESSION THIS TASK EXISTS TO PREVENT. With station_key NULL on
    // both rows, a plain unique constraint over nullable columns does not
    // conflict and both insert.
    const nodeId = "dup-node";
    await insertOptOut({ stationKey: null, nodeId, settingId: SETTING });

    await expect(insertOptOut({ stationKey: null, nodeId, settingId: SETTING })).rejects.toThrow();
  });

  test("a row with neither station nor node is refused", async () => {
    await expect(insertOptOut({ stationKey: null, nodeId: null, settingId: SETTING })).rejects.toThrow();
  });

  test("a row with BOTH station and node is refused", async () => {
    await expect(
      insertOptOut({ stationKey: "both-station", nodeId: "both-node", settingId: SETTING }),
    ).rejects.toThrow();
  });

  test("deleting a station row leaves the node row untouched", async () => {
    const stationKey = "leave-alone-station";
    const nodeId = "leave-alone-node";
    const stationRowId = await insertOptOut({ stationKey, nodeId: null, settingId: SETTING });
    const nodeRowId = await insertOptOut({ stationKey: null, nodeId, settingId: SETTING });

    await rawSql`DELETE FROM harness_config_opt_out WHERE id = ${stationRowId}`;

    const remaining = await rawSql`
      SELECT id FROM harness_config_opt_out WHERE id = ${nodeRowId}
    `;
    expect(remaining.length).toBe(1);

    const gone = await rawSql`
      SELECT id FROM harness_config_opt_out WHERE id = ${stationRowId}
    `;
    expect(gone.length).toBe(0);
  });

  test("deleting a station removes its applied_harness_config rows (FK cascade)", async () => {
    const { stationId, nodeId } = await createStationFixture("cascade");

    await rawSql`
      INSERT INTO applied_harness_config (id, tenant_id, station_id, setting_id, value)
      VALUES (${rid("acfg")}, ${TENANT_ID}, ${stationId}, ${SETTING}, '"900"'::jsonb)
    `;

    const before = await rawSql`SELECT id FROM applied_harness_config WHERE station_id = ${stationId}`;
    expect(before.length).toBe(1);

    await rawSql`DELETE FROM stations WHERE id = ${stationId}`;

    const after = await rawSql`SELECT id FROM applied_harness_config WHERE station_id = ${stationId}`;
    expect(after.length).toBe(0);

    await rawSql`DELETE FROM nodes WHERE id = ${nodeId}`;
  });
});

// ─── resolveOptOuts: most-specific-first ──────────────────────────────────────

describe("resolveOptOuts resolves most-specific-first", () => {
  test("a station row optedOut=true exempts the setting", async () => {
    const stationKey = "resolve-station-true";
    const nodeId = "resolve-node-for-station-true";

    await setOptOut({ tenantId: TENANT_ID, settingId: SETTING, optedOut: true, stationKey, optedOutBy: TEST_USER });

    const out = await resolveOptOuts(TENANT_ID, stationKey, nodeId);
    expect(out.has(SETTING)).toBe(true);
  });

  test("a node row optedOut=true exempts every station on that node", async () => {
    const nodeId = "resolve-node-true";

    await setOptOut({ tenantId: TENANT_ID, settingId: SETTING, optedOut: true, nodeId, optedOutBy: TEST_USER });

    const stationA = await resolveOptOuts(TENANT_ID, "resolve-station-a-on-node", nodeId);
    const stationB = await resolveOptOuts(TENANT_ID, "resolve-station-b-on-node", nodeId);
    expect(stationA.has(SETTING)).toBe(true);
    expect(stationB.has(SETTING)).toBe(true);
  });

  test("a station row optedOut=FALSE overrides a node row optedOut=true", async () => {
    const stationKey = "resolve-station-override";
    const nodeId = "resolve-node-overridden";

    await setOptOut({ tenantId: TENANT_ID, settingId: SETTING, optedOut: true, nodeId, optedOutBy: TEST_USER });
    await setOptOut({ tenantId: TENANT_ID, settingId: SETTING, optedOut: false, stationKey, optedOutBy: TEST_USER });

    const out = await resolveOptOuts(TENANT_ID, stationKey, nodeId);
    expect(out.has(SETTING)).toBe(false);

    // A sibling station on the same node, with no station-level row of its
    // own, is still exempt — the override is specific to THIS station, not
    // the node's rule itself.
    const sibling = await resolveOptOuts(TENANT_ID, "resolve-station-sibling", nodeId);
    expect(sibling.has(SETTING)).toBe(true);
  });

  test("no row at either level means not exempt", async () => {
    const out = await resolveOptOuts(TENANT_ID, "resolve-station-none", "resolve-node-none");
    expect(out.has(SETTING)).toBe(false);
  });

  test("deleting the station row falls back to the node row (absence is not false)", async () => {
    const stationKey = "resolve-station-fallback";
    const nodeId = "resolve-node-fallback";

    await setOptOut({ tenantId: TENANT_ID, settingId: SETTING, optedOut: true, nodeId, optedOutBy: TEST_USER });
    await setOptOut({ tenantId: TENANT_ID, settingId: SETTING, optedOut: false, stationKey, optedOutBy: TEST_USER });
    expect((await resolveOptOuts(TENANT_ID, stationKey, nodeId)).has(SETTING)).toBe(false);

    const cleared = await clearOptOut({ tenantId: TENANT_ID, settingId: SETTING, stationKey });
    expect(cleared.cleared).toBe(true);

    // The station's "not exempt" was deleted, not flipped to true — the
    // node's rule is what the station now falls back to.
    expect((await resolveOptOuts(TENANT_ID, stationKey, nodeId)).has(SETTING)).toBe(true);
  });

  test("resolveOptOuts returns only ids for THIS station and THIS node, never another tenant's", async () => {
    const stationKey = "resolve-station-tenant-isolation";
    const nodeId = "resolve-node-tenant-isolation";

    await setOptOut({ tenantId: TENANT_ID_2, settingId: SETTING, optedOut: true, stationKey, optedOutBy: TEST_USER });

    const out = await resolveOptOuts(TENANT_ID, stationKey, nodeId);
    expect(out.has(SETTING)).toBe(false);
  });

  test("setOptOut twice for the same level updates rather than duplicating", async () => {
    const stationKey = "resolve-station-upsert";

    await setOptOut({
      tenantId: TENANT_ID, settingId: SETTING, optedOut: true, stationKey, optedOutBy: TEST_USER, reason: "first",
    });
    await setOptOut({
      tenantId: TENANT_ID, settingId: SETTING, optedOut: true, stationKey, optedOutBy: TEST_USER, reason: "second",
    });

    const rows = await listOptOuts(TENANT_ID, { stationKey });
    const matching = rows.filter((r) => r.settingId === SETTING);
    expect(matching.length).toBe(1);
    expect(matching[0]?.reason).toBe("second");
  });

  test("clearOptOut reports cleared:false when there was nothing to clear", async () => {
    const result = await clearOptOut({
      tenantId: TENANT_ID, settingId: SETTING, stationKey: "resolve-station-nothing-to-clear",
    });
    expect(result.cleared).toBe(false);
  });
});

// ─── Task 4: the routes — PUT/DELETE/GET /api/fleet/config/opt-out ───────────
//
// `setOptOut`/`clearOptOut`/`listOptOuts` were reachable only from tests
// before this. These routes are what makes the two-level register usable
// from outside the hub: `fleet config opt-out` (the CLI, Task 5) and any
// other operator-facing surface.
//
// Enrollment/`adoptStations` always resolve to `BOOTSTRAP_TENANT_ID`
// (`src/auth/tenant.ts`), never the `TENANT_ID`/`TENANT_ID_2` fixtures
// above — so this block's fixture app authenticates every caller into
// `BOOTSTRAP_TENANT_ID`, the same pattern `harness-config-apply.test.ts`
// and `harness-config-optout-write.test.ts` use.

const ROUTE_SETTING_A = "hermes.approvals.timeout";
const ROUTE_SETTING_B = "hermes.approvals.mode";
const ROUTE_REGISTRY = [
  { id: ROUTE_SETTING_A, harness: "hermes", scope: "profile", policy: "reconcilable", restartToTakeEffect: false },
  { id: ROUTE_SETTING_B, harness: "hermes", scope: "profile", policy: "reconcilable", restartToTakeEffect: false },
];

const ROUTE_USER = "test-user-cfgoptlvl-route-001";
const ROUTE_AGENT_USER = "test-user-cfgoptlvl-route-agent-001";

const routeTestApp = new Hono()
  .use("/api/*", async (c, next) => {
    const userId = c.req.header("X-Test-User-Id");
    if (userId && userId !== "anonymous") {
      c.set("user", { id: userId, authType: "api_key", tenantId: BOOTSTRAP_TENANT_ID } satisfies AuthUser);
    } else {
      c.set("user", { id: "anonymous", authType: "api_key", tenantId: BOOTSTRAP_TENANT_ID } satisfies AuthUser);
    }
    return next();
  })
  .route("/public/nodes", gatewayRoutes)
  .route("/api", harnessConfigRoutes);

async function enrollRouteNode(hostname: string) {
  const { token } = await mintEnrollmentToken(ROUTE_USER);
  return enrollNode(token, { hostname, os: "linux", arch: "amd64", cpuCount: 2 });
}

function routeDetectedFor(stationKey: string): DetectedStation[] {
  return [
    {
      key: stationKey,
      harness: "hermes",
      kind: "leaf",
      displayName: "Opt-out Route Test",
      parentKey: null,
      workspacePath: `/workspace/${stationKey}`,
      capabilities: ["health", "config.manage"],
      matrixId: null,
      adopted: false,
    },
  ];
}

/** A fake node that answers only `config.settings` — every opt-out route's write path needs the live registry, nothing else. */
async function connectRouteFakeNode(
  serverPort: number,
  nodeId: string,
  nodeSecret: string,
): Promise<{ ws: WebSocket; asked: string[] }> {
  const asked: string[] = [];
  const ws = new WebSocket(`ws://localhost:${serverPort}/public/nodes/gateway`, {
    headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
  } as RequestInit & { headers: Record<string, string> });

  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("Node WS connection error"));
  });

  ws.onmessage = (e) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.type !== "req") return;
    const verb = msg.verb as string;
    asked.push(verb);
    if (verb === "config.settings") {
      ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: { settings: ROUTE_REGISTRY } }));
      return;
    }
  };

  await waitForNodeOnline(nodeId);
  return { ws, asked };
}

function routeAppFetch(
  baseUrl: string,
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["X-Test-User-Id"] = opts.token;
  return fetch(`${baseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function setUpRouteStation(hostname: string, stationKey: string) {
  const { nodeId, nodeSecret } = await enrollRouteNode(hostname);
  const [station] = await adoptStations(ROUTE_USER, nodeId, [stationKey], routeDetectedFor(stationKey));
  if (!station) throw new Error("station adoption failed");
  return { station, nodeId, nodeSecret };
}

describe("the opt-out routes: PUT/DELETE/GET /api/fleet/config/opt-out", () => {
  let agentPrincipalId: string;

  beforeAll(async () => {
    await createTestUser({ id: ROUTE_USER, email: "cfgoptlvl-route@example.com", name: "Opt-out Route Test User" });
    await createTestUser({
      id: ROUTE_AGENT_USER,
      email: "cfgoptlvl-route-agent@example.com",
      name: "Opt-out Route Agent User",
    });
    agentPrincipalId = await createPrincipal({
      kind: "agent",
      handle: "cfgoptlvl-route-test-agent",
      userId: ROUTE_AGENT_USER,
    });
  });

  afterAll(async () => {
    try {
      await rawSql`DELETE FROM applied_harness_config WHERE station_id IN (SELECT id FROM stations WHERE user_id IN (${ROUTE_USER}, ${ROUTE_AGENT_USER}))`;
      await rawSql`DELETE FROM harness_config_opt_out  WHERE opted_out_by IN (${ROUTE_USER}, ${ROUTE_AGENT_USER})`;
      await rawSql`DELETE FROM principal_identities    WHERE principal_id = ${agentPrincipalId}`;
      await rawSql`DELETE FROM principals              WHERE id = ${agentPrincipalId}`;
      await rawSql`DELETE FROM station_audit           WHERE user_id IN (${ROUTE_USER}, ${ROUTE_AGENT_USER})`;
      await rawSql`DELETE FROM stations                WHERE user_id IN (${ROUTE_USER}, ${ROUTE_AGENT_USER})`;
      await rawSql`DELETE FROM nodes                   WHERE user_id IN (${ROUTE_USER}, ${ROUTE_AGENT_USER})`;
      await rawSql`DELETE FROM enrollment_tokens        WHERE user_id IN (${ROUTE_USER}, ${ROUTE_AGENT_USER})`;
      await rawSql`DELETE FROM "user"                  WHERE id IN (${ROUTE_USER}, ${ROUTE_AGENT_USER})`;
    } catch {
      // Ignore cleanup errors
    }
  });

  test(
    "PUT creates a station-level opt-out, GET lists it, DELETE removes it",
    async () => {
      const server = Bun.serve({ fetch: routeTestApp.fetch, websocket, port: 0 });
      const baseUrl = `http://localhost:${server.port}`;
      try {
        const stationKey = "cfgoptlvl-route-verbs-station";
        const { nodeId, nodeSecret } = await setUpRouteStation("cfgoptlvl-route-verbs-host", stationKey);
        const fake = await connectRouteFakeNode(server.port!, nodeId, nodeSecret);

        const putRes = await routeAppFetch(baseUrl, "/api/fleet/config/opt-out", {
          method: "PUT",
          token: ROUTE_USER,
          body: { settingId: ROUTE_SETTING_A, optedOut: true, stationKey, reason: "testing" },
        });
        expect(putRes.status).toBe(204);

        const getRes = await routeAppFetch(baseUrl, `/api/fleet/config/opt-out?stationKey=${stationKey}`, {
          token: ROUTE_USER,
        });
        expect(getRes.status).toBe(200);
        const rows = (await getRes.json()) as Array<{ settingId: string; optedOut: boolean; stationKey: string | null }>;
        expect(rows.length).toBe(1);
        expect(rows[0]?.settingId).toBe(ROUTE_SETTING_A);
        expect(rows[0]?.optedOut).toBe(true);

        const delRes = await routeAppFetch(baseUrl, "/api/fleet/config/opt-out", {
          method: "DELETE",
          token: ROUTE_USER,
          body: { settingId: ROUTE_SETTING_A, stationKey },
        });
        expect(delRes.status).toBe(200);
        const delBody = (await delRes.json()) as { cleared: boolean };
        expect(delBody.cleared).toBe(true);

        const getAfter = await routeAppFetch(baseUrl, `/api/fleet/config/opt-out?stationKey=${stationKey}`, {
          token: ROUTE_USER,
        });
        const afterRows = (await getAfter.json()) as unknown[];
        expect(afterRows.length).toBe(0);

        fake.ws.close();
        await new Promise((r) => setTimeout(r, 100));
      } finally {
        server.stop(true);
      }
    },
    20_000,
  );

  test(
    "PUT works at node level too, filtered by ?nodeId=",
    async () => {
      const server = Bun.serve({ fetch: routeTestApp.fetch, websocket, port: 0 });
      const baseUrl = `http://localhost:${server.port}`;
      try {
        const stationKey = "cfgoptlvl-route-node-station";
        const { nodeId, nodeSecret } = await setUpRouteStation("cfgoptlvl-route-node-host", stationKey);
        const fake = await connectRouteFakeNode(server.port!, nodeId, nodeSecret);

        const putRes = await routeAppFetch(baseUrl, "/api/fleet/config/opt-out", {
          method: "PUT",
          token: ROUTE_USER,
          body: { settingId: ROUTE_SETTING_A, optedOut: true, nodeId },
        });
        expect(putRes.status).toBe(204);

        const getRes = await routeAppFetch(baseUrl, `/api/fleet/config/opt-out?nodeId=${nodeId}`, {
          token: ROUTE_USER,
        });
        expect(getRes.status).toBe(200);
        const rows = (await getRes.json()) as Array<{ settingId: string; nodeId: string | null }>;
        expect(rows.length).toBe(1);
        expect(rows[0]?.nodeId).toBe(nodeId);

        fake.ws.close();
        await new Promise((r) => setTimeout(r, 100));
      } finally {
        server.stop(true);
      }
    },
    20_000,
  );

  test("PUT naming both stationKey and nodeId is refused with 400", async () => {
    const server = Bun.serve({ fetch: routeTestApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const res = await routeAppFetch(baseUrl, "/api/fleet/config/opt-out", {
        method: "PUT",
        token: ROUTE_USER,
        body: { settingId: ROUTE_SETTING_A, optedOut: true, stationKey: "whatever-station", nodeId: "whatever-node" },
      });
      expect(res.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });

  test("PUT naming neither stationKey nor nodeId is refused with 400", async () => {
    const server = Bun.serve({ fetch: routeTestApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const res = await routeAppFetch(baseUrl, "/api/fleet/config/opt-out", {
        method: "PUT",
        token: ROUTE_USER,
        body: { settingId: ROUTE_SETTING_A, optedOut: true },
      });
      expect(res.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });

  test("DELETE naming both or neither level is refused with 400", async () => {
    const server = Bun.serve({ fetch: routeTestApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const both = await routeAppFetch(baseUrl, "/api/fleet/config/opt-out", {
        method: "DELETE",
        token: ROUTE_USER,
        body: { settingId: ROUTE_SETTING_A, stationKey: "a-station", nodeId: "a-node" },
      });
      expect(both.status).toBe(400);

      const neither = await routeAppFetch(baseUrl, "/api/fleet/config/opt-out", {
        method: "DELETE",
        token: ROUTE_USER,
        body: { settingId: ROUTE_SETTING_A },
      });
      expect(neither.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });

  test(
    "PUT with an unregistered setting id is refused before any write",
    async () => {
      const server = Bun.serve({ fetch: routeTestApp.fetch, websocket, port: 0 });
      const baseUrl = `http://localhost:${server.port}`;
      try {
        const stationKey = "cfgoptlvl-route-unknown-station";
        const { nodeId, nodeSecret } = await setUpRouteStation("cfgoptlvl-route-unknown-host", stationKey);
        const fake = await connectRouteFakeNode(server.port!, nodeId, nodeSecret);

        const res = await routeAppFetch(baseUrl, "/api/fleet/config/opt-out", {
          method: "PUT",
          token: ROUTE_USER,
          body: { settingId: "hermes.not_a_real_setting", optedOut: true, stationKey },
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("UNKNOWN_SETTING");

        const rows = await listOptOuts(BOOTSTRAP_TENANT_ID, { stationKey });
        expect(rows.length).toBe(0);

        fake.ws.close();
        await new Promise((r) => setTimeout(r, 100));
      } finally {
        server.stop(true);
      }
    },
    20_000,
  );

  test("another tenant's station is invisible to PUT", async () => {
    const server = Bun.serve({ fetch: routeTestApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const foreignNodeId = `node_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const foreignStationKey = "cfgoptlvl-route-foreign-station";
      await rawSql`
        INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, secret_hash)
        VALUES (${foreignNodeId}, ${TENANT_ID_2}, ${ROUTE_USER}, 'cfgoptlvl-foreign-host', 'cfgoptlvl-foreign-host', 'linux', 'amd64', 'unused')`;
      await rawSql`
        INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, workspace_path, capabilities)
        VALUES (${`station_${crypto.randomUUID()}`}, ${TENANT_ID_2}, ${ROUTE_USER}, ${foreignNodeId}, 'hermes', ${foreignStationKey}, 'leaf',
                'Opt-out Route Foreign Test', ${"/workspace/" + foreignStationKey}, ${JSON.stringify(["health", "config.manage"])}::jsonb)`;

      const res = await routeAppFetch(baseUrl, "/api/fleet/config/opt-out", {
        method: "PUT",
        token: ROUTE_USER,
        body: { settingId: ROUTE_SETTING_A, optedOut: true, stationKey: foreignStationKey },
      });
      expect(res.status).toBe(400);

      const rows = await listOptOuts(BOOTSTRAP_TENANT_ID, { stationKey: foreignStationKey });
      expect(rows.length).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("a non-human principal is refused on PUT, DELETE and GET", async () => {
    const server = Bun.serve({ fetch: routeTestApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const putRes = await routeAppFetch(baseUrl, "/api/fleet/config/opt-out", {
        method: "PUT",
        token: ROUTE_AGENT_USER,
        body: { settingId: ROUTE_SETTING_A, optedOut: true, nodeId: "node_whatever" },
      });
      expect(putRes.status).toBe(403);

      const delRes = await routeAppFetch(baseUrl, "/api/fleet/config/opt-out", {
        method: "DELETE",
        token: ROUTE_AGENT_USER,
        body: { settingId: ROUTE_SETTING_A, nodeId: "node_whatever" },
      });
      expect(delRes.status).toBe(403);

      const getRes = await routeAppFetch(baseUrl, "/api/fleet/config/opt-out", { token: ROUTE_AGENT_USER });
      expect(getRes.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });
});
