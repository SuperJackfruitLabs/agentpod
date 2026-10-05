/**
 * Integration Test: an operator's opt-out on the MANUAL write path
 * (`plan`/`apply`), not just adopt-time reconcile or `compare()`.
 *
 * The design decision is explicit: "An explicit operator opt-out wins.
 * Declared state does not override it. Such a station reports `opted-out`,
 * not `drifted`." Before this file, the opt-out register
 * (`harness_config_opt_out`, `src/services/harness-config.ts`) was honoured
 * in exactly two places — `reconcileStation` (adopt-time) and `compare()`
 * (the read-only observation state) — and nowhere on the path a human drives
 * by hand: `POST .../config/plan` and `POST .../config/apply`
 * (`src/services/harness-config-apply.ts`). An operator could opt a station
 * out and have `fleet config plan` / `fleet config apply` write the setting
 * anyway.
 *
 * This file proves:
 *
 *   1. `plan` on a single opted-out setting refuses with `OPTED_OUT`, naming
 *      it, and never dispatches `config.plan` to the node at all.
 *   2. `apply` refuses an opted-out setting even when the plan was reviewed
 *      BEFORE the opt-out existed — the race the adopt-time check alone
 *      cannot close, because a plan can sit reviewed for any length of time
 *      before someone applies it.
 *   3. The opted-out setting's document is unchanged after that refused
 *      apply.
 *   4. A plan mixing one opted-out setting with one ordinary setting refuses
 *      only the opted-out entry — not the whole plan — because
 *      `fleet config plan --station ID` plans every setting currently
 *      declared for a station, and a whole-plan refusal would let one
 *      opt-out block writing anything else to that station.
 *   5. Clearing the opt-out lets the same plan/apply succeed again.
 *
 * Follows `tests/integration/harness-config-apply.test.ts`'s fixture: a
 * minimal test Hono app with a fake `X-Test-User-Id` auth middleware, the
 * real gateway + harness-config routes, and a fake node connected over the
 * real WebSocket gateway. This file's fake node additionally tracks a tiny
 * in-memory "document" per setting, so a test can assert a refused apply
 * never wrote anything — the same way a real node's config file would stay
 * untouched.
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
import { declare, setOptOut, clearOptOut } from "../../src/services/harness-config";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/tenant-scope";
import { gatewayRoutes } from "../../src/routes/gateway";
import { harnessConfigRoutes } from "../../src/routes/harness-config";
import { websocket } from "../../src/ws";
import type { AuthUser } from "../../src/auth/middleware";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER = "test-user-cfgoptout-001";
const SETTING_A = "hermes.approvals.timeout";
const SETTING_B = "hermes.approvals.mode";

const REGISTRY = [
  { id: SETTING_A, harness: "hermes", scope: "profile", policy: "reconcilable", restartToTakeEffect: false },
  { id: SETTING_B, harness: "hermes", scope: "profile", policy: "reconcilable", restartToTakeEffect: false },
];

const INITIAL_DOCUMENT: Record<string, unknown> = { [SETTING_A]: "300", [SETTING_B]: "standard" };

const FAKE_GATEWAY_PID = 55123;

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
    email: "cfgoptout-test@example.com",
    name: "Config Opt-Out Test User",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM applied_harness_config WHERE station_id IN (SELECT id FROM stations WHERE user_id = ${TEST_USER})`;
    await rawSql`DELETE FROM declared_harness_config WHERE declared_by = ${TEST_USER}`;
    await rawSql`DELETE FROM harness_config_opt_out  WHERE opted_out_by = ${TEST_USER}`;
    await rawSql`DELETE FROM station_audit           WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM stations                WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM nodes                   WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens        WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM "user"                  WHERE id = ${TEST_USER}`;
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
      displayName: "Config Opt-Out Test",
      parentKey: null,
      workspacePath: `/workspace/${stationKey}`,
      capabilities: ["health", "config.manage"],
      matrixId: null,
      adopted: false,
    },
  ];
}

type FakePlanEntry = {
  settingId: string;
  file: string;
  keyPath: string;
  policy: string;
  current: unknown;
  intended: unknown;
  action: string;
  restartToTakeEffect: boolean;
};

type FakePlan = {
  schemaVersion: 1;
  operationId: string;
  stationKey: string;
  entries: FakePlanEntry[];
  beforeSha256: string;
  diff: string;
  diffTruncated: boolean;
  noOp: boolean;
  restartRequired: boolean;
  createdAt: string;
  planDigest: string;
};

/**
 * A fake node that answers `config.settings`, `config.observe`,
 * `config.plan`, `config.apply`, `config.inspect` and `health`, and tracks
 * a tiny in-memory "document" per setting — mutated ONLY by a successful
 * `config.apply` — so a test can assert a refused apply never wrote
 * anything, and `config.observe` always reads the current document back
 * (needed by `GET /api/stations/:id/config`'s `observeStation`, and by
 * adopt-time reconcile).
 *
 * `config.plan` accepts a multi-entry `want` (unlike the single-entry fake
 * node in `harness-config-apply.test.ts`), because the mixed opted-out /
 * ordinary test here needs a plan covering more than one setting.
 *
 * `config.inspect` answers for an operation that was only PLANNED, not yet
 * applied — phase `"planned"`, mirroring the real node's journal (see
 * `apps/node-agent/internal/descriptor/hermes_config.go`'s comment: "A plan
 * with no refusal IS recorded — phase 'planned' — in the station's own
 * journal"). `applyFor`'s opt-out check needs exactly this: it inspects the
 * plan BEFORE ever calling `config.apply`, so inspect must answer for a plan
 * nobody has applied yet.
 */
