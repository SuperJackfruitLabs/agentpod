/**
 * Route tests: `GET /api/fleet/dispatchable`.
 *
 * Two properties carry this file, and everything else is detail.
 *
 * **1. The answer comes from the token and from nothing else.** The endpoint
 * returns an authorization decision — which agents this operator may dispatch
 * — so if a query parameter, a header or a body could widen it, an
 * authenticated caller would be one request away from the whole fleet. There
 * are tests below that send exactly those and assert the answer does not move.
 *
 * **2. An agent may not enumerate the fleet.** `mayDispatch` is the authority
 * to ask an agent to work, never the authority to discover what else exists.
 *
 * Tokens are minted with `auth.api.signJWT`, the hub's own signer — the same
 * call `auth-authorize.ts`'s exchange makes — so every token here is signed
 * with the real key, carries the real issuer and audience, and would be
 * accepted by any consumer in the suite. The refusals are therefore about the
 * claims, not about a fixture the endpoint happens not to like. The two that
 * ARE about the signature say so: one is signed with a key generated in this
 * file, the other with the hub's service key.
 *
 * Uses the local Docker test-postgres (localhost:5434).
 * DATABASE_URL must be set before any src/ modules are imported.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { SignJWT, generateKeyPair } from "jose";

import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { rawSql } from "../db/drizzle";
import { auth } from "../auth/drizzle-auth";
import { config } from "../config";
import { createPrincipal, suspendPrincipal } from "../services/principals";
import { signServiceToken } from "../auth/service-signing";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { createDispatchableRoutes } from "./fleet-dispatchable";

const RUN = crypto.randomUUID().slice(0, 8);
const HANDLE_PREFIX = `dispatchable-it-${RUN}`;

const app = createDispatchableRoutes();

/** Principal ids created in `beforeAll`, filled in there. */
let agentA = "";
let agentB = "";
let agentC = "";
let humanId = "";
let suspendedAgent = "";

/** An id shaped like a principal's that names nobody — a stale grant. */
const GHOST = "prn_00000000000000000000000000";

/**
 * A hub token with these claims, signed by the hub's real key.
 *
 * Claims are supplied whole rather than built through `buildTokenPayload`,
 * because what is under test is what the endpoint does with a claim — an agent
 * kind, an absent control pair, a grant naming a deleted principal — and
 * several of those are states the mint path deliberately will not produce.
 */
async function tokenWith(claims: Record<string, unknown>): Promise<string> {
  const { token } = await auth.api.signJWT({
    body: {
      payload: {
        iat: Math.floor(Date.now() / 1000),
        sub: humanId,
        principalKind: "human",
        tenant: BOOTSTRAP_TENANT_ID,
        mayDispatch: [],
        mayGrantReach: false,
        ...claims,
      },
    },
  });
  return token;
}

