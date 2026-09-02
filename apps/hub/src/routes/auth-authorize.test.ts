/**
 * Route test: `GET /api/auth/authorize`.
 *
 * Most of this file is about ONE property, asserted the only way that proves
 * it: **a refusal carries no `Location` header at all.** A test that checked
 * only for a 400 would pass an implementation that returned 400 *and*
 * redirected anyway — and an authorize endpoint that redirects to a URI it was
 * not told to is an open redirector that mints credentials, which is the worst
 * outcome available here. So every refusal below asserts the absence of the
 * header, not merely the status.
 *
 * The registry is injected rather than read from `HUB_OAUTH_CLIENTS`, because
 * `oauthClients` is computed at module scope on first import and a test file
 * cannot reliably be the first importer (`config.test.ts` uses a subprocess for
 * exactly that reason). `findOAuthClient`/`isRegisteredRedirect` are the real
 * ones — only the list they read is this file's.
 *
 * The session is injected for the same class of reason: a Better Auth session
 * is a signed cookie this test cannot mint. Everything downstream of it is
 * real — the real `buildTokenPayload`, the real `mintCode`, the real database.
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
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";

import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { db, rawSql } from "../db/drizzle";
import { oauthCodes } from "../db/schema/oauth";
import { createPrincipal, suspendPrincipal } from "../services/principals";
import { signInUrl, type OAuthClient } from "../config";
import { createAuthorizeRoutes } from "./auth-authorize";

const RUN = crypto.randomUUID().slice(0, 8);
const HANDLE_PREFIX = `authorize-it-${RUN}`;

/** A signed-in operator who maps to a live principal — the happy path. */
const LIVE_USER = `test-user-authorize-live-${RUN}`;
/** A signed-in operator whose principal has been shut off. */
const SUSPENDED_USER = `test-user-authorize-suspended-${RUN}`;
/** A signed-in operator who maps to no principal at all. */
const UNMAPPED_USER = `test-user-authorize-unmapped-${RUN}`;

const REDIRECT = "https://kaambaan.dev/hub/callback";
const SECOND_REDIRECT = "https://kaambaan.dev/hub/callback-alt";

/**
 * The registry the routes under test read. Two URIs for one client, so
 * "registered" is proved to mean "any of this client's", and a second client
 * so a cross-client redirect can be attempted.
 */
const REGISTRY: OAuthClient[] = [
  { id: "kaambaan", redirectUris: [REDIRECT, SECOND_REDIRECT] },
  { id: "supermessage", redirectUris: ["https://supermessage.dev/hub/callback"] },
];

/** 43 base64url characters — S256 of some verifier. */
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/** The state kaambaan would send: opaque here, meaningful only to it. */
const STATE = "opaque-state-from-kaambaan";

const VALID: Record<string, string> = {
  client: "kaambaan",
  redirect_uri: REDIRECT,
  state: STATE,
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
};

/** Routes whose session lookup answers for `userId`, or for nobody. */
function appFor(userId: string | null) {
  return createAuthorizeRoutes({
    clients: REGISTRY,
    getSession: async () => (userId ? { user: { id: userId } } : null),
  });
}

const signedIn = appFor(LIVE_USER);
const signedOut = appFor(null);

/**
 * `null` for a parameter means "omit it" — the difference between a missing
 * parameter and an empty one is exactly what several of these refusals are
 * about.
 */
async function authorize(
  app: ReturnType<typeof appFor>,
  overrides: Record<string, string | null> = {}
): Promise<Response> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...VALID, ...overrides })) {
    if (value !== null) params.set(key, value);
  }
  return app.request(`/api/auth/authorize?${params.toString()}`);
}

/** Every code this file caused to exist, so afterAll can take them away. */
async function codesFor(userId: string) {
  return db.select().from(oauthCodes).where(eq(oauthCodes.userId, userId));
}

