# Cross-domain token handoff — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the hub a door a browser on another domain can walk through, so a plane on its own domain can obtain a hub token for the operator who is signed in.

**Architecture:** Authorization code with PKCE. `GET /api/auth/authorize` reads the hub's own first-party session (a top-level navigation, which `SameSite=Lax` permits) and redirects back with a one-time code; `POST /api/auth/token/exchange` trades that code plus a PKCE verifier for the token `GET /api/auth/token` already issues. Bun + Hono + Drizzle/Postgres on the hub; a Worker route on each consuming plane.

**Tech Stack:** Bun, Hono, Drizzle ORM, Postgres, Better Auth (jwt + bearer + admin plugins), `bun:test`. kaambaan: Cloudflare Worker, D1, SvelteKit, vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-cross-domain-token-handoff-design.md`

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **No new credential and no change to the token.** The exchange returns exactly what `GET /api/auth/token` returns: `buildTokenPayload`'s claims, the same signing key, `TOKEN_TTL = "5m"`. Do not add claims, do not change the TTL, do not touch verification.
2. **Register new `/api/auth/*` routes BEFORE Better Auth's catch-all.** Hono matches in registration order and the catch-all swallows anything after it. `GET /api/auth/jwks` sits above it for exactly this reason (`apps/hub/src/index.ts`, ~line 141) — put these beside it, and say so in a comment.
3. **These routes authenticate themselves.** `authMiddleware` 401s anything that is not a session or the static API_TOKEN, so a route reached by redirect or by a server-to-server POST must sit ahead of it, like `stationTokenRoutes` already does.
4. **A bad `redirect_uri` renders a 400 and redirects nowhere.** An authorize endpoint that redirects on an unregistered URI is an open redirector that mints credentials. This is the single most important rule in the plan.
5. **The client registry is not `ALLOWED_ORIGINS`.** They answer different questions. Being allowed to call the hub must not by itself confer the right to receive a token. Empty by default.
6. **Codes are single-use, enforced by one conditional UPDATE**, not read-then-write. Copy the shape of `redeemCredentialAuthorization` in `apps/hub/src/services/matrix-credential.ts`, which is already proven under 25 concurrent redemptions.
7. **Fail closed.** No session, suspended principal, no tenant, unknown client, bad verifier — all refuse. Reuse `buildTokenPayload`'s existing refusal wording rather than inventing new sentences.
8. **Migrations run against a real Postgres before they are called done.** Migration 0056 shipped constraint names Postgres never used and only a real run caught it. The next number is **0065**.
9. **Hub tests need a database.** `source /private/tmp/claude-501/-Users-rakeshgangwar-Projects-charter/2beb0c45-4f42-4781-ab6b-fb509f96b1b0/scratchpad/hubenv.sh` then `pnpm test` from `apps/hub`. Baseline is 390 pass / 0 fail across 39 files for the integration subset; the full CI suite is 1718 across 146 files. A bare `pnpm test` with no `DATABASE_URL` fails with ECONNREFUSED and is **not** a real failure — set the env.
10. **Run the FULL suite before every commit**, not just the files touched.
11. Comments explain WHY at the point a reader would ask, matching the surrounding code.

---

## File Structure

**Hub — new**

| Path | Responsibility |
|---|---|
| `apps/hub/src/db/drizzle-migrations/0065_oauth_codes.sql` | The `oauth_codes` table. |
| `apps/hub/src/db/schema/oauth.ts` | Drizzle schema for it. |
| `apps/hub/src/services/oauth-codes.ts` | Mint and redeem. The single-use guard lives here. |
| `apps/hub/src/services/oauth-codes.test.ts` | Including a concurrent-redemption test. |
| `apps/hub/src/routes/auth-authorize.ts` | `GET /api/auth/authorize`, `POST /api/auth/token/exchange`. |
| `apps/hub/src/routes/auth-authorize.test.ts` | Route tests. |

**Hub — modified**

| Path | Change |
|---|---|
| `apps/hub/src/config.ts` | `oauthClients` registry parsed from `HUB_OAUTH_CLIENTS`, beside `allowedOrigins`. |
| `apps/hub/src/config.test.ts` | Registry parsing tests. |
| `apps/hub/src/index.ts` | Register the routes above the Better Auth catch-all and above `authMiddleware`. |

**kaambaan — modified**

| Path | Change |
|---|---|
| `apps/api/src/index.ts` | `GET /hub/callback` — exchange server-side, hand the token to the SPA. |
| `apps/web/src/lib/hub-token.ts` | Start the flow when there is no token; keep `null` an ordinary answer. |

---

## Task 1: The client registry

**Files:** Modify `apps/hub/src/config.ts`, `apps/hub/src/config.test.ts`

**Interfaces — Produces:**
```ts
export interface OAuthClient {
  /** Registry key, named in the `client` query param. */
  id: string;
  /** Exact redirect URIs. Full-string compare — no prefix, no origin matching. */
  redirectUris: string[];
}
/** Empty when HUB_OAUTH_CLIENTS is unset: a hub that has not opted in refuses every authorize. */
export const oauthClients: OAuthClient[];
export function findOAuthClient(id: string | null | undefined): OAuthClient | null;
/** True only for an EXACT match against that client's registered URIs. */
export function isRegisteredRedirect(client: OAuthClient, redirectUri: string): boolean;
```

Format: `HUB_OAUTH_CLIENTS=kaambaan|https://kaambaan.dev/hub/callback,supermessage|https://…`
Multiple URIs for one client: repeat the client key.

