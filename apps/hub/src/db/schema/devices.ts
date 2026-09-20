import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { tenants } from "./tenants";

/**
 * A long-lived credential bound to one machine, which a human exchanges for a
 * five-minute token.
 *
 * `charter → decisions/2026-09-18-a-human-at-a-terminal-has-nothing-to-exchange.md`,
 * accepted 2026-09-20. An agent re-mints by exchanging the credential it already
 * holds; a browser re-mints silently from its session cookie; a human at a
 * terminal held neither, so every five minutes cost a browser, a person and a
 * click. This is the station credential's role, played for a principal kind the
 * original decision did not consider.
 *
 * **Only the hash is stored**, as `nodes.secretHash` and
 * `enrollmentTokens.tokenHash` already are. The raw secret is returned once, at
 * creation. A lost secret is a new device, not a recovery.
 *
 * **No `principalId` column, deliberately.** The principal is resolved from
 * `userId` at every exchange, through `buildTokenPayload`, which already refuses
 * to mint for a suspended principal. Freezing the principal here would freeze a
 * decision the hub re-makes each time — and a suspended principal whose device
 * row still named it is exactly the thing not to freeze.
 */
export const deviceCredentials = pgTable("device_credentials", {
  id: text("id").primaryKey(),

  /** Cascades, like `nodes.userId`: a deleted user's devices are not somebody's to inherit. */
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),

  /** Restricts, like `nodes.tenantId`: a tenant with live credentials is not deletable by accident. */
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),

  /**
   * What the person calls this machine. The hostname by default.
   *
   * Not unique and not an identifier — the record asks for devices to be "a thing
   * an operator can see and name in a list", and two laptops called `mbp` is a
   * readable list, not a conflict.
   */
  name: text("name").notNull(),

  secretHash: text("secret_hash").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

  /** Null until the first exchange, which is a distinct state from "used long ago". */
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),

  /**
   * Slides 90 days forward on every successful exchange.
   *
   * Sustained work therefore never meets it, and a machine that stops being used
   * stops holding a key without anyone having to remember to revoke it — the
   * answer to the record's own warning that a stolen device credential is worse
   * than a stolen token.
   */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

  /** Set rather than deleted, so a revoked device stays visible in the list it was revoked from. */
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [
  index("device_credentials_user_id_idx").on(t.userId),
  index("device_credentials_tenant_id_idx").on(t.tenantId),
]);
