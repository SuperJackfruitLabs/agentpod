/**
 * A service principal (superwitness) exchanges its credential for a five-minute token whose `aud`
 * is the registered client's list and whose `scope` is its grant — and nothing else gets one.
 * DATABASE_URL must point at the local test-postgres on :5434.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { decodeJwt } from "jose";

import { config, type OAuthClient } from "../../src/config";
import { rawSql } from "../../src/db/drizzle";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { createAdminServicePrincipalsRouter } from "../../src/routes/admin-service-principals";
import { createServiceTokenRoutes } from "../../src/routes/service-token";
import { getGrant } from "../../src/services/grants";
import { createPrincipal, suspendPrincipal } from "../../src/services/principals";
import { mintServiceCredential, revokeServiceCredential } from "../../src/services/service-credentials";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const RUN = crypto.randomUUID().slice(0, 8);
const HANDLE = `sw-it-${RUN}`;
const PLANE = "https://app.superpipeline.test";
const CLIENTS: OAuthClient[] = [
  { id: "superwitness", redirectUris: ["urn:ietf:wg:oauth:2.0:oob"], audiences: [config.publicUrl, PLANE] },
];

const tokenApp = new Hono().route("/api/auth", createServiceTokenRoutes({ clients: CLIENTS }));
/** A well-formed fleet id that names no tenant row: its writes break the FK, its reads match nothing. */
const NO_SUCH_TENANT = "fleet_deaddeaddeaddeaddead";
function adminApp(tenantId?: string) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: "test-admin", role: "admin", ...(tenantId ? { tenantId } : {}) } as never);
    await next();
  });
  a.route("/service-principals", createAdminServicePrincipalsRouter({ clients: CLIENTS }));
  return a;
}
const exchange = (cred: string) =>
  tokenApp.request("/api/auth/service-token", { method: "POST", headers: { Authorization: `Bearer ${cred}` } });