- [ ] **Step 1: Write the failing tests.** Empty env → `oauthClients` is `[]` and `findOAuthClient('kaambaan')` is null. One entry parses. Two URIs for one client merge into one entry with two URIs. Whitespace is trimmed. A malformed entry (no `|`, empty id, empty URI) is **skipped, not thrown** — a typo in deployment config must not stop the hub booting, but must not silently become a wildcard either. `isRegisteredRedirect` is exact: a registered `https://k.dev/hub/callback` does **not** match `https://k.dev/hub/callback/x`, `https://k.dev/hub/callback?a=1`, or a different scheme/host.
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement**, beside `allowedOrigins`, with a comment saying why this is a separate list from it.
- [ ] **Step 4:** `pnpm test` (with the env sourced), then commit — `feat(hub): a registry of who may receive a token`

---

## Task 2: The code store

**Files:** Create `0065_oauth_codes.sql`, `src/db/schema/oauth.ts`, `src/services/oauth-codes.ts` + test

**Table:**

| column | type | |
|---|---|---|
| `code` | text PK | 32 bytes CSPRNG, base64url |
| `client_id` | text not null | |
| `redirect_uri` | text not null | what it was issued for |
| `code_challenge` | text not null | S256, base64url |
| `user_id` | text not null | who authorized |
| `expires_at` | timestamptz not null | issued + 60s |
| `redeemed_at` | timestamptz | null until redeemed |
| `created_at` | timestamptz not null default now() | |

**Interfaces — Produces:**
```ts
export async function mintCode(input: {
  clientId: string; redirectUri: string; codeChallenge: string; userId: string;
}): Promise<{ code: string; expiresAt: Date }>;

/**
 * Redeem once. Returns the row on the single win, null on every loss —
 * expired, already redeemed, unknown, or a mismatched client/redirect.
 */
export async function redeemCode(input: {
  code: string; clientId: string; redirectUri: string;
}): Promise<{ userId: string; codeChallenge: string } | null>;

export const CODE_TTL_MS: number; // 60_000
```

`redeemCode` must be ONE statement: `UPDATE … SET redeemed_at = now() WHERE code = $1 AND client_id = $2 AND redirect_uri = $3 AND redeemed_at IS NULL AND expires_at > now() RETURNING user_id, code_challenge`. Read-then-write races.