async function connectOptOutFakeNode(
  serverPort: number,
  nodeId: string,
  nodeSecret: string,
): Promise<{
  ws: WebSocket;
  asked: string[];
  documents: Map<string, unknown>;
  plans: Map<string, FakePlan>;
}> {
  const asked: string[] = [];
  const documents = new Map<string, unknown>(Object.entries(INITIAL_DOCUMENT));
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
      ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: { settings: REGISTRY } }));
      return;
    }

    if (verb === "config.observe") {
      const params = msg.params as { stationKey: string; settings: string[] };
      const values = params.settings.map((settingId) => ({
        settingId,
        observed: documents.get(settingId),
        readable: true,
      }));
      ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: { values } }));
      return;
    }

    if (verb === "config.plan") {
      const params = msg.params as {
        stationKey: string;
        operationId: string;
        want: Array<{ settingId: string; value: unknown }>;
      };
      const entries: FakePlanEntry[] = params.want.map((w) => {
        const current = documents.get(w.settingId);
        return {
          settingId: w.settingId,
          file: "/workspace/config.yaml",
          keyPath: w.settingId,
          policy: "reconcilable",
          current,
          intended: w.value,
          action: current === w.value ? "noop" : "modify",
          restartToTakeEffect: false,
        };
      });
      const plan: FakePlan = {
        schemaVersion: 1,
        operationId: params.operationId,
        stationKey: params.stationKey,
        entries,
        beforeSha256: "before-sha",
        diff: entries.map((en) => `- ${en.current}\n+ ${en.intended}`).join("\n"),
        diffTruncated: false,
        noOp: entries.every((en) => en.action === "noop"),
        restartRequired: false,
        createdAt: new Date().toISOString(),
        planDigest: `digest-${params.operationId}`,
      };
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
      const written: Array<{ settingId: string; action: string; wrote: unknown }> = [];
      for (const entry of plan.entries) {
        if (entry.action === "noop") continue;
        documents.set(entry.settingId, entry.intended);
        written.push({ settingId: entry.settingId, action: entry.action, wrote: entry.intended });
      }
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
      if (receipt) {
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: receipt }));
        return;
      }
      const plan = plans.get(params.operationId);
      if (plan) {
        ws.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            data: { plan, phase: "planned", updatedAt: plan.createdAt, written: [] },
          }),
        );
        return;
      }
      ws.send(JSON.stringify({ type: "res", id: msg.id, ok: false, error: "operation not found" }));
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
  return { ws, asked, documents, plans };
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

