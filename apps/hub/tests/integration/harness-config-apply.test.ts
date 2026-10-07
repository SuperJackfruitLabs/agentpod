/**
 * Integration Test: plan / inspect / apply a declared harness setting (Task 7)
 *
 * Verifies the three new routes in `src/routes/harness-config.ts`
 * (`POST .../config/plan`, `GET .../config/operations/:operationId`,
 * `POST .../config/apply`) and `src/services/harness-config-apply.ts`
 * (`planFor`, `applyFor`, `recordApplied`):
 *
 *   1. `plan` proxies to the node and returns the node's plan unchanged.
 *   2. `plan` for a station on an offline node is a 502, not an empty plan —
 *      the registry could not be confirmed, so nothing is offered.
 *   3. `apply` requires the digest the plan returned; a different digest is
 *      refused (the node's own conflict semantics, forwarded unchanged).
 *   4. A successful `apply` records `applied_harness_config` with the
 *      gateway pid/uptime read from this station's health right after.
 *   5. A non-human principal is refused on `apply` (`nonHumanRefusal`,
 *      reused from Plan 1 — these routes declare fleet policy same as
 *      `declare`/`undeclare`).
 *   6. An unregistered setting id is refused (400) before `config.plan` is
 *      ever dispatched to the node — only the registry check (`config.settings`)
 *      is allowed to have been asked.
 *   7. A station belonging to another tenant is invisible to `plan`,
 *      `inspect` and `apply` alike (404, the same `getStation` + tenant
 *      check every route in this file already uses).
 *
 * Follows `tests/unit/harness-config-routes.test.ts`: a minimal test Hono app
 * with a fake `X-Test-User-Id` auth middleware, the real gateway routes, and
 * a fake node connected over the real WebSocket gateway — not a mocked
 * broker. The fake node here additionally answers `config.plan`,
 * `config.apply` and `health`, since this file exercises Task 6's broker
 * verbs rather than `config.observe`.
 *
 * Uses the local Docker test-postgres (localhost:5434).
 * DATABASE_URL must be set before any src/ modules are imported.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import type { DetectedStation } from "@agentpod/contract";

// src/ imports — DB URL is already set above
import { rawSql } from "../../src/db/drizzle";
import { createTestUser, deleteTestUsers } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { waitForNodeOnline } from "../helpers/wait";
import { mintEnrollmentToken, enrollNode } from "../../src/services/enrollment";
import { adoptStations } from "../../src/services/station-registry";
import { createPrincipal, forgetPrincipals } from "../helpers/principals";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/tenant-scope";
import { gatewayRoutes } from "../../src/routes/gateway";
import { harnessConfigRoutes } from "../../src/routes/harness-config";
import { websocket } from "../../src/ws";
import type { AuthUser } from "../../src/auth/middleware";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER = "test-user-cfgapply-001";
const AGENT_USER = "test-user-cfgapply-agent-001";
const SETTING_ID = "hermes.approvals.timeout";
// A real AgentPod tenant id (`fleet_<20 hex>`) distinct from the bootstrap
// tenant — "tnt_test" fails the CHECK constraint, and a station belonging to
// this tenant is exactly the row #7 must prove is invisible.
const OTHER_TENANT = "fleet_cfa0000000000000002";

const FAKE_GATEWAY_PID = 44321;
const FAKE_GATEWAY_UPTIME_SEC = 777;

/** Mirrors the real node's registry (apps/node-agent/internal/descriptor/hermes_config.go). */
const HERMES_REGISTRY = [
  { id: "hermes.approvals.timeout", harness: "hermes", scope: "profile", policy: "reconcilable", restartToTakeEffect: true },
  { id: "hermes.approvals.mode", harness: "hermes", scope: "profile", policy: "reconcilable", restartToTakeEffect: true },
];

// ─── Minimal test app ─────────────────────────────────────────────────────────

