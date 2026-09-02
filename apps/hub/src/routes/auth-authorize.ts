/**
 * `GET /api/auth/authorize` and `POST /api/auth/token/exchange` — the door a
 * browser on another registrable domain can actually walk through, and the
 * counter where the ticket it comes back with is cashed.
 *
 * The hub's session cookie is `SameSite=Lax`, so a cross-site `fetch` never
 * carries it and `GET /api/auth/token` — the hub's only way to hand a browser
 * a token — is unreachable from `kaambaan.dev` by construction. What Lax still
 * permits is **top-level navigation**, which was measured in a real browser
 * rather than read: a `fetch` to the hub saw no user, and navigating to the
 * same URL returned the full session. So the browser *goes* to this endpoint
 * instead of *calling* it, the hub reads its own first-party cookie, and a
 * one-time code rides back in the redirect to be exchanged server-to-server
 * for exactly the token `GET /api/auth/token` already issues. See
 * docs/superpowers/specs/2026-09-02-cross-domain-token-handoff-design.md.
 *
 * **The one rule that matters most here: a refusal redirects NOWHERE.** An
 * authorize endpoint that redirects to an unregistered `redirect_uri` is an
 * open redirector that mints credentials — it hands whoever asked a code for
 * whoever happened to be signed in. So the client and the redirect URI are
 * checked first, before anything else, and both refusals render a page and set
 * no `Location` header at all. `auth-authorize.test.ts` asserts the absence of
 * that header rather than only the 400, because a status-only assertion would
 * pass an implementation that returned 400 and redirected anyway.
 *
 * Everything else fails closed for the same reason: an unknown client, an
 * unregistered URI, a `plain` challenge method, a malformed challenge, a
 * missing or oversized state, a suspended principal, a session mapping to
 * nobody. The only path that produces a code is the one where every question
 * has been answered.
 *
 * The exchange is the same story from the other side. It is called by the
 * plane's own back end, server-to-server, and everything about it follows from
 * two facts: the code arrived through a URL, so it must be worth nothing after
 * one use — which is why it is spent BEFORE the verifier is checked, not after
 * — and the token must never be readable by a page, which is why the hub's
 * global CORS headers are removed from its responses and a request carrying an
 * `Origin` is refused outright.
 *
 * Both routes authenticate themselves and therefore sit ahead of
 * `authMiddleware` in `index.ts`, beside the jwks route — see the comment
 * there.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { Hono } from "hono";
import { html } from "hono/html";

import {
  config,
  findOAuthClient,
  isRegisteredRedirect,
  oauthClients,
  signInUrl,
  type OAuthClient,
} from "../config";
import { auth } from "../auth/drizzle-auth";
import { buildTokenPayload, type TokenPayload } from "../auth/jwt-claims";
import { mintCode, redeemCode } from "../services/oauth-codes";

/** S256 of a verifier: 32 bytes, base64url, unpadded — 43 characters. */
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * `state` is the consuming plane's own CSRF token for this flow, echoed back
 * untouched. Bounded because it rides in a URL that must survive every proxy
 * and browser between here and the callback, and an unbounded one is a way to
 * make this endpoint write whatever length someone likes into a redirect.
 */
const MAX_STATE_LENGTH = 256;

/**
 * What the route needs from the rest of the hub.
 *
 * Injectable for the same reason `buildTokenPayload`'s resolvers and
 * `findOAuthClient`'s registry are: `oauthClients` is computed at module scope
 * from `process.env`, so a test cannot populate it after import, and a Better
 * Auth session is a signed cookie a test cannot mint. Real callers pass
 * nothing and get the hub's own registry and the hub's own session lookup.
 */
