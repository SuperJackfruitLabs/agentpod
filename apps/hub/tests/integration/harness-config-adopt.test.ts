/**
 * Integration Test: reconcile declared harness settings at adopt time (Task 8)
 *
 * Spec §5: "On adopt, after the station is registered: observe, then apply
 * the `reconcilable` and `additive-only` settings whose declared value
 * differs. Failures are recorded against the station and do not fail the
 * adoption — a station that is adopted with one setting unwritten is better
 * than one not adopted."
 *
 * Exercises `reconcileOnAdopt` (`src/services/harness-config-apply.ts`),
 * called from `adoptStations` (`src/services/station-registry.ts`) after its
 * rows are written. Every test below calls the real `adoptStations` — never
 * `reconcileOnAdopt` directly — so a regression in the wiring (reconcile
 * running before the station row exists, or not being called at all) shows
 * up here too.
 *
 * Follows `tests/integration/harness-config-apply.test.ts`'s fixture: a
 * minimal test Hono app is not even needed here (no routes are under test),
 * just the real gateway + a fake node connected over it, driven directly
 * through `adoptStations`.
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
import { reconcileOnAdopt } from "../../src/services/harness-config-apply";
import { declare } from "../../src/services/harness-config";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/tenant-scope";
import { gatewayRoutes } from "../../src/routes/gateway";
import { websocket } from "../../src/ws";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER = "test-user-cfgadopt-001";
const TIMEOUT_SETTING = "hermes.approvals.timeout"; // policy: reconcilable
const MODE_SETTING = "hermes.approvals.mode"; // policy: report-only, for this fixture

/** Mirrors the real node's registry shape (apps/node-agent/internal/descriptor/hermes_config.go). */
const REGISTRY = [
  { id: TIMEOUT_SETTING, harness: "hermes", scope: "profile", policy: "reconcilable", restartToTakeEffect: true },
  { id: MODE_SETTING, harness: "hermes", scope: "profile", policy: "report-only", restartToTakeEffect: false },
];

const FAKE_GATEWAY_PID = 55123;
const FAKE_GATEWAY_UPTIME_SEC = 42;

// ─── Minimal test app (only the gateway is needed — no HTTP routes exercised) ──

