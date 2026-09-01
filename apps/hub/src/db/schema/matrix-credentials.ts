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
 * No `token_hash`: unlike `enrollmentTokens` (`./nodes.ts`), which this
 * table's shape started from, there is no unauthenticated party here to hand
 * a bearer token to. The node redeeming this record is already authenticated
 * by its own `<nodeId>:<nodeSecret>` and already proven to host the station
 * (`routes/station-matrix-credential.ts`), so `station_id` is the only key
 * redemption needs. What carries over from `enrollmentTokens` is `expires_at`
 * and `used_at` — `used_at` is what makes redemption single-use; the redeem
 * statement sets it in the same UPDATE that checks it is null (see
 * `services/matrix-credential.ts`), so two concurrent redemptions of one
 * authorisation cannot both succeed — a race here would mean two working
 * Matrix credentials for one human approval.
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
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("matrix_credential_auth_station_idx").on(t.stationId)]
);
