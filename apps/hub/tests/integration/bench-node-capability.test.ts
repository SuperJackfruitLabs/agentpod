/**
 * A node that advertises `bench.registry.manage` in its hello frame is asked, end to end.
 *
 * Through the real gateway: the hello frame is parsed by the contract, its capabilities stored on
 * the node row, and `fleet bench` decides from that row whether the node can be asked. The
 * capability was once filtered out by that parse, so every node read as too old and every bench
 * verb refused with "update it (fleet nodes update)". A test that seeded the row directly could
 * not see it.
 */
process.env.DATABASE_URL ||= "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";

import { rawSql } from "../../src/db/drizzle";
import { createTestUser, deleteTestUser } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { enrollNode, mintEnrollmentToken } from "../../src/services/nodes/enrollment";
import { listNodes } from "../../src/services/nodes/registry";
import { gatewayRoutes } from "../../src/routes/gateway";
import { websocket } from "../../src/ws";
import { nodeRegistryStatus } from "../../src/services/bridge/bench-node";
import { pollUntil, waitForNodeOnline } from "../helpers/wait";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";

const USER = `test-user-bench-cap-${crypto.randomUUID().slice(0, 8)}`;
const app = new Hono().route("/public/nodes", gatewayRoutes);
/** What the node puts in its hello today (gateway.NodeCapabilities plus run.go's extras). */
const HELLO_CAPABILITIES = ["posture", "frames.large", "mcp.proxy", "mcp.proxy.manage", "bench.registry.manage", "turn.errors", "fleet.reports"];
const Request = z.object({ type: z.literal("req"), id: z.string(), verb: z.string() });

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER, email: `${USER}@example.com`, name: "bench capability" });
});

afterAll(async () => {
  await rawSql`DELETE FROM nodes WHERE user_id = ${USER}`;
  await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${USER}`;
  await deleteTestUser(USER);
});

test("a node advertising bench.registry.manage is stored with it and asked for its registry", async () => {
  const server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  try {
    const { token } = await mintEnrollmentToken(USER, BOOTSTRAP_TENANT_ID);
    const { nodeId, nodeSecret } = await enrollNode(token, { hostname: "bench-cap", os: "linux", arch: "amd64", cpuCount: 2 });
    const ws = new WebSocket(`ws://localhost:${server.port}/public/nodes/gateway`, {
      headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
    });
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res());
      ws.addEventListener("error", () => rej(new Error("WebSocket connection error")));
    });
    const asked: string[] = [];
    ws.addEventListener("message", (e) => {
      const msg = Request.safeParse(JSON.parse(String(e.data)));
      if (!msg.success || msg.data.verb !== "bench.registry.status") return;
      asked.push(msg.data.verb);
      ws.send(JSON.stringify({ type: "res", id: msg.data.id, ok: true,
        data: { configured: false, valid: false, problem: "unconfigured", node_id: nodeId, profiles: [] } }));
    });
    ws.send(JSON.stringify({ type: "hello", hostInfo: { hostname: "bench-cap", os: "linux", arch: "amd64", cpuCount: 2 },
      version: "v0.0.0-test", capabilities: HELLO_CAPABILITIES }));
    await waitForNodeOnline(nodeId);

    const stored = await pollUntil(async () =>
      (await listNodes(BOOTSTRAP_TENANT_ID)).find((n) => n.id === nodeId && n.capabilities !== null));
    expect(stored?.capabilities).toEqual(HELLO_CAPABILITIES);

    const answer = await nodeRegistryStatus(nodeId);
    expect(answer).toMatchObject({ ok: true, status: { configured: false, problem: "unconfigured" } });
    expect(asked).toEqual(["bench.registry.status"]);
    ws.close();
  } finally {
    server.stop(true);
  }
});
