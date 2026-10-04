import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createNodeRoutes } from "../../src/routes/nodes";
import type { RolloutNode } from "../../src/services/rollout";

const mk = (id: string, name: string, status = "online", v = "v0.1.80"): RolloutNode => ({
  id,
  name,
  status,
  agentVersion: v,
  latestVersion: v,
  updateAvailable: false,
});
const fleet = [mk("n_a", "alpha"), mk("n_b", "bravo", "online", "v0.1.20"), mk("n_c", "charlie", "offline")];

type Call = { nodeId: string; verb: string; params: unknown };

function setup(opts: {
  admin?: boolean;
  reply?: (c: Call) => { ok: boolean; data?: unknown; error?: string };
  auditFails?: boolean;
}) {
  const calls: Call[] = [];
  const audits: any[] = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" });
    await next();
  });
  app.route(
    "/api/nodes",
    createNodeRoutes({
      request: async (nodeId, verb, params) => {
        const call = { nodeId, verb, params };
        calls.push(call);
        return opts.reply ? opts.reply(call) : { ok: true, data: { ok: true } };
      },
      listNodesFn: async () => fleet,
      fixedImageNodesFn: async () => new Set(),
      isAdminFn: async () => opts.admin ?? true,
      auditFn: async (e) => {
        if (opts.auditFails) throw new Error("db down");
        audits.push(e);
        return "id";
      },
    })
  );
  return { app, calls, audits };
}

