import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createNodeRoutes } from "../../src/routes/nodes";
import type { RolloutNode } from "../../src/services/rollout";

/**
 * POST /api/nodes/update-all — the fleet rollout of issue #295.
 *
 * The route itself is thin; what these assert is that it wires the planner to
 * the broker faithfully and reports every node, including the ones it declined
 * to touch. A rollout that answered only about its successes would repeat the
 * defect issue #296 fixed on the single-node route: an operator reading "ok"
 * while machines sat on the old binary.
 */

const fleet: RolloutNode[] = [
  {
    id: "n_behind",
    name: "molt-bot",
    status: "online",
    agentVersion: "v0.1.22",
    latestVersion: "v0.1.26",
    updateAvailable: true,
  },
  {
    id: "n_current",
    name: "superchotu",
    status: "online",
    agentVersion: "v0.1.26",
    latestVersion: "v0.1.26",
    updateAvailable: false,
  },
  {
    id: "n_offline",
    name: "cloudchamber",
    status: "offline",
    agentVersion: "v0.1.22",
    latestVersion: "v0.1.26",
    updateAvailable: true,
  },
];

/** Mounts the routes behind a stub that supplies the authenticated user. */
function appWith(request: Parameters<typeof createNodeRoutes>[0]["request"]) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" });
    await next();
  });
  app.route(
    "/api/nodes",
    createNodeRoutes({ request, listNodesFn: async () => fleet })
  );
  return app;
}

const post = (app: Hono, body?: unknown) =>
  app.request("/api/nodes/update-all", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("POST /api/nodes/update-all (#295)", () => {
  test("updates only the node that is behind, and says why the others were left", async () => {
    const asked: string[] = [];
    const app = appWith(async (nodeId) => {
      asked.push(nodeId);
      return { ok: true, data: { ok: true, updating: true, tag: "v0.1.26" } };
    });

    const res = await post(app);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      summary: Record<string, number>;
      results: Array<{ nodeId: string; outcome: string; reason?: string }>;
    };

    expect(asked).toEqual(["n_behind"]);
    expect(body.summary).toMatchObject({ updated: 1, skipped: 2, failed: 0 });

    // Every node is accounted for, not just the one that moved.
    expect(body.results).toHaveLength(3);
    const offline = body.results.find((r) => r.nodeId === "n_offline")!;
    expect(offline.outcome).toBe("skipped");
    expect(offline.reason).toContain("offline");
    const current = body.results.find((r) => r.nodeId === "n_current")!;
    expect(current.reason).toContain("current");
  });

  test("reports results in name order, so a long rollout reads in sequence", async () => {
    const app = appWith(async () => ({
      ok: true,
      data: { ok: true, updating: true, tag: "v0.1.26" },
    }));
    const body = (await (await post(app)).json()) as {
      results: Array<{ name: string }>;
    };
    expect(body.results.map((r) => r.name)).toEqual([
      "cloudchamber",
      "molt-bot",
      "superchotu",
    ]);
  });

  test("force re-applies to a current node but still leaves the offline one", async () => {
    const asked: string[] = [];
    const app = appWith(async (nodeId) => {
      asked.push(nodeId);
      return { ok: true, data: { ok: true, updating: true, tag: "v0.1.26" } };
    });

    await post(app, { force: true });
    expect(asked.sort()).toEqual(["n_behind", "n_current"]);
  });

  test("`only` restricts the rollout to the named nodes", async () => {
    const asked: string[] = [];
    const app = appWith(async (nodeId) => {
      asked.push(nodeId);
      return { ok: true, data: { ok: true, updating: true, tag: "v0.1.26" } };
    });

    const body = (await (await post(app, { only: ["n_behind"] })).json()) as {
      results: unknown[];
    };
    expect(asked).toEqual(["n_behind"]);
    expect(body.results).toHaveLength(1);
  });

  test("one node failing is a failed row, not a failed request", async () => {
    const app = appWith(async () => ({ ok: false, error: "node offline" }));

    const res = await post(app, { force: true });
    // 200: the rollout ran. The rows carry what happened to each node.
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      summary: Record<string, number>;
      results: Array<{ outcome: string; error?: string }>;
    };
    expect(body.summary.failed).toBe(2);
    expect(body.results.find((r) => r.outcome === "failed")!.error).toContain("offline");
  });

  test("an absent body is a plain rollout, not a 400", async () => {
    const app = appWith(async () => ({
      ok: true,
      data: { ok: true, updating: true, tag: "v0.1.26" },
    }));
    const res = await app.request("/api/nodes/update-all", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
