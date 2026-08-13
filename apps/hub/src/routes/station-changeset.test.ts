/**
 * Integration Test: hub changeset routes (capability-gated).
 *
 * Verifies:
 *   1. POST /changeset/status on a changeset-capable station → 200 + the node's
 *      answer, and the node received changeset.status with the station key.
 *   2. POST /changeset/diff → 200 + patch, audited (status is deliberately NOT).
 *   3. Both verbs on a station WITHOUT the capability → 403, node receives
 *      NO request.
 *   4. Unauthenticated → 401. Unowned station → 404.
 *   5. An offline node → 409; any other node-side failure → 502.
 *   6. An invalid `side` → 400 before anything reaches the node.
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
import { stationAudit } from "../db/schema/audit";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { waitForNodeOnline } from "../../tests/helpers/wait";
import { mintEnrollmentToken, enrollNode } from "../services/enrollment";
import { gatewayRoutes } from "./gateway";
import { stationChangesetRoutes } from "./station-changeset";
import { stationRoutes } from "./stations";
import { websocket } from "../ws";
import type { AuthUser } from "../auth/middleware";
import type { StationRow } from "../services/station-registry";

const TEST_USER = "test-user-changeset-001";

const STATUS_PAYLOAD = {
  repo: { branch: "feat/agent-work", head: "9f1c2ab", detached: false },
  base: { ref: "origin/main", sha: "3d4e5f6", reason: "upstream" },
  uncommitted: {
    files: [
      { path: "src/a.ts", oldPath: null, status: "modified", insertions: 12, deletions: 3, binary: false },
      { path: "notes.md", oldPath: null, status: "untracked", insertions: null, deletions: null, binary: false },
    ],
    insertions: 12,
    deletions: 3,
  },
  committed: { files: [], insertions: 0, deletions: 0, commits: [] },
  truncatedFiles: false,
};

// ─── Minimal test app ─────────────────────────────────────────────────────────

const testApp = new Hono()
  .use("/api/*", async (c, next) => {
    const userId = c.req.header("X-Test-User-Id");
    if (userId && userId !== "anonymous") {
      c.set("user", { id: userId, authType: "api_key" , tenantId: "fleet_00000000000000000000"} satisfies AuthUser);
    } else {
      c.set("user", { id: "anonymous", authType: "api_key" , tenantId: "fleet_00000000000000000000"} satisfies AuthUser);
    }
    return next();
  })
  .route("/public/nodes", gatewayRoutes)
  .route("/api", stationChangesetRoutes)
  .route("/api", stationRoutes);

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "changeset-test@example.com",
    name: "Station Changeset Test User",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM station_audit     WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM stations          WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM nodes             WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM "user"            WHERE id = ${TEST_USER}`;
  } catch {
    // ignore
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * A fake node that answers detect plus the two changeset verbs.
 *
 * `failWith` makes every changeset verb answer ok:false, so the error-mapping
 * tests exercise the real broker path rather than a mock.
 */
async function connectFakeNode(
  serverPort: number,
  nodeId: string,
  nodeSecret: string,
  stationKey: string,
  capabilities: string[],
  capturedMsgs?: string[],
  failWith?: string
): Promise<WebSocket> {
  const ws = new WebSocket(
    `ws://localhost:${serverPort}/public/nodes/gateway`,
    {
      headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
    } as RequestInit & { headers: Record<string, string> }
  );

  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("Node WS connection error"));
  });

  ws.onmessage = (e) => {
    const raw = String(e.data);
    if (capturedMsgs) capturedMsgs.push(raw);

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type !== "req") return;

    const fail = (id: unknown) =>
      ws.send(JSON.stringify({ type: "res", id, ok: false, error: failWith }));

    switch (msg.verb) {
      case "detect":
        ws.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            data: [
              {
                key: stationKey,
                harness: "codex",
                kind: "leaf",
                displayName: `Test Station (${stationKey})`,
                parentKey: null,
                workspacePath: `/workspace/${stationKey}`,
                capabilities,
              },
            ],
          })
        );
        break;

      case "changeset.status":
        if (failWith) return fail(msg.id);
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: STATUS_PAYLOAD }));
        break;

      case "changeset.diff":
        if (failWith) return fail(msg.id);
        ws.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            data: { content: "@@ -1 +1 @@\n-one\n+two\n", truncated: false, binary: false },
          })
        );
        break;
    }
  };

  // onOpen → verifyNodeCredential (argon2id) → register outlasts any fixed
  // sleep under load; wait for the registration itself.
  await waitForNodeOnline(nodeId);
  return ws;
}

