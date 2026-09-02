# A front door for planes on their own domains

**Status:** proposed, 2026-09-02
**Repos:** `agentpod` (hub), and one callback route per consuming plane
**Charter:** `decisions/2026-08-15-one-issuer-and-offline-verification.md`,
`decisions/2026-08-13-ecosystem-identity.md` (Decision 4),
`decisions/2026-08-15-a-grant-names-an-agent-per-plane.md`

---

## The problem, measured

kaambaan's browser cannot obtain a hub token, so every card it queues from the
deployed UI is queued **without authority**. Under enforcement those cards are
refused. It has never worked in production, and it fails silently because
`hubToken()` treats every failure the same way:

> *"Offline, blocked, CORS — all the same answer: no authority this time."*

Two locks, discovered in order. The first was a real bug and is fixed:

1. **CORS.** The hub unit had `EnvironmentFile=/etc/agentpod/hub.env` on line 22
   and `Environment=ALLOWED_ORIGINS=https://app.agentpod.dev` on line 29, so the
   unit **shadowed** the file. The file's list — which already named
   `https://kaambaan.dev` — was dead, and only a legacy origin pointing at a
   domain that 404s applied. Removing the shadowing line fixed it; the hub now
   answers `access-control-allow-origin: https://kaambaan.dev`.

2. **The cookie, which allowlisting cannot fix.** The hub's session cookie is
   `Domain=.agentpod.dev`, `SameSite=Lax` — always, deliberately. `kaambaan.dev`
   and `agentpod.dev` are different registrable domains, so the browser never
   attaches it to a cross-site `fetch`. Measured from `https://kaambaan.dev`
   after the CORS fix:

   | call | result |
   |---|---|
   | `GET /api/auth/get-session` | 200, **no user** |
   | `GET /api/auth/token` | **401** |
   | `GET /api/admin/principals` | **401** |

**This is not a kaambaan problem.** The hub has exactly one way to hand a
browser a token — `GET /api/auth/token`, which requires a cookie the browser
will only send same-site. Every plane on its own domain is locked out by
construction: supermessage and estate will hit the identical wall.

## What makes it solvable without changing anything sensitive

`SameSite=Lax` blocks cross-site `fetch` but **permits top-level GET
navigation** — that is the whole difference between Lax and Strict.

Verified in the same browser, in the same session, minutes apart:

- `fetch("https://hub.agentpod.dev/api/auth/get-session")` from
  `https://kaambaan.dev` → 200, **no user**
- **Navigating** to `https://hub.agentpod.dev/api/auth/get-session` → the full
  session: `{"user":{"name":"Rakesh Gangwar","role":"admin",…}}`

So the hub can already authenticate an operator for another plane, today,
unchanged — if the browser *goes there* instead of *calling* there. What is
missing is a door built for it.

## Rejected alternatives

**Serve kaambaan under `agentpod.dev`.** Makes it same-site and works in a
minute. Rejected: kaambaan is built to be a standalone product — migration
0003 states plainly that a standalone kaambaan must boot with no hub in
existence and that `kbn_` is permanent. Subordinating its domain to another
plane's, to make a cookie travel, trades that away. It also does not
generalise: every future plane would have to give up its own domain too.

**`SameSite=None` on the hub session.** Works from every origin, one line.
Rejected as a permanent answer: it removes the CSRF protection the hub chose on
purpose, for *every* plane at once, to solve a problem that has a mechanism-
level fix. Acceptable only as a recorded, time-boxed stopgap.

**A pasted long-lived hub token.** No coupling, but it makes an operator handle
a credential by hand, and a long-lived one at that — against the grain of a
5-minute TTL chosen because "the expiry IS the revocation SLA".

**kaambaan stores its own grants.** Explicitly warned against:
`decisions/2026-08-15-a-grant-names-an-agent-per-plane.md` — two grant stores
is drift, and an asymmetric grant is worse than no grant.

---

## Design

### Shape: authorization code with PKCE

Not a token in the redirect fragment. kaambaan has a Worker, so it can perform
a server-to-server exchange, which keeps the token out of the URL bar, browser
history, and any `Referer`. PKCE because the exchange has no client secret to
hold — the consuming plane is a public client with a private back end.

```
kaambaan.dev
   │  operator clicks "Connect to AgentPod" (or the app needs authority)
   │  mint verifier; store verifier + state in sessionStorage
   ▼
NAVIGATE (top level — the Lax carve-out, proven)
   https://hub.agentpod.dev/api/auth/authorize
     ?client=kaambaan
     &redirect_uri=https://kaambaan.dev/hub/callback
     &state=<opaque>
     &code_challenge=<S256(verifier)>
     &code_challenge_method=S256
   │
   │  hub reads its OWN first-party session cookie
   │  no session        → 302 to its sign-in, resuming this authorize on success
   │  redirect_uri not allowlisted → 400, rendered, NO redirect
   ▼
302 https://kaambaan.dev/hub/callback?code=<one-time>&state=<opaque>
   │
   │  kaambaan's Worker (server-side) POSTs the exchange
   ▼
POST https://hub.agentpod.dev/api/auth/token/exchange
   { code, code_verifier, redirect_uri }
   → { token, expiresIn }        the SAME token /api/auth/token issues today
```