const testApp = new Hono().route("/public/nodes", gatewayRoutes);

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "cfgadopt-test@example.com",
    name: "Config Adopt Test User",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM applied_harness_config WHERE station_id IN (SELECT id FROM stations WHERE user_id = ${TEST_USER})`;
    await rawSql`DELETE FROM harness_config_opt_out  WHERE opted_out_by = ${TEST_USER}`;
    await rawSql`DELETE FROM declared_harness_config WHERE declared_by = ${TEST_USER}`;
    await rawSql`DELETE FROM station_audit           WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM stations                WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM nodes                    WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens        WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM "user"                   WHERE id = ${TEST_USER}`;
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

function detectedFor(stationKeys: string[]): DetectedStation[] {
  return stationKeys.map((stationKey) => ({
    key: stationKey,
    harness: "hermes",
    kind: "leaf",
    displayName: `Config Adopt Test (${stationKey})`,
    parentKey: null,
    workspacePath: `/workspace/${stationKey}`,
    capabilities: ["health", "config.manage"],
    matrixId: null,
    adopted: false,
  }));
}

async function declareFleet(settingId: string, value: unknown) {
  await declare({
    settingId,
    stationId: null,
    nodeId: null,
    value,
    tenantId: BOOTSTRAP_TENANT_ID,
    declaredBy: TEST_USER,
  });
}

async function optOut(stationKey: string, settingId: string) {
  await rawSql`
    INSERT INTO harness_config_opt_out (id, tenant_id, station_key, setting_id, opted_out_by)
    VALUES (${`cfgoo_${crypto.randomUUID()}`}, ${BOOTSTRAP_TENANT_ID}, ${stationKey}, ${settingId}, ${TEST_USER})`;
}

async function configReasonOf(stationId: string): Promise<string | null> {
  const rows = await rawSql<{ config_reason: string | null }[]>`
    SELECT config_reason FROM stations WHERE id = ${stationId}`;
  return rows[0]?.config_reason ?? null;
}

type FakePlan = {
  schemaVersion: 1;
  operationId: string;
  stationKey: string;
  entries: Array<Record<string, unknown>>;
  beforeSha256: string;
  diff: string;
  diffTruncated: boolean;
  noOp: boolean;
  restartRequired: boolean;
  createdAt: string;
  planDigest: string;
};

interface FakeNodeOptions {
  /** stationKey -> settingId -> observed value. Absent settingId reads as "key not in document". */
  observed?: Record<string, Record<string, unknown>>;
  /** config.plan refuses outright (ok:false) for these station keys. */
  planFails?: Set<string>;
  /**
   * config.plan answers ok:true with a REFUSED plan for these station keys —
   * a populated digest, `noOp: false`, `refusal`, and (as the real node does)
   * nothing journaled, so a following apply would answer "operation not
   * found".
   */
  planRefusal?: { code: string; message: string };
  /** config.apply refuses outright (ok:false) for these station keys. */
  applyFails?: Set<string>;
  /** Called synchronously inside the config.plan handler, before answering. */
  onPlanDispatched?: (stationKey: string, settingId: string) => void | Promise<void>;
  /** Hold every `config.observe` this many ms before answering. */
  observeDelayMs?: number;
  /** Never answer `config.observe` at all — a node connected but wedged. */
  observeNeverAnswers?: boolean;
}

/**
 * Connects a fake node that answers `config.settings`, `config.observe`,
 * `config.plan`, `config.apply` and `health` — everything `reconcileOnAdopt`
 * touches. Tracks every `config.plan`/`config.apply` dispatch by
 * (stationKey, settingId) so a test can assert a setting was never planned
 * (report-only, opted-out, already-matching).
 */
async function connectFakeNode(
  serverPort: number,
  nodeId: string,
  nodeSecret: string,
  opts: FakeNodeOptions = {},
): Promise<{
  ws: WebSocket;
  planCalls: Array<{ stationKey: string; settingId: string }>;
  applyCalls: Array<{ stationKey: string; settingId: string }>;
  /** The most `config.observe` requests this node ever held open at once. */
  peakObserveInFlight: () => number;
}> {
  const planCalls: Array<{ stationKey: string; settingId: string }> = [];
  const applyCalls: Array<{ stationKey: string; settingId: string }> = [];
  const plans = new Map<string, FakePlan>();
  let observeInFlight = 0;
  let maxObserveInFlight = 0;

  const ws = new WebSocket(`ws://localhost:${serverPort}/public/nodes/gateway`, {
    headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
  } as RequestInit & { headers: Record<string, string> });

  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("Node WS connection error"));
  });

  ws.onmessage = async (e) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.type !== "req") return;
    const verb = msg.verb as string;

    if (verb === "config.settings") {
      ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: { settings: REGISTRY } }));
      return;
    }

    if (verb === "config.observe") {
      const params = msg.params as { stationKey: string; settings: string[] };
      if (opts.observeNeverAnswers) return;
      const forStation = opts.observed?.[params.stationKey] ?? {};
      const values = params.settings.map((settingId) => ({
        settingId,
        observed: forStation[settingId],
        readable: true,
      }));
      if (opts.observeDelayMs) {
        // Held open on purpose: `observeInFlight` is what a test reads to see
        // whether stations are being worked on concurrently or one at a time.
        observeInFlight += 1;
        maxObserveInFlight = Math.max(maxObserveInFlight, observeInFlight);
        await new Promise((r) => setTimeout(r, opts.observeDelayMs));
        observeInFlight -= 1;
      }
      ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: { values } }));
      return;
    }

    if (verb === "config.plan") {
      const params = msg.params as { stationKey: string; operationId: string; want: Array<{ settingId: string; value: unknown }> };
      const want = params.want[0]!;
      planCalls.push({ stationKey: params.stationKey, settingId: want.settingId });
      await opts.onPlanDispatched?.(params.stationKey, want.settingId);
      if (opts.planFails?.has(params.stationKey)) {
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: false, error: "the node refuses to plan this edit" }));
        return;
      }
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
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: { ...plan, refusal: opts.planRefusal } }));
        return;
      }
      plans.set(params.operationId, plan);
      ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: plan }));
      return;
    }

    if (verb === "config.apply") {
      const params = msg.params as { stationKey: string; operationId: string; planDigest: string };
      const plan = plans.get(params.operationId);
      if (!plan) {
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: false, error: "operation not found" }));
        return;
      }
      applyCalls.push({ stationKey: plan.stationKey, settingId: (plan.entries[0]!.settingId as string) });
      if (opts.applyFails?.has(plan.stationKey)) {
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: false, error: "the node refuses to apply this edit" }));
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
  return { ws, planCalls, applyCalls, peakObserveInFlight: () => maxObserveInFlight };
}