async function adoptStation(
  baseUrl: string,
  nodeId: string,
  stationKey: string
): Promise<StationRow> {
  const res = await fetch(`${baseUrl}/api/nodes/${nodeId}/stations/adopt`, {
    method: "POST",
    headers: { "X-Test-User-Id": TEST_USER, "Content-Type": "application/json" },
    body: JSON.stringify({ keys: [stationKey] }),
  });
  expect(res.status).toBe(200);
  const rows = (await res.json()) as StationRow[];
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function pollUntil<T>(
  condition: () => T | undefined | null | false,
  timeoutMs = 4000,
  pollMs = 30
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = condition();
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

function reqFor(msgs: string[], verb: string): Record<string, unknown> | undefined {
  for (const raw of msgs) {
    try {
      const m = JSON.parse(raw);
      if (m?.type === "req" && m?.verb === verb) return m.params as Record<string, unknown>;
    } catch {
      // not JSON — skip
    }
  }
  return undefined;
}

/** Boots a server with a capable station already adopted. */
async function withCapableStation(
  capabilities: string[],
  failWith?: string
) {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  const baseUrl = `http://localhost:${server.port}`;
  const stationKey = `changeset-${crypto.randomUUID().slice(0, 8)}`;
  const capturedMsgs: string[] = [];

  const { token } = await mintEnrollmentToken(TEST_USER);
  const { nodeId, nodeSecret } = await enrollNode(token, {
    hostname: `changeset-host-${stationKey}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });

  const fakeNode = await connectFakeNode(
    server.port!,
    nodeId,
    nodeSecret,
    stationKey,
    capabilities,
    capturedMsgs,
    failWith
  );

  const station = await adoptStation(baseUrl, nodeId, stationKey);
  return { server, baseUrl, station, stationKey, capturedMsgs, fakeNode };
}

const post = (baseUrl: string, path: string, body: unknown, user = TEST_USER) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "X-Test-User-Id": user, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ─── Tests ────────────────────────────────────────────────────────────────────

test("status on a changeset-capable station returns the node's answer", async () => {
  const ctx = await withCapableStation(["health", "changeset"]);
  try {
    const res = await post(ctx.baseUrl, `/api/stations/${ctx.station.id}/changeset/status`, {
      base: "origin/main",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STATUS_PAYLOAD);

    await pollUntil(() => sawVerb(ctx.capturedMsgs, "changeset.status"));

    // The station key must be forwarded — the node keys everything by it.
    const params = reqFor(ctx.capturedMsgs, "changeset.status");
    expect(params?.key).toBe(ctx.stationKey);
    expect(params?.base).toBe("origin/main");
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("status is NOT audited — it is polled, and would bury the log", async () => {
  const ctx = await withCapableStation(["health", "changeset"]);
  try {
    await post(ctx.baseUrl, `/api/stations/${ctx.station.id}/changeset/status`, {});
    await new Promise((r) => setTimeout(r, 250));

    const rows = await db
      .select()
      .from(stationAudit)
      .where(
        and(eq(stationAudit.userId, TEST_USER), eq(stationAudit.verb, "changeset.status"))
      );
    expect(rows).toHaveLength(0);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("diff returns a patch and IS audited — it moves source off the machine", async () => {
  const ctx = await withCapableStation(["health", "changeset"]);
  try {
    const res = await post(ctx.baseUrl, `/api/stations/${ctx.station.id}/changeset/diff`, {
      side: "uncommitted",
      path: "src/a.ts",
      maxBytes: 4096,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.content).toContain("+two");
    expect(body.truncated).toBe(false);

    const params = await pollUntil(() => reqFor(ctx.capturedMsgs, "changeset.diff"));
    expect(params.key).toBe(ctx.stationKey);
    expect(params.side).toBe("uncommitted");
    expect(params.path).toBe("src/a.ts");
    expect(params.maxBytes).toBe(4096);

    await new Promise((r) => setTimeout(r, 250));
    const rows = await db
      .select()
      .from(stationAudit)
      .where(
        and(
          eq(stationAudit.userId, TEST_USER),
          eq(stationAudit.stationKey, ctx.stationKey),
          eq(stationAudit.verb, "changeset.diff")
        )
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result).toBe("ok");
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("a station without the capability is 403 and the node is never called", async () => {
  // The gate must reject BEFORE any node call: a station with no git workspace
  // should cost nothing to ask about.
  const ctx = await withCapableStation(["health", "logs"]);
  try {
    const before = ctx.capturedMsgs.length;

    const status = await post(ctx.baseUrl, `/api/stations/${ctx.station.id}/changeset/status`, {});
    expect(status.status).toBe(403);

    const diff = await post(ctx.baseUrl, `/api/stations/${ctx.station.id}/changeset/diff`, {
      side: "uncommitted",
    });
    expect(diff.status).toBe(403);

    await new Promise((r) => setTimeout(r, 200));
    const after = ctx.capturedMsgs.slice(before);
    expect(sawVerb(after, "changeset.status")).toBe(false);
    expect(sawVerb(after, "changeset.diff")).toBe(false);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("unauthenticated is 401", async () => {
  const ctx = await withCapableStation(["health", "changeset"]);
  try {
    const res = await post(
      ctx.baseUrl,
      `/api/stations/${ctx.station.id}/changeset/status`,
      {},
      "anonymous"
    );
    expect(res.status).toBe(401);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("a station the user does not own is 404", async () => {
  const ctx = await withCapableStation(["health", "changeset"]);
  try {
    const res = await post(ctx.baseUrl, `/api/stations/station_not_mine/changeset/status`, {});
    expect(res.status).toBe(404);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("an offline node is 409, not 502", async () => {
  // Two different problems needing two different responses: "come back later"
  // versus "something is broken".
  const ctx = await withCapableStation(["health", "changeset"], "node offline");
  try {
    const res = await post(ctx.baseUrl, `/api/stations/${ctx.station.id}/changeset/status`, {});
    expect(res.status).toBe(409);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("any other node-side failure is 502", async () => {
  const ctx = await withCapableStation(["health", "changeset"], "changeset.status: git exploded");
  try {
    const res = await post(ctx.baseUrl, `/api/stations/${ctx.station.id}/changeset/status`, {});
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain("git exploded");
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("an unknown side is rejected before it reaches the node", async () => {
  const ctx = await withCapableStation(["health", "changeset"]);
  try {
    const before = ctx.capturedMsgs.length;
    const res = await post(ctx.baseUrl, `/api/stations/${ctx.station.id}/changeset/diff`, {
      side: "sideways",
    });
    expect(res.status).toBe(400);

    await new Promise((r) => setTimeout(r, 200));
    expect(sawVerb(ctx.capturedMsgs.slice(before), "changeset.diff")).toBe(false);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("omitted optional fields are not forwarded as nulls", async () => {
  // The node treats an absent base as "choose one for me". Forwarding an
  // explicit null would look like an explicit base and change the answer.
  const ctx = await withCapableStation(["health", "changeset"]);
  try {
    await post(ctx.baseUrl, `/api/stations/${ctx.station.id}/changeset/status`, {});
    const params = await pollUntil(() => reqFor(ctx.capturedMsgs, "changeset.status"));
    expect("base" in params).toBe(false);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});
