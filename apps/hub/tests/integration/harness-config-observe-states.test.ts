/**
 * Integration Test: `awaiting-restart` and `opted-out` arrive through the API
 * (Task 9b)
 *
 * `compare()` (`src/services/harness-config.ts`) has emitted all seven
 * observation states since Task 9, proven by unit tests
 * (`tests/unit/harness-config-compare.test.ts`). But `awaiting-restart` and
 * `opted-out` depend on three optional arguments — `appliedWrites`,
 * `currentGatewayPid`, `optedOut` — that no caller passed: `observeStation`
 * (`src/routes/harness-config.ts`), which serves both
 * `GET /api/stations/:stationId/config` and `GET /api/fleet/config/drift`,
 * called `compare()` with none of them. This file proves the two states now
 * reach a caller through the real routes, not just through `compare()`
 * directly.
 *
 * Follows `tests/integration/harness-config-apply.test.ts`'s fixture: a
 * minimal test Hono app with a fake `X-Test-User-Id` auth middleware, the
 * real gateway + harness-config routes, and a fake node connected over the
 * real WebSocket gateway answering `config.settings`, `config.observe` and
 * `health`.
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
import type { ConfigObservation, DetectedStation } from "@agentpod/contract";

// src/ imports — DB URL is already set above
import { rawSql } from "../../src/db/drizzle";
import { createTestUser, deleteTestUser } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { waitForNodeOnline } from "../helpers/wait";
import { mintEnrollmentToken, enrollNode } from "../../src/services/enrollment";
import { adoptStations } from "../../src/services/station-registry";
import { declare, setOptOut } from "../../src/services/harness-config";
import { recordApplied } from "../../src/services/harness-config-apply";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/tenant-scope";
import { gatewayRoutes } from "../../src/routes/gateway";
import { harnessConfigRoutes } from "../../src/routes/harness-config";
import { websocket } from "../../src/ws";
import type { AuthUser } from "../../src/auth/middleware";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER = "test-user-cfgobserve-001";
const SETTING_A = "hermes.approvals.timeout"; // restartToTakeEffect: true
const SETTING_B = "hermes.approvals.mode"; // restartToTakeEffect: true, opted out in some tests

const REGISTRY = [
  { id: SETTING_A, harness: "hermes", scope: "profile", policy: "reconcilable", restartToTakeEffect: true },
  { id: SETTING_B, harness: "hermes", scope: "profile", policy: "reconcilable", restartToTakeEffect: true },
];

const RECORDED_PID = 51001;
const DIFFERENT_PID = 51002;

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

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "cfgobserve-test@example.com",
    name: "Config Observe States Test User",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM applied_harness_config WHERE station_id IN (SELECT id FROM stations WHERE user_id = ${TEST_USER})`;
    await rawSql`DELETE FROM harness_config_opt_out  WHERE opted_out_by = ${TEST_USER}`;
    await rawSql`DELETE FROM declared_harness_config WHERE declared_by = ${TEST_USER}`;
    await rawSql`DELETE FROM station_audit           WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM stations                WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM nodes                   WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens        WHERE user_id = ${TEST_USER}`;
    await deleteTestUser(TEST_USER);
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
      displayName: "Config Observe States Test",
      parentKey: null,
      workspacePath: `/workspace/${stationKey}`,
      capabilities: ["health", "config.manage"],
      matrixId: null,
      adopted: false,
    },
  ];
}

type HealthBehavior = { ok: true; pid: number } | { ok: false };

/**
 * Connects a fake node that answers `config.settings`, `config.observe` and
 * `health` — the three verbs `observeStation` now touches. `observed` maps a
 * settingId to the value the fake node reports as readable; any settingId
 * requested but not present in `observed` is reported as not in the document
 * (`observed: undefined`, still `readable: true`).
 */