export interface AuthorizeDeps {
  /**
   * The caller's Better Auth session. Defaults to exactly what
   * `sessionMiddleware` and `GET /api/auth/token` use — Better Auth reading
   * the request's own cookies. Deliberately not hand-rolled cookie parsing:
   * the session is signed, and a second reader of that format is a second
   * chance to get it wrong.
   */
  getSession?: (headers: Headers) => Promise<{ user: { id: string } } | null>;
  /** Who may receive a token. Empty means every authorize is refused. */
  clients?: readonly OAuthClient[];
}

/**
 * The 400 an operator actually sees.
 *
 * A page rather than JSON because the thing reading it is a browser that
 * navigated here — a JSON body would render as a wall of quotes to the person
 * who clicked "Connect".
 *
 * `html` from hono/html escapes every interpolation. That is not decoration:
 * `detail` can contain the `client` the caller sent, this page renders on the
 * hub's own origin, and reflecting attacker text unescaped there would be a
 * reflected XSS on the origin that issues tokens.
 */
function refusalPage(reason: string, detail: string) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Authorization refused</title>
        <style>
          body {
            font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
            margin: 0;
            padding: 3rem 1.5rem;
            color: #1c1c1c;
            background: #fafafa;
          }
          main {
            max-width: 34rem;
            margin: 0 auto;
          }
          h1 {
            font-size: 1.25rem;
            margin: 0 0 0.75rem;
          }
          code {
            background: #ededed;
            padding: 0.1rem 0.3rem;
            border-radius: 3px;
            word-break: break-all;
          }
          .note {
            color: #5c5c5c;
            font-size: 0.875rem;
            margin-top: 2rem;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>Authorization refused</h1>
          <p>${reason}</p>
          <p><code>${detail}</code></p>
          <p class="note">
            No code was issued and you have not been redirected anywhere. If you
            reached this from another site, that site is asking for something
            this hub has not been configured to give it.
          </p>
        </main>
      </body>
    </html>`;
}

/**
 * The exchange's path, in one place: a middleware and a route both name it, and
 * they must name the same string or the CORS strip below silently stops
 * applying to the endpoint it exists for.
 */
const EXCHANGE_PATH = "/api/auth/token/exchange";

/**
 * The response headers `src/index.ts`'s global `cors()` puts on everything.
 *
 * It sets them BEFORE calling `next()`, and Hono carries headers already on
 * `c.res` over onto whatever a handler returns — so a route cannot avoid them
 * by what it returns, only by removing them on the way out. Stripping them
 * matters because that middleware's `origin` function answers with an allowed
 * origin for *every* request, including one with no `Origin` at all: left
 * alone, this endpoint would be callable from a browser on the console's own
 * origin, with credentials, and this is the endpoint that hands out tokens.
 */
const CORS_RESPONSE_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-expose-headers",
];

/**
 * Compare the presented challenge with the stored one without leaking, in the
 * timing, how much of it was right.
 *
 * Belt and braces — the code is already spent by the time this runs, so there
 * is no second attempt to inform. It costs a line.
 */
function sameChallenge(presented: string, stored: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAuthorizeRoutes(deps: AuthorizeDeps = {}): Hono {
  const clients = deps.clients ?? oauthClients;
  const getSession =
    deps.getSession ??
    (async (headers: Headers) => {
      try {
        return await auth.api.getSession({ headers });
      } catch {
        // Treated as "no session", the same way `sessionMiddleware` does. A
        // session lookup that threw has not authenticated anybody, and the
        // fail-closed answer here is the sign-in redirect below.
        return null;
      }
    });

  return new Hono().get("/api/auth/authorize", async (c) => {
    const clientId = c.req.query("client") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const state = c.req.query("state") ?? "";
    const codeChallenge = c.req.query("code_challenge") ?? "";
    const method = c.req.query("code_challenge_method") ?? "";

    // ── 1 & 2: the two checks that must happen before anything else ──────────
    //
    // Both refuse WITHOUT redirecting, and they come first so that no later
    // path — not the sign-in redirect, not a refusal page's link — can ever be
    // built from a destination this hub has not been told about.

    const client = findOAuthClient(clientId, clients);
    if (!client) {
      return c.html(
        refusalPage(
          "This hub does not know that client. A plane is added to the registry at deployment time, deliberately — being allowed to call the hub is not the same as being allowed to receive a token for whoever is signed in.",
          clientId || "(no client parameter)"
        ),
        400
      );
    }

    if (!redirectUri || !isRegisteredRedirect(client, redirectUri)) {
      return c.html(
        refusalPage(
          `That redirect URI is not registered for ${client.id}. The comparison is the whole string: a prefix, a different path, or another registered client's URI are all "not it", because anything looser is how this endpoint would become an open redirector that mints credentials.`,
          redirectUri || "(no redirect_uri parameter)"
        ),
        400
      );
    }

    // A registered URI that is not a URL is an operator's typo, not a caller's
    // — but it still fails closed here rather than throwing at the redirect,
    // where a 500 would say nothing about which setting is wrong.
    let destination: URL;
    try {
      destination = new URL(redirectUri);
    } catch {
      return c.html(
        refusalPage(
          "That redirect URI is registered but is not a URL this hub can parse. Fix HUB_OAUTH_CLIENTS.",
          redirectUri
        ),
        400
      );
    }

    // ── 3 & 4: PKCE and state ────────────────────────────────────────────────

    // `plain` sends the verifier itself, which is the whole thing PKCE exists
    // to avoid: anyone who read the authorize URL would hold everything the
    // exchange asks for.
    if (method !== "S256") {
      return c.html(
        refusalPage(
          "Only S256 is accepted for code_challenge_method. `plain` puts the verifier itself in the URL, which is exactly what PKCE exists to prevent.",
          method || "(no code_challenge_method parameter)"
        ),
        400
      );
    }

    if (!CODE_CHALLENGE_RE.test(codeChallenge)) {
      return c.html(
        refusalPage(
          "code_challenge must be the base64url SHA-256 of the verifier — 43 characters, unpadded.",
          codeChallenge || "(no code_challenge parameter)"
        ),
        400
      );
    }

    if (!state || state.length > MAX_STATE_LENGTH) {
      return c.html(
        refusalPage(
          `state is required and must be at most ${MAX_STATE_LENGTH} characters. It is the consuming plane's own defence against a callback it did not start, so there is no sensible request without one.`,
          state ? `${state.length} characters` : "(no state parameter)"
        ),
        400
      );
    }

    // ── 5: no session ────────────────────────────────────────────────────────

    const session = await getSession(c.req.raw.headers);
    if (!session) {
      // Rebuilt from the validated parameters rather than echoed from
      // `c.req.url`: the return path is then, by construction, this hub's own
      // authorize endpoint carrying only values that have already passed every
      // check above — and the hub's public URL rather than whatever host a
      // proxy put on the request line.
      const back = new URL("/api/auth/authorize", `${config.publicUrl.replace(/\/+$/, "")}/`);
      back.searchParams.set("client", client.id);
      back.searchParams.set("redirect_uri", redirectUri);
      back.searchParams.set("state", state);
      back.searchParams.set("code_challenge", codeChallenge);
      back.searchParams.set("code_challenge_method", "S256");

      // `signInUrl` is configuration, never a request parameter — this is the
      // one redirect the endpoint performs for a caller it has not
      // authenticated, and it must not be steerable.
      const signIn = new URL(signInUrl);
      signIn.searchParams.set("redirect", back.toString());

      return c.redirect(signIn.toString(), 302);
    }

    // ── 6: the principal behind the session ──────────────────────────────────
    //
    // The claims are discarded — the token is minted at the exchange, from
    // this same function, so that it is identical to `GET /api/auth/token`'s by
    // construction. What this call is for is refusing NOW: a code handed to a
    // suspended principal is a code that can only fail sixty seconds later, at
    // the plane's callback, where nobody can see why.
    try {
      await buildTokenPayload({ user: { id: session.user.id } });
    } catch (e) {
      const message = (e as Error).message;
      // buildTokenPayload's own refusals — no principal, suspended, no tenant —
      // let through in its words rather than re-worded here, so an operator
      // reading this page and an operator reading a hub log are reading the
      // same sentence. Anything else is a fault, not a refusal, and keeps being
      // a 500.
      if (message.startsWith("refusing to mint a token")) {
        return c.html(
          refusalPage(
            "You are signed in, but the hub will not issue a token for this account.",
            message
          ),
          400
        );
      }
      throw e;
    }

    // ── 7: mint, and go ──────────────────────────────────────────────────────

    const { code } = await mintCode({
      clientId: client.id,
      redirectUri,
      codeChallenge,
      userId: session.user.id,
    });

    // Built through URL so a registered URI that already carries a query — or
    // a fragment — keeps working. It cannot widen anything: the exact-string
    // registry check above ran against the raw parameter, before this.
    destination.searchParams.set("code", code);
    destination.searchParams.set("state", state);

    return c.redirect(destination.toString(), 302);
  })

    // ── POST /api/auth/token/exchange ────────────────────────────────────────
    //
    // Strip the hub's global CORS headers from every response on this path.
    // Registered ahead of the route so it wraps it; see CORS_RESPONSE_HEADERS
    // for why removing them on the way out is the only place it can be done.
    .use(EXCHANGE_PATH, async (c, next) => {
      await next();
      for (const header of CORS_RESPONSE_HEADERS) c.res.headers.delete(header);
    })

    /**
     * Trade a one-time code for exactly the token `GET /api/auth/token` issues.
     *
     * Called by the consuming plane's back end, never by a browser: the code
     * came back through a redirect the browser can see, but the token must not
     * be somewhere a page can read it.
     */
    .post(EXCHANGE_PATH, async (c) => {
      // A browser cannot READ this response — the CORS headers are gone — but
      // it could still SEND the request, and the request is what spends the
      // code. `Origin` is the header a browser always attaches to a cross-site
      // POST and that a server-to-server caller never sends unless it decides
      // to (a Cloudflare Worker's `fetch` does not), so its presence is the one
      // reliable signal that the caller is a page rather than a plane.
      //
      // Checked before anything is redeemed, and it depends on nothing the
      // caller can only learn by guessing, so it is not a retry oracle: an
      // attacker with a stolen code was always able to leave the header off.
      // What it buys is that a page cannot burn an operator's code.
      if (c.req.header("origin")) {
        return c.json(
          {
            error: "invalid_request",
            error_description:
              "This endpoint is server-to-server. A request carrying an Origin header is a browser, and a browser must not spend an authorization code.",
          },
          403
        );
      }

      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      const code = typeof body?.code === "string" ? body.code : "";
      const verifier = typeof body?.code_verifier === "string" ? body.code_verifier : "";
      const redirectUri = typeof body?.redirect_uri === "string" ? body.redirect_uri : "";

      if (!code || !verifier || !redirectUri) {
        return c.json(
          {
            error: "invalid_request",
            error_description:
              "code, code_verifier and redirect_uri are all required, as JSON.",
          },
          400
        );
      }

      // `redeemCode` matches on the client the code was issued to, and the
      // body names no client — the spec's body is the three fields above, and
      // a plane's back end sends what the spec says. The registry answers it
      // instead: a redirect URI belongs to whichever client registered it.
      //
      // A URI registered by two clients (nothing forbids it) is why this is a
      // list and not a `find`: each is tried, and a mismatched client consumes
      // nothing, so the loop cannot spend a code it then fails to return. In
      // every real deployment there is exactly one candidate.
      //
      // This lookup is not the security boundary. The row's own `redirect_uri`
      // is, and it is compared inside the same UPDATE that spends the code.
      const candidates = clients.filter((client) => isRegisteredRedirect(client, redirectUri));

      let redeemed: Awaited<ReturnType<typeof redeemCode>> = null;
      for (const client of candidates) {
        redeemed = await redeemCode({ code, clientId: client.id, redirectUri });
        if (redeemed) break;
      }

      if (!redeemed) {
        // Deliberately one sentence for all of: unknown code, already
        // redeemed, expired, wrong redirect URI, unregistered redirect URI. A
        // caller who does not hold a live code learns nothing about which of
        // those it was, and the legitimate caller does not need to be told.
        return c.json(
          {
            error: "invalid_grant",
            error_description:
              "That code is not redeemable: it is unknown, already spent, expired, or was not issued for this redirect_uri.",
          },
          400
        );
      }

      // ── The verifier, checked AFTER the code is already spent ──────────────
      //
      // This ordering is the point of the endpoint. Checked first, a wrong
      // verifier would leave the code sitting there redeemable, and whoever
      // read it out of an address bar, a history entry or a `Referer` would
      // have the rest of the TTL to guess at the verifier. Spent first, they
      // get exactly one attempt — and PKCE means one attempt is none.
      //
      // The verifier's own shape is deliberately not validated: any check that
      // could refuse before the redemption is the retry hole above, and one
      // that runs after adds nothing a 43-character digest comparison has not
      // already settled.
      const presented = createHash("sha256").update(verifier).digest("base64url");
      if (!sameChallenge(presented, redeemed.codeChallenge)) {
        return c.json(
          {
            error: "invalid_grant",
            error_description:
              "code_verifier does not match the code_challenge this code was issued for. The code has been consumed.",
          },
          400
        );
      }

      // ── The token, from the path GET /api/auth/token already takes ─────────
      //
      // `auth.api.signJWT` is the jwt plugin's own signer, holding the options
      // the plugin was registered with in `drizzle-auth.ts` — so the signing
      // key, `TOKEN_TTL`, the issuer and the audience are that endpoint's by
      // construction rather than by being copied here. Only the payload is
      // assembled, and it is assembled the way `getJwtToken` assembles it:
      // `iat`, then the configured `definePayload` (`buildTokenPayload`), then
      // `sub`.
      //
      // **`sub` is the Better Auth user id, not `buildTokenPayload`'s principal
      // id.** The plugin overwrites `sub` after calling `definePayload`
      // (`sub: getSubject?.(session) ?? session.user.id`, and this hub
      // configures no `getSubject`), so that is what `GET /api/auth/token`
      // actually issues today. Matching it is the requirement — the exchange
      // must return the same token, not a better one. Changing which id `sub`
      // carries is a change to the token itself and belongs to whoever owns
      // that decision, on both paths at once.
      let payload: TokenPayload;
      try {
        payload = await buildTokenPayload({ user: { id: redeemed.userId } });
      } catch (e) {
        const message = (e as Error).message;
        // The same translation the authorize route does, and for the same
        // reason: buildTokenPayload's refusals come through in its own words.
        // Reachable here even though authorize checked too — sixty seconds is
        // long enough to suspend somebody.
        if (message.startsWith("refusing to mint a token")) {
          return c.json({ error: "invalid_grant", error_description: message }, 400);
        }
        throw e;
      }

      const { token } = await auth.api.signJWT({
        body: { payload: { iat: Math.floor(Date.now() / 1000), ...payload, sub: redeemed.userId } },
      });

      // Read back off the token rather than derived from `TOKEN_TTL`: the
      // caller is told what this token actually says, so the number cannot
      // drift from the claim if the TTL is ever changed somewhere else.
      const claims = JSON.parse(
        Buffer.from(token.split(".")[1] ?? "", "base64url").toString()
      ) as { iat: number; exp: number };

      return c.json({ token, expiresIn: claims.exp - claims.iat });
    });
}

/** The hub's own authorize routes, reading the hub's own registry. */
export const authorizeRoutes = createAuthorizeRoutes();
