process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from "jose";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { signServiceToken } from "../service-signing";
import { config } from "../../config";
import type { PlaneBearerResult } from "../hub-token";
import { createPlaneVerifier } from "./verify";
import { db } from "../../db/drizzle";
import { tenants } from "../../db/schema/tenants";
import { eq } from "drizzle-orm";
import { verifyPlaneBearer } from "../hub-token";
import { resolveMcpCaller } from "../../mcp/auth";
import { setOrgPlaneForTests, TEST_PLANE } from "./config";
import { createDispatchableRoutes } from "../../routes/fleet-dispatchable";

const claims = {
  iss: TEST_PLANE.issuer, sub: "prn_aaaaaaaaaaaaaaaaaaaa", aud: TEST_PLANE.audience, exp: 2e9, iat: 2e9 - 300, jti: "j",
  principalKind: "agent" as const, org: "org_00000000000000000000", ent: ["agentpod"], mayDispatch: [], mayGrantReach: false,
};
let restore = () => {};
afterEach(() => restore());

describe("verifyPlaneBearer", () => {
  test("verified claims plus a mapped tenant", async () => {
    const r = await verifyPlaneBearer("t", {
      verify: async () => claims,
      tenantFor: async () => ({ ok: true, tenantId: "fleet_22222222222222222222" }),
    });
    expect(r).toEqual({ ok: true, caller: { sub: claims.sub, principalKind: "agent", tenantId: "fleet_22222222222222222222", claims } });
  });

  test("an unverifiable token is 401 and never reaches the tenant table", async () => {
    let touched = false;
    const r = await verifyPlaneBearer("t", { verify: async () => null, tenantFor: async () => ((touched = true), { ok: true, tenantId: "x" }) });
    expect(r).toEqual({ ok: false, status: 401 });
    expect(touched).toBe(false);
  });
});

describe("MCP under the plane", () => {
  test("an agent token resolves to its principal", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const caller = await resolveMcpCaller(
      new Request("http://hub/mcp", { headers: { Authorization: "Bearer t" } }),
      { verifyPlane: async () => ({ ok: true, caller: { sub: claims.sub, principalKind: "agent", tenantId: "fleet_x", claims } }) },
    );
    expect(caller).toEqual({ principalId: claims.sub, kind: "agent" });
  });

  test("product_not_enabled is surfaced as a refusal, not swallowed into a 401", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const caller = await resolveMcpCaller(
      new Request("http://hub/mcp", { headers: { Authorization: "Bearer t" } }),
      { verifyPlane: async () => ({ ok: false, status: 403, body: { error: "product_not_enabled", org: claims.org } }) },
    );
    expect(caller).toEqual({ refusal: { error: "product_not_enabled", org: claims.org } });
  });
});

describe("dispatchable under the plane", () => {
  test("reads mayDispatch from the plane token", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const app = createDispatchableRoutes({
      verifyPlane: async () => ({
        ok: true,
        caller: { sub: "prn_hhhhhhhhhhhhhhhhhhhh", principalKind: "human", tenantId: "fleet_x", claims: { ...claims, principalKind: "human", mayDispatch: ["prn_aaaaaaaaaaaaaaaaaaaa"] } },
      }),
      listPrincipals: async () => [
        { id: "prn_aaaaaaaaaaaaaaaaaaaa", kind: "agent", handle: "a", displayName: "A", userId: null, suspendedAt: null },
      ],
    });
    const res = await app.request("/api/fleet/dispatchable", { headers: { Authorization: "Bearer t" } });
    expect(await res.json()).toEqual({ agents: [{ id: "prn_aaaaaaaaaaaaaaaaaaaa", handle: "a", displayName: "A" }] });
  });
});

const notEnabled = { ok: false, status: 403, body: { error: "product_not_enabled", org: claims.org } } as const;

/** A verifyPlane that records every call: in legacy mode it must never be reached. */
function spy(result: PlaneBearerResult = { ok: false, status: 401 }) {
  const seen: string[] = [];
  return { seen, verifyPlane: async (t: string) => (seen.push(t), result) };
}

describe("verifyPlaneBearer refusals", () => {
  test("product_not_enabled passes through with the contract's body", async () => {
    const r = await verifyPlaneBearer("t", {
      verify: async () => ({ ...claims, ent: ["superpipeline"] }),
      tenantFor: async (c) => ({ ok: false, status: 403, body: { error: "product_not_enabled", org: c.org } }),
    });
    expect(r).toEqual(notEnabled);
  });
});

describe("MCP door", () => {
  beforeAll(ensurePgMigrations);

  test("legacy mode is unchanged: a hub token resolves and the plane is never asked", async () => {
    const s = spy();
    const token = await signServiceToken({
      payload: { principalKind: "agent", mayDispatch: [], mayGrantReach: false } as never,
      subject: claims.sub,
      ttl: "5m",
    });
    const caller = await resolveMcpCaller(
      new Request("http://hub/mcp", { headers: { Authorization: `Bearer ${token}` } }),
      { verifyPlane: s.verifyPlane },
    );
    expect(caller).toEqual({ principalId: claims.sub, kind: "agent" });
    expect(s.seen).toEqual([]);
  });

  test("under the plane, a hub-issued token is not accepted (no dual-accept)", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const token = await signServiceToken({
      payload: { principalKind: "agent", mayDispatch: [], mayGrantReach: false } as never,
      subject: claims.sub,
      ttl: "5m",
    });
    const s = spy();
    const caller = await resolveMcpCaller(
      new Request("http://hub/mcp", { headers: { Authorization: `Bearer ${token}` } }),
      { verifyPlane: s.verifyPlane },
    );
    expect(caller).toBeNull();
    expect(s.seen).toEqual([token]);
  });
});

