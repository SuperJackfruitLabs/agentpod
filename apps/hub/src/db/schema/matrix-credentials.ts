import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { stations } from "./stations";

/**
 * An authorization for one station to redeem one Matrix credential.
 *
 * A human authorises a station; the node then redeems that authorisation for
 * the credential itself. This row is the boundary between the two — a node
 * can never mint itself a credential, only cash in what a human already
 * approved for this exact station.
 *
 * Shape copied from `enrollmentTokens` (`./nodes.ts`) rather than invented: a
 * hashed token, an `expires_at`, and a `used_at` that makes redemption
 * single-use. The redeem statement sets `used_at` in the same UPDATE that
 * checks it is null (see `services/matrix-credential.ts`), so two concurrent
 * redemptions of one authorisation cannot both succeed — a race here would
 * mean two working Matrix credentials for one human approval.
 */
export const matrixCredentialAuthorizations = pgTable(
  "matrix_credential_authorizations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    stationId: text("station_id")
      .notNull()
      .references(() => stations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("matrix_credential_auth_station_idx").on(t.stationId)]
);