/** `GET /api/fleet/dispatchable`, with an optional Bearer and extra bait. */
async function fetchDispatchable(
  token: string | null,
  opts: { query?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
  const headers = new Headers(opts.headers ?? {});
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return app.request(`/api/fleet/dispatchable${opts.query ?? ""}`, { headers });
}

async function agentsFrom(res: Response) {
  return (
    (await res.json()) as {
      agents: Array<{ id: string; handle: string; displayName: string | null }>;
    }
  ).agents;
}

beforeAll(async () => {
  await ensurePgMigrations();

  agentA = await createPrincipal({
    kind: "agent",
    handle: `${HANDLE_PREFIX}-alpha`,
    displayName: "Alpha",
  });
  agentB = await createPrincipal({
    kind: "agent",
    handle: `${HANDLE_PREFIX}-beta`,
    displayName: "Beta",
  });
  // Deliberately no displayName: the response type says it may be null, and a
  // picker that crashed on the ordinary case would be found in production.
  agentC = await createPrincipal({ kind: "agent", handle: `${HANDLE_PREFIX}-gamma` });
  humanId = await createPrincipal({
    kind: "human",
    handle: `${HANDLE_PREFIX}-operator`,
    displayName: "An Operator",
  });

  suspendedAgent = await createPrincipal({
    kind: "agent",
    handle: `${HANDLE_PREFIX}-shut-off`,
    displayName: "Shut Off",
  });
  await suspendPrincipal(suspendedAgent);
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM principals WHERE handle LIKE ${HANDLE_PREFIX + "%"}`;
  } catch {
    // cleanup only
  }
});

// ─── The set the token grants, and only that set ──────────────────────────────

describe("what a valid human token gets back", () => {
  test("only the agent principals its grant names, with their handles", async () => {
    const token = await tokenWith({ mayDispatch: [agentA, agentC] });

    const res = await fetchDispatchable(token);
    expect(res.status).toBe(200);

    expect(await agentsFrom(res)).toEqual([
      { id: agentA, handle: `${HANDLE_PREFIX}-alpha`, displayName: "Alpha" },
      { id: agentC, handle: `${HANDLE_PREFIX}-gamma`, displayName: null },
    ]);
  });

  test("an agent the grant does not name is absent", async () => {
    const token = await tokenWith({ mayDispatch: [agentA] });

    const ids = (await agentsFrom(await fetchDispatchable(token))).map((a) => a.id);
    expect(ids).toEqual([agentA]);
    expect(ids).not.toContain(agentB);
  });

  test("an id that resolves to nothing is skipped, not thrown", async () => {
    // A grant naming a deleted principal is a stale grant. It must not take
    // the live half of the list down with it, and it must not 500.
    const token = await tokenWith({ mayDispatch: [GHOST, agentB] });

    const res = await fetchDispatchable(token);
    expect(res.status).toBe(200);
    expect((await agentsFrom(res)).map((a) => a.id)).toEqual([agentB]);
  });

  test("an id that resolves to a human is skipped — this list is agents", async () => {
    const token = await tokenWith({ mayDispatch: [humanId, agentA] });

    expect((await agentsFrom(await fetchDispatchable(token))).map((a) => a.id)).toEqual([agentA]);
  });

  test("a suspended agent is not offered", async () => {
    // The response shape carries no way to say "suspended", so a consumer
    // cannot filter one out — and a suspended principal is one the hub itself
    // refuses to mint a token for. Offering it would be offering something
    // that cannot work.
    const token = await tokenWith({ mayDispatch: [suspendedAgent, agentA] });

    expect((await agentsFrom(await fetchDispatchable(token))).map((a) => a.id)).toEqual([agentA]);
  });

  test("a duplicated id is listed once", async () => {
    const token = await tokenWith({ mayDispatch: [agentA, agentA] });

    expect((await agentsFrom(await fetchDispatchable(token))).map((a) => a.id)).toEqual([agentA]);
  });

  test("an empty grant is 200 and an empty list, not a failure", async () => {
    // Nothing to offer is an answer. A fresh operator with no grant should see
    // an empty picker, which is the truth, rather than an error they cannot act
    // on and cannot distinguish from the hub being down.
    const res = await fetchDispatchable(await tokenWith({ mayDispatch: [] }));

    expect(res.status).toBe(200);
    expect(await agentsFrom(res)).toEqual([]);
  });

  test("a token with no mayDispatch claim at all gets nothing, not everything", async () => {
    const res = await fetchDispatchable(await tokenWith({ mayDispatch: undefined }));

    expect(res.status).toBe(200);
    expect(await agentsFrom(res)).toEqual([]);
  });
});

// ─── The decision is the token's, and the caller cannot move it ───────────────

describe("nothing the caller sends can widen the answer", () => {
  test("a mayDispatch query parameter is ignored", async () => {
    // The one that matters. If this ever passes by returning agentB, the
    // endpoint hands any authenticated caller the whole fleet.
    const token = await tokenWith({ mayDispatch: [agentA] });

    const res = await fetchDispatchable(token, {
      query: `?mayDispatch=${agentB}&mayDispatch=${agentC}`,
    });

    expect((await agentsFrom(res)).map((a) => a.id)).toEqual([agentA]);
  });

  test("a mayDispatch header is ignored", async () => {
    const token = await tokenWith({ mayDispatch: [agentA] });

    const res = await fetchDispatchable(token, {
      headers: { "x-may-dispatch": agentB, "may-dispatch": agentB },
    });

    expect((await agentsFrom(res)).map((a) => a.id)).toEqual([agentA]);
  });

  test("a principalKind query parameter cannot rescue an agent's token", async () => {
    const token = await tokenWith({ principalKind: "agent", mayDispatch: [agentA] });

    const res = await fetchDispatchable(token, { query: "?principalKind=human" });
    expect(res.status).toBe(401);
  });
});

// ─── Who may ask ──────────────────────────────────────────────────────────────

describe("who the endpoint refuses", () => {
  test("an agent-kind token cannot enumerate the fleet", async () => {
    // Even with a full grant. `mayDispatch` is the authority to ask an agent to
    // work; discovering what else exists is a different question, and an agent
    // asking it is reconnaissance.
    const token = await tokenWith({
      principalKind: "agent",
      sub: agentA,
      mayDispatch: [agentB, agentC],
    });

    const res = await fetchDispatchable(token);
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_token" });
  });

  test("a service-kind token is refused too", async () => {
    const res = await fetchDispatchable(
      await tokenWith({ principalKind: "service", mayDispatch: [agentA] })
    );
    expect(res.status).toBe(401);
  });

  test("a token with no principalKind claim is refused", async () => {
    // Absent is not human. A consumer that read a missing claim as the
    // permissive case would accept every token an older issuer ever signed.
    const res = await fetchDispatchable(
      await tokenWith({ principalKind: undefined, mayDispatch: [agentA] })
    );
    expect(res.status).toBe(401);
  });

  test("no Authorization header at all is 401", async () => {
    const res = await fetchDispatchable(null);
    expect(res.status).toBe(401);
  });

  test("an Authorization header that is not a Bearer is 401", async () => {
    const res = await app.request("/api/fleet/dispatchable", {
      headers: new Headers({ authorization: `Basic ${btoa("who:cares")}` }),
    });
    expect(res.status).toBe(401);
  });

  test("an empty Bearer is 401", async () => {
    const res = await app.request("/api/fleet/dispatchable", {
      headers: new Headers({ authorization: "Bearer " }),
    });
    expect(res.status).toBe(401);
  });
});

// ─── The signature ────────────────────────────────────────────────────────────

describe("which tokens verify", () => {
  test("an expired token is 401", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const token = await tokenWith({ mayDispatch: [agentA], iat: past - 300, exp: past });

    const res = await fetchDispatchable(token);
    expect(res.status).toBe(401);
  });

  test("a token signed by somebody else is 401", async () => {
    // Same claims, same issuer and audience, same algorithm — everything but a
    // key this hub published. This is the check the whole endpoint rests on.
    const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
    const token = await new SignJWT({
      principalKind: "human",
      tenant: BOOTSTRAP_TENANT_ID,
      mayDispatch: [agentA, agentB, agentC],
      mayGrantReach: true,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "not-a-key-this-hub-has" })
      .setSubject(humanId)
      .setIssuedAt()
      .setIssuer(config.publicUrl)
      .setAudience(config.publicUrl)
      .setExpirationTime("5m")
      .sign(privateKey);

    const res = await fetchDispatchable(token);
    expect(res.status).toBe(401);
  });

  test("a token minted for another issuer is 401", async () => {
    const token = await tokenWith({
      mayDispatch: [agentA],
      iss: "https://not-this-hub.example",
    });

    expect((await fetchDispatchable(token)).status).toBe(401);
  });

  test("a token minted for another audience is 401", async () => {
    const token = await tokenWith({
      mayDispatch: [agentA],
      aud: "https://somebody-else.example",
    });

    expect((await fetchDispatchable(token)).status).toBe(401);
  });

  test("garbage in the Bearer is 401, not a 500", async () => {
    expect((await fetchDispatchable("not.a.jwt")).status).toBe(401);
  });

  test("a token signed with the hub's SERVICE key is accepted", async () => {
    // The key set this endpoint verifies against is the one `/api/auth/jwks`
    // publishes, which is both halves — Better Auth's keys and the service
    // signing keys. This test is what holds the two together: drop the service
    // keys from `publishedJwks` and only this fails, which is the difference
    // between "the bridge's assertion of a human works everywhere" and "it
    // works everywhere except here".
    const token = await signServiceToken({
      payload: {
        sub: humanId,
        principalKind: "human",
        tenant: BOOTSTRAP_TENANT_ID,
        mayDispatch: [agentB],
        mayGrantReach: false,
      },
      subject: humanId,
      ttl: "120s",
    });

    const res = await fetchDispatchable(token);
    expect(res.status).toBe(200);
    expect((await agentsFrom(res)).map((a) => a.id)).toEqual([agentB]);
  });
});