describe("dispatchable door", () => {
  const listPrincipals = async () => [
    { id: "prn_aaaaaaaaaaaaaaaaaaaa", kind: "agent", handle: "a", displayName: "A", userId: null, suspendedAt: null },
  ] as never;
  const human = (extra: Record<string, unknown> = {}): PlaneBearerResult => ({
    ok: true,
    caller: {
      sub: "prn_bbbbbbbbbbbbbbbbbbbb",
      principalKind: "human",
      tenantId: "fleet_x",
      claims: { ...claims, sub: "prn_bbbbbbbbbbbbbbbbbbbb", principalKind: "human", mayDispatch: ["prn_aaaaaaaaaaaaaaaaaaaa"], ...extra },
    },
  });
  const get = (app: ReturnType<typeof createDispatchableRoutes>, token = "t") =>
    app.request("/api/fleet/dispatchable", { headers: { Authorization: `Bearer ${token}` } });

  test("product_not_enabled is the contract's 403 body, never a bare 403", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const res = await get(createDispatchableRoutes({ verifyPlane: async () => notEnabled, listPrincipals }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(notEnabled.body);
  });

  test("a human token minted for superpipeline-web is accepted: client_id/azp are ignored (contract §3.1)", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const res = await get(createDispatchableRoutes({
      verifyPlane: async () => human({ client_id: "superpipeline-web", azp: "superpipeline-web" }),
      listPrincipals,
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: [{ id: "prn_aaaaaaaaaaaaaaaaaaaa", handle: "a", displayName: "A" }] });
  });

  test("an agent's plane token still may not enumerate the fleet", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const res = await get(createDispatchableRoutes({
      verifyPlane: async () => ({ ok: true, caller: { sub: claims.sub, principalKind: "agent", tenantId: "fleet_x", claims } }),
      listPrincipals,
    }));
    expect(res.status).toBe(401);
  });

  test("an unverifiable token under the plane is 401 invalid_token", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const res = await get(createDispatchableRoutes({ verifyPlane: async () => ({ ok: false, status: 401 }), listPrincipals }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
  });

  test("legacy mode is unchanged: a hub token is verified locally and the plane is never asked", async () => {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
    const jwks = async () => ({ keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "EdDSA" }] }) as JSONWebKeySet;
    const token = await new SignJWT({ principalKind: "human", mayDispatch: ["prn_aaaaaaaaaaaaaaaaaaaa"] })
      .setProtectedHeader({ alg: "EdDSA", kid: "k" })
      .setIssuer(config.publicUrl)
      .setAudience(config.publicUrl)
      .setSubject("u")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const s = spy(human());
    const res = await get(createDispatchableRoutes({ jwks, verifyPlane: s.verifyPlane, listPrincipals }), token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: [{ id: "prn_aaaaaaaaaaaaaaaaaaaa", handle: "a", displayName: "A" }] });
    expect(s.seen).toEqual([]);
    // …and a plane-shaped bearer is just an unknown token to it.
    expect((await get(createDispatchableRoutes({ jwks, verifyPlane: s.verifyPlane, listPrincipals }), "plane-token")).status).toBe(401);
    expect(s.seen).toEqual([]);
  });
});

describe("verifyPlaneBearer end to end (real verifier, real tenant table)", () => {
  beforeAll(ensurePgMigrations);

  async function signed(ent: string[], org: string) {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: "e2e", alg: "EdDSA" };
    const verifier = createPlaneVerifier({
      issuer: TEST_PLANE.issuer,
      audience: TEST_PLANE.audience,
      jwksUrl: TEST_PLANE.jwksUrl,
      fetch: async () => new Response(JSON.stringify({ keys: [jwk] })),
    });
    const token = await new SignJWT({ principalKind: "human", org, ent, mayDispatch: [], mayGrantReach: false, jti: crypto.randomUUID() })
      .setProtectedHeader({ alg: "EdDSA", kid: "e2e" })
      .setIssuer(TEST_PLANE.issuer)
      .setAudience(["https://app.superpipeline.test", TEST_PLANE.audience])
      .setSubject("prn_cccccccccccccccccccc")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return { token, verify: (t: string) => verifier.verify(t) };
  }
  const hex = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);

  test("an org without agentpod in ent: exactly 403 product_not_enabled, and no tenant created", async () => {
    const org = `org_${hex()}`;
    const { token, verify } = await signed(["superpipeline"], org);
    expect(await verifyPlaneBearer(token, { verify })).toEqual({
      ok: false,
      status: 403,
      body: { error: "product_not_enabled", org },
    });
    expect(await db.select().from(tenants).where(eq(tenants.externalId, org))).toHaveLength(0);
  });

  test("an entitled org on first sight gets its tenant, and the caller is in it", async () => {
    const org = `org_${hex()}`;
    const { token, verify } = await signed(["agentpod"], org);
    try {
      const r = await verifyPlaneBearer(token, { verify });
      const [row] = await db.select().from(tenants).where(eq(tenants.externalId, org));
      expect(r.ok && r.caller.tenantId).toBe(row!.id);
      expect(r.ok && r.caller.principalKind).toBe("human");
    } finally {
      await db.delete(tenants).where(eq(tenants.externalId, org));
    }
  });
});
