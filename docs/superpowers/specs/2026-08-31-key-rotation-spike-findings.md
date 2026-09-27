# Can a jwt signing key be rotated cleanly, end to end? — spike findings

**Date:** 2026-08-31
**Question:** verification is offline (agentpod#331) — consumers never ask the
issuer anything, so key rotation is the *only* lever that retires signing
authority at all. Does it actually work, cleanly, end to end?
**Answer: yes, for Better Auth's `jwt` plugin — but there is a real window
(up to 10 minutes) where a freshly rotated key's tokens are rejected by
kaambaan's verifier, not because rotation is broken but because that
verifier's cache does not refetch on an unknown `kid`.**
**Status:** spike complete. Nothing here is kept code — two throwaway scripts
(`apps/hub/tmp-rotation-spike*.ts`, `apps/api/tmp-hub-jwt-spike.ts` in
kaambaan) were written, run, and deleted; neither repo has any diff.

## Method

Ran against the local Postgres (`agentpod-test-postgres`, `agentpod` db — the
`rehearsal` copy was never touched). Two throwaway scripts:

1. **In agentpod** (`apps/hub`), driving `auth.api.signJWT` directly — the
   same `jwt` plugin code path `GET /api/auth/token` uses, minus session
   middleware — against the real `jwks` table, migrated fresh.
2. **In kaambaan** (`apps/api`), calling the real, unmodified
   `verifyHubToken` from `src/auth/hub-jwt.ts` with an injected `fetch`, so
   the 10-minute cache behaviour under test is the actual shipped code, not a
   reproduction of it.

The first script wrote tokens and JWKS documents to a JSON handoff file in the
scratchpad, which the second script read. That file and both scripts were
deleted after the run; `git status` in both repos is clean.

Rotation itself was done the way `apps/hub/src/db/schema/auth.ts`'s own
comment prescribes for this table: mark the current key's `expiresAt` in the
past. Better Auth's `signJWT` (`node_modules/better-auth/dist/plugins/jwt/sign.mjs`)
checks `!key || (key.expiresAt && key.expiresAt < now)` on the latest key and,
if true, calls `createJwk()` to mint a fresh one before signing — this is the
library's own rotation trigger, not something this spike invented.

## What was run, and what it returned

**1. Mint token #1.** `kid=Fa0MFuAbe01ph94MDGerq64KjSFIH5AW` (values vary per
run; shown from the kaambaan-handoff run). One row in `jwks`, `expiresAt`
null.

**2. Rotate.** `UPDATE jwks SET "expiresAt" = now() - interval '1 second'
WHERE id = <kid1>`. Next `signJWT` call **observed** to insert a second row
and sign with it: `kid=VoRQlov9sZJbOMMGNT67eVH87PSYykRC`. The `jwks` table
after rotation held both rows — the old one with a past `expiresAt`, the new
one with `expiresAt` null.

**3. Old token still verifies.** `jwtVerify(token1, …)` against the
post-rotation JWKS (both keys published) **succeeded** — observed directly.
`GET /api/auth/jwks` publishes every row whose `expiresAt + gracePeriod
(default 30 days)` has not passed (`better-auth/dist/plugins/jwt/index.mjs`),
so a row going past-`expiresAt` does not stop it being published — it only
flips `signJWT`'s "mint a new one" trigger. **This is the same behaviour as
`servicePublicJwks()`** in `service-signing.ts`, which does the equivalent by
filtering on `retiredAt IS NULL` for signing while still returning every row's
public half. Better Auth's `jwks` table and agentpod's own
`service_signing_keys` table implement the identical policy — publish
everything, sign with only the newest live one — independently.

One asymmetry worth naming: `service_signing_keys.retiredAt` exists in the
schema but **nothing in the codebase sets it** (checked by grep — only the
`isNull(retiredAt)` read in `activeKey()`). That table's rotation lever is
designed-for but not wired to any operational trigger today. Out of scope for
this spike (it mints service assertions, not the session tokens kaambaan's
`hub-jwt.ts` verifies) but worth flagging since the spike went looking.

