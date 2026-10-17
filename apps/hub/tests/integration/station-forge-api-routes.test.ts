/**
 * Forge API access routes: who may grant a station a forge credential, and what a response may say.
 *
 * Authority (plan Review Focus 4): every mutation needs BOTH the hub operator seat (`isUserAdmin`)
 * AND the control pair's reach (`requireIssueCredentials`, enforced under ENFORCE_CONTROL_PAIR).
 * Owning the station is not enough; an agent token never reaches a route; the account is never
 * taken from a body. Responses are a sanitised view: no sealed blob, no token handle, no token.
 *
 * The service's broker/provider/sealer are stubs injected through the route deps; the route module
 * never imports libsodium at load time.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { and, eq, inArray, like } from "drizzle-orm";
import handoverFixture from "../../../../packages/contract/fixtures/handover-v1.json";

import { db, rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { createAuthMiddleware, type AuthUser } from "../../src/auth/middleware";
import { hubOperators } from "../../src/db/schema/operators";
import { stationAudit } from "../../src/db/schema/audit";
import { stationForgeApiGrants as g } from "../../src/db/schema/forge-api-grants";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { createPrincipal, forgetPrincipals } from "../helpers/principals";
import { getProvider, type ForgeProvider } from "../../src/services/forge-api/providers";
import type { ForgeApiDeps } from "../../src/services/station-forge-api";
import { createStationForgeApiRoutes } from "../../src/routes/station-forge-api";

const RUN = crypto.randomUUID().slice(0, 8);
const hex20 = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
const OWNER = `prn_${hex20()}`; // owns the stations; not an operator
const ADMIN = `prn_${hex20()}`; // hub operator; owns nothing
const NODE = `node_sfr_${RUN}`;
const OTHER_TENANT = `fleet_${hex20()}`;
const OTHER_NODE = `node_sfr_o_${RUN}`;
const FORGE = "https://forge.sfr.test";
const SECRET = "0123456789abcdef0123456789abcdef01234567";
const SEALED = "stk-handover-v1:" + "A".repeat(64);

let tenant: string;
let seq = 0;
const handles: string[] = [];
const agentPrincipals: string[] = [];

// ─── Stubs ────────────────────────────────────────────────────────────────────

type Reply = { ok: boolean; data?: unknown; error?: string };
const replies: Record<string, (p: unknown) => Reply> = {};
function resetReplies() {
  for (const k of Object.keys(replies)) delete replies[k];
  Object.assign(replies, {
    "forge.api.status": () => ({ ok: true, data: { grants: [], publicKey: (handoverFixture as { public_key: string }).public_key } }),
    "forge.api.deliver": () => ({ ok: true, data: { ok: true, stored: true, isolation: "same-user" } }),
    "forge.api.verify": (p: unknown) => ({
      ok: true,
      data: { ok: true, login: (p as { expectLogin: string }).expectLogin, isolation: "separate-user" },
    }),
    "forge.api.revoke": () => ({ ok: true, data: { removed: true } }),
    "forge.api.policy": () => ({ ok: true, data: { ok: true } }),
  });
}

let mintId = 900;
const real = getProvider("forgejo", { cfg: { baseUrl: FORGE, adminToken: "admin" } });
const provider: ForgeProvider = {
  ...real,
  async mint(_account, spec) {
    return { id: mintId++, name: spec.name, secret: SECRET };
  },
  async revoke() {},
  async checkToken(account) {
    if (checkFails) throw new Error("forge: checking the new token failed (PROVIDER-TEXT 500).");
    return { login: account };
  },
};
let checkFails = false;
const service: Partial<ForgeApiDeps> = {
  broker: {
    async request(_n, verb, params) {
      const r = replies[verb];
      return r ? r(params) : { ok: false, error: `unknown verb: ${verb}` };
    },
  },
  providers: () => provider,
  seal: async () => SEALED,
};
const FORGE_CFG = { baseUrl: FORGE, adminToken: "admin-token-not-a-secret-here" };

function app(user: Partial<AuthUser> | null, forge: typeof FORGE_CFG | null = FORGE_CFG) {
  const a = new Hono();
  if (user) {
    a.use("*", async (c, next) => {
      c.set("user", { authType: "api_key", tenantId: tenant, ...user } as AuthUser);
      await next();
    });
  }
  a.route("/api", createStationForgeApiRoutes({ forge, service }));
  return a;
}
const asOwner = () => app({ id: OWNER });
const asAdmin = () => app({ id: ADMIN });

async function call(a: Hono, method: string, path: string, body?: unknown, raw?: string) {
  const res = await a.request(`/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json: json as Record<string, any>, text };
}

async function freshStation(opts: { occupied?: boolean } = {}) {
  const id = `station_sfr_${RUN}_${seq++}`;
  let principalId: string | null = null;
  if (opts.occupied !== false) {
    const handle = `sfr-agent-${RUN}-${seq}`;
    handles.push(handle);
    principalId = await createPrincipal({ kind: "agent", handle });
    agentPrincipals.push(principalId);
  }
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, principal_id, adopted_at, created_at)
    VALUES (${id}, ${tenant}, ${OWNER}, ${NODE}, 'claude-code', ${"claude-code:" + id}, 'leaf', ${id}, '["acp","forge.api"]'::jsonb, ${principalId}, now(), now())`;
  return { id, principalId };
}

const grantBody = (over: Record<string, unknown> = {}) => ({
  provider: "forgejo",
  instance: FORGE,
  mode: "minted",
  repositories: ["org/repo"],
  preset: "read",
  ...over,
});

async function grantedStation() {
  const st = await freshStation();
  const r = await call(asAdmin(), "POST", `/stations/${st.id}/forge-api`, grantBody());
  expect(r.status).toBe(200);
  return { ...st, grantId: r.json.grant.id as string };
}

/** Every key anywhere in a JSON value, lower-cased. */
function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.push(k.toLowerCase());
      allKeys(x, out);
    }
  return out;
}
const FORBIDDEN_KEYS = ["sealedblob", "sealed", "tokenhandle", "token", "secret", "previous", "orphan", "sealedexpiresat", "principalid", "createdby"];
function assertSanitised(r: { json: unknown; text: string }) {
  const keys = allKeys(r.json);
  for (const k of FORBIDDEN_KEYS) expect(keys).not.toContain(k);
  expect(r.text).not.toContain(SECRET);
  expect(r.text).not.toContain("stk-handover-v1:");
  expect(r.text).not.toContain("agentpod-"); // the minted token's name, sfa-style `agentpod-…`
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: `${OWNER}@example.com`, name: "SFR owner" });
  await createTestUser({ id: ADMIN, email: `${ADMIN}@example.com`, name: "SFR admin" });
  tenant = await resolveTenantForUser(OWNER);
  await db.insert(hubOperators).values({ principalId: ADMIN });
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${OWNER}, ${`sfr-box-${RUN}`}, 'sb', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`INSERT INTO tenants (id, name) VALUES (${OTHER_TENANT}, 'sfr other')`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${OTHER_NODE}, ${OTHER_TENANT}, ${ADMIN}, ${`sfr-other-${RUN}`}, 'sb', 'linux', 'amd64', 2, 'online', 'x', now())`;
});

beforeEach(() => {
  resetReplies();
  checkFails = false;
  delete process.env.ENFORCE_CONTROL_PAIR;
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM station_forge_api_grants WHERE station_id_snapshot LIKE ${`station_sfr_${RUN}_%`}`;
    await rawSql`DELETE FROM station_audit WHERE user_id IN (${OWNER}, ${ADMIN})`;
    await rawSql`DELETE FROM stations WHERE id LIKE ${`station_sfr_${RUN}_%`}`;
    await rawSql`DELETE FROM nodes WHERE id IN (${NODE}, ${OTHER_NODE})`;
    await rawSql`DELETE FROM tenants WHERE id = ${OTHER_TENANT}`;
    await db.delete(hubOperators).where(inArray(hubOperators.principalId, [ADMIN]));
    await forgetPrincipals({ handles });
  } catch {
    // cleanup only
  }
});

