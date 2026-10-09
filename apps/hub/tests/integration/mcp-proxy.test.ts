/**
 * Which stations a node's loopback MCP proxy serves — `fleet mcp-proxy list|enable|disable|rotate`.
 *
 * A real fake node over the gateway websocket, holding its own served set, so the verbs, their
 * params and the offline mapping are the real ones. What matters most: an ineligible harness is
 * refused before the node is asked, every change leaves an audit row, a declaration disagreeing
 * with the node shows as drift, and no secret ever crosses the broker.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";

import { db, rawSql } from "../../src/db/drizzle";
import { stations } from "../../src/db/schema/stations";
import { nodes } from "../../src/db/schema/nodes";
import { stationAudit } from "../../src/db/schema/audit";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser, deleteTestUser } from "../helpers/database";
import { waitForNodeOnline } from "../helpers/wait";
import { enrollNode, mintEnrollmentToken } from "../../src/services/enrollment";
import { createMcpProxyRoutes } from "../../src/routes/mcp-proxy";
import { gatewayRoutes } from "../../src/routes/gateway";
import { stationRoutes } from "../../src/routes/stations";
import { websocket } from "../../src/ws";
import { connectionManager } from "../../src/services/connection-manager";
import type { AuthUser } from "../../src/auth/middleware";
import type { StationRow } from "../../src/services/station-registry";
import { McpProxyFleetView } from "@agentpod/contract";

const RUN = crypto.randomUUID().slice(0, 8);
const TEST_USER = `usr_mcpproxy_${RUN}`;
const OTHER_USER = `usr_mcpproxy_other_${RUN}`;

function appFor() {
  return new Hono()
    .use("/api/*", async (c, next) => {
      const userId = c.req.header("X-Test-User-Id") ?? "anonymous";
      c.set("user", { id: userId, authType: "api_key", tenantId: "fleet_00000000000000000000" } satisfies AuthUser);
      return next();
    })
    .route("/public/nodes", gatewayRoutes)
    .route("/api", createMcpProxyRoutes())
    .route("/api", stationRoutes);
}

type Harness = "hermes" | "codex" | "openclaw" | "pi";

interface FakeNode {
  ws: WebSocket;
  captured: string[];
  served: Set<string>;
}

async function connectFakeNode(opts: {
  port: number;
  nodeId: string;
  nodeSecret: string;
  stations: { key: string; harness: Harness }[];
  served: Set<string>;
  captured: string[];
}): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${opts.port}/public/nodes/gateway`, {
    headers: { Authorization: `Bearer ${opts.nodeId}:${opts.nodeSecret}` },
  } as RequestInit & { headers: Record<string, string> });
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("Node WS connection error"));
  });
  ws.onmessage = (e) => {
    const raw = String(e.data);
    opts.captured.push(raw);
    const msg = JSON.parse(raw) as { type: string; id: string; verb: string; params: Record<string, unknown> };
    if (msg.type !== "req") return;
    const ok = (data: unknown) => ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data }));
    switch (msg.verb) {
      case "detect":
        return ok(
          opts.stations.map((s) => ({
            key: s.key,
            harness: s.harness,
            kind: "leaf",
            displayName: `Station ${s.key}`,
            parentKey: null,
            workspacePath: `/workspace/${s.key}`,
            capabilities: ["health"],
          })),
        );
      case "mcp.proxy.status":
        return ok({ running: true, stations: [...opts.served].sort() });
      case "mcp.proxy.set": {
        for (const id of (msg.params.enable as string[] | undefined) ?? []) opts.served.add(id);
        for (const id of (msg.params.disable as string[] | undefined) ?? []) opts.served.delete(id);
        return ok({ stations: [...opts.served].sort() });
      }
      case "mcp.proxy.rotate": {
        const named = (msg.params.stations as string[] | undefined) ?? [...opts.served];
        return ok({ rotated: named.filter((id) => opts.served.has(id)).sort() });
      }
    }
  };
  await waitForNodeOnline(opts.nodeId);
  return ws;
}

/** A node with one station per harness, adopted, advertising proxy management unless told not to. */
async function withNode(opts: { harnesses: Harness[]; capable?: boolean; served?: string[] }) {
  const server = Bun.serve({ fetch: appFor().fetch, websocket, port: 0 });
  const baseUrl = `http://localhost:${server.port}`;
  const tag = crypto.randomUUID().slice(0, 8);
  const stationDefs = opts.harnesses.map((harness, i) => ({ key: `${harness}:mcp-${tag}-${i}`, harness }));
  const { token } = await mintEnrollmentToken(TEST_USER);
  const { nodeId, nodeSecret } = await enrollNode(token, { hostname: `mcp-host-${tag}`, os: "linux", arch: "amd64", cpuCount: 2 });
  const captured: string[] = [];
  const served = new Set<string>();
  const ws = await connectFakeNode({ port: server.port!, nodeId, nodeSecret, stations: stationDefs, served, captured });
  if (opts.capable !== false) {
    await db.update(nodes).set({ capabilities: ["mcp.proxy", "mcp.proxy.manage"] }).where(eq(nodes.id, nodeId));
  }
  const res = await fetch(`${baseUrl}/api/nodes/${nodeId}/stations/adopt`, {
    method: "POST",
    headers: { "X-Test-User-Id": TEST_USER, "Content-Type": "application/json" },
    body: JSON.stringify({ keys: stationDefs.map((s) => s.key) }),
  });
  expect(res.status).toBe(200);
  const rows = (await res.json()) as StationRow[];
  const byHarness = (h: Harness) => rows.find((r) => r.harness === h)!;
  const node: FakeNode = { ws, captured, served };
  const stop = () => {
    ws.close();
    server.stop(true);
  };
  return { baseUrl, nodeId, rows, byHarness, node, stop };
}

