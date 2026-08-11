/**
 * Integration Test: hub node posture route (node-capability gated).
 *
 * Verifies:
 *   1. A node's capabilities are stored from its hello frame — this is what
 *      gates the console panel, and it rides the handshake so it cannot go
 *      stale the way station capabilities could.
 *   2. A node that sends no capabilities stores null, and degrades silently.
 *   3. POST /posture/scan returns the node's report, audited.
 *   4. A node without the capability → 403, and the node is never called.
 *   5. Unauthenticated → 401; another user's node → 404.
 *   6. Offline → 409; any other node-side failure → 502.
 *
 * Uses the local Docker test-postgres (localhost:5434).
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";

import { db, rawSql } from "../db/drizzle";
import { nodes } from "../db/schema/nodes";
import { stationAudit } from "../db/schema/audit";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { mintEnrollmentToken, enrollNode } from "../services/enrollment";
import { gatewayRoutes } from "./gateway";
import { nodePostureRoutes } from "./node-posture";
import { websocket } from "../ws";
import type { AuthUser } from "../auth/middleware";

const TEST_USER = "test-user-posture-001";

const REPORT = {
  hostname: "molt-bot",
  stations: 15,
  findings: [
    {
      check: "creds.world-readable",
      status: "fail",
      severity: "critical",
      harness: "hermes",
      station: "hermes:analyst-echo",
      title: "Credentials readable by other users",
      detail: "mode 0644 and reachable",
      path: "/root/.hermes/profiles/analyst-echo/auth.json",
      remedy: "chmod 600 /root/.hermes/profiles/analyst-echo/auth.json",
    },
  ],
  grade: "F",
};

// ─── Minimal test app ─────────────────────────────────────────────────────────

const testApp = new Hono()
  .use("/api/*", async (c, next) => {
    const userId = c.req.header("X-Test-User-Id");
    c.set("user", {
      id: userId && userId !== "anonymous" ? userId : "anonymous",
      authType: "api_key",
    } satisfies AuthUser);
    return next();
  })
  .route("/public/nodes", gatewayRoutes)
  .route("/api", nodePostureRoutes);

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "posture-test@example.com",
    name: "Node Posture Test User",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM station_audit     WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM nodes             WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM "user"            WHERE id = ${TEST_USER}`;
  } catch {
    // ignore
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * A fake node that sends a hello frame with the given capabilities and answers
 * posture.scan.
 *
 * `capabilities: null` reproduces a node that predates them, which must degrade
 * silently rather than error.
 */
