import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { principals } from "./organization";
import { tenants } from "./tenants";

/**
 * A service principal's long-lived credential, exchanged at `POST /api/auth/service-token` for a
 * five-minute token (superwitness contract C6). The device credential's shape, bound to a
 * PRINCIPAL rather than a Better Auth user — a service has no user — and to the registered client
 * whose audiences its tokens carry, so the caller never chooses where its token may be spent.
 * Only the SHA-256 of the secret is stored. No expiry: revocation is the lever, and a revoked row
 * stays visible.
 */
export const serviceCredentials = pgTable(
  "service_credentials",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
    principalId: text("principal_id").notNull().references(() => principals.id, { onDelete: "cascade" }),
    /** A `HUB_OAUTH_CLIENTS` id. Its audience list becomes the token's `aud`. */
    oauthClient: text("oauth_client").notNull(),
    name: text("name").notNull(),
    secretHash: text("secret_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("service_credentials_principal_idx").on(t.principalId),
    index("service_credentials_tenant_id_idx").on(t.tenantId),
  ],
);