function reqsFor(msgs: string[], verb: string): Record<string, unknown>[] {
  return msgs
    .map((raw) => JSON.parse(raw) as { type: string; verb: string; params: Record<string, unknown> })
    .filter((m) => m.type === "req" && m.verb === verb)
    .map((m) => m.params);
}

const change = (baseUrl: string, body: unknown, user = TEST_USER) =>
  fetch(`${baseUrl}/api/fleet/mcp-proxy`, {
    method: "POST",
    headers: { "X-Test-User-Id": user, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const list = async (baseUrl: string, nodeId?: string) => {
  const res = await fetch(`${baseUrl}/api/fleet/mcp-proxy${nodeId ? `?nodeId=${nodeId}` : ""}`, {
    headers: { "X-Test-User-Id": TEST_USER },
  });
  expect(res.status).toBe(200);
  return McpProxyFleetView.parse(await res.json());
};

async function auditRows(stationKey: string, verb: string) {
  return db
    .select()
    .from(stationAudit)
    .where(and(eq(stationAudit.stationKey, stationKey), eq(stationAudit.verb, verb)));
}

async function declared(stationId: string) {
  const [row] = await db.select({ v: stations.mcpProxy }).from(stations).where(eq(stations.id, stationId));
  return row?.v ?? null;
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: TEST_USER, email: `mcp-proxy-${RUN}@example.com`, name: "MCP proxy test" });
  await createTestUser({ id: OTHER_USER, email: `mcp-proxy-other-${RUN}@example.com`, name: "MCP proxy other" });
});