beforeAll(async () => {
  await ensurePgMigrations();

  await createPrincipal({
    kind: "human",
    handle: `${HANDLE_PREFIX}-live`,
    userId: LIVE_USER,
  });

  const suspended = await createPrincipal({
    kind: "human",
    handle: `${HANDLE_PREFIX}-suspended`,
    userId: SUSPENDED_USER,
  });
  await suspendPrincipal(suspended);
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM oauth_codes WHERE user_id IN (${LIVE_USER}, ${SUSPENDED_USER}, ${UNMAPPED_USER})`;
    await rawSql`DELETE FROM principals WHERE handle LIKE ${HANDLE_PREFIX + "%"}`;
  } catch {
    // cleanup only
  }
});

// ─── The rule that matters most: a refusal redirects NOWHERE ──────────────────

describe("a refusal never carries a Location header", () => {
  test("an unknown client is refused, and not redirected", async () => {
    const res = await authorize(signedIn, { client: "not-a-registered-plane" });

    expect(res.status).toBe(400);
    // The assertion this whole endpoint exists to satisfy. `toBe(null)` and
    // not `toBeFalsy()`: "" would also be falsy and would still be a Location
    // header on the wire.
    expect(res.headers.get("location")).toBe(null);
  });

  test("a registered client with an unregistered redirect_uri is refused, and not redirected", async () => {
    const res = await authorize(signedIn, {
      redirect_uri: "https://attacker.example/steal",
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBe(null);
  });

  test("a redirect_uri registered to a DIFFERENT client is refused", async () => {
    // Being in the registry at all is not the question; being in *this*
    // client's list is. Otherwise one registered plane could collect another's
    // codes.
    const res = await authorize(signedIn, {
      client: "kaambaan",
      redirect_uri: "https://supermessage.dev/hub/callback",
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBe(null);
  });

  test("a redirect_uri that merely starts with a registered one is refused", async () => {
    // Prefix matching is how this becomes an open redirector.
    const res = await authorize(signedIn, {
      redirect_uri: `${REDIRECT}/../../evil`,
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBe(null);
  });

  test("a missing redirect_uri is refused, and not redirected", async () => {
    const res = await authorize(signedIn, { redirect_uri: null });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBe(null);
  });

  test("a missing client is refused, and not redirected", async () => {
    const res = await authorize(signedIn, { client: null });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBe(null);
  });

  test("an empty registry refuses even the client that would otherwise be registered", async () => {
    // The default posture of a hub that has not opted in.
    const app = createAuthorizeRoutes({
      clients: [],
      getSession: async () => ({ user: { id: LIVE_USER } }),
    });
    const res = await authorize(app);

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBe(null);
  });
});

// ─── PKCE and the rest of the parameters ──────────────────────────────────────

describe("PKCE parameters", () => {
  test("code_challenge_method=plain is refused", async () => {
    const res = await authorize(signedIn, {
      code_challenge_method: "plain",
      code_challenge: "a-verifier-sent-in-the-clear",
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBe(null);
  });

  test("a missing code_challenge_method is refused", async () => {
    const res = await authorize(signedIn, { code_challenge_method: null });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBe(null);
  });

  test("the method is compared exactly — s256 in lower case is refused", async () => {
    const res = await authorize(signedIn, { code_challenge_method: "s256" });

    expect(res.status).toBe(400);
  });

  test("a code_challenge that is not 43 base64url characters is refused", async () => {
    for (const challenge of [
      "",
      "too-short",
      `${CHALLENGE}x`,
      CHALLENGE.slice(0, 42),
      `${CHALLENGE.slice(0, 42)}+`, // base64, not base64url
      `${CHALLENGE.slice(0, 42)}=`,
    ]) {
      const res = await authorize(signedIn, { code_challenge: challenge });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBe(null);
    }
  });

  test("a missing code_challenge is refused", async () => {
    const res = await authorize(signedIn, { code_challenge: null });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBe(null);
  });
});

describe("state", () => {
  test("a missing state is refused", async () => {
    const res = await authorize(signedIn, { state: null });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBe(null);
  });

  test("an empty state is refused", async () => {
    const res = await authorize(signedIn, { state: "" });

    expect(res.status).toBe(400);
  });

  test("a state longer than 256 characters is refused", async () => {
    const res = await authorize(signedIn, { state: "s".repeat(257) });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBe(null);
  });

  test("a state of exactly 256 characters is accepted", async () => {
    const res = await authorize(signedIn, { state: "s".repeat(256) });

    expect(res.status).toBe(302);
  });
});

// ─── No session ───────────────────────────────────────────────────────────────

describe("a browser with no hub session", () => {
  test("is sent to sign in, not to the redirect_uri", async () => {
    const res = await authorize(signedOut);
    const location = res.headers.get("location") ?? "";

    expect(res.status).toBe(302);
    expect(location.startsWith(signInUrl)).toBe(true);
    // The load-bearing half: no code exists yet, so a redirect to the plane
    // here would be a redirect that teaches an attacker nothing — but it would
    // also mean the endpoint redirects to a caller-supplied URI on a path
    // where it has authenticated nobody.
    expect(location.startsWith(REDIRECT)).toBe(false);
    expect(location).not.toContain("code=");
  });

  test("is sent back to this exact authorize request afterwards", async () => {
    const res = await authorize(signedOut);
    const location = new URL(res.headers.get("location") ?? "");
    const back = new URL(location.searchParams.get("redirect") ?? "https://invalid.example");

    expect(back.pathname).toBe("/api/auth/authorize");
    expect(back.searchParams.get("client")).toBe("kaambaan");
    expect(back.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe(STATE);
    expect(back.searchParams.get("code_challenge")).toBe(CHALLENGE);
    expect(back.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("mints nothing", async () => {
    // Counted rather than asserted-empty, so this does not depend on running
    // before the happy-path block below.
    const before = (await codesFor(LIVE_USER)).length;
    await authorize(signedOut);

    // A code minted for a caller nobody has authenticated would be a token for
    // whoever asked.
    expect(await codesFor(LIVE_USER)).toHaveLength(before);
  });

  test("is still refused outright when the client is unknown", async () => {
    // Order matters: the redirect_uri checks come first, so a bad client never
    // reaches the sign-in redirect and the sign-in URL never carries an
    // unvalidated return path.
    const res = await authorize(signedOut, { client: "not-a-registered-plane" });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBe(null);
  });
});

// ─── The principal behind the session ─────────────────────────────────────────

describe("the principal behind the session", () => {
  test("a suspended principal is refused, in buildTokenPayload's own words", async () => {
    const res = await authorize(appFor(SUSPENDED_USER));
    const body = await res.text();

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBe(null);
    expect(body).toContain("suspended");
    expect(await codesFor(SUSPENDED_USER)).toHaveLength(0);
  });

  test("a session mapping to no principal is refused", async () => {
    const res = await authorize(appFor(UNMAPPED_USER));

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBe(null);
    expect(await codesFor(UNMAPPED_USER)).toHaveLength(0);
  });
});

// ─── The happy path ───────────────────────────────────────────────────────────

describe("a signed-in operator authorizing a registered plane", () => {
  test("is redirected to the registered URI with a code and the state returned untouched", async () => {
    const state = `state-${crypto.randomUUID()}`;
    const res = await authorize(signedIn, { state });

    expect(res.status).toBe(302);

    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(REDIRECT)).toBe(true);

    const url = new URL(location);
    expect(url.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Byte for byte, whatever it was.
    expect(url.searchParams.get("state")).toBe(state);
  });

  test("the code that comes back is a real row, issued for this client and URI", async () => {
    const res = await authorize(signedIn);
    const code = new URL(res.headers.get("location") ?? "").searchParams.get("code")!;

    const [row] = await db.select().from(oauthCodes).where(eq(oauthCodes.code, code));

    expect(row).toBeDefined();
    expect(row!.clientId).toBe("kaambaan");
    expect(row!.redirectUri).toBe(REDIRECT);
    expect(row!.codeChallenge).toBe(CHALLENGE);
    expect(row!.userId).toBe(LIVE_USER);
    expect(row!.redeemedAt).toBe(null);
  });

  test("the second registered URI of the same client also works", async () => {
    const res = await authorize(signedIn, { redirect_uri: SECOND_REDIRECT });
    const location = res.headers.get("location") ?? "";

    expect(res.status).toBe(302);
    expect(location.startsWith(SECOND_REDIRECT)).toBe(true);
  });

  test("two authorizations never carry the same code", async () => {
    const first = await authorize(signedIn);
    const second = await authorize(signedIn);

    const codeOf = (r: Response) =>
      new URL(r.headers.get("location") ?? "").searchParams.get("code");

    expect(codeOf(first)).not.toBe(codeOf(second));
  });
});

// ─── The refusal page itself ──────────────────────────────────────────────────

describe("the refusal page", () => {
  test("is a page, not JSON — a browser is the thing reading it", async () => {
    const res = await authorize(signedIn, { client: "not-a-registered-plane" });

    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("escapes the client id it echoes back", async () => {
    // The client id is attacker-controlled and this page renders on the hub's
    // own origin, so reflecting it unescaped would be a reflected XSS on the
    // origin that issues tokens.
    const res = await authorize(signedIn, {
      client: '<script>alert(1)</script>',
    });
    const body = await res.text();

    expect(res.status).toBe(400);
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });
});

// ─── Where the route is registered ────────────────────────────────────────────

describe("registration order in src/index.ts", () => {
  /**
   * Read as text rather than by booting the app: the repo rule is that tests
   * never import `src/index.ts`, because importing it starts the sweeper and
   * the boot hooks (see `tests/unit/acp-proxy-route.test.ts`).
   *
   * It is worth asserting at all because this is the one way this task breaks
   * silently. Hono matches in registration order: below the Better Auth
   * catch-all the route is simply never reached, and below `authMiddleware`
   * every navigation gets a 401 before the route's own logic runs — and both
   * look, from kaambaan, exactly like an operator who has not connected yet.
   */
  const source = readFileSync(
    new URL("../index.ts", import.meta.url),
    "utf8"
  );

  const authorizeAt = source.indexOf(".route('/', authorizeRoutes)");
  const catchAllAt = source.indexOf("'/api/auth/*', (c) => {");
  const authMiddlewareAt = source.indexOf(".use('/api/*', authMiddleware)");

  test("all three anchors are still there to compare", () => {
    // Guard the guard: a renamed anchor would make every assertion below
    // compare -1 against -1 and pass for free.
    expect(authorizeAt).toBeGreaterThan(-1);
    expect(catchAllAt).toBeGreaterThan(-1);
    expect(authMiddlewareAt).toBeGreaterThan(-1);
  });

  test("the authorize route is registered above Better Auth's catch-all", () => {
    expect(authorizeAt).toBeLessThan(catchAllAt);
  });

  test("the authorize route is registered above authMiddleware", () => {
    expect(authorizeAt).toBeLessThan(authMiddlewareAt);
  });
});