async function appliedValueOf(stationId: string, settingId: string): Promise<unknown | undefined> {
  const rows = await rawSql<{ value: unknown }[]>`
    SELECT value FROM applied_harness_config WHERE station_id = ${stationId} AND setting_id = ${settingId}`;
  return rows[0]?.value;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "a station adopted with a fleet-level declaration gets the value written",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    try {
      await declareFleet(TIMEOUT_SETTING, 900);
      const { nodeId, nodeSecret } = await enrollTestNode("cfgadopt-written-host");
      const stationKey = "cfgadopt-written-station";
      const fake = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        observed: { [stationKey]: { [TIMEOUT_SETTING]: 300 } },
      });

      const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor([stationKey]));
      if (!station) throw new Error("station adoption failed");

      expect(fake.applyCalls).toEqual([{ stationKey, settingId: TIMEOUT_SETTING }]);
      expect(await appliedValueOf(station.id, TIMEOUT_SETTING)).toBe(900);
      expect(await configReasonOf(station.id)).toBeNull();

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "a station whose node is offline is still adopted, with the failure recorded",
  async () => {
    await declareFleet(TIMEOUT_SETTING, 900);
    // Enrolled, but never connected to the gateway — offline by construction,
    // the same fixture `harness-config-apply.test.ts` uses for its 502 case.
    const { nodeId } = await enrollTestNode("cfgadopt-offline-host");
    const stationKey = "cfgadopt-offline-station";

    const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor([stationKey]));

    expect(station).toBeTruthy();
    expect(station!.stationKey).toBe(stationKey);
    const reason = await configReasonOf(station!.id);
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/not.*reach|offline|could not/i);
  },
  20_000,
);