### The token is unchanged

This spec adds no new credential. The exchange returns exactly what
`GET /api/auth/token` returns — `buildTokenPayload`'s claims, signed by the
same key, verified by peers offline against the published JWKS:

```ts
{ sub: principalId, principalKind, tenant, mayDispatch: string[], mayGrantReach: boolean }
```

`TOKEN_TTL` stays `"5m"`. Nothing about issuance, verification or the
revocation SLA changes; only how a cross-domain browser reaches the issuer.

### New endpoints

**`GET /api/auth/authorize`**

| param | required | rule |
|---|---|---|
| `client` | yes | a key in the client registry (below) |
| `redirect_uri` | yes | must **exactly** equal one of that client's registered URIs — full string compare, no prefix or origin matching |
| `state` | yes | opaque, ≤256 chars, returned untouched |
| `code_challenge` | yes | base64url S256, 43 chars |
| `code_challenge_method` | yes | literally `S256`; `plain` is refused |

Behaviour:

- **Unregistered `client` or mismatched `redirect_uri` → 400 rendered as a
  page, and no redirect of any kind.** An authorize endpoint that redirects on a
  bad `redirect_uri` is an open redirector that mints credentials. This is the
  single most important rule here.
- **No session** → 302 to the hub's own sign-in with a return path back to this
  exact authorize URL. A top-level navigation, so the Lax cookie is set and read
  normally.
- **Session, suspended principal or no tenant** → 400 with the same refusal
  wording `buildTokenPayload` already throws. Fail closed, as both subject paths
  already do.
- **Otherwise** → mint a code and 302 to `redirect_uri?code=…&state=…`.

**`POST /api/auth/token/exchange`**

Body `{ code, code_verifier, redirect_uri }`. Returns `{ token, expiresIn }`.

- The code is **single-use**: redeemed with one conditional UPDATE, exactly the
  pattern `redeemCredentialAuthorization` uses, so two concurrent redemptions
  produce one winner and one refusal rather than two tokens.
- `SHA256(code_verifier)` must equal the stored challenge.
- `redirect_uri` must equal the one the code was issued for.
- **TTL 60 seconds.** A code lives only as long as a redirect takes.
- Any failure → 400, and the code is consumed regardless, so a wrong verifier
  cannot be retried.
- No CORS for this route: it is server-to-server, never called from a browser.

### The client registry

A code that can be redirected anywhere is a token that can be stolen anywhere,
so the destination must be named in advance, on the hub, in config — not
inferred from `Origin`, and not derived from `ALLOWED_ORIGINS` (which answers a
different question, and being on it must not by itself confer the right to
receive credentials).

```
HUB_OAUTH_CLIENTS=kaambaan|https://kaambaan.dev/hub/callback,supermessage|https://…
```

Parsed once at boot into `{ client → redirect_uris[] }`, beside
`allowedOrigins` in `config.ts`. Empty by default: a hub with none configured
answers 400 to every authorize, which is the right posture for a deployment
that has not opted in.

**A registry entry is a deployment-time grant of the right to receive a token
for whoever is signed in.** It says nothing about what that token permits —
that is still `mayDispatch`, still per plane, still the hub's answer.

### Storage

One table, `oauth_codes`:

| column | |
|---|---|
| `code` | PK, 32 bytes of CSPRNG, base64url |
| `client`, `redirect_uri` | what it was issued for |
| `code_challenge` | S256, base64url |
| `user_id` | who authorized |
| `expires_at` | issued + 60s |
| `redeemed_at` | null until redeemed; the single-use guard |

Swept on write, like the other short-lived tables, rather than by a job.

### The consuming plane

One route, `GET /hub/callback`, in the plane's own back end:

1. Compare `state` with the stored one; mismatch → refuse, do not exchange.
2. Exchange the code server-side with the verifier.
3. Hand the token to the app and drop the verifier.

kaambaan's `hubToken()` keeps its shape and its contract — including that
**null stays an ordinary answer**. A plane whose operator has not connected, or
that runs with no hub at all, keeps working exactly as it does now. This adds a
way to get authority; it does not make authority mandatory.

---

## What this fixes beyond the picker

- kaambaan's cards carry authority for the first time in production.
- "Add from AgentPod" works on `kaambaan.dev` with no domain change.
- supermessage and estate get the same door by writing one callback route.
- The hub stops being reachable only from origins that happen to share its
  registrable domain — which is what made this look like a kaambaan bug rather
  than a missing piece of the identity story.

## Out of scope

- Refresh tokens. The TTL is 5 minutes and the flow is a navigation; when a
  token expires the plane runs it again. A refresh token is a long-lived
  credential, which is the thing the TTL exists to avoid.
- Third-party clients, consent screens, scopes. Every client here is
  first-party and registered by deployment config.
- Retiring `GET /api/auth/token`. It is correct for same-site callers (the
  console) and keeps working untouched.

## Recorded stopgap

If cards must carry authority before this is built, the one-line lever is
`SameSite=None` on the hub session. It should be recorded with an end date,
because it weakens CSRF for every plane at once to buy time on a problem that
has a proper fix.