const post = (app: Hono, path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

let principalId = "";
let credential = { id: "", secret: "" };

beforeAll(async () => {
  await ensurePgMigrations();
});
afterAll(async () => {
  await rawSql`DELETE FROM principals WHERE handle LIKE ${`sw-it-${RUN}%`}`;
});

describe("creating a service principal", () => {
  test("creates the principal, its read-only grant and one credential, the secret shown once", async () => {
    const res = await adminApp().request("/service-principals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: HANDLE, oauthClient: "superwitness", scopes: ["evidence:read"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      principalId: string;
      credential: { id: string; secret: string; oauthClient: string };
    };
    expect(body.credential.id).toMatch(/^svc_[0-9a-f]{20}$/);
    expect(body.credential.secret.length).toBeGreaterThanOrEqual(43);
    principalId = body.principalId;
    credential = body.credential;
    expect(await getGrant(principalId)).toEqual({ mayDispatch: [], mayGrantReach: false, scopes: ["evidence:read"] });
  });

  test("a second create with the same handle is a conflict that names the existing principal", async () => {
    const res = await adminApp().request("/service-principals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: HANDLE, oauthClient: "superwitness", scopes: ["evidence:read"] }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { principalId: string }).principalId).toBe(principalId);
  });

  test("a client the hub has not registered is refused before anything is created", async () => {
    const res = await adminApp().request("/service-principals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: `${HANDLE}-x`, oauthClient: "nobody", scopes: ["evidence:read"] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/service-token", () => {
  test("mints a service token for both planes, carrying its scope and no actor", async () => {
    const res = await exchange(`${credential.id}:${credential.secret}`);
    expect(res.status).toBe(200);
    const { token, expiresIn } = (await res.json()) as { token: string; expiresIn: number };
    expect(expiresIn).toBe(300);
    const claims = decodeJwt(token);
    expect(claims.sub).toBe(principalId);
    expect(claims.principalKind).toBe("service");
    expect(claims.scope).toBe("evidence:read");
    expect(claims.aud).toEqual([config.publicUrl, PLANE]);
    expect(claims.act).toBeUndefined();
    expect(claims.tenant).toBe(BOOTSTRAP_TENANT_ID);
  });

  test("a wrong secret, a garbled header and an unknown id all get the same 401", async () => {
    for (const cred of [`${credential.id}:wrong`, "garbage", `svc_00000000000000000000:${credential.secret}`]) {
      const res = await exchange(cred);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid service credential" });
    }
  });

  test("a credential naming a human principal mints nothing", async () => {
    const human = await createPrincipal({ kind: "human", handle: `${HANDLE}-human` });
    const c = await mintServiceCredential({ tenantId: BOOTSTRAP_TENANT_ID, principalId: human, oauthClient: "superwitness", name: "x" });
    expect((await exchange(`${c.id}:${c.secret}`)).status).toBe(403);
  });

  test("a credential whose client was unregistered mints nothing", async () => {
    const c = await mintServiceCredential({ tenantId: BOOTSTRAP_TENANT_ID, principalId, oauthClient: "gone", name: "x" });
    expect((await exchange(`${c.id}:${c.secret}`)).status).toBe(403);
  });

  test("a suspended service principal mints nothing", async () => {
    const other = await createPrincipal({ kind: "service", handle: `${HANDLE}-susp` });
    const c = await mintServiceCredential({ tenantId: BOOTSTRAP_TENANT_ID, principalId: other, oauthClient: "superwitness", name: "x" });
    await suspendPrincipal(other);
    expect((await exchange(`${c.id}:${c.secret}`)).status).toBe(403);
  });

  test("a revoked credential is the same 401 as an unknown one", async () => {
    const c = await mintServiceCredential({ tenantId: BOOTSTRAP_TENANT_ID, principalId, oauthClient: "superwitness", name: "x" });
    expect(await revokeServiceCredential(BOOTSTRAP_TENANT_ID, c.id)).toBe(true);
    expect((await exchange(`${c.id}:${c.secret}`)).status).toBe(401);
  });
});

describe("creating a service principal is all or nothing", () => {
  test("a credential that cannot be written leaves no principal and no grant behind", async () => {
    const handle = `${HANDLE}-atomic`;
    // The tenant is well-formed but has no row, so the credential insert — the LAST of the three
    // writes — breaks its foreign key after the principal and grant were already written.
    const res = await post(adminApp(NO_SUCH_TENANT), "/service-principals", {
      handle, oauthClient: "superwitness", scopes: ["evidence:read"],
    });
    expect(res.status).toBe(500);
    const rows = await rawSql`SELECT id FROM principals WHERE handle = ${handle}`;
    expect(rows).toHaveLength(0);
  });
});

describe("rotating a service credential", () => {
  test("after revoking A, a credential B minted for the same principal exchanges and A does not", async () => {
    const res = await post(adminApp(), "/service-principals", {
      handle: `${HANDLE}-rot`, oauthClient: "superwitness", scopes: ["evidence:read"],
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { principalId: string; credential: { id: string; secret: string } };
    const a = created.credential;

    expect((await post(adminApp(), `/service-principals/credentials/${a.id}/revoke`)).status).toBe(204);

    const minted = await post(adminApp(), `/service-principals/${created.principalId}/credentials`, { oauthClient: "superwitness" });
    expect(minted.status).toBe(201);
    const { credential: b } = (await minted.json()) as { credential: { id: string; secret: string; oauthClient: string } };
    expect(b.id).toMatch(/^svc_[0-9a-f]{20}$/);
    expect(b.id).not.toBe(a.id);
    expect(b.oauthClient).toBe("superwitness");
    expect(b.secret.length).toBeGreaterThanOrEqual(43);

    const ok = await exchange(`${b.id}:${b.secret}`);
    expect(ok.status).toBe(200);
    expect(decodeJwt(((await ok.json()) as { token: string }).token).sub).toBe(created.principalId);
    expect((await exchange(`${a.id}:${a.secret}`)).status).toBe(401);
  });

  test("a principal that is not a service gets no credential: 404", async () => {
    const human = await createPrincipal({ kind: "human", handle: `${HANDLE}-rot-human` });
    const res = await post(adminApp(), `/service-principals/${human}/credentials`, { oauthClient: "superwitness" });
    expect(res.status).toBe(404);
    const rows = await rawSql`SELECT id FROM service_credentials WHERE principal_id = ${human}`;
    expect(rows).toHaveLength(0);
  });

  test("a principal that does not exist: 404", async () => {
    const res = await post(adminApp(), "/service-principals/prn_00000000000000000000/credentials", { oauthClient: "superwitness" });
    expect(res.status).toBe(404);
  });

  test("a client the hub has not registered is refused as create refuses it", async () => {
    const res = await post(adminApp(), `/service-principals/${principalId}/credentials`, { oauthClient: "nobody" });
    expect(res.status).toBe(400);
  });
});

describe("POST /service-principals/credentials/:id/revoke", () => {
  test("204, then 404 on a second revoke, and the revoked credential is refused at the exchange", async () => {
    const c = await mintServiceCredential({ tenantId: BOOTSTRAP_TENANT_ID, principalId, oauthClient: "superwitness", name: "x" });
    expect((await exchange(`${c.id}:${c.secret}`)).status).toBe(200);

    const first = await post(adminApp(), `/service-principals/credentials/${c.id}/revoke`);
    expect(first.status).toBe(204);
    const second = await post(adminApp(), `/service-principals/credentials/${c.id}/revoke`);
    expect(second.status).toBe(404);
    expect((await exchange(`${c.id}:${c.secret}`)).status).toBe(401);
  });

  test("an admin acting in another tenant cannot revoke this tenant's credential", async () => {
    const c = await mintServiceCredential({ tenantId: BOOTSTRAP_TENANT_ID, principalId, oauthClient: "superwitness", name: "x" });
    expect((await post(adminApp(NO_SUCH_TENANT), `/service-principals/credentials/${c.id}/revoke`)).status).toBe(404);
    expect((await exchange(`${c.id}:${c.secret}`)).status).toBe(200);
  });
});

describe("the token's audiences come from the registered client, never the request", () => {
  test("aud / audiences in the body or the query are ignored", async () => {
    const res = await tokenApp.request("/api/auth/service-token?aud=https://evil.test&audiences=https://evil.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.id}:${credential.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ aud: ["https://evil.test"], audiences: ["https://evil.test"] }),
    });
    expect(res.status).toBe(200);
    expect(decodeJwt(((await res.json()) as { token: string }).token).aud).toEqual([config.publicUrl, PLANE]);
  });
});

/**
 * Where the exchange is MOUNTED, which the bare-app tests above cannot see — the same structural
 * guard `src/routes/devices.test.ts` keeps for `deviceRoutes`, after those paths 404'd in production.
 */
describe("the service-token route is mounted where it can be reached", () => {
  const source = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
  const mount = source.indexOf(".route('/api/auth', serviceTokenRoutes)");

  test("above Better Auth's /api/auth/* catch-all", () => {
    const catchAll = source.indexOf(".on(['GET', 'POST'], '/api/auth/*'");
    expect(mount, "serviceTokenRoutes is not mounted in index.ts at all").toBeGreaterThan(-1);
    expect(catchAll, "the Better Auth catch-all moved or changed shape — re-read this test").toBeGreaterThan(-1);
    expect(mount, "serviceTokenRoutes is mounted AFTER Better Auth's catch-all, which swallows it").toBeLessThan(catchAll);
  });

  test("above authMiddleware, which would 401 a svc_… credential", () => {
    const middleware = source.indexOf(".use('/api/*', authMiddleware)");
    expect(middleware).toBeGreaterThan(-1);
    expect(mount, "serviceTokenRoutes is behind authMiddleware, which accepts no svc_… credential").toBeLessThan(middleware);
  });
});

describe("a run reporter (superwitness app spec §3.4)", () => {
  const REPORTER: OAuthClient[] = [
    {
      id: "superpipeline-run-reporter",
      redirectUris: ["urn:ietf:wg:oauth:2.0:oob"],
      audiences: ["http://foundry.test:8790", "https://app.superwitness.test"],
    },
  ];
  const reporterAdmin = () => {
    const a = new Hono();
    a.use("*", async (c, next) => {
      c.set("user", { id: "test-admin", role: "admin" } as never);
      await next();
    });
    a.route("/service-principals", createAdminServicePrincipalsRouter({ clients: REPORTER }));
    return a;
  };

  test("is created holding runs:write alone, and its token carries that scope and only its client's audiences", async () => {
    const res = await post(reporterAdmin(), "/service-principals", {
      handle: `${HANDLE}-rep`, oauthClient: "superpipeline-run-reporter", scopes: ["runs:write"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { principalId: string; credential: { id: string; secret: string } };
    expect(await getGrant(body.principalId)).toEqual({ mayDispatch: [], mayGrantReach: false, scopes: ["runs:write"] });

    const tokens = new Hono().route("/api/auth", createServiceTokenRoutes({ clients: REPORTER }));
    const t = await tokens.request("/api/auth/service-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${body.credential.id}:${body.credential.secret}` },
    });
    expect(t.status).toBe(200);
    const claims = decodeJwt(((await t.json()) as { token: string }).token);
    expect(claims.principalKind).toBe("service");
    expect(claims.scope).toBe("runs:write");
    expect(claims.aud).toEqual(["http://foundry.test:8790", "https://app.superwitness.test"]);
    expect(claims.mayDispatch).toEqual([]);
    expect(claims.mayGrantReach).toBe(false);
  });

  test("a scope outside the vocabulary is still refused before anything is created", async () => {
    const res = await post(reporterAdmin(), "/service-principals", {
      handle: `${HANDLE}-rep2`, oauthClient: "superpipeline-run-reporter", scopes: ["runs:read"],
    });
    expect(res.status).toBe(400);
  });
});
