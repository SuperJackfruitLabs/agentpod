/**
 * A service principal (superwitness) exchanges its credential for a five-minute token whose `aud`
 * is the registered client's list and whose `scope` is its grant — and nothing else gets one.
 * DATABASE_URL must point at the local test-postgres on :5434.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
function adminApp() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: "test-admin", role: "admin" } as never);
    await next();
  });
  a.route("/service-principals", createAdminServicePrincipalsRouter({ clients: CLIENTS }));
  return a;
}
const exchange = (cred: string) =>
  tokenApp.request("/api/auth/service-token", { method: "POST", headers: { Authorization: `Bearer ${cred}` } });

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
    expect(await revokeServiceCredential(c.id)).toBe(true);
    expect((await exchange(`${c.id}:${c.secret}`)).status).toBe(401);
  });
});