**4. New key published; new token carries new `kid`; kaambaan's verifier
accepts it — with a real caveat.**

- `GET /api/auth/jwks` after rotation **observed** to list both kids.
- Token #2, minted after rotation, **observed** to carry `kid2` in its
  header.
- Feeding token #2 to kaambaan's real `verifyHubToken()` with a *cold* cache
  (freshly reset, or a mock `fetch` returning the post-rotation JWKS)
  **observed** to succeed and return the expected claims.
- Feeding token #2 to the same `verifyHubToken()` while its cache was **warm
  from before the rotation** (only `kid1` known) **observed to return
  `null`** — rejected — even though the mock `fetch` passed to that call
  would have returned the correct post-rotation JWKS *if consulted*. It
  wasn't consulted. Reading `hub-jwt.ts` explains why: `keySet()` only
  refetches when `now - cached.fetchedAt >= JWKS_TTL_MS` (10 minutes); it does
  not refetch on an unrecognised `kid`. That's a deliberate choice documented
  in the file (`createRemoteJWKSet`'s auto-refetch-on-miss produces unhandled
  rejections, so it was replaced with a fixed-TTL cache) — but its consequence
  is exactly what was observed here.

So: **rotation on the issuer side is immediate and clean — publish-then-sign,
nothing deleted, no outage.** What is *not* immediate is kaambaan noticing the
new key. A token minted between the moment of rotation and the moment
kaambaan's cache next refreshes is rejected as if it were invalid, for up to
10 minutes, purely because the verifier hasn't looked again — not because
anything is wrong with the token or the key. Operationally this means: **after
rotating, wait up to 10 minutes before minting tokens a caller needs verified
immediately** (or accept that some minted in that window will need a retry
once the cache turns over — there is no user-visible corruption, just a
delayed-accept window). This window applies only to *newly* minted tokens; a
token already in flight, signed before rotation, verifies the entire time
(confirmed above), so the window is a lag in adopting the new key, never a gap
in accepting the old one.

**5. Nothing signs with the retired key afterwards.** A third `signJWT` call,
with no further DB change, **observed** to reuse `kid2` (the post-rotation
key) again — not `kid1`. `signJWT` always asks for the *latest* row by
`createdAt`, so once a newer key exists, the retired one is never selected for
signing again, only for verification of what it already signed.

## What was inferred, not observed

- The 10-minute figure itself (`JWKS_TTL_MS = 10 * 60 * 1000`) was read from
  source, not independently timed — the spike forced the cache-cold and
  cache-warm branches directly rather than waiting out a real 10 minutes.
- Better Auth's 30-day JWKS `gracePeriod` default was read from source
  (`options?.jwks?.gracePeriod ?? 3600 * 24 * 30`) and not exercised — no
  scenario here waited 30 days to see a key actually drop out of
  `/api/auth/jwks`. The mechanism (filter by `expiresAt + gracePeriod`) was
  confirmed by reading the deployed library code, not by running out the
  clock.

## Environment notes

- `agentpod` test database (`agentpod`, not `rehearsal`) was used throughout.
  Its `jwks` table was cleared at the start and end of the run by the
  throwaway scripts (`DELETE FROM jwks`) — no full `DROP DATABASE` reset was
  needed or performed.
- Full suite re-run after cleanup: **1608 pass / 0 fail**, matching baseline
  exactly, no database reset required to get there.

## Bottom line

Key rotation on the hub's `jwt` plugin works exactly as its own schema comment
promises: insert the newer key, let old tokens drain, and the retired one
keeps verifying until it expires — a routine rotation is not a fleet-wide
outage. The one real sharp edge is on the consumer side: kaambaan's 10-minute
JWKS cache means a rotation is not instantly safe for *new* tokens — there is
a window, up to 10 minutes wide, where a token minted right after rotation is
wrongly rejected until kaambaan's cache catches up. That is a known,
observed, fixed-size lag, not a rotation failure.