async function connectObserveFakeNode(
  serverPort: number,
  nodeId: string,
  nodeSecret: string,
  opts: { observed: Record<string, unknown>; health: HealthBehavior },
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
      ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: { settings: REGISTRY } }));
      return;
    }

    if (verb === "config.observe") {
      const params = msg.params as { settings: string[] };
      const values = params.settings.map((id) => ({
        settingId: id,
        readable: true,
        observed: opts.observed[id],
      }));
      ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: { values } }));
      return;
    }

    if (verb === "health") {
      if (!opts.health.ok) {
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: false, error: "health unavailable" }));
        return;
      }
      ws.send(
        JSON.stringify({
          type: "res",
          id: msg.id,
          ok: true,
          data: {
            running: true,
            pid: opts.health.pid,
            cpuPct: 1.5,
            memBytes: 1024,
            diskBytes: 2048,
            uptimeSec: 100,
            lastActivity: null,
            note: null,
          },
        }),
      );
      return;
    }
  };

  await waitForNodeOnline(nodeId);
  return { ws, asked };
}

function appFetch(baseUrl: string, path: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { "X-Test-User-Id": token } });
}

async function setUpStation(
  hostname: string,
  stationKey: string,
): Promise<{ stationId: string; nodeId: string; nodeSecret: string }> {
  const { nodeId, nodeSecret } = await enrollTestNode(hostname);
  const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor(stationKey));
  if (!station) throw new Error("station adoption failed");
  return { stationId: station.id, nodeId, nodeSecret };
}

