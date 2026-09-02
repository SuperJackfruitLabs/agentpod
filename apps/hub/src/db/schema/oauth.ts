import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * A one-time authorization code for the cross-domain token handoff.
 *
 * The hub's session cookie is `SameSite=Lax`, so a plane on its own domain
 * (kaambaan.dev) can never carry it on a cross-site `fetch`. What Lax *does*
 * permit is top-level navigation, so the browser NAVIGATES to
 * `GET /api/auth/authorize`, the hub reads its own first-party cookie, and one
 * of these rows is what comes back through the redirect — exchanged
 * server-to-server for exactly the token `GET /api/auth/token` already issues.
 * The code is the only thing that ever travels in a URL, which is why it lives
 * for 60 seconds and can be spent once.
 *
 * `redeemed_at` is what makes it once, and it is set by the same UPDATE that
 * checks it is null (see `services/oauth-codes.ts`) — the shape
 * `matrix_credential_authorizations` already uses. Read-then-write would let
 * two concurrent redemptions of one code both mint a token.
 *
 * `code_challenge` is the PKCE S256 digest. There is no client secret to hold:
 * the consuming plane is a public client with a private back end, so what
 * proves the exchange comes from whoever started the flow is the verifier.
 *
 * Timestamps are `timestamptz`, deliberately unlike the older tables here.
 * Both the expiry check and the redemption stamp are evaluated by Postgres as
 * `now()` rather than by the hub as a JS Date, and comparing `now()` against a
 * `timestamp without time zone` silently reinterprets it through the session's
 * TimeZone. For a 60-second window a one-hour timezone slip is not a rounding
 * error, it is every code being born expired.
 *
 * No foreign key on `user_id`. These rows live 60 seconds and are swept on
 * write; a referential constraint on a table this short-lived buys nothing and
 * would make deleting a user depend on a code that has already stopped
 * mattering.
 */
export const oauthCodes = pgTable(
  "oauth_codes",
  {
    /** 32 bytes of CSPRNG, base64url. The whole secret — hence the short TTL. */
    code: text("code").primaryKey(),
    /** The registry key (`config.ts`'s `oauthClients`) this was issued to. */
    clientId: text("client_id").notNull(),
    /** The exact redirect URI it was issued for; the exchange must repeat it. */
    redirectUri: text("redirect_uri").notNull(),
    /** PKCE S256 challenge, base64url. */
    codeChallenge: text("code_challenge").notNull(),
    /** Who authorized — the signed-in hub user the token will be minted for. */
    userId: text("user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Null until redeemed. The single-use guard. */
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  // Only the sweep reads by age; every other access is by primary key.
  (t) => [index("oauth_codes_created_at_idx").on(t.createdAt)]
);