const post = (app: Hono, body: unknown) =>
  app.request("/api/nodes/telemetry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (app: Hono) => app.request("/api/nodes/telemetry");

describe("GET /api/nodes/telemetry", () => {
  test("non-admin gets 403 and no node is contacted", async () => {
    const { app, calls } = setup({ admin: false });
    expect((await get(app)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("reports status per node; offline is not asked", async () => {
    const { app, calls } = setup({
      reply: () => ({ ok: true, data: { ok: true, path: "/p", endpoint: "http://x", enabled: true } }),
    });
    const res = await get(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(calls.map((c) => c.nodeId).sort()).toEqual(["n_a", "n_b"]);
    expect(calls.every((c) => c.verb === "telemetry.status")).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.summary).toEqual({ ok: 2, offline: 1 });
    const a = body.results.find((r: any) => r.nodeId === "n_a");
    expect(a).toMatchObject({ name: "alpha", status: "ok", endpoint: "http://x", enabled: true });
    expect(body.results.find((r: any) => r.nodeId === "n_c").status).toBe("offline");
  });

  test("unknown verb maps to unsupported with roll-forward hint", async () => {
    const { app } = setup({
      reply: (c) =>
        c.nodeId === "n_b"
          ? { ok: false, error: 'descriptor: unknown verb "telemetry.status"' }
          : { ok: true, data: { ok: true, endpoint: "", enabled: false } },
    });
    const body = (await (await get(app)).json()) as any;
    const b = body.results.find((r: any) => r.nodeId === "n_b");
    expect(b.status).toBe("unsupported");
    expect(b.error).toContain("v0.1.20");
    expect(b.error).toContain("fleet nodes update");
    expect(body.summary.unsupported).toBe(1);
  });

  test("node-reported unsupported and broker failure", async () => {
    const { app } = setup({
      reply: (c) =>
        c.nodeId === "n_a"
          ? { ok: true, data: { ok: false, unsupported: true, error: "no config" } }
          : { ok: false, error: "timeout" },
    });
    const body = (await (await get(app)).json()) as any;
    expect(body.results.find((r: any) => r.nodeId === "n_a")).toMatchObject({ status: "unsupported", error: "no config" });
    expect(body.results.find((r: any) => r.nodeId === "n_b")).toMatchObject({ status: "failed", error: "timeout" });
  });
});

describe("POST /api/nodes/telemetry", () => {
  test("non-admin gets 403, nothing sent or audited", async () => {
    const { app, calls, audits } = setup({ admin: false });
    expect((await post(app, { off: true })).status).toBe(403);
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  });

  test.each([
    [{}],
    [{ endpoint: "http://x", off: true }],
    [{ off: false }],
    [{ endpoint: "ftp://x" }],
    [{ endpoint: "http://a b" }],
    [{ endpoint: "http://x/?a=b" }],
    [{ endpoint: "http://x\n" }],
    [{ endpoint: "not a url" }],
    [{ endpoint: 5 }],
    [{ off: true, only: "alpha" }],
  ])("invalid body %j -> 400, no node contacted", async (body) => {
    const { app, calls } = setup({});
    expect((await post(app, body)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("unknown only names -> 400 listing them, nothing sent", async () => {
    const { app, calls } = setup({});
    const res = await post(app, { off: true, only: ["alpha", "ghost", "phantom"] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toContain("ghost");
    expect(body.error).toContain("phantom");
    expect(calls).toEqual([]);
  });

  test("sets endpoint on all online nodes, audits each asked node, skips offline", async () => {
    const { app, calls, audits } = setup({
      reply: (c) =>
        c.nodeId === "n_a"
          ? { ok: true, data: { ok: true, changed: true, endpoint: "http://c:4318", enabled: true, restarting: true } }
          : { ok: true, data: { ok: true, changed: false, endpoint: "http://c:4318", enabled: true, restarting: false } },
    });
    const res = await post(app, { endpoint: "http://c:4318" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(calls.every((c) => c.verb === "telemetry.set")).toBe(true);
    expect(calls.map((c) => c.params)).toEqual([{ endpoint: "http://c:4318" }, { endpoint: "http://c:4318" }]);
    expect(body.summary).toEqual({ changed: 1, unchanged: 1, offline: 1 });
    expect(body.results.find((r: any) => r.nodeId === "n_a")).toMatchObject({
      status: "changed",
      restarting: true,
      enabled: true,
      endpoint: "http://c:4318",
    });
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      adminUserId: "user_1",
      action: "node_telemetry_update",
      targetResourceType: "node",
      targetResourceId: "n_a",
      details: { endpoint: "http://c:4318", status: "changed" },
    });
    expect(audits.map((a) => a.targetResourceId)).toEqual(["n_a", "n_b"]);
  });

  test("off:true sends {off:true}; only accepts names and ids", async () => {
    const { app, calls, audits } = setup({
      reply: () => ({ ok: true, data: { ok: true, changed: true, endpoint: "", enabled: false, restarting: false } }),
    });
    const res = await post(app, { off: true, only: ["alpha", "n_b"] });
    expect(res.status).toBe(200);
    expect(calls.map((c) => [c.nodeId, c.params])).toEqual([
      ["n_a", { off: true }],
      ["n_b", { off: true }],
    ]);
    expect(audits[0].details).toEqual({ off: true, status: "changed" });
  });

  test("only naming an offline node reports offline and audits nothing", async () => {
    const { app, calls, audits } = setup({});
    const body = (await (await post(app, { off: true, only: ["charlie"] })).json()) as any;
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
    expect(body.summary).toEqual({ offline: 1 });
  });

  test("unsupported and failed are audited with error; node ok:false is failed", async () => {
    const { app, audits } = setup({
      reply: (c) =>
        c.nodeId === "n_a"
          ? { ok: false, error: 'descriptor: unknown verb "telemetry.set"' }
          : { ok: true, data: { ok: false, error: "write failed" } },
    });
    const body = (await (await post(app, { off: true })).json()) as any;
    const a = body.results.find((r: any) => r.nodeId === "n_a");
    expect(a.status).toBe("unsupported");
    expect(a.error).toContain("fleet nodes update");
    expect(body.results.find((r: any) => r.nodeId === "n_b")).toMatchObject({ status: "failed", error: "write failed" });
    expect(audits.map((x) => [x.targetResourceId, x.details.status, typeof x.details.error])).toEqual([
      ["n_a", "unsupported", "string"],
      ["n_b", "failed", "string"],
    ]);
  });

  test("audit failure does not hide the node result", async () => {
    const { app } = setup({
      auditFails: true,
      reply: () => ({ ok: true, data: { ok: true, changed: true, endpoint: "", enabled: false, restarting: false } }),
    });
    const res = await post(app, { off: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).summary.changed).toBe(2);
  });
});
