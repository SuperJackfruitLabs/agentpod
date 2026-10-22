import { pgTable, text, timestamp, foreignKey } from "drizzle-orm/pg-core";
import { stations } from "./stations";
import { tenants } from "./tenants";

/** Durable receipts for setup retries. Replaying a receipt never reapplies grants. */
export const stationSetups = pgTable(
  "station_setups",
  {
    requestId: text("request_id").primaryKey(),
    stationId: text("station_id")
      .notNull()
      .references(() => stations.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull(),
    input: text("input").notNull(),
    principalId: text("principal_id").notNull(),
    matrixStatus: text("matrix_status"),
    matrixError: text("matrix_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    // The station's tenant, not its adopter: any admin of the workspace may set a station up (W4,
    // migration 0114). `user_id` records who did.
    foreignKey({
      columns: [t.stationId, t.tenantId],
      foreignColumns: [stations.id, stations.tenantId],
      name: "station_setups_station_tenant_fk",
    }).onDelete("cascade"),
  ],
);