// ─── Authority ────────────────────────────────────────────────────────────────

const MUTATIONS: [string, (st: string, gr: string) => string, unknown][] = [
  ["POST", (st) => `/stations/${st}/forge-api`, grantBody()],
  ["POST", (st, gr) => `/stations/${st}/forge-api/${gr}/verify`, undefined],
  ["POST", (st, gr) => `/stations/${st}/forge-api/${gr}/rotate`, undefined],
  ["POST", (st, gr) => `/stations/${st}/forge-api/${gr}/secret`, { sealed: SEALED }],
  ["PATCH", (st, gr) => `/stations/${st}/forge-api/${gr}/policy`, { preset: "issues", rules: [], allowGraphql: false }],
  ["DELETE", (st, gr) => `/stations/${st}/forge-api/${gr}`, undefined],
  ["POST", (st, gr) => `/stations/${st}/forge-api/${gr}/confirm-revoked`, undefined],
];

describe("authority", () => {
  test("the station owner who is not an operator is refused every mutation (403), and nothing changes", async () => {
    const st = await grantedStation();
    const before = await db.select().from(g).where(eq(g.id, st.grantId));
    for (const [method, path, body] of MUTATIONS) {
      const r = await call(asOwner(), method, path(st.id, st.grantId), body);
      expect(`${method} ${path(st.id, st.grantId)} ${r.status}`).toBe(`${method} ${path(st.id, st.grantId)} 403`);
      expect(r.json.error).toBe("operator-required");
    }
    const after = await db.select().from(g).where(eq(g.id, st.grantId));
    expect(after).toEqual(before);
  });

  test("the owner may read status; a stranger in the tenant may not see it", async () => {
    const st = await grantedStation();
    const own = await call(asOwner(), "GET", `/stations/${st.id}/forge-api`);
    expect(own.status).toBe(200);
    expect(own.json.grants).toHaveLength(1);
    const stranger = await call(app({ id: `prn_${hex20()}` }), "GET", `/stations/${st.id}/forge-api`);
    expect(stranger.status).toBe(404);
  });

  describe("with the control pair enforced", () => {
    test("an operator without reach is refused every mutation (403)", async () => {
      const st = await grantedStation();
      process.env.ENFORCE_CONTROL_PAIR = "true";
      const noReach = app({
        id: ADMIN,
        authType: "org_plane",
        authority: { principalKind: "human", mayDispatch: [st.principalId!], mayGrantReach: false, scopes: [] },
      });
      for (const [method, path, body] of MUTATIONS) {
        const r = await call(noReach, method, path(st.id, st.grantId), body);
        expect(`${method} ${r.status}`).toBe(`${method} 403`);
        expect(r.json.error).toBe("reach-denied");
      }
    });

    test("an operator whose reach does not cover this agent is refused (403)", async () => {
      const st = await freshStation();
      process.env.ENFORCE_CONTROL_PAIR = "true";
      const elsewhere = app({
        id: ADMIN,
        authType: "org_plane",
        authority: { principalKind: "human", mayDispatch: [`prn_${hex20()}`], mayGrantReach: true, scopes: [] },
      });
      const r = await call(elsewhere, "POST", `/stations/${st.id}/forge-api`, grantBody());
      expect(r.status).toBe(403);
      expect(await db.select().from(g).where(eq(g.stationIdSnapshot, st.id))).toHaveLength(0);
    });

    test("an operator with reach over this agent may grant", async () => {
      const st = await freshStation();
      process.env.ENFORCE_CONTROL_PAIR = "true";
      const withReach = app({
        id: ADMIN,
        authType: "org_plane",
        authority: { principalKind: "human", mayDispatch: [st.principalId!], mayGrantReach: true, scopes: [] },
      });
      const r = await call(withReach, "POST", `/stations/${st.id}/forge-api`, grantBody());
      expect(r.status).toBe(200);
      expect(r.json.grant.state).toBe("delivered");
    });
  });

  test("an agent's org-plane token never reaches the route (403 at authMiddleware)", async () => {
    const st = await freshStation();
    const a = new Hono();
    a.use(
      "*",
      createAuthMiddleware({
        verifyPlane: (async () => ({
          ok: true,
          caller: { sub: st.principalId!, principalKind: "agent", tenantId: tenant, claims: { principalKind: "agent" } },
        })) as never,
      }),
    );
    a.route("/api", createStationForgeApiRoutes({ forge: FORGE_CFG, service }));
    const res = await a.request(`/api/stations/${st.id}/forge-api`, {
      method: "POST",
      headers: { authorization: "Bearer agent-token", "content-type": "application/json" },
      body: JSON.stringify(grantBody()),
    });
    expect(res.status).toBe(403);
    expect(await db.select().from(g).where(eq(g.stationIdSnapshot, st.id))).toHaveLength(0);
  });

  test("a node credential is not a caller here: refused at authMiddleware, nothing granted", async () => {
    // Node secrets authenticate only on /api/nodes/* (their own middleware). Presented here, the
    // plane does not recognise them, so authMiddleware answers 401 before the route runs.
    const st = await freshStation();
    const a = new Hono();
    a.use("*", createAuthMiddleware({ verifyPlane: (async () => ({ ok: false, status: 401 })) as never }));
    a.route("/api", createStationForgeApiRoutes({ forge: FORGE_CFG, service }));
    const res = await a.request(`/api/stations/${st.id}/forge-api`, {
      method: "POST",
      headers: { authorization: "Bearer node-secret-abc", "content-type": "application/json" },
      body: JSON.stringify(grantBody()),
    });
    expect([401, 403]).toContain(res.status);
    expect(await db.select().from(g).where(eq(g.stationIdSnapshot, st.id))).toHaveLength(0);
  });

  test("a request with no caller is 401", async () => {
    const st = await freshStation();
    const r = await call(app(null), "GET", `/stations/${st.id}/forge-api`);
    expect(r.status).toBe(401);
  });

  test("the account is never taken from a body: account / principal / unknown fields are 400", async () => {
    const st = await freshStation();
    for (const extra of [{ account: "root" }, { principal: "prn_x" }, { principalId: "prn_x" }, { surprise: 1 }]) {
      const r = await call(asAdmin(), "POST", `/stations/${st.id}/forge-api`, grantBody(extra));
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("bad-request");
    }
    expect(await db.select().from(g).where(eq(g.stationIdSnapshot, st.id))).toHaveLength(0);
    const gr = await grantedStation();
    const p = await call(asAdmin(), "PATCH", `/stations/${gr.id}/forge-api/${gr.grantId}/policy`, {
      preset: "read",
      rules: [],
      allowGraphql: false,
      account: "root",
    });
    expect(p.status).toBe(400);
    const s = await call(asAdmin(), "POST", `/stations/${gr.id}/forge-api/${gr.grantId}/secret`, { sealed: SEALED, account: "x" });
    expect(s.status).toBe(400);
  });

  test("a minted grant's account is the occupant's handle", async () => {
    const st = await grantedStation();
    const [row] = await db.select().from(g).where(eq(g.id, st.grantId));
    expect(row!.account).toMatch(/^sfr-agent-/);
  });

  test("another tenant's station and grant are 404, and nothing is touched", async () => {
    const otherStation = `station_sfr_${RUN}_other`;
    await rawSql`
      INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, principal_id, adopted_at, created_at)
      VALUES (${otherStation}, ${OTHER_TENANT}, ${ADMIN}, ${OTHER_NODE}, 'claude-code', ${"claude-code:" + otherStation}, 'leaf', 'o', '["forge.api"]'::jsonb, null, now(), now())`;
    const gid = `fga_sfr_${RUN}_other`;
    await rawSql`
      INSERT INTO station_forge_api_grants (id, tenant_id, station_id, station_id_snapshot, provider, instance, mode, account, repositories, preset, state, generation, created_by)
      VALUES (${gid}, ${OTHER_TENANT}, ${otherStation}, ${otherStation}, 'forgejo', ${FORGE}, 'supplied', 'bot', '["o/r"]'::jsonb, 'read', 'verified', 1, ${ADMIN})`;
    // ADMIN owns that station, but acts in `tenant` here.
    expect((await call(asAdmin(), "GET", `/stations/${otherStation}/forge-api`)).status).toBe(404);
    expect((await call(asAdmin(), "DELETE", `/stations/${otherStation}/forge-api/${gid}`)).status).toBe(404);
    // And the other tenant's grant id under one of OUR stations is 404 too.
    const ours = await freshStation();
    expect((await call(asAdmin(), "DELETE", `/stations/${ours.id}/forge-api/${gid}`)).status).toBe(404);
    expect((await call(asAdmin(), "POST", `/stations/${ours.id}/forge-api/${gid}/verify`)).status).toBe(404);
    // A grant of a DIFFERENT station in our own tenant is not reachable through this station either.
    const sibling = await grantedStation();
    expect((await call(asAdmin(), "DELETE", `/stations/${ours.id}/forge-api/${sibling.grantId}`)).status).toBe(404);
    const [sib] = await db.select().from(g).where(eq(g.id, sibling.grantId));
    expect(sib!.state).toBe("delivered");
    const [row] = await db.select().from(g).where(eq(g.id, gid));
    expect(row!.state).toBe("verified");
    await rawSql`DELETE FROM station_forge_api_grants WHERE id = ${gid}`;
    await rawSql`DELETE FROM stations WHERE id = ${otherStation}`;
  });
});