- [ ] **Step 1: Write the failing tests.** Mint then redeem returns the row. A second redeem returns null. An expired code returns null. A wrong `clientId` or `redirectUri` returns null **and still consumes nothing** (it never matched). **25 concurrent redemptions of one code produce exactly 1 win and 24 nulls** — mirror `matrix-credential.test.ts`'s concurrency test.
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Write the migration and run it against the real Postgres** (`pnpm db:migrate` or the project's equivalent — check `package.json`). Confirm the table exists with `psql \d oauth_codes`. Constraint names Postgres actually used, not the ones you expected — this is what 0056 got wrong.
- [ ] **Step 4: Implement the service.**
- [ ] **Step 5:** full `pnpm test`, then commit — `feat(hub): one-time codes, redeemed once`

---

## Task 3: The authorize endpoint

**Files:** Create `apps/hub/src/routes/auth-authorize.ts` + test; modify `apps/hub/src/index.ts`

`GET /api/auth/authorize` params: `client`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method`.

Order of checks — the first two before anything else, because both must refuse **without redirecting**:

1. `client` unknown → 400, rendered as a page.
2. `redirect_uri` not an exact registered match → 400, rendered as a page. **Never redirect.**
3. `code_challenge_method !== 'S256'` → 400. `plain` is refused.
4. `code_challenge` not 43-char base64url, or `state` missing / >256 chars → 400.
5. No session → 302 to the hub's sign-in with a return to this exact authorize URL.
6. Session present: resolve the principal the way `buildTokenPayload` does. Suspended, or no tenant → 400 with its existing refusal wording.
7. Mint a code, 302 to `redirect_uri?code=…&state=…`.

Reading the session: use the same mechanism `GET /api/auth/token` uses (Better Auth's session from the request). Find it in `apps/hub/src/auth/` and reuse it; do not hand-roll cookie parsing.

- [ ] **Step 1: Write the failing tests.** Unknown client → 400 and **no `Location` header**. Registered client with an unregistered `redirect_uri` → 400 and **no `Location` header** (assert the absence explicitly — this is constraint 4). `plain` method → 400. No session → 302 to sign-in, not to `redirect_uri`. Happy path → 302 whose `Location` starts with the registered URI, carries a `code`, and returns `state` byte-for-byte. A suspended principal → 400.
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement**, and register in `index.ts` **above the Better Auth catch-all and above `authMiddleware`**, with a comment pointing at the jwks route's precedent.
- [ ] **Step 4:** full `pnpm test`, then commit — `feat(hub): an authorize endpoint that redirects nowhere it was not told to`

---

## Task 4: The exchange endpoint

**Files:** Modify `apps/hub/src/routes/auth-authorize.ts` + test

`POST /api/auth/token/exchange`, body `{ code, code_verifier, redirect_uri }` → `{ token, expiresIn }`.

- Redeem the code (single statement, task 2). Null → 400.
- `base64url(SHA256(code_verifier))` must equal the stored challenge → else 400. **The code is consumed either way**, so a wrong verifier cannot be retried.
- Mint the token for the redeemed `user_id` using the SAME path `GET /api/auth/token` uses, so the claims and the signing key are identical by construction rather than by copying.
- **No CORS on this route.** It is server-to-server. A browser must not be able to call it.

- [ ] **Step 1: Write the failing tests.** Happy path returns a token whose claims match what `/api/auth/token` returns for that user (assert `sub`, `tenant`, `mayDispatch`). Wrong verifier → 400. Replaying a consumed code → 400. Expired code → 400. A verifier that is right but a `redirect_uri` that differs from issuance → 400. Assert the response carries **no** `access-control-allow-origin`.
- [ ] **Step 2: Run, watch fail. Step 3: Implement. Step 4:** full `pnpm test`, then commit — `feat(hub): trade a code for the token the hub already issues`

---

## Task 5: kaambaan walks through the door

**Files:** Modify `apps/api/src/index.ts`, `apps/web/src/lib/hub-token.ts`, tests in both

**Worker:** `GET /hub/callback?code&state` — exchanges server-side with the stored verifier, then hands the token to the SPA. Never expose the verifier or the exchange to the browser.

**SPA:** when `hubToken()` has none and the operator asks for one, generate `verifier` + `state` into `sessionStorage`, navigate top-level to the hub's authorize URL. Keep the existing contract: **null stays an ordinary answer**, a plane with no hub keeps working, and nothing about a standalone kaambaan changes.

- [ ] **Step 1: Write the failing tests.** `state` mismatch → refuse and do not exchange. A failed exchange leaves `hubToken()` returning null rather than throwing. A standalone kaambaan (no hub configured) never navigates anywhere.
- [ ] **Step 2: Run, watch fail. Step 3: Implement. Step 4:** `pnpm test` in `apps/api` (446 baseline) and `apps/web` (19 baseline), `pnpm typecheck`, `pnpm build`. Commit — `feat: obtain a hub token without sharing a domain with the hub`

---

## Task 6: End to end, on the real thing

Controller-executed (it holds the browser and the deploy credentials).

- [ ] Set `HUB_OAUTH_CLIENTS` on infra, restart the hub, verify the fleet reconnects.
- [ ] Deploy kaambaan.
- [ ] From `https://kaambaan.dev` in a real browser: connect, and confirm `hubToken()` returns a token — the thing that has never worked in production.
- [ ] Confirm "Add from AgentPod" lists the fleet's agent principals and adds one.
- [ ] Confirm a card queued afterwards carries `mayDispatch`.
- [ ] Negative: an unregistered `redirect_uri` renders 400 and sends no `Location`.

---

## Self-review notes

- **Spec coverage:** registry → 1; codes → 2; authorize → 3; exchange → 4; consuming plane → 5; the claims-unchanged requirement → 4's assertion against `/api/auth/token`.
- **The riskiest task is 3**, because an authorize endpoint that redirects on a bad `redirect_uri` is a credential-minting open redirector. Its test asserts the *absence* of a `Location` header rather than the presence of a 400, because a 400 that also redirects would pass a status-only test.
- **Not built:** refresh tokens, consent, scopes, third-party clients — all out of scope in the spec and all long-lived-credential shaped, which is what the 5-minute TTL exists to avoid.