test(
  "a node that refuses the apply does not fail the adoption",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    try {
      await declareFleet(TIMEOUT_SETTING, 900);
      const { nodeId, nodeSecret } = await enrollTestNode("cfgadopt-refuse-host");
      const stationKey = "cfgadopt-refuse-station";
      const fake = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        observed: { [stationKey]: { [TIMEOUT_SETTING]: 300 } },
        applyFails: new Set([stationKey]),
      });

      const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor([stationKey]));

      expect(station).toBeTruthy();
      expect(await appliedValueOf(station!.id, TIMEOUT_SETTING)).toBeUndefined();
      const reason = await configReasonOf(station!.id);
      expect(reason).toBeTruthy();
      expect(reason).toMatch(/refuse/i);

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "a reconcilable setting already matching is not written",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    try {
      await declareFleet(TIMEOUT_SETTING, 900);
      const { nodeId, nodeSecret } = await enrollTestNode("cfgadopt-matches-host");
      const stationKey = "cfgadopt-matches-station";
      const fake = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        // Already matches the declared value — nothing should be written.
        observed: { [stationKey]: { [TIMEOUT_SETTING]: 900 } },
      });

      const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor([stationKey]));

      expect(fake.planCalls).toEqual([]);
      expect(fake.applyCalls).toEqual([]);
      expect(await appliedValueOf(station!.id, TIMEOUT_SETTING)).toBeUndefined();
      expect(await configReasonOf(station!.id)).toBeNull();

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "a report-only setting is never written on adopt",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    try {
      // MODE_SETTING is report-only in the fake registry.
      await declareFleet(MODE_SETTING, "strict");
      const { nodeId, nodeSecret } = await enrollTestNode("cfgadopt-reportonly-host");
      const stationKey = "cfgadopt-reportonly-station";
      const fake = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        observed: { [stationKey]: { [MODE_SETTING]: "loose" } }, // differs — would drift if writable
      });

      const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor([stationKey]));

      expect(fake.planCalls.some((c) => c.settingId === MODE_SETTING)).toBe(false);
      expect(await appliedValueOf(station!.id, MODE_SETTING)).toBeUndefined();
      expect(await configReasonOf(station!.id)).toBeNull();

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "an opted-out setting is not written on adopt",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    try {
      await declareFleet(TIMEOUT_SETTING, 900);
      const { nodeId, nodeSecret } = await enrollTestNode("cfgadopt-optedout-host");
      const stationKey = "cfgadopt-optedout-station";
      await optOut(stationKey, TIMEOUT_SETTING);
      const fake = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        observed: { [stationKey]: { [TIMEOUT_SETTING]: 300 } }, // differs — would drift if not opted out
      });

      const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor([stationKey]));

      expect(fake.planCalls.some((c) => c.settingId === TIMEOUT_SETTING)).toBe(false);
      expect(await appliedValueOf(station!.id, TIMEOUT_SETTING)).toBeUndefined();
      expect(await configReasonOf(station!.id)).toBeNull();

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "adopting 3 stations where the middle one fails adopts all 3",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    try {
      await declareFleet(TIMEOUT_SETTING, 900);
      const { nodeId, nodeSecret } = await enrollTestNode("cfgadopt-three-host");
      const keys = ["cfgadopt-three-a", "cfgadopt-three-b", "cfgadopt-three-c"];
      const fake = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        observed: Object.fromEntries(keys.map((k) => [k, { [TIMEOUT_SETTING]: 300 }])),
        // The middle station's apply fails; the other two succeed.
        applyFails: new Set([keys[1]!]),
      });

      const adopted = await adoptStations(TEST_USER, nodeId, keys, detectedFor(keys));

      expect(adopted.length).toBe(3);
      expect(adopted.map((s) => s.stationKey).sort()).toEqual([...keys].sort());

      const [a, b, c] = keys.map((k) => adopted.find((s) => s.stationKey === k)!);

      expect(await appliedValueOf(a.id, TIMEOUT_SETTING)).toBe(900);
      expect(await configReasonOf(a.id)).toBeNull();

      expect(await appliedValueOf(b.id, TIMEOUT_SETTING)).toBeUndefined();
      expect(await configReasonOf(b.id)).toBeTruthy();

      expect(await appliedValueOf(c.id, TIMEOUT_SETTING)).toBe(900);
      expect(await configReasonOf(c.id)).toBeNull();

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  30_000,
);