// ─── Preconditions and error mapping ──────────────────────────────────────────

describe("preconditions and errors", () => {
  test("503 when the hub has no forge configured", async () => {
    const st = await freshStation();
    const r = await call(app({ id: ADMIN }, null), "POST", `/stations/${st.id}/forge-api`, grantBody());
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("forge-not-configured");
  });

  test("409 when the station has no occupant", async () => {
    const st = await freshStation({ occupied: false });
    const r = await call(asAdmin(), "POST", `/stations/${st.id}/forge-api`, grantBody());
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("no-occupant");
  });

  test("typed errors map to their status with a fixed message: no provider or node text", async () => {
    const st = await freshStation();
    // ForgeApiConfigError: preset none needs no token → 422
    const none = await call(asAdmin(), "POST", `/stations/${st.id}/forge-api`, grantBody({ preset: "none" }));
    expect(none.status).toBe(422);
    expect(none.json.error).toBe("preset-none-needs-no-token");
    // station-key-unavailable → 502, and the node's free text does not come back
    replies["forge.api.status"] = () => ({ ok: false, error: "NODE-FREE-TEXT boom" });
    const nokey = await call(asAdmin(), "POST", `/stations/${st.id}/forge-api`, grantBody());
    expect(nokey.status).toBe(502);
    expect(nokey.json.error).toBe("station-key-unavailable");
    expect(nokey.text).not.toContain("NODE-FREE-TEXT");
    expect(Object.keys(nokey.json).sort()).toEqual(["error", "message"]);
    // supplied without expectedLogin → 422 from the body schema's own rule
    const sup = await call(asAdmin(), "POST", `/stations/${st.id}/forge-api`, grantBody({ mode: "supplied" }));
    expect(sup.status).toBe(400);
  });

  test("rotation-failed is 502 with the code, audited as an error, and no provider text", async () => {
    const st = await grantedStation();
    checkFails = true;
    const r = await call(asAdmin(), "POST", `/stations/${st.id}/forge-api/${st.grantId}/rotate`);
    expect(r.status).toBe(502);
    expect(r.json).toEqual({ error: "rotation-failed", message: expect.any(String) });
    expect(r.text).not.toContain("PROVIDER-TEXT");
    const [a] = await db
      .select()
      .from(stationAudit)
      .where(and(eq(stationAudit.verb, "forge.api.route.rotate"), eq(stationAudit.stationKey, "claude-code:" + st.id)));
    expect(a!.result).toBe("error");
    expect(a!.error).toBe("rotation-failed");
  });

  test("a sealed secret that is not an envelope is 400 and not echoed", async () => {
    const st = await grantedStation();
    const r = await call(asAdmin(), "POST", `/stations/${st.id}/forge-api/${st.grantId}/secret`, { sealed: SECRET });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain(SECRET);
  });

  test("bodies over 64 KiB are 413", async () => {
    const st = await freshStation();
    const big = JSON.stringify(grantBody({ repositories: ["a/" + "b".repeat(70 * 1024)] }));
    const r = await call(asAdmin(), "POST", `/stations/${st.id}/forge-api`, undefined, big);
    expect(r.status).toBe(413);
  });

  test("instance must be a bare https origin", async () => {
    const st = await freshStation();
    for (const instance of [
      "http://forge.sfr.test",
      "https://user:pw@forge.sfr.test",
      "https://forge.sfr.test/path",
      "https://forge.sfr.test/?q=1",
      "https://forge.sfr.test/#x",
      "not a url",
    ]) {
      const r = await call(asAdmin(), "POST", `/stations/${st.id}/forge-api`, grantBody({ instance }));
      expect(`${instance} ${r.status}`).toBe(`${instance} 400`);
    }
    const ok = await call(asAdmin(), "POST", `/stations/${st.id}/forge-api`, grantBody({ instance: "https://FORGE.sfr.test/" }));
    expect(ok.status).toBe(200);
    expect(ok.json.grant.instance).toBe(FORGE);
  });

  test("repository lists are bounded and shaped", async () => {
    const st = await freshStation();
    for (const repositories of [[], ["noslash"], Array.from({ length: 51 }, (_, i) => `o/r${i}`)]) {
      const r = await call(asAdmin(), "POST", `/stations/${st.id}/forge-api`, grantBody({ repositories }));
      expect(r.status).toBe(400);
    }
  });
});