async function setUpStation(hostname: string, stationKey: string) {
  const { nodeId, nodeSecret } = await enrollTestNode(hostname);
  const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor(stationKey));
  if (!station) throw new Error("station adoption failed");
  return { station, nodeId, nodeSecret };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "plan on an opted-out setting refuses with OPTED_OUT, naming it, and never asks the node to plan",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const stationKey = "cfgoptout-plan-station";
      const { station, nodeId, nodeSecret } = await setUpStation("cfgoptout-plan-host", stationKey);
      const fake = await connectOptOutFakeNode(server.port!, nodeId, nodeSecret);

      await setOptOut({
        stationKey,
        settingId: SETTING_A,
        optedOut: true,
        tenantId: BOOTSTRAP_TENANT_ID,
        optedOutBy: TEST_USER,
      });

      const res = await appFetch(baseUrl, `/api/stations/${station.id}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        body: { settings: [{ settingId: SETTING_A, value: "900" }] },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code?: string };
      expect(body.code).toBe("OPTED_OUT");
      expect(body.error).toInclude(SETTING_A);

      // The registry check (`config.settings`) may have been asked; the
      // planning verb itself must never have been dispatched for a setting
      // every bit of the request was opted out of.
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
  "apply refuses an opted-out setting even when the plan was made before the opt-out existed, and the document is unchanged",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const stationKey = "cfgoptout-race-station";
      const { station, nodeId, nodeSecret } = await setUpStation("cfgoptout-race-host", stationKey);
      const fake = await connectOptOutFakeNode(server.port!, nodeId, nodeSecret);

      // Plan FIRST, while nothing is opted out.
      const planRes = await appFetch(baseUrl, `/api/stations/${station.id}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        body: { settings: [{ settingId: SETTING_A, value: "900" }] },
      });
      expect(planRes.status).toBe(200);
      const plan = (await planRes.json()) as FakePlan;
      expect(plan.entries[0]?.settingId).toBe(SETTING_A);

      // THEN the operator opts the station out of this exact setting — the
      // window between a reviewed plan and its apply is exactly where this
      // matters most.
      await setOptOut({
        stationKey,
        settingId: SETTING_A,
        optedOut: true,
        tenantId: BOOTSTRAP_TENANT_ID,
        optedOutBy: TEST_USER,
      });

      const applyRes = await appFetch(baseUrl, `/api/stations/${station.id}/config/apply`, {
        method: "POST",
        token: TEST_USER,
        body: { operationId: plan.operationId, planDigest: plan.planDigest },
      });
      expect(applyRes.status).toBe(400);
      const body = (await applyRes.json()) as { error: string; code?: string };
      expect(body.code).toBe("OPTED_OUT");
      expect(body.error).toInclude(SETTING_A);

      // `config.apply` must never have been dispatched to the node.
      expect(fake.asked).not.toContain("config.apply");

      // The document is unchanged — still the original value, not "900".
      expect(fake.documents.get(SETTING_A)).toBe("300");

      // No evidence of a write was recorded either.
      const rows = await rawSql`
        SELECT 1 FROM applied_harness_config
        WHERE station_id = ${station.id} AND setting_id = ${SETTING_A}`;
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
  "a plan mixing one opted-out setting and one ordinary setting refuses only the opted-out entry, and applying it writes only the ordinary one",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const stationKey = "cfgoptout-mixed-station";
      const { station, nodeId, nodeSecret } = await setUpStation("cfgoptout-mixed-host", stationKey);
      const fake = await connectOptOutFakeNode(server.port!, nodeId, nodeSecret);

      await setOptOut({
        stationKey,
        settingId: SETTING_A,
        optedOut: true,
        tenantId: BOOTSTRAP_TENANT_ID,
        optedOutBy: TEST_USER,
      });

      // DECISION: a mixed request refuses only the opted-out entry, not the
      // whole plan. `fleet config plan --station ID` plans every setting
      // currently declared for a station with no way to narrow it — a
      // whole-plan refusal would let one opt-out block writing anything
      // else to that station, which is the wrong failure mode for an
      // explicit, single-setting operator choice.
      const planRes = await appFetch(baseUrl, `/api/stations/${station.id}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        body: {
          settings: [
            { settingId: SETTING_A, value: "900" },
            { settingId: SETTING_B, value: "strict" },
          ],
        },
      });
      expect(planRes.status).toBe(200);
      const body = (await planRes.json()) as FakePlan & {
        refused?: Array<{ settingId: string; code: string; message: string }>;
      };

      // The plan itself covers only the ordinary setting.
      expect(body.entries.map((e) => e.settingId)).toEqual([SETTING_B]);

      // The opted-out setting is named in a refusal carried alongside the
      // plan, never silently dropped.
      expect(body.refused?.length).toBe(1);
      expect(body.refused?.[0]?.settingId).toBe(SETTING_A);
      expect(body.refused?.[0]?.code).toBe("OPTED_OUT");

      const applyRes = await appFetch(baseUrl, `/api/stations/${station.id}/config/apply`, {
        method: "POST",
        token: TEST_USER,
        body: { operationId: body.operationId, planDigest: body.planDigest },
      });
      expect(applyRes.status).toBe(200);
      const receipt = (await applyRes.json()) as { phase: string; written: Array<{ settingId: string }> };
      expect(receipt.phase).toBe("applied");
      expect(receipt.written.map((w) => w.settingId)).toEqual([SETTING_B]);

      // The opted-out setting's document is untouched; the ordinary one was written.
      expect(fake.documents.get(SETTING_A)).toBe("300");
      expect(fake.documents.get(SETTING_B)).toBe("strict");

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "clearing the opt-out lets the same plan/apply succeed",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const stationKey = "cfgoptout-cleared-station";
      const { station, nodeId, nodeSecret } = await setUpStation("cfgoptout-cleared-host", stationKey);
      const fake = await connectOptOutFakeNode(server.port!, nodeId, nodeSecret);

      await setOptOut({
        stationKey,
        settingId: SETTING_A,
        optedOut: true,
        tenantId: BOOTSTRAP_TENANT_ID,
        optedOutBy: TEST_USER,
      });

      const refusedRes = await appFetch(baseUrl, `/api/stations/${station.id}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        body: { settings: [{ settingId: SETTING_A, value: "900" }] },
      });
      expect(refusedRes.status).toBe(400);

      await clearOptOut({ stationKey, settingId: SETTING_A, tenantId: BOOTSTRAP_TENANT_ID });

      const planRes = await appFetch(baseUrl, `/api/stations/${station.id}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        body: { settings: [{ settingId: SETTING_A, value: "900" }] },
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
      expect(fake.documents.get(SETTING_A)).toBe("900");

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

// ─── Task 3: the same two callers (plan/apply) honour a NODE-level opt-out,
// and the station-row `optedOut=false` override reaches them too ─────────────
//
// Tasks 1-2 shipped the register's two levels and `resolveOptOuts`'s
// most-specific-first resolution; the four production call sites were
// already wired to it (observeStation, reconcileStation, planFor, applyFor)
// before this file's tests existed. What follows is the integration proof
// that the wiring holds at both ends of the manual write path AND the
// read-only observation route — not new production code.

test(
  "a station row optedOut=false lets plan and apply proceed despite a node row saying exempt",
  async () => {
    // THE proof of R1 end-to-end, through the real routes: a station can opt
    // back IN against a fleet-wide (node-level) exemption. Collapsing
    // "absent" and "false" in `resolveOptOuts` would make this impossible —
    // this is the test that would fail first if that collapse crept back in.
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const stationKey = "cfgoptout-override-station";
      const { station, nodeId, nodeSecret } = await setUpStation("cfgoptout-override-host", stationKey);
      const fake = await connectOptOutFakeNode(server.port!, nodeId, nodeSecret);

      // The whole node is exempt...
      await setOptOut({
        nodeId,
        settingId: SETTING_A,
        optedOut: true,
        tenantId: BOOTSTRAP_TENANT_ID,
        optedOutBy: TEST_USER,
      });
      // ...but THIS station explicitly opts back in.
      await setOptOut({
        stationKey,
        settingId: SETTING_A,
        optedOut: false,
        tenantId: BOOTSTRAP_TENANT_ID,
        optedOutBy: TEST_USER,
      });

      const planRes = await appFetch(baseUrl, `/api/stations/${station.id}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        body: { settings: [{ settingId: SETTING_A, value: "900" }] },
      });
      expect(planRes.status).toBe(200);
      const plan = (await planRes.json()) as FakePlan;
      expect(plan.entries[0]?.settingId).toBe(SETTING_A);

      const applyRes = await appFetch(baseUrl, `/api/stations/${station.id}/config/apply`, {
        method: "POST",
        token: TEST_USER,
        body: { operationId: plan.operationId, planDigest: plan.planDigest },
      });
      expect(applyRes.status).toBe(200);
      const receipt = (await applyRes.json()) as { phase: string };
      expect(receipt.phase).toBe("applied");
      expect(fake.documents.get(SETTING_A)).toBe("900");

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "GET /api/stations/:id/config reports opted-out for a NODE-level exemption",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const stationKey = "cfgoptout-node-observe-station";
      const { station, nodeId, nodeSecret } = await setUpStation("cfgoptout-node-observe-host", stationKey);
      const fake = await connectOptOutFakeNode(server.port!, nodeId, nodeSecret);

      // Declared at fleet level so `observeStation` has something to compare —
      // without a declaration the setting is simply absent from the report.
      await declare({
        settingId: SETTING_A,
        stationId: null,
        nodeId: null,
        value: "900",
        tenantId: BOOTSTRAP_TENANT_ID,
        declaredBy: TEST_USER,
      });
      await setOptOut({
        nodeId,
        settingId: SETTING_A,
        optedOut: true,
        tenantId: BOOTSTRAP_TENANT_ID,
        optedOutBy: TEST_USER,
      });

      const res = await appFetch(baseUrl, `/api/stations/${station.id}/config`, { token: TEST_USER });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { observations: Array<{ settingId: string; state: string }> };
      const obs = body.observations.find((o) => o.settingId === SETTING_A);
      expect(obs?.state).toBe("opted-out");

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "plan refuses a NODE-level exempted setting, naming it",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const stationKey = "cfgoptout-node-plan-station";
      const { station, nodeId, nodeSecret } = await setUpStation("cfgoptout-node-plan-host", stationKey);
      const fake = await connectOptOutFakeNode(server.port!, nodeId, nodeSecret);

      await setOptOut({
        nodeId,
        settingId: SETTING_A,
        optedOut: true,
        tenantId: BOOTSTRAP_TENANT_ID,
        optedOutBy: TEST_USER,
      });

      const res = await appFetch(baseUrl, `/api/stations/${station.id}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        body: { settings: [{ settingId: SETTING_A, value: "900" }] },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code?: string };
      expect(body.code).toBe("OPTED_OUT");
      expect(body.error).toInclude(SETTING_A);
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
  "apply refuses a NODE-level exempted setting even when the plan predates the exemption",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const stationKey = "cfgoptout-node-apply-station";
      const { station, nodeId, nodeSecret } = await setUpStation("cfgoptout-node-apply-host", stationKey);
      const fake = await connectOptOutFakeNode(server.port!, nodeId, nodeSecret);

      // Plan FIRST, while the node is not yet exempt.
      const planRes = await appFetch(baseUrl, `/api/stations/${station.id}/config/plan`, {
        method: "POST",
        token: TEST_USER,
        body: { settings: [{ settingId: SETTING_A, value: "900" }] },
      });
      expect(planRes.status).toBe(200);
      const plan = (await planRes.json()) as FakePlan;

      // THEN the operator exempts the whole node.
      await setOptOut({
        nodeId,
        settingId: SETTING_A,
        optedOut: true,
        tenantId: BOOTSTRAP_TENANT_ID,
        optedOutBy: TEST_USER,
      });

      const applyRes = await appFetch(baseUrl, `/api/stations/${station.id}/config/apply`, {
        method: "POST",
        token: TEST_USER,
        body: { operationId: plan.operationId, planDigest: plan.planDigest },
      });
      expect(applyRes.status).toBe(400);
      const body = (await applyRes.json()) as { error: string; code?: string };
      expect(body.code).toBe("OPTED_OUT");
      expect(body.error).toInclude(SETTING_A);
      expect(fake.asked).not.toContain("config.apply");
      expect(fake.documents.get(SETTING_A)).toBe("300");

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

test(
  "adopt-time reconcile skips a NODE-level exempted setting",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    try {
      const { nodeId, nodeSecret } = await enrollTestNode("cfgoptout-node-adopt-host");
      const stationKey = "cfgoptout-node-adopt-station";

      // Declared at fleet level, and the setting's observed value differs —
      // this would be planned and applied if not for the node-level
      // exemption set BEFORE the station is even adopted.
      await declare({
        settingId: SETTING_A,
        stationId: null,
        nodeId: null,
        value: "900",
        tenantId: BOOTSTRAP_TENANT_ID,
        declaredBy: TEST_USER,
      });
      await setOptOut({
        nodeId,
        settingId: SETTING_A,
        optedOut: true,
        tenantId: BOOTSTRAP_TENANT_ID,
        optedOutBy: TEST_USER,
      });

      const fake = await connectOptOutFakeNode(server.port!, nodeId, nodeSecret);
      const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detectedFor(stationKey));
      if (!station) throw new Error("station adoption failed");

      expect(fake.asked).not.toContain("config.plan");
      expect(fake.documents.get(SETTING_A)).toBe("300");

      const rows = await rawSql`
        SELECT 1 FROM applied_harness_config
        WHERE station_id = ${station.id} AND setting_id = ${SETTING_A}`;
      expect(rows.length).toBe(0);

      fake.ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000,
);