const testApp = new Hono()
  .use("/api/*", async (c, next) => {
    const userId = c.req.header("X-Test-User-Id");
    if (userId && userId !== "anonymous") {
      c.set("user", {
        id: userId,
        authType: "api_key",
        tenantId: BOOTSTRAP_TENANT_ID,
      } satisfies AuthUser);
    } else {
      c.set("user", {
        id: "anonymous",
        authType: "api_key",
        tenantId: BOOTSTRAP_TENANT_ID,
      } satisfies AuthUser);
    }
    return next();
  })
  .route("/public/nodes", gatewayRoutes)
  .route("/api", harnessConfigRoutes);

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

let agentPrincipalId: string;

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "cfgapply-test@example.com",
    name: "Config Apply Test User",
  });
  await createTestUser({
    id: AGENT_USER,
    email: "cfgapply-agent@example.com",
    name: "Config Apply Agent User",
  });
  agentPrincipalId = await createPrincipal({
    kind: "agent",
    handle: "cfgapply-test-agent",
    userId: AGENT_USER,
  });
  await rawSql`DELETE FROM tenants WHERE id = ${OTHER_TENANT}`;
  await rawSql`INSERT INTO tenants (id, name) VALUES (${OTHER_TENANT}, 'Other (cfgapply)')`;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM applied_harness_config WHERE tenant_id IN (${BOOTSTRAP_TENANT_ID}, ${OTHER_TENANT})
                   AND station_id IN (SELECT id FROM stations WHERE user_id IN (${TEST_USER}, ${AGENT_USER}))`;
    await rawSql`DELETE FROM declared_harness_config WHERE declared_by IN (${TEST_USER}, ${AGENT_USER})`;
    await forgetPrincipals({ ids: [agentPrincipalId] });
    await rawSql`DELETE FROM station_audit           WHERE user_id IN (${TEST_USER}, ${AGENT_USER})`;
    await rawSql`DELETE FROM stations                WHERE user_id IN (${TEST_USER}, ${AGENT_USER})`;
    await rawSql`DELETE FROM nodes                   WHERE user_id IN (${TEST_USER}, ${AGENT_USER})`;
    await rawSql`DELETE FROM enrollment_tokens        WHERE user_id IN (${TEST_USER}, ${AGENT_USER})`;
    await rawSql`DELETE FROM tenants                 WHERE id = ${OTHER_TENANT}`;
    await deleteTestUsers([TEST_USER, AGENT_USER]);
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function enrollTestNode(hostname: string) {
  const { token } = await mintEnrollmentToken(TEST_USER);
  return enrollNode(token, {
    hostname,
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });
}

function detectedFor(stationKey: string): DetectedStation[] {
  return [
    {
      key: stationKey,
      harness: "hermes",
      kind: "leaf",
      displayName: "Config Apply Test",
      parentKey: null,
      workspacePath: `/workspace/${stationKey}`,
      capabilities: ["health", "config.manage"],
      matrixId: null,
      adopted: false,
    },
  ];
}

type FakePlan = {
  schemaVersion: 1;
  operationId: string;
  stationKey: string;
  entries: Array<{
    settingId: string;
    file: string;
    keyPath: string;
    policy: string;
    intended: unknown;
    action: string;
    restartToTakeEffect: boolean;
  }>;
  beforeSha256: string;
  diff: string;
  diffTruncated: boolean;
  noOp: boolean;
  restartRequired: boolean;
  createdAt: string;
  planDigest: string;
};

/**
 * Connects a fake node that answers `config.settings`, `config.plan`,
 * `config.apply`, `config.inspect` and `health` — the five verbs Task 7's
 * plan/apply/inspect flow touches. `asked` records every verb requested, for
 * the test that proves `config.plan` is never dispatched for an id the
 * registry does not carry.
 */
async function connectConfigFakeNode(
  serverPort: number,
  nodeId: string,
  nodeSecret: string,
  /**
   * When set, `config.plan` answers ok:true with a REFUSED plan — exactly
   * what the real node returns for SHAPE_UNEXPECTED, UNREADABLE,
   * CREDENTIAL_PATH or OUT_OF_SCOPE: a populated digest, `noOp: false`, and
   * `refusal`. The node also declines to journal it, which is why treating
   * it as a plan and applying it used to come back as "the node could not be
   * reached".
   */
  opts: { planRefusal?: { code: string; message: string } } = {},
): Promise<{ ws: WebSocket; asked: string[]; plans: Map<string, FakePlan> }> {
  const asked: string[] = [];
  const plans = new Map<string, FakePlan>();
  const receipts = new Map<string, Record<string, unknown>>();

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
      ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: { settings: HERMES_REGISTRY } }));
      return;
    }

    if (verb === "config.plan") {
      const params = msg.params as { stationKey: string; operationId: string; want: Array<{ settingId: string; value: unknown }> };
      const want = params.want[0]!;
      const plan: FakePlan = {
        schemaVersion: 1,
        operationId: params.operationId,
        stationKey: params.stationKey,
        entries: [
          {
            settingId: want.settingId,
            file: "/workspace/config.yaml",
            keyPath: "approvals.timeout",
            policy: "reconcilable",
            intended: want.value,
            action: "modify",
            restartToTakeEffect: true,
          },
        ],
        beforeSha256: "before-sha",
        diff: "- old\n+ new",
        diffTruncated: false,
        noOp: false,
        restartRequired: true,
        createdAt: new Date().toISOString(),
        planDigest: `digest-${params.operationId}`,
      };
      if (opts.planRefusal) {
        // A refused plan is NOT journaled by the real node, so `plans` is
        // deliberately left without this operation: an apply that followed
        // would get "operation not found", the path that used to surface as
        // a 502 blaming connectivity.
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: { ...plan, refusal: opts.planRefusal } }));
        return;
      }
      plans.set(params.operationId, plan);
      ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: plan }));
      return;
    }

    if (verb === "config.apply") {
      const params = msg.params as { operationId: string; planDigest: string };
      const plan = plans.get(params.operationId);
      if (!plan) {
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: false, error: "operation not found" }));
        return;
      }
      if (params.planDigest !== plan.planDigest) {
        const receipt = {
          plan: { ...plan, refusal: { code: "PLAN_DIGEST_MISMATCH", message: "digest mismatch" } },
          phase: "conflict",
          updatedAt: new Date().toISOString(),
          written: [],
        };
        receipts.set(params.operationId, receipt);
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: receipt }));
        return;
      }
      const written = plan.entries.map((entry) => ({
        settingId: entry.settingId,
        action: entry.action,
        wrote: entry.intended,
      }));
      const receipt = {
        plan,
        phase: "applied",
        updatedAt: new Date().toISOString(),
        written,
        afterSha256: "after-sha",
      };
      receipts.set(params.operationId, receipt);
      ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: receipt }));
      return;
    }

    if (verb === "config.inspect") {
      const params = msg.params as { operationId: string };
      const receipt = receipts.get(params.operationId);
      if (!receipt) {
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: false, error: "operation not found" }));
        return;
      }
      ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: receipt }));
      return;
    }

    if (verb === "health") {
      ws.send(
        JSON.stringify({
          type: "res",
          id: msg.id,
          ok: true,
          data: {
            running: true,
            pid: FAKE_GATEWAY_PID,
            cpuPct: 1.5,
            memBytes: 1024,
            diskBytes: 2048,
            uptimeSec: FAKE_GATEWAY_UPTIME_SEC,
            lastActivity: null,
            note: null,
          },
        }),
      );
      return;
    }
  };

  await waitForNodeOnline(nodeId);
  return { ws, asked, plans };
}

function appFetch(
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

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "plan proxies to the node and returns the node's plan unchanged",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const { nodeId, nodeSecret } = await enrollTestNode("cfgapply-plan-host");
      const stationKey = "cfgapply-plan-station";
      const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor(stationKey));
      if (!station) throw new Error("station adoption failed");

      const fake = await connectConfigFakeNode(server.port!, nodeId, nodeSecret);

      const res = await appFetch(baseUrl, `/api/stations/${station.id}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        body: { settings: [{ settingId: SETTING_ID, value: "900" }] },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as FakePlan;
      expect(fake.plans.get(body.operationId)).toEqual(body);
      expect(body.stationKey).toBe(stationKey);
      expect(body.entries[0]?.intended).toBe("900");

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "plan for a station on an offline node is a 502, not an empty plan",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      // Enrolled, but never connected to the gateway — offline by construction.
      const { nodeId } = await enrollTestNode("cfgapply-offline-host");
      const stationKey = "cfgapply-offline-station";
      const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor(stationKey));
      if (!station) throw new Error("station adoption failed");

      const res = await appFetch(baseUrl, `/api/stations/${station.id}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        body: { settings: [{ settingId: SETTING_ID, value: "900" }] },
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error?: string; entries?: unknown };
      expect(body.error).toBeTruthy();
      // Never an empty-but-well-formed plan standing in for "could not ask".
      expect(body.entries).toBeUndefined();
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "apply requires the digest the plan returned; a different digest is refused",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const { nodeId, nodeSecret } = await enrollTestNode("cfgapply-digest-host");
      const stationKey = "cfgapply-digest-station";
      const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor(stationKey));
      if (!station) throw new Error("station adoption failed");

      const fake = await connectConfigFakeNode(server.port!, nodeId, nodeSecret);

      const planRes = await appFetch(baseUrl, `/api/stations/${station.id}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        body: { settings: [{ settingId: SETTING_ID, value: "900" }] },
      });
      expect(planRes.status).toBe(200);
      const plan = (await planRes.json()) as FakePlan;

      const applyRes = await appFetch(baseUrl, `/api/stations/${station.id}/config/apply`, {
        method: "POST",
        token: TEST_USER,
        body: { operationId: plan.operationId, planDigest: "not-the-real-digest" },
      });
      expect(applyRes.status).toBe(409);
      const body = (await applyRes.json()) as { phase: string };
      expect(body.phase).toBe("conflict");

      const rows = await rawSql`
        SELECT 1 FROM applied_harness_config
        WHERE station_id = ${station.id} AND setting_id = ${SETTING_ID}`;
      expect(rows.length).toBe(0);

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "apply records applied_harness_config with the gateway pid from health",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const { nodeId, nodeSecret } = await enrollTestNode("cfgapply-success-host");
      const stationKey = "cfgapply-success-station";
      const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor(stationKey));
      if (!station) throw new Error("station adoption failed");

      const fake = await connectConfigFakeNode(server.port!, nodeId, nodeSecret);

      const planRes = await appFetch(baseUrl, `/api/stations/${station.id}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        body: { settings: [{ settingId: SETTING_ID, value: "900" }] },
      });
      expect(planRes.status).toBe(200);
      const plan = (await planRes.json()) as FakePlan;

      const applyRes = await appFetch(baseUrl, `/api/stations/${station.id}/config/apply`, {
        method: "POST",
        token: TEST_USER,
        body: { operationId: plan.operationId, planDigest: plan.planDigest },
      });
      expect(applyRes.status).toBe(200);
      const receipt = (await applyRes.json()) as { phase: string };
      expect(receipt.phase).toBe("applied");

      const rows = await rawSql<
        { setting_id: string; value: unknown; gateway_pid: number; gateway_uptime_sec: number }[]
      >`
        SELECT setting_id, value, gateway_pid, gateway_uptime_sec
        FROM applied_harness_config
        WHERE station_id = ${station.id} AND setting_id = ${SETTING_ID}`;
      expect(rows.length).toBe(1);
      expect(rows[0]?.gateway_pid).toBe(FAKE_GATEWAY_PID);
      expect(rows[0]?.gateway_uptime_sec).toBe(FAKE_GATEWAY_UPTIME_SEC);
      expect(rows[0]?.value).toBe("900");

      // Inspect round-trips the same receipt the node's journal has on record.
      const inspectRes = await appFetch(baseUrl, `/api/stations/${station.id}/config/operations/${plan.operationId}`, {
        token: TEST_USER,
      });
      expect(inspectRes.status).toBe(200);
      const inspected = (await inspectRes.json()) as { phase: string };
      expect(inspected.phase).toBe("applied");

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test("apply by a non-human principal is refused", async () => {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  const baseUrl = `http://localhost:${server.port}`;
  try {
    const res = await appFetch(baseUrl, `/api/stations/station_does_not_matter/config/apply`, {
      method: "POST",
      token: AGENT_USER,
      body: { operationId: "op_whatever", planDigest: "digest_whatever" },
    });
    expect(res.status).toBe(403);

    const planRes = await appFetch(baseUrl, `/api/stations/station_does_not_matter/config/plan`, {
      method: "POST",
      token: AGENT_USER,
      body: { settings: [{ settingId: SETTING_ID, value: "900" }] },
    });
    expect(planRes.status).toBe(403);
  } finally {
    server.stop(true);
  }
});