function findObservation(observations: ConfigObservation[], settingId: string): ConfigObservation {
  const o = observations.find((x) => x.settingId === settingId);
  if (!o) throw new Error(`no observation for ${settingId}`);
  return o;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "GET /api/stations/:stationId/config reports awaiting-restart for a setting written under the current gateway pid",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const { stationId, nodeId, nodeSecret } = await setUpStation(
        "cfgobserve-awaiting-host",
        "cfgobserve-awaiting-station",
      );

      await declare({
        settingId: SETTING_A,
        stationId,
        nodeId: null,
        value: "900",
        tenantId: BOOTSTRAP_TENANT_ID,
        declaredBy: TEST_USER,
      });
      await recordApplied({
        tenantId: BOOTSTRAP_TENANT_ID,
        stationId,
        settingId: SETTING_A,
        value: "900",
        gatewayPid: RECORDED_PID,
        gatewayUptimeSec: 10,
        appliedAt: new Date(),
      });

      const fake = await connectObserveFakeNode(server.port!, nodeId, nodeSecret, {
        // The document already holds the declared value — without restart
        // evidence this would read as `matches`.
        observed: { [SETTING_A]: "900" },
        health: { ok: true, pid: RECORDED_PID },
      });

      const res = await appFetch(baseUrl, `/api/stations/${stationId}/config`, TEST_USER);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { observations: ConfigObservation[] };
      const o = findObservation(body.observations, SETTING_A);
      expect(o.state).toBe("awaiting-restart");

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "the same setting reports matches once the current gateway pid differs from the recorded one",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const { stationId, nodeId, nodeSecret } = await setUpStation(
        "cfgobserve-restarted-host",
        "cfgobserve-restarted-station",
      );

      await declare({
        settingId: SETTING_A,
        stationId,
        nodeId: null,
        value: "900",
        tenantId: BOOTSTRAP_TENANT_ID,
        declaredBy: TEST_USER,
      });
      await recordApplied({
        tenantId: BOOTSTRAP_TENANT_ID,
        stationId,
        settingId: SETTING_A,
        value: "900",
        gatewayPid: RECORDED_PID,
        gatewayUptimeSec: 10,
        appliedAt: new Date(),
      });

      const fake = await connectObserveFakeNode(server.port!, nodeId, nodeSecret, {
        observed: { [SETTING_A]: "900" },
        health: { ok: true, pid: DIFFERENT_PID },
      });

      const res = await appFetch(baseUrl, `/api/stations/${stationId}/config`, TEST_USER);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { observations: ConfigObservation[] };
      const o = findObservation(body.observations, SETTING_A);
      expect(o.state).toBe("matches");

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "a station whose health cannot be read reports awaiting-restart, never matches",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const { stationId, nodeId, nodeSecret } = await setUpStation(
        "cfgobserve-unreadable-health-host",
        "cfgobserve-unreadable-health-station",
      );

      await declare({
        settingId: SETTING_A,
        stationId,
        nodeId: null,
        value: "900",
        tenantId: BOOTSTRAP_TENANT_ID,
        declaredBy: TEST_USER,
      });
      await recordApplied({
        tenantId: BOOTSTRAP_TENANT_ID,
        stationId,
        settingId: SETTING_A,
        value: "900",
        gatewayPid: RECORDED_PID,
        gatewayUptimeSec: 10,
        appliedAt: new Date(),
      });

      const fake = await connectObserveFakeNode(server.port!, nodeId, nodeSecret, {
        observed: { [SETTING_A]: "900" },
        health: { ok: false },
      });

      const res = await appFetch(baseUrl, `/api/stations/${stationId}/config`, TEST_USER);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { observations: ConfigObservation[] };
      const o = findObservation(body.observations, SETTING_A);
      expect(o.state).toBe("awaiting-restart");
      expect(o.state).not.toBe("matches");

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "GET /api/stations/:stationId/config reports opted-out for an opted-out setting, even when the observed value differs",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const { stationId, nodeId, nodeSecret, stationKey } = await (async () => {
        const stationKey = "cfgobserve-optedout-station";
        const built = await setUpStation("cfgobserve-optedout-host", stationKey);
        return { ...built, stationKey };
      })();

      await declare({
        settingId: SETTING_B,
        stationId,
        nodeId: null,
        value: "900",
        tenantId: BOOTSTRAP_TENANT_ID,
        declaredBy: TEST_USER,
      });
      await setOptOut({
        stationKey,
        settingId: SETTING_B,
        optedOut: true,
        tenantId: BOOTSTRAP_TENANT_ID,
        optedOutBy: TEST_USER,
      });

      const fake = await connectObserveFakeNode(server.port!, nodeId, nodeSecret, {
        observed: { [SETTING_B]: "300" }, // differs from declared "900"
        health: { ok: true, pid: RECORDED_PID },
      });

      const res = await appFetch(baseUrl, `/api/stations/${stationId}/config`, TEST_USER);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { observations: ConfigObservation[] };
      const o = findObservation(body.observations, SETTING_B);
      expect(o.state).toBe("opted-out");
      expect(o.state).not.toBe("drifted");

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "GET /api/fleet/config/drift carries both awaiting-restart and opted-out",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const stationKey = "cfgobserve-drift-station";
      const { stationId, nodeId, nodeSecret } = await setUpStation("cfgobserve-drift-host", stationKey);

      await declare({
        settingId: SETTING_A,
        stationId,
        nodeId: null,
        value: "900",
        tenantId: BOOTSTRAP_TENANT_ID,
        declaredBy: TEST_USER,
      });
      await recordApplied({
        tenantId: BOOTSTRAP_TENANT_ID,
        stationId,
        settingId: SETTING_A,
        value: "900",
        gatewayPid: RECORDED_PID,
        gatewayUptimeSec: 10,
        appliedAt: new Date(),
      });

      await declare({
        settingId: SETTING_B,
        stationId,
        nodeId: null,
        value: "900",
        tenantId: BOOTSTRAP_TENANT_ID,
        declaredBy: TEST_USER,
      });
      await setOptOut({
        stationKey,
        settingId: SETTING_B,
        optedOut: true,
        tenantId: BOOTSTRAP_TENANT_ID,
        optedOutBy: TEST_USER,
      });

      const fake = await connectObserveFakeNode(server.port!, nodeId, nodeSecret, {
        observed: { [SETTING_A]: "900", [SETTING_B]: "300" },
        health: { ok: true, pid: RECORDED_PID },
      });

      const res = await appFetch(baseUrl, `/api/fleet/config/drift`, TEST_USER);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { observations: ConfigObservation[]; stationsUnreachable: string[] };
      expect(body.stationsUnreachable).not.toContain(stationId);

      const forThisStation = body.observations.filter((o) => o.stationId === stationId);
      expect(findObservation(forThisStation, SETTING_A).state).toBe("awaiting-restart");
      expect(findObservation(forThisStation, SETTING_B).state).toBe("opted-out");

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);