// ─── Responses and audit ──────────────────────────────────────────────────────

describe("responses are sanitised and every mutation is audited", () => {
  test("the whole lifecycle through the routes: no sealed/token/handle field in any response", async () => {
    const st = await freshStation();
    const responses: { json: unknown; text: string }[] = [];
    const go = async (method: string, path: string, body?: unknown, want = 200) => {
      const r = await call(asAdmin(), method, `/stations/${st.id}/forge-api${path}`, body);
      expect(`${method} ${path} ${r.status}`).toBe(`${method} ${path} ${want}`);
      responses.push(r);
      return r;
    };
    // Node offline on deliver: a live sealed blob stays on the row, and must not show.
    replies["forge.api.deliver"] = () => ({ ok: false, error: "node offline" });
    const created = await go("POST", "", grantBody());
    const offline = created.json.grant.id as string;
    expect(created.json.grant.hasPendingCredential).toBe(true);
    const [row] = await db.select().from(g).where(eq(g.id, offline));
    expect(row!.sealedBlob).not.toBeNull(); // the thing being hidden really exists
    expect(row!.tokenHandle).not.toBeNull();
    responses.push(await call(asOwner(), "GET", `/stations/${st.id}/forge-api`));
    responses.push(await call(asAdmin(), "GET", `/stations/${st.id}/forge-api`));
    resetReplies();
    // An undelivered grant is not verifiable (reconcile re-sends it); withdraw it and grant again.
    await go("DELETE", `/${offline}`);
    const id = (await go("POST", "", grantBody())).json.grant.id as string;
    await go("POST", `/${id}/verify`);
    const rotated = await go("POST", `/${id}/rotate`);
    expect(rotated.json.grant.generation).toBeGreaterThan(1);
    await go("PATCH", `/${id}/policy`, { preset: "issues", rules: [{ deny: "DELETE /repos/*" }], allowGraphql: false });
    await go("DELETE", `/${id}`);
    for (const r of responses) assertSanitised(r);
    const view = created.json.grant;
    for (const k of ["id", "stationId", "provider", "instance", "mode", "account", "expectedLogin", "repositories", "preset", "rules", "allowGraphql", "state", "stateReason", "generation", "isolation", "hasPendingCredential", "rotation", "createdAt", "updatedAt"]) {
      expect(view).toHaveProperty(k);
    }
    expect(view).not.toHaveProperty("deliveredAt");

    const audits = await db
      .select()
      .from(stationAudit)
      .where(and(eq(stationAudit.userId, ADMIN), like(stationAudit.verb, "forge.api.route.%")));
    const mine = audits.filter((a) => (a.paramsSummary as Record<string, unknown>).stationKey === "claude-code:" + st.id);
    const verbs = mine.map((a) => a.verb).sort();
    expect(verbs).toEqual(
      [
        "forge.api.route.grant",
        "forge.api.route.grant",
        "forge.api.route.policy",
        "forge.api.route.revoke",
        "forge.api.route.revoke",
        "forge.api.route.rotate",
        "forge.api.route.verify",
      ].sort(),
    );
    for (const a of mine) {
      const p = a.paramsSummary as Record<string, unknown>;
      expect(p.actor).toBe(ADMIN);
      expect(p.provider).toBe("forgejo");
      expect(p.mode).toBe("minted");
      expect(a.result).not.toBe("pending");
      if (a.verb !== "forge.api.route.grant") expect([id, offline]).toContain(p.grantId as string);
      const s = JSON.stringify(a);
      expect(s).not.toContain(SECRET);
      expect(s).not.toContain("stk-handover-v1:");
      expect(Object.keys(p)).not.toContain("sealed");
    }
  });

  test("supplied mode: secret and confirm-revoked are audited with the outcome, never the blob", async () => {
    const st = await freshStation();
    const created = await call(asAdmin(), "POST", `/stations/${st.id}/forge-api`, grantBody({ mode: "supplied", expectedLogin: "sfr-bot" }));
    expect(created.status).toBe(200);
    const id = created.json.grant.id as string;
    const sec = await call(asAdmin(), "POST", `/stations/${st.id}/forge-api/${id}/secret`, { sealed: SEALED });
    expect(sec.status).toBe(200);
    assertSanitised(sec);
    const rev = await call(asAdmin(), "DELETE", `/stations/${st.id}/forge-api/${id}`);
    expect(rev.status).toBe(200);
    expect(rev.json.outcome).toBe("pending-operator");
    const conf = await call(asAdmin(), "POST", `/stations/${st.id}/forge-api/${id}/confirm-revoked`);
    expect(conf.status).toBe(200);
    expect(conf.json.grant.state).toBe("revoked");
    const audits = await db.select().from(stationAudit).where(eq(stationAudit.userId, ADMIN));
    const mine = audits.filter((a) => (a.paramsSummary as Record<string, unknown>).grantId === id);
    expect(mine.map((a) => a.verb).sort()).toEqual(
      ["forge.api.route.confirm-revoked", "forge.api.route.revoke", "forge.api.route.secret"].sort(),
    );
    expect(JSON.stringify(mine)).not.toContain("stk-handover-v1:");
    for (const a of mine) expect(a.result).toBe("ok");
  });

  test("a refused step is audited as an error with its code only", async () => {
    const st = await freshStation({ occupied: false });
    await call(asAdmin(), "POST", `/stations/${st.id}/forge-api`, grantBody());
    const [a] = await db
      .select()
      .from(stationAudit)
      .where(and(eq(stationAudit.userId, ADMIN), eq(stationAudit.stationKey, "claude-code:" + st.id)));
    expect(a!.verb).toBe("forge.api.route.grant");
    expect(a!.result).toBe("error");
    expect(a!.error).toBe("no-occupant");
    expect((a!.paramsSummary as Record<string, unknown>).actor).toBe(ADMIN);
  });
});