test(
  "an unregistered setting id is refused before the node is ever asked to plan",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const { nodeId, nodeSecret } = await enrollTestNode("cfgapply-unknown-host");
      const stationKey = "cfgapply-unknown-station";
      const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor(stationKey));
      if (!station) throw new Error("station adoption failed");

      const fake = await connectConfigFakeNode(server.port!, nodeId, nodeSecret);

      const res = await appFetch(baseUrl, `/api/stations/${station.id}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        body: { settings: [{ settingId: "hermes.approvals.not_a_real_setting", value: "900" }] },
      });
      expect(res.status).toBe(400);
      // The registry check (`config.settings`) may have been asked; the
      // planning verb itself must never have been dispatched for an id the
      // registry does not carry.
      expect(fake.asked).not.toContain("config.plan");

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "a station in another tenant is not visible to plan, inspect or apply",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      // `stations_node_tenant_fk` is a composite FK on (node_id, tenant_id) —
      // by design, a station cannot be moved into another tenant while its
      // node stays in the first (that pair would stop existing). So a
      // cross-tenant fixture needs a node AND a station inserted directly
      // under OTHER_TENANT from the start, the same way
      // `tenant-isolation.test.ts` builds its own foreign row — not
      // `enrollTestNode`/`adoptStations`, which always resolve to the
      // bootstrap tenant today (`resolveTenantForUser`).
      const foreignNodeId = `node_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const foreignStationId = `station_${crypto.randomUUID()}`;
      await rawSql`
        INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, secret_hash)
        VALUES (${foreignNodeId}, ${OTHER_TENANT}, ${TEST_USER}, 'cfgapply-foreign-host', 'cfgapply-foreign-host', 'linux', 'amd64', 'unused')`;
      await rawSql`
        INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, workspace_path, capabilities)
        VALUES (${foreignStationId}, ${OTHER_TENANT}, ${TEST_USER}, ${foreignNodeId}, 'hermes', 'cfgapply-foreign-station', 'leaf',
                'Config Apply Foreign Test', '/workspace/cfgapply-foreign-station', ${JSON.stringify(["health", "config.manage"])}::jsonb)`;

      const planRes = await appFetch(baseUrl, `/api/stations/${foreignStationId}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        body: { settings: [{ settingId: SETTING_ID, value: "900" }] },
      });
      expect(planRes.status).toBe(404);

      const inspectRes = await appFetch(baseUrl, `/api/stations/${foreignStationId}/config/operations/op_whatever`, {
        token: TEST_USER,
      });
      expect(inspectRes.status).toBe(404);

      const applyRes = await appFetch(baseUrl, `/api/stations/${foreignStationId}/config/apply`, {
        method: "POST",
        token: TEST_USER,
        body: { operationId: "op_whatever", planDigest: "digest_whatever" },
      });
      expect(applyRes.status).toBe(404);
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "a plan the node REFUSED is reported as a refusal, with the node's own code",
  async () => {
    // Finding 3. The node answers promptly and names the problem; the hub
    // used to answer 200 with `{refusal: …}` in the body, so `fleet config
    // plan` printed it and exited 0 and no programmatic caller could tell a
    // refusal from a plan.
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const { nodeId, nodeSecret } = await enrollTestNode("cfgapply-refusal-host");
      const stationKey = "cfgapply-refusal-station";
      const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor(stationKey));
      if (!station) throw new Error("station adoption failed");

      const fake = await connectConfigFakeNode(server.port!, nodeId, nodeSecret, {
        planRefusal: {
          code: "SHAPE_UNEXPECTED",
          message: "approvals.timeout: declared value is not a scalar",
        },
      });

      const res = await appFetch(baseUrl, `/api/stations/${station.id}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        body: { settings: [{ settingId: SETTING_ID, value: "900" }] },
      });

      // A status a caller can branch on — and specifically not 200.
      // 400, not 409: `SHAPE_UNEXPECTED` cannot be satisfied by re-sending
      // the same request, whatever happens on the station (Minor 4; the
      // whole mapping is pinned in tests/unit/harness-config-refusal-status).
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string; code?: string; entries?: unknown; planDigest?: string };
      // The node's own code and sentence, not "the node could not be reached".
      expect(body.code).toBe("SHAPE_UNEXPECTED");
      expect(body.error).toContain("not a scalar");
      expect(body.error).not.toMatch(/could not be reached|unreachable/i);
      // And never a plan-shaped body a caller might try to apply.
      expect(body.entries).toBeUndefined();
      expect(body.planDigest).toBeUndefined();

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "a refusal that no retry could satisfy is a 400, distinguishable from a 409 about the state",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const { nodeId, nodeSecret } = await enrollTestNode("cfgapply-refusal400-host");
      const stationKey = "cfgapply-refusal400-station";
      const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor(stationKey));
      if (!station) throw new Error("station adoption failed");

      const fake = await connectConfigFakeNode(server.port!, nodeId, nodeSecret, {
        planRefusal: {
          code: "OUT_OF_SCOPE",
          message: "hermes is the composite root, which has no profile-scoped document of its own",
        },
      });

      const res = await appFetch(baseUrl, `/api/stations/${station.id}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        body: { settings: [{ settingId: SETTING_ID, value: "900" }] },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe("OUT_OF_SCOPE");

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "planning with no value and nothing declared is NOTHING_DECLARED, not UNKNOWN_SETTING",
  async () => {
    // Finding 5. `UNKNOWN_SETTING` is reserved for an id not in the registry
    // (D1), and this id IS in the registry — the live check just passed. The
    // remedies are different sentences, so they are different codes.
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const { nodeId, nodeSecret } = await enrollTestNode("cfgapply-nodecl-host");
      const stationKey = "cfgapply-nodecl-station";
      const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor(stationKey));
      if (!station) throw new Error("station adoption failed");

      const fake = await connectConfigFakeNode(server.port!, nodeId, nodeSecret);

      const res = await appFetch(baseUrl, `/api/stations/${station.id}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        // No `value`, and nothing declared at any level for this station.
        body: { settings: [{ settingId: SETTING_ID }] },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string; code?: string };
      expect(body.code).toBe("NOTHING_DECLARED");
      expect(body.code).not.toBe("UNKNOWN_SETTING");
      expect(body.error).toContain(SETTING_ID);
      // Nothing was asked of the node to plan — there was nothing to plan.
      expect(fake.asked).not.toContain("config.plan");

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);
