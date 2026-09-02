/**
 * One-time authorization codes for the cross-domain token handoff — mint and
 * redeem.
 *
 * The hub has exactly one way to hand a browser a token today
 * (`GET /api/auth/token`), and it needs a session cookie the browser will only
 * send same-site. A plane on its own registrable domain therefore cannot reach
 * it at all. What `SameSite=Lax` does still permit is top-level navigation, so
 * the browser navigates to `GET /api/auth/authorize`, the hub reads its own
 * first-party cookie, and one of these codes rides back in the redirect to be
 * exchanged server-to-server for exactly the token that endpoint already
 * issues. See
 * docs/superpowers/specs/2026-09-02-cross-domain-token-handoff-design.md.
 *
 * A code is the only part of this that travels in a URL — through an address
 * bar, browser history and any `Referer` — so it is worth as little as it can
 * be made to be: 60 seconds, one redemption, and only for the client and
 * redirect URI it was issued to. It is not itself the credential; it is a
 * claim ticket, and PKCE (`code_challenge` here, the verifier at the exchange)
 * is what proves the party redeeming it is the one that started the flow.
 *
 * `redeemedAt` is what makes redemption single-use, exactly as `usedAt` does
 * for `matrixCredentialAuthorizations` — the UPDATE below sets it in the same
 * statement that checks it is null, so two concurrent redemptions cannot both
 * win.
 */

import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db/drizzle";
import { oauthCodes } from "../db/schema/oauth";

/**
 * A code lives only as long as a redirect takes.
 *
 * Not a compromise between the redirect and anything else: nothing legitimate
 * happens between the 302 and the plane's back end POSTing the exchange, and a
 * longer window is only ever a longer window for whatever read the URL.
 */
export const CODE_TTL_MS = 60_000;

/**
 * Rows older than this are deleted whenever one is minted.
 *
 * Swept on write rather than by a job, like the other short-lived tables — a
 * timer is a second thing to run and to notice has stopped. An hour is far
 * past the point where a row can affect any answer (the TTL is a minute); it
 * is deliberately not "expired" so a redeemed or expired code stays readable
 * for a moment while someone is looking at why an exchange failed.
 */
const SWEEP_AFTER_MS = 60 * 60 * 1000;

/**
 * 32 bytes of CSPRNG, base64url — 43 characters, none of which need escaping
 * in the query string this rides back in.
 */
function generateCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Mint a code for a signed-in user to carry back to `clientId`'s
 * `redirectUri`.
 *
 * `redirectUri` is stored rather than looked up again at redemption: the
 * exchange must repeat the URI the code was issued for, so a code that leaks
 * out of one plane's callback cannot be spent against another's. The caller
 * (`routes/auth-authorize.ts`) is responsible for having already checked that
 * URI against the client registry — this function stores what it is given.
 */
export async function mintCode(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  /** Test seam. Real callers take the 60 seconds. */
  ttlMs?: number;
}): Promise<{ code: string; expiresAt: Date }> {
  await db
    .delete(oauthCodes)
    .where(lt(oauthCodes.createdAt, new Date(Date.now() - SWEEP_AFTER_MS)));

  const code = generateCode();
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? CODE_TTL_MS));

  await db.insert(oauthCodes).values({
    code,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    userId: input.userId,
    expiresAt,
  });

  return { code, expiresAt };
}

/**
 * Redeem once. Returns the row on the single win, null on every loss —
 * expired, already redeemed, unknown, or a mismatched client/redirect.
 *
 * ONE statement, on purpose. Read-then-write races: every concurrent caller
 * would see `redeemed_at IS NULL` before any of them wrote it, and one
 * authorization would become as many tokens as there were racers. The
 * conditional UPDATE makes Postgres the arbiter — the row is locked by the
 * first writer and re-checked by the second, so exactly one `RETURNING` comes
 * back non-empty.
 *
 * A mismatched `clientId` or `redirectUri` consumes nothing, because it never
 * matched the WHERE at all. That is the right answer: someone who learned a
 * code must not be able to burn the legitimate holder's redirect by guessing
 * wrong at it. What protects against a *correctly* addressed replay is the
 * verifier check the caller does after this returns — and by then the code is
 * already spent, so a wrong verifier cannot be retried.
 *
 * `now()` on both sides is Postgres's clock, not the hub's: with a 60-second
 * window, a hub whose clock has drifted would otherwise reject codes its own
 * database still considers live.
 */
export async function redeemCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
}): Promise<{ userId: string; codeChallenge: string } | null> {
  const rows = await db
    .update(oauthCodes)
    .set({ redeemedAt: sql`now()` })
    .where(
      and(
        eq(oauthCodes.code, input.code),
        eq(oauthCodes.clientId, input.clientId),
        eq(oauthCodes.redirectUri, input.redirectUri),
        isNull(oauthCodes.redeemedAt),
        gt(oauthCodes.expiresAt, sql`now()`)
      )
    )
    .returning({
      userId: oauthCodes.userId,
      codeChallenge: oauthCodes.codeChallenge,
    });

  return rows[0] ?? null;
}