test(
  "the reconcile runs after the station row exists",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    try {
      await declareFleet(TIMEOUT_SETTING, 900);
      const { nodeId, nodeSecret } = await enrollTestNode("cfgadopt-order-host");
      const stationKey = "cfgadopt-order-station";

      let rowExistedWhenPlanned = false;
      const fake = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        observed: { [stationKey]: { [TIMEOUT_SETTING]: 300 } },
        onPlanDispatched: async (dispatchedKey) => {
          if (dispatchedKey !== stationKey) return;
          const rows = await rawSql<{ id: string }[]>`
            SELECT id FROM stations WHERE node_id = ${nodeId} AND station_key = ${stationKey}`;
          rowExistedWhenPlanned = rows.length === 1;
        },
      });

      await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor([stationKey]));

      expect(fake.planCalls.length).toBeGreaterThan(0);
      expect(rowExistedWhenPlanned).toBe(true);

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "a node that REFUSES the plan records that refusal, not an unreachable node",
  async () => {
    // Finding 3, at adopt time: `reconcileStation` checked only `plan.noOp`,
    // so a refused plan went on to `applyFor`, the node answered
    // `ErrConfigOperationNotFound`, and the station's `configReason` said the
    // node could not be reached — sending the operator to debug connectivity
    // that was fine, forever, on a recorded reason.
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    try {
      await declareFleet(TIMEOUT_SETTING, 900);
      const { nodeId, nodeSecret } = await enrollTestNode("cfgadopt-planrefusal-host");
      const stationKey = "cfgadopt-planrefusal-station";
      const fake = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        observed: { [stationKey]: { [TIMEOUT_SETTING]: 300 } },
        planRefusal: {
          code: "SHAPE_UNEXPECTED",
          message: "approvals.timeout is not a scalar",
        },
      });

      const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor([stationKey]));

      // The adoption still succeeded — the invariant this whole path exists
      // to keep.
      expect(station).toBeTruthy();
      // Nothing was written, and the apply was never even attempted on a plan
      // that does not exist.
      expect(await appliedValueOf(station!.id, TIMEOUT_SETTING)).toBeUndefined();
      expect(fake.applyCalls).toEqual([]);

      const reason = await configReasonOf(station!.id);
      expect(reason).toContain("SHAPE_UNEXPECTED");
      expect(reason).toContain("not a scalar");
      expect(reason).not.toMatch(/could not be reached|unreachable|offline/i);

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "stations are reconciled concurrently, not one 15-second round trip after another",
  async () => {
    // Finding 7. Reconcile runs inside `POST /api/stations/adopt`, and every
    // broker round trip it makes carries the broker's 15s default timeout —
    // which a connected-but-wedged node pays in full. Serially, a 20-station
    // adopt could run for ten minutes with its rows already committed, so the
    // operator's client gave up and reported a failed adoption of stations
    // that were in fact adopted.
    //
    // Asserted by overlap rather than by elapsed time: the fake holds each
    // `config.observe` open, and a serial pass can never have more than one
    // open at once.
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    try {
      await declareFleet(TIMEOUT_SETTING, 900);
      const { nodeId, nodeSecret } = await enrollTestNode("cfgadopt-concurrent-host");
      const keys = ["cfgadopt-conc-a", "cfgadopt-conc-b", "cfgadopt-conc-c"];
      const fake = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        observed: Object.fromEntries(keys.map((k) => [k, { [TIMEOUT_SETTING]: 900 }])),
        observeDelayMs: 150,
      });

      const adopted = await adoptStations(TEST_USER, nodeId, keys, detectedFor(keys));

      expect(adopted.length).toBe(3);
      expect(fake.peakObserveInFlight()).toBeGreaterThan(1);

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  30_000,
);

test(
  "a wedged node does not hold the adoption past the reconcile deadline",
  async () => {
    // The other half of finding 7's bound. Called directly rather than
    // through `adoptStations` — unlike every other test in this file —
    // because the deadline this exercises is 16s in production and the point
    // is to assert the cap exists, not to wait for it.
    //
    // A node that is CONNECTED but never answers is the case that matters:
    // offline fails fast, wedged does not.
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    try {
      await declareFleet(TIMEOUT_SETTING, 900);
      const { nodeId, nodeSecret } = await enrollTestNode("cfgadopt-wedged-host");
      const stationKey = "cfgadopt-wedged-station";
      const fake = await connectFakeNode(server.port!, nodeId, nodeSecret, {
        observeNeverAnswers: true,
      });
      const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor([stationKey]));
      if (!station) throw new Error("station adoption failed");

      const startedAt = Date.now();
      const outcomes = await reconcileOnAdopt(BOOTSTRAP_TENANT_ID, [station], { deadlineMs: 250 });
      const elapsed = Date.now() - startedAt;

      // Returned on the deadline, nowhere near the 15s broker timeout the
      // wedged `config.observe` is still sitting on.
      expect(elapsed).toBeLessThan(10_000);
      expect(outcomes.length).toBe(1);
      // "pending", not "failed": nothing failed — the pass is still running
      // and records its own reason when it finishes. The deadline is one
      // broker round trip and a station's pass is `2 + 4n` of them, so a
      // merely slow node reaches it too (Minor 8).
      expect(outcomes[0]!.result).toBe("pending");
      expect(outcomes[0]!.result).not.toBe("failed");
      expect(outcomes[0]!.reason).toContain("still being reconciled");

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  30_000,
);
