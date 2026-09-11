/**
 * `authMiddleware` accepts a token this hub issued — from a human principal, and only a human.
 *
 * **What this closes.** The hub is the issuer for the whole suite and was the one plane that
 * would not read its own tokens: exactly one route, `/api/fleet/dispatchable`, verified a hub
 * JWT, and every other `/api/*` route took a session cookie, the static API_TOKEN, or a Better
 * Auth session token. A client finishing the authorization-code flow got a credential that
 * opened one endpoint.
 *
 * **What it deliberately does not open.** An agent-kind token is refused at the middleware
 * rather than at each route. Most routes here have never had to consider a non-human caller;
 * `requireGrantReach` guards the reach-bearing acts, but only on the routes that call it, and
 * `runtimes`, `stations` and `station-acp` call nothing. Widening what a hub token REACHES must
 * not silently widen WHO may hold one. A route audited and found correct for an agent can opt
 * in later, from a default that was closed.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { auth } from "./drizzle-auth";
import { authMiddleware } from "./middleware";
import { BOOTSTRAP_TENANT_ID } from "./tenant";
import { createPrincipal } from "../services/principals";

let humanPrincipalId: string;
let humanUserId: string;
let agentPrincipalId: string;

/** A minimal protected app: the middleware, and a route that reports who got through. */
const app = new Hono()
  .use("/api/*", authMiddleware)
  .get("/api/whoami", (c) => {
    const u = c.get("user");
    return c.json({ id: u.id, authType: u.authType, tenantId: u.tenantId });
  });

async function tokenFor(sub: string, principalKind: string): Promise<string> {
  const { token } = await auth.api.signJWT({
    body: {
      payload: {
        iat: Math.floor(Date.now() / 1000),
        sub,
        principalKind,
        tenant: BOOTSTRAP_TENANT_ID,
        mayDispatch: [],
        mayGrantReach: false,
      },
    },
  });
  return token;
}

const get = (token?: string) =>
  app.request("/api/whoami", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

beforeAll(async () => {
  humanUserId = `usr_hubtok_${Date.now()}`;
  humanPrincipalId = await createPrincipal({
    kind: "human",
    handle: `hubtok-human-${Date.now()}`,
    userId: humanUserId,
  });

  agentPrincipalId = await createPrincipal({
    kind: "agent",
    handle: `hubtok-agent-${Date.now()}`,
  });
});

describe("a hub-issued token on an ordinary route", () => {
  test("a human principal is admitted, as its Better Auth user", async () => {
    const res = await get(await tokenFor(humanPrincipalId, "human"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; authType: string; tenantId: string };

    // The translation is the point. Everything below this layer resolves on a Better Auth id —
    // `getStation(userId, …)`, `requireLive(userId, …)` — and handing those a `prn_` is the
    // defect that killed every bridge-mode room on 2026-08-31 (#399, #400).
    expect(body.id).toBe(humanUserId);
    expect(body.id.startsWith("prn_")).toBe(false);
    expect(body.authType).toBe("hub_token");
    expect(body.tenantId).toBe(BOOTSTRAP_TENANT_ID);
  });

  test("an agent principal is refused, and told why", async () => {
    const res = await get(await tokenFor(agentPrincipalId, "agent"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("agent");
  });

  test("a service principal is refused too — the rule is human-only, not not-agent", async () => {
    const res = await get(await tokenFor(humanPrincipalId, "service"));
    expect(res.status).toBe(403);
  });

  test("a human principal with no account on this hub is refused", async () => {
    // A principal row can exist with no `better-auth` identity linked. It cannot act on routes
    // that scope by Better Auth id, and failing closed is the only safe answer.
    const orphan = await createPrincipal({
      kind: "human",
      handle: `hubtok-orphan-${Date.now()}`,
    });
    const res = await get(await tokenFor(orphan, "human"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toContain("no account");
  });
});

describe("what it does not accept", () => {
  test("no token at all is still 401, not 403", async () => {
    // The distinction matters to a CLI: 401 means sign in, 403 means you may not.
    expect((await get()).status).toBe(401);
  });

  test("a garbage bearer is 401", async () => {
    expect((await get("not-a-token")).status).toBe(401);
  });

  test("a token signed by a key this hub does not publish is 401", async () => {
    // Same shape, wrong signer. Verified by the JWKS, not by the token's own header.
    const foreign =
      "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9." +
      Buffer.from(JSON.stringify({ sub: humanPrincipalId, principalKind: "human" })).toString("base64url") +
      ".c2lnbmF0dXJl";
    expect((await get(foreign)).status).toBe(401);
  });
});
