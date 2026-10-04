/**
 * Route Test: declared harness configuration (Task 7)
 *
 * Verifies src/routes/harness-config.ts:
 *   1. Agent-kind principals are refused (403) on every route.
 *   2. PUT /fleet/config/declared refuses a declaration naming two levels (400).
 *   3. GET /stations/:id/config reports `unreadable`, never `matches`, when the
 *      station's node is offline — the Task 6 caller contract: every declared
 *      setting must come back with a ConfigValue, synthesised when the broker
 *      call itself fails.
 *   4. GET /fleet/config/drift lists only stations whose state is not `matches`.
 *   5. A node that answers `ok:true` with a SHORT or EMPTY values array still
 *      closes every requested setting as `unreadable` — the likelier failure
 *      mode than an outright offline node, because it looks like success.
 *   6. PUT's registry check tries every reachable candidate before refusing
 *      UNKNOWN_SETTING — not just the first one that answers (regression:
 *      an early `return` on "not found" used to make the verdict depend on
 *      an arbitrary, possibly unrelated candidate).
 *
 * Follows apps/hub/src/routes/station-acp.test.ts: a minimal test Hono app with
 * a fake `X-Test-User-Id` auth middleware, the real gateway routes, and a fake
 * node connected over the real WebSocket gateway — not a mocked broker.
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
import { createTestUser } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { waitForNodeOnline } from "../helpers/wait";
import { mintEnrollmentToken, enrollNode } from "../../src/services/enrollment";
import { adoptStations } from "../../src/services/station-registry";
import { createPrincipal } from "../../src/services/principals";
import { declare } from "../../src/services/harness-config";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/tenant-scope";
import { gatewayRoutes } from "../../src/routes/gateway";
import { harnessConfigRoutes } from "../../src/routes/harness-config";
import { websocket } from "../../src/ws";
import type { AuthUser } from "../../src/auth/middleware";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER = "test-user-cfgroute-001";
const AGENT_USER = "test-user-cfgroute-agent-001";
const SETTING_ID = "hermes.approvals.timeout";

/** What a fake Hermes-harness node answers `config.settings` with — mirrors
 *  the real node's registry (apps/node-agent/internal/descriptor/hermes_config.go)
 *  closely enough for these tests, which only exercise `hermes.approvals.*`. */
const HERMES_REGISTRY = [
  { id: "hermes.approvals.timeout", harness: "hermes", scope: "profile", policy: "reconcilable", restartToTakeEffect: true },
  { id: "hermes.approvals.mode", harness: "hermes", scope: "profile", policy: "reconcilable", restartToTakeEffect: true },
  { id: "hermes.approvals.command_allowlist", harness: "hermes", scope: "profile", policy: "additive-only", restartToTakeEffect: true },
];

// ─── Minimal test app ─────────────────────────────────────────────────────────

// Mirrors station-acp.test.ts: a fake auth middleware carrying identity via
// X-Test-User-Id, the real gateway, and the real routes under test.
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
    email: "cfgroute-test@example.com",
    name: "Config Route Test User",
  });
  await createTestUser({
    id: AGENT_USER,
    email: "cfgroute-agent@example.com",
    name: "Config Route Agent User",
  });
  agentPrincipalId = await createPrincipal({
    kind: "agent",
    handle: "cfgroute-test-agent",
    userId: AGENT_USER,
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM declared_harness_config WHERE declared_by IN (${TEST_USER}, ${AGENT_USER})`;
    await rawSql`DELETE FROM principal_identities    WHERE principal_id = ${agentPrincipalId}`;
    await rawSql`DELETE FROM principals              WHERE id = ${agentPrincipalId}`;
    await rawSql`DELETE FROM station_audit           WHERE user_id IN (${TEST_USER}, ${AGENT_USER})`;
    await rawSql`DELETE FROM stations                WHERE user_id IN (${TEST_USER}, ${AGENT_USER})`;
    await rawSql`DELETE FROM nodes                   WHERE user_id IN (${TEST_USER}, ${AGENT_USER})`;
    await rawSql`DELETE FROM enrollment_tokens        WHERE user_id IN (${TEST_USER}, ${AGENT_USER})`;
    await rawSql`DELETE FROM "user"                  WHERE id IN (${TEST_USER}, ${AGENT_USER})`;
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
      displayName: "Config Route Test",
      parentKey: null,
      workspacePath: `/workspace/${stationKey}`,
      capabilities: ["health", "config.manage"],
      matrixId: null,
      adopted: false,
    },
  ];
}

/**
 * Connect a fake node over the real gateway WebSocket and answer
 * `config.observe` with a fixed observed value for every requested setting.
 */
async function connectFakeNode(
  serverPort: number,
  nodeId: string,
  nodeSecret: string,
  observedValue: unknown,
): Promise<WebSocket> {
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

    if (msg.verb === "config.settings") {
      ws.send(
        JSON.stringify({
          type: "res",
          id: msg.id,
          ok: true,
          data: { settings: HERMES_REGISTRY },
        }),
      );
      return;
    }

    if (msg.verb !== "config.observe") return;
    const params = msg.params as { settings: string[] };
    ws.send(
      JSON.stringify({
        type: "res",
        id: msg.id,
        ok: true,
        data: {
          values: params.settings.map((settingId) => ({
            settingId,
            readable: true,
            observed: observedValue,
          })),
        },
      }),
    );
  };

  await waitForNodeOnline(nodeId);
  return ws;
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

test("an agent-kind token is refused on every route", async () => {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  const baseUrl = `http://localhost:${server.port}`;
  try {
    for (const path of ["/api/fleet/config/settings", "/api/fleet/config/drift"]) {
      const res = await appFetch(baseUrl, path, { token: AGENT_USER });
      expect(res.status).toBe(403);
    }
  } finally {
    server.stop(true);
  }
});