afterAll(async () => {
  for (const u of [TEST_USER, OTHER_USER]) {
    try {
      await rawSql`DELETE FROM station_audit     WHERE user_id = ${u}`;
      await rawSql`DELETE FROM stations          WHERE user_id = ${u}`;
      await rawSql`DELETE FROM nodes             WHERE user_id = ${u}`;
      await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${u}`;
      await deleteTestUser(u);
    } catch {
      // ignore
    }
  }
});

describe("enable / disable", () => {
  test("enable asks the node, records the declaration and writes an audit row", async () => {
    const ctx = await withNode({ harnesses: ["hermes"] });
    try {
      const st = ctx.byHarness("hermes");
      const res = await change(ctx.baseUrl, { action: "enable", stationIds: [st.id] });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { stationId: string; nodeId: string; ok: boolean }[] };
      expect(body.results).toEqual([{ stationId: st.id, nodeId: ctx.nodeId, ok: true }]);
      expect(reqsFor(ctx.node.captured, "mcp.proxy.set")).toEqual([{ enable: [st.id] }]);
      expect(ctx.node.served.has(st.id)).toBe(true);
      expect(await declared(st.id)).toBe(true);
      const audit = await auditRows(st.stationKey, "mcp.proxy.enable");
      expect(audit.length).toBe(1);
      expect(audit[0]!.result).toBe("ok");
      expect(audit[0]!.nodeId).toBe(ctx.nodeId);
    } finally {
      ctx.stop();
    }
  });

  test("disable takes it away, declared off, audited", async () => {
    const ctx = await withNode({ harnesses: ["codex"] });
    try {
      const st = ctx.byHarness("codex");
      ctx.node.served.add(st.id);
      const res = await change(ctx.baseUrl, { action: "disable", stationIds: [st.id] });
      expect(res.status).toBe(200);
      expect(reqsFor(ctx.node.captured, "mcp.proxy.set")).toEqual([{ disable: [st.id] }]);
      expect(ctx.node.served.has(st.id)).toBe(false);
      expect(await declared(st.id)).toBe(false);
      expect((await auditRows(st.stationKey, "mcp.proxy.disable"))[0]!.result).toBe("ok");
    } finally {
      ctx.stop();
    }
  });

  for (const harness of ["openclaw", "pi"] as const) {
    test(`enabling a ${harness} station is refused before the node is asked`, async () => {
      const ctx = await withNode({ harnesses: ["hermes", harness] });
      try {
        const bad = ctx.byHarness(harness);
        const good = ctx.byHarness("hermes");
        const res = await change(ctx.baseUrl, { action: "enable", stationIds: [good.id, bad.id] });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: string; refused: { stationId: string; harness: string }[] };
        expect(body.error).toContain("HTTP MCP");
        expect(body.refused).toEqual([{ stationId: bad.id, harness }]);
        // Nothing half-done: the eligible station named alongside is not enabled either.
        expect(reqsFor(ctx.node.captured, "mcp.proxy.set")).toEqual([]);
        expect(await declared(good.id)).toBeNull();
        expect(await auditRows(good.stationKey, "mcp.proxy.enable")).toEqual([]);
      } finally {
        ctx.stop();
      }
    });
  }

  test("--all-eligible enables every eligible station and skips OpenClaw and Pi", async () => {
    const ctx = await withNode({ harnesses: ["hermes", "codex", "openclaw", "pi"] });
    try {
      const res = await change(ctx.baseUrl, { action: "enable", allEligible: true, nodeId: ctx.nodeId });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { stationId: string }[]; skipped: { stationId: string; harness: string }[] };
      const want = [ctx.byHarness("hermes").id, ctx.byHarness("codex").id].sort();
      expect(body.results.map((r) => r.stationId).sort()).toEqual(want);
      expect(body.skipped.map((s) => s.harness).sort()).toEqual(["openclaw", "pi"]);
      expect([...ctx.node.served].sort()).toEqual(want);
    } finally {
      ctx.stop();
    }
  });

  test("an unknown or someone else's station is a 404 and nothing is sent", async () => {
    const ctx = await withNode({ harnesses: ["hermes"] });
    try {
      const st = ctx.byHarness("hermes");
      expect((await change(ctx.baseUrl, { action: "enable", stationIds: ["st_nope"] })).status).toBe(404);
      expect((await change(ctx.baseUrl, { action: "enable", stationIds: [st.id] }, OTHER_USER)).status).toBe(404);
      expect(reqsFor(ctx.node.captured, "mcp.proxy.set")).toEqual([]);
    } finally {
      ctx.stop();
    }
  });

  test("a node that cannot manage its proxy is a 409, nothing declared, the failure audited", async () => {
    const ctx = await withNode({ harnesses: ["hermes"], capable: false });
    try {
      const st = ctx.byHarness("hermes");
      const res = await change(ctx.baseUrl, { action: "enable", stationIds: [st.id] });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { results: { error: string }[] }).results[0]!.error).toContain("update");
      expect(reqsFor(ctx.node.captured, "mcp.proxy.set")).toEqual([]);
      expect(await declared(st.id)).toBeNull();
      expect((await auditRows(st.stationKey, "mcp.proxy.enable"))[0]!.result).toBe("error");
    } finally {
      ctx.stop();
    }
  });

  test("an offline node is a 409 and nothing is declared", async () => {
    const ctx = await withNode({ harnesses: ["hermes"] });
    const st = ctx.byHarness("hermes");
    ctx.node.ws.close();
    try {
      // A condition, not a sleep: the route must see the node as gone.
      for (let i = 0; i < 200 && connectionManager.isOnline(ctx.nodeId); i++) {
        await new Promise((res) => setTimeout(res, 10));
      }
      expect(connectionManager.isOnline(ctx.nodeId)).toBe(false);
      const res = await change(ctx.baseUrl, { action: "enable", stationIds: [st.id] });
      expect(res.status).toBe(409);
      expect(await declared(st.id)).toBeNull();
      expect((await auditRows(st.stationKey, "mcp.proxy.enable"))[0]!.result).toBe("error");
    } finally {
      ctx.stop();
    }
  });
});

describe("list and drift", () => {
  test("a hand-edited node config reads as on with no declaration — no migration step", async () => {
    const ctx = await withNode({ harnesses: ["hermes", "codex"] });
    try {
      const st = ctx.byHarness("hermes");
      ctx.node.served.add(st.id);
      const view = await list(ctx.baseUrl, ctx.nodeId);
      const node = view.nodes.find((n) => n.nodeId === ctx.nodeId)!;
      expect(node.reachable).toBe(true);
      const row = node.stations.find((s) => s.stationId === st.id)!;
      expect(row).toMatchObject({ declared: null, serving: true, state: "on", eligible: true });
      expect(node.stations.find((s) => s.harness === "codex")!.state).toBe("off");
      expect(view.drifted).toBe(0);
    } finally {
      ctx.stop();
    }
  });

  test("a declaration the node disagrees with is drift, both ways, and so is an unadopted id", async () => {
    const ctx = await withNode({ harnesses: ["hermes", "codex", "openclaw"] });
    try {
      const h = ctx.byHarness("hermes");
      const c = ctx.byHarness("codex");
      const o = ctx.byHarness("openclaw");
      await change(ctx.baseUrl, { action: "enable", stationIds: [h.id] });
      await change(ctx.baseUrl, { action: "disable", stationIds: [c.id] });
      // Hand edits behind the hub's back.
      ctx.node.served.delete(h.id);
      ctx.node.served.add(c.id);
      ctx.node.served.add(o.id);
      ctx.node.served.add("st_not_adopted_here");

      const view = await list(ctx.baseUrl, ctx.nodeId);
      const node = view.nodes.find((n) => n.nodeId === ctx.nodeId)!;
      const state = (id: string) => node.stations.find((s) => s.stationId === id)!.state;
      expect(state(h.id)).toBe("drifted");
      expect(state(c.id)).toBe("drifted");
      expect(state(o.id)).toBe("ineffective");
      expect(node.unadoptedStations).toEqual(["st_not_adopted_here"]);
      expect(view.drifted).toBe(4);
    } finally {
      ctx.stop();
    }
  });

  test("a node that cannot be asked reads as unknown, not off", async () => {
    const ctx = await withNode({ harnesses: ["hermes"], capable: false });
    try {
      const view = await list(ctx.baseUrl, ctx.nodeId);
      const node = view.nodes.find((n) => n.nodeId === ctx.nodeId)!;
      expect(node.reachable).toBe(false);
      expect(node.stations[0]!.state).toBe("unknown");
      expect(node.stations[0]!.serving).toBeNull();
    } finally {
      ctx.stop();
    }
  });

  test("one station's view, for the console", async () => {
    const ctx = await withNode({ harnesses: ["hermes"] });
    try {
      const st = ctx.byHarness("hermes");
      ctx.node.served.add(st.id);
      const res = await fetch(`${ctx.baseUrl}/api/stations/${st.id}/mcp-proxy`, { headers: { "X-Test-User-Id": TEST_USER } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ stationId: st.id, serving: true, state: "on", eligible: true });
      const other = await fetch(`${ctx.baseUrl}/api/stations/${st.id}/mcp-proxy`, { headers: { "X-Test-User-Id": OTHER_USER } });
      expect(other.status).toBe(404);
    } finally {
      ctx.stop();
    }
  });
});

describe("rotate", () => {
  test("asks the node to rotate the named stations, audits it, and carries no secret", async () => {
    const ctx = await withNode({ harnesses: ["hermes", "codex"] });
    try {
      const h = ctx.byHarness("hermes");
      ctx.node.served.add(h.id);
      const res = await fetch(`${ctx.baseUrl}/api/fleet/mcp-proxy/rotate`, {
        method: "POST",
        headers: { "X-Test-User-Id": TEST_USER, "Content-Type": "application/json" },
        body: JSON.stringify({ stationIds: [h.id] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [{ stationId: h.id, nodeId: ctx.nodeId, ok: true }] });
      expect(reqsFor(ctx.node.captured, "mcp.proxy.rotate")).toEqual([{ stations: [h.id] }]);
      expect((await auditRows(h.stationKey, "mcp.proxy.rotate"))[0]!.result).toBe("ok");
      expect(ctx.node.captured.join("\n")).not.toMatch(/secret/i);
    } finally {
      ctx.stop();
    }
  });

  test("rotating a station the node does not serve says so", async () => {
    const ctx = await withNode({ harnesses: ["codex"] });
    try {
      const c = ctx.byHarness("codex");
      const res = await fetch(`${ctx.baseUrl}/api/fleet/mcp-proxy/rotate`, {
        method: "POST",
        headers: { "X-Test-User-Id": TEST_USER, "Content-Type": "application/json" },
        body: JSON.stringify({ stationIds: [c.id] }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { results: { ok: boolean; error: string }[] };
      expect(body.results[0]!.ok).toBe(false);
      expect(body.results[0]!.error).toContain("does not serve");
    } finally {
      ctx.stop();
    }
  });
});