async function connectFakeNode(
  serverPort: number,
  nodeId: string,
  nodeSecret: string,
  // null means "send a hello with no capabilities key at all" — an explicit
  // undefined would trigger withPostureNode's default parameter instead.
  capabilities: string[] | null,
  report: unknown,
  capturedMsgs?: string[],
  failWith?: string
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${serverPort}/public/nodes/gateway`, {
    headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
  } as RequestInit & { headers: Record<string, string> });

  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("Node WS connection error"));
  });

  ws.send(
    JSON.stringify({
      type: "hello",
      hostInfo: { hostname: "molt-bot", os: "linux", arch: "amd64", cpuCount: 2 },
      version: "v0.1.22",
      ...(capabilities ? { capabilities } : {}),
    })
  );

  ws.onmessage = (e) => {
    const raw = String(e.data);
    if (capturedMsgs) capturedMsgs.push(raw);
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type !== "req" || msg.verb !== "posture.scan") return;

    if (failWith) {
      ws.send(JSON.stringify({ type: "res", id: msg.id, ok: false, error: failWith }));
      return;
    }
    ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: report }));
  };

  await new Promise((r) => setTimeout(r, 250));
  return ws;
}

async function withPostureNode(
  report: unknown,
  capabilities: string[] | null = ["posture"],
  failWith?: string
) {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  const baseUrl = `http://localhost:${server.port}`;
  const capturedMsgs: string[] = [];

  const { token } = await mintEnrollmentToken(TEST_USER);
  const { nodeId, nodeSecret } = await enrollNode(token, {
    hostname: `posture-host-${crypto.randomUUID().slice(0, 8)}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });

  const fakeNode = await connectFakeNode(
    server.port!,
    nodeId,
    nodeSecret,
    capabilities,
    report,
    capturedMsgs,
    failWith
  );

  return { server, baseUrl, nodeId, capturedMsgs, fakeNode };
}

async function pollUntil<T>(
  condition: () => Promise<T | undefined | null | false> | (T | undefined | null | false),
  timeoutMs = 4000,
  pollMs = 40
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await condition();
    if (result) return result as T;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs} ms`);
}

function sawVerb(msgs: string[], verb: string): boolean {
  return msgs.some((raw) => {
    try {
      const m = JSON.parse(raw);
      return m?.type === "req" && m?.verb === verb;
    } catch {
      return false;
    }
  });
}

const post = (baseUrl: string, path: string, body: unknown, user = TEST_USER) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "X-Test-User-Id": user, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ─── Tests ────────────────────────────────────────────────────────────────────

test("a node's capabilities are stored from its hello frame", async () => {
  const ctx = await withPostureNode(REPORT, ["posture"]);
  try {
    await pollUntil(async () => {
      const rows = await db.select().from(nodes).where(eq(nodes.id, ctx.nodeId));
      return rows[0]?.capabilities?.includes("posture") ? rows[0] : null;
    });
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("a node that sends no capabilities stores none", async () => {
  // An older node must degrade silently, not error. Null rather than [] keeps
  // "did not say" distinguishable from "said nothing".
  const ctx = await withPostureNode(REPORT, null);
  try {
    await new Promise((r) => setTimeout(r, 400));
    const rows = await db.select().from(nodes).where(eq(nodes.id, ctx.nodeId));
    expect(rows[0]?.capabilities ?? null).toBeNull();
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("scan returns the node's report and is audited", async () => {
  const ctx = await withPostureNode(REPORT);
  try {
    const res = await post(ctx.baseUrl, `/api/nodes/${ctx.nodeId}/posture/scan`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);

    await new Promise((r) => setTimeout(r, 250));
    const rows = await db
      .select()
      .from(stationAudit)
      .where(
        and(eq(stationAudit.userId, TEST_USER), eq(stationAudit.verb, "posture.scan"))
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.result === "ok")).toBe(true);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("a node without the capability is 403 and is never called", async () => {
  const ctx = await withPostureNode(REPORT, []);
  try {
    const before = ctx.capturedMsgs.length;
    const res = await post(ctx.baseUrl, `/api/nodes/${ctx.nodeId}/posture/scan`, {});
    expect(res.status).toBe(403);

    await new Promise((r) => setTimeout(r, 200));
    expect(sawVerb(ctx.capturedMsgs.slice(before), "posture.scan")).toBe(false);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("unauthenticated is 401", async () => {
  const ctx = await withPostureNode(REPORT);
  try {
    const res = await post(
      ctx.baseUrl,
      `/api/nodes/${ctx.nodeId}/posture/scan`,
      {},
      "anonymous"
    );
    expect(res.status).toBe(401);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("another user's node is 404", async () => {
  const ctx = await withPostureNode(REPORT);
  try {
    const res = await post(ctx.baseUrl, `/api/nodes/node_not_mine/posture/scan`, {});
    expect(res.status).toBe(404);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("an offline node is 409, not 502", async () => {
  const ctx = await withPostureNode(REPORT, ["posture"], "node offline");
  try {
    const res = await post(ctx.baseUrl, `/api/nodes/${ctx.nodeId}/posture/scan`, {});
    expect(res.status).toBe(409);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("any other failure is 502", async () => {
  const ctx = await withPostureNode(REPORT, ["posture"], "lsof exploded");
  try {
    const res = await post(ctx.baseUrl, `/api/nodes/${ctx.nodeId}/posture/scan`, {});
    expect(res.status).toBe(502);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});