test("PUT declared refuses a declaration naming two levels", async () => {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  const baseUrl = `http://localhost:${server.port}`;
  try {
    const res = await appFetch(baseUrl, "/api/fleet/config/declared", {
      method: "PUT",
      token: TEST_USER,
      body: { settingId: SETTING_ID, stationId: "station_a", nodeId: "node_1", value: 900 },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("one level");
  } finally {
    server.stop(true);
  }
});

test(
  "a station whose node is offline reports unreadable, not matches",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      // Enrolled, but never connected to the gateway — offline by construction.
      const { nodeId } = await enrollTestNode("cfgroute-offline-host");
      const stationKey = "cfgroute-offline-station";
      const [station] = await adoptStations(
        TEST_USER,
        nodeId,
        [stationKey],
        detectedFor(stationKey),
      );
      if (!station) throw new Error("station adoption failed");

      await declare({
        settingId: SETTING_ID,
        stationId: station.id,
        nodeId: null,
        value: "900",
        tenantId: BOOTSTRAP_TENANT_ID,
        declaredBy: TEST_USER,
      });

      const res = await appFetch(baseUrl, `/api/stations/${station.id}/config`, {
        token: TEST_USER,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { observations: Array<{ state: string }> };
      expect(body.observations.length).toBeGreaterThan(0);
      for (const o of body.observations) expect(o.state).toBe("unreadable");
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "drift lists only stations that disagree",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const { nodeId, nodeSecret } = await enrollTestNode("cfgroute-drift-host");

      const matchingKey = "cfgroute-drift-matching";
      const driftedKey = "cfgroute-drift-drifted";
      const [matchingStation] = await adoptStations(
        TEST_USER,
        nodeId,
        [matchingKey],
        detectedFor(matchingKey),
      );
      const [driftedStation] = await adoptStations(
        TEST_USER,
        nodeId,
        [driftedKey],
        detectedFor(driftedKey),
      );
      if (!matchingStation || !driftedStation) throw new Error("station adoption failed");

      // Declare the same setting on both stations; the node always answers "900".
      await declare({
        settingId: SETTING_ID,
        stationId: matchingStation.id,
        nodeId: null,
        value: "900",
        tenantId: BOOTSTRAP_TENANT_ID,
        declaredBy: TEST_USER,
      });
      await declare({
        settingId: SETTING_ID,
        stationId: driftedStation.id,
        nodeId: null,
        value: "300",
        tenantId: BOOTSTRAP_TENANT_ID,
        declaredBy: TEST_USER,
      });

      const fake = await connectFakeNode(server.port!, nodeId, nodeSecret, "900");

      const res = await appFetch(baseUrl, "/api/fleet/config/drift", { token: TEST_USER });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        observations: Array<{ state: string; stationId: string }>;
        stationsUnreachable: string[];
      };

      for (const o of body.observations) expect(o.state).not.toBe("matches");
      // The matching station must not appear at all; the drifted one must.
      expect(body.observations.some((o) => o.stationId === matchingStation.id)).toBe(false);
      expect(body.observations.some((o) => o.stationId === driftedStation.id)).toBe(true);

      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "a short or empty node response still closes every requested setting as unreadable",
  async () => {
    // This is the likelier failure mode than an outright offline node — the
    // node answers `ok:true`, which looks like success, but leaves a
    // requested setting out of `values`. ensureEveryValue() must close the
    // gap for BOTH a short array (one of two requested settings missing)
    // and a fully empty one (none of the requested settings present),
    // scoped per-station so no other test's tenant-wide data interferes.
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const { nodeId, nodeSecret } = await enrollTestNode("cfgroute-shortempty-host");

      const shortKey = "cfgroute-short-station";
      const emptyKey = "cfgroute-empty-station";
      const [shortStation] = await adoptStations(
        TEST_USER,
        nodeId,
        [shortKey],
        detectedFor(shortKey),
      );
      const [emptyStation] = await adoptStations(
        TEST_USER,
        nodeId,
        [emptyKey],
        detectedFor(emptyKey),
      );
      if (!shortStation || !emptyStation) throw new Error("station adoption failed");

      // Two settings declared on the "short" station; the node will answer
      // with only one of them. One setting declared on the "empty" station;
      // the node will answer with none at all.
      await declare({
        settingId: SETTING_ID,
        stationId: shortStation.id,
        nodeId: null,
        value: "900",
        tenantId: BOOTSTRAP_TENANT_ID,
        declaredBy: TEST_USER,
      });
      await declare({
        settingId: "hermes.approvals.mode",
        stationId: shortStation.id,
        nodeId: null,
        value: "ask",
        tenantId: BOOTSTRAP_TENANT_ID,
        declaredBy: TEST_USER,
      });
      await declare({
        settingId: SETTING_ID,
        stationId: emptyStation.id,
        nodeId: null,
        value: "900",
        tenantId: BOOTSTRAP_TENANT_ID,
        declaredBy: TEST_USER,
      });

      const ws = new WebSocket(`ws://localhost:${server.port}/public/nodes/gateway`, {
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

        if (msg.verb === "config.settings") {
          ws.send(
            JSON.stringify({ type: "res", id: msg.id, ok: true, data: { settings: HERMES_REGISTRY } }),
          );
          return;
        }

        if (msg.verb !== "config.observe") return;
        const params = msg.params as { stationKey: string; settings: string[] };
        if (params.stationKey === shortKey) {
          // Short: answer only the FIRST requested setting, omitting the second.
          ws.send(
            JSON.stringify({
              type: "res",
              id: msg.id,
              ok: true,
              data: { values: [{ settingId: params.settings[0], readable: true, observed: "900" }] },
            }),
          );
        } else if (params.stationKey === emptyKey) {
          // Empty: ok:true, but no values at all — not a broker failure.
          ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: { values: [] } }));
        }
      };
      await waitForNodeOnline(nodeId);

      const shortRes = await appFetch(baseUrl, `/api/stations/${shortStation.id}/config`, {
        token: TEST_USER,
      });
      expect(shortRes.status).toBe(200);
      const shortBody = (await shortRes.json()) as {
        observations: Array<{ settingId: string; state: string; reason?: string }>;
      };
      expect(shortBody.observations).toHaveLength(2);
      const answered = shortBody.observations.find((o) => o.settingId === SETTING_ID);
      const missing = shortBody.observations.find((o) => o.settingId === "hermes.approvals.mode");
      expect(answered?.state).toBe("matches");
      expect(missing?.state).toBe("unreadable");
      expect(missing?.reason).toBeTruthy();

      const emptyRes = await appFetch(baseUrl, `/api/stations/${emptyStation.id}/config`, {
        token: TEST_USER,
      });
      expect(emptyRes.status).toBe(200);
      const emptyBody = (await emptyRes.json()) as {
        observations: Array<{ settingId: string; state: string; reason?: string }>;
      };
      expect(emptyBody.observations).toHaveLength(1);
      expect(emptyBody.observations[0]?.state).toBe("unreadable");
      expect(emptyBody.observations[0]?.reason).toBeTruthy();

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "PUT tries every reachable candidate before refusing UNKNOWN_SETTING, not just the first",
  async () => {
    // Regression for an early-`return` bug: when a declaration's target is
    // ambiguous (here, a node with more than one config.manage station) the
    // registry check must try every reachable candidate before refusing —
    // an id that the FIRST one answered does not manage, but the SECOND
    // does, must still be accepted. Both stations live on one node and are
    // asked over one WebSocket connection, so "first"/"second" follows this
    // node's own adoption order.
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const { nodeId, nodeSecret } = await enrollTestNode("cfgroute-fallback-host");

      const unknowingKey = "cfgroute-fallback-unknowing";
      const knowingKey = "cfgroute-fallback-knowing";
      const [unknowingStation] = await adoptStations(
        TEST_USER,
        nodeId,
        [unknowingKey],
        detectedFor(unknowingKey),
      );
      const [knowingStation] = await adoptStations(
        TEST_USER,
        nodeId,
        [knowingKey],
        detectedFor(knowingKey),
      );
      if (!unknowingStation || !knowingStation) throw new Error("station adoption failed");

      const TARGET_SETTING_ID = "hermes.approvals.command_allowlist";

      const ws = new WebSocket(`ws://localhost:${server.port}/public/nodes/gateway`, {
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
        if (msg.type !== "req" || msg.verb !== "config.settings") return;
        const params = msg.params as { stationKey: string };
        // The "unknowing" station's registry omits the target id entirely;
        // the "knowing" one carries the full registry.
        const settings =
          params.stationKey === unknowingKey
            ? HERMES_REGISTRY.filter((s) => s.id !== TARGET_SETTING_ID)
            : HERMES_REGISTRY;
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: { settings } }));
      };
      await waitForNodeOnline(nodeId);

      const res = await appFetch(baseUrl, "/api/fleet/config/declared", {
        method: "PUT",
        token: TEST_USER,
        body: { settingId: TARGET_SETTING_ID, stationId: null, nodeId, value: "git,ls" },
      });
      expect(res.status).toBe(204);

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);
