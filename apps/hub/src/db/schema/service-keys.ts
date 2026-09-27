/**
 * The key this hub signs **service assertions** with — see migration 0054.
 *
 * Separate from Better Auth's `jwks` table on purpose. Both key sets are
 * published together and verify identically, so this is not a cryptographic
 * boundary; it is an *authority* boundary. A token minted from a person's own
 * session and a token the Application Service minted while asserting that
 * person should not be the same object signed the same way, because only one of
 * them involved the person.
 */

import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const serviceSigningKeys = pgTable(
  "service_signing_keys",
  {
    /** The JWK `kid`, which is how a verifier picks this key out of the set. */
    kid: text("kid").primaryKey(),
    publicJwk: text("public_jwk").notNull(),
    /**
     * Stored as a JWK, unencrypted — and this is a deliberate, bounded choice
     * rather than an oversight. Better Auth encrypts its own private keys with
     * the app secret, which lives in the same environment, on the same box, as
     * this database: the protection is thinner than it looks. What actually
     * limits the damage here is scope — this key can mint only what
     * `mintPrincipalAssertion` will build, and that function takes its subject
     * from `principal_identities`, never from a caller.
     *
     * If this is ever wrong, the fix is a KMS or an HSM, not re-encrypting it
     * with a secret stored beside it.
     */
    privateJwk: text("private_jwk").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    /** Set when superseded. Still published, so tokens signed by it still verify. */
    retiredAt: timestamp("retired_at"),
  },
  (t) => [
    index("service_signing_keys_active_idx")
      .on(sql`${t.createdAt} DESC`)
      .where(sql`${t.retiredAt} IS NULL`),
  ]
);
