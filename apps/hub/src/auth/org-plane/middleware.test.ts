import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createAuthMiddleware } from "../middleware";
import type { PlaneBearerResult } from "../hub-token";
import { config } from "../../config";

const human: PlaneBearerResult = {
  ok: true,
  caller: {
    sub: "prn_aaaaaaaaaaaaaaaaaaaa",
    principalKind: "human",
    tenantId: "fleet_11111111111111111111",
    claims: {
      email: "op@example.com",
      principalKind: "human",
      mayDispatch: ["prn_bbbbbbbbbbbbbbbbbbbb"],
      mayGrantReach: true,
      // A human's `scope` is the OAuth scope string; it must never read as a grant (contract §2).
      scope: "openid evidence:read",
    } as never,
  },
};

function app(result: PlaneBearerResult, seen: string[] = []) {
  return new Hono()
    .use("/api/*", createAuthMiddleware({
      verifyPlane: async (t) => {
        seen.push(t);
        return result;
      },
    }))
    .get("/api/whoami", (c) => c.json(c.get("user")));
}

describe("authMiddleware (the org plane is the only issuer)", () => {
  test("a human plane token is admitted as its prn_, in the tenant its org maps to", async () => {
    const res = await app(human).request("/api/whoami", { headers: { Authorization: "Bearer t" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "prn_aaaaaaaaaaaaaaaaaaaa",
      email: "op@example.com",
      authType: "org_plane",
      tenantId: "fleet_11111111111111111111",
      authority: { principalKind: "human", mayDispatch: ["prn_bbbbbbbbbbbbbbbbbbbb"], mayGrantReach: true, scopes: [] },
    });
  });

  test("the token's authority rides on AuthUser, so authorization never reads the plane (design §5.7)", async () => {
    const res = await app(human).request("/api/whoami", { headers: { Authorization: "Bearer t" } });
    const u = (await res.json()) as { authority?: unknown };
    expect(u.authority).toEqual({
      principalKind: "human",
      mayDispatch: ["prn_bbbbbbbbbbbbbbbbbbbb"],
      mayGrantReach: true,
      scopes: [],
    });
  });

  test("the static API_TOKEN carries no token authority", async () => {
    const res = await app({ ok: false, status: 401 }).request("/api/whoami", {
      headers: { Authorization: `Bearer ${config.auth.token}` },
    });
    expect(((await res.json()) as { authority?: unknown }).authority).toBeUndefined();
  });

  test("?token= is still read, for the browser's WebSocket and EventSource", async () => {
    const seen: string[] = [];
    const res = await app(human, seen).request("/api/whoami?token=qt");
    expect(res.status).toBe(200);
    expect(seen).toEqual(["qt"]);
  });

  test.each([
    ["the terminal socket", "/api/stations/st_1/terminal"],
    ["the ACP socket", "/api/acp/sessions/acps_1/ws"],
    ["the logs stream", "/api/stations/st_1/logs"],
  ])("?token= on %s is verified as a plane token, as legacy reads it there", async (_name, path) => {
    const seen: string[] = [];
    const a = new Hono()
      .use("/api/*", createAuthMiddleware({ verifyPlane: async (t) => (seen.push(t), human) }))
      .get(path, (c) => c.json(c.get("user")));
    const res = await a.request(`${path}?token=fresh`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { authType: string }).authType).toBe("org_plane");
    expect(seen).toEqual(["fresh"]);
  });

  test("a Bearer header wins over ?token=, exactly as in legacy mode", async () => {
    const seen: string[] = [];
    await app(human, seen).request("/api/whoami?token=qt", { headers: { Authorization: "Bearer hdr" } });
    expect(seen).toEqual(["hdr"]);
  });

  test("an agent token is refused with the same 403 as today", async () => {
    const agent = { ...human, caller: { ...(human as { caller: object }).caller, principalKind: "agent" } } as PlaneBearerResult;
    const res = await app(agent).request("/api/whoami", { headers: { Authorization: "Bearer t" } });
    expect(res.status).toBe(403);
  });

  test("product_not_enabled passes through as the contract's body", async () => {
    const res = await app({ ok: false, status: 403, body: { error: "product_not_enabled", org: "org_00000000000000000000" } })
      .request("/api/whoami", { headers: { Authorization: "Bearer t" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "product_not_enabled", org: "org_00000000000000000000" });
  });

  test("no dual-accept: a context already holding a Better Auth user is not trusted", async () => {
    const a = new Hono()
      .use("/api/*", async (c, next) => {
        c.set("user", { id: "ba-user", authType: "better_auth", tenantId: "fleet_x" } as never);
        await next();
      })
      .use("/api/*", createAuthMiddleware({ verifyPlane: async () => ({ ok: false, status: 401 }) }))
      .get("/api/whoami", (c) => c.json(c.get("user")));
    expect((await a.request("/api/whoami")).status).toBe(401);
  });

  test("a human token minted for another first-party client (superpipeline-web, contract §3.1) is admitted", async () => {
    const viaSuperpipeline = {
      ...human,
      caller: { ...(human as { caller: object }).caller, claims: { email: "op@example.com", client_id: "superpipeline-web", azp: "superpipeline-web" } },
    } as unknown as PlaneBearerResult;
    const res = await app(viaSuperpipeline).request("/api/whoami", { headers: { Authorization: "Bearer t" } });
    expect(res.status).toBe(200);
  });

  test("the static API_TOKEN keeps working (it is configuration, not an issuer)", async () => {
    const res = await app({ ok: false, status: 401 }).request("/api/whoami", {
      headers: { Authorization: `Bearer ${config.auth.token}` },
    });
    expect(res.status).toBe(200);
  });
});
