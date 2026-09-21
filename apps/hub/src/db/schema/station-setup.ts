import { pgTable, text, timestamp, foreignKey } from "drizzle-orm/pg-core";
import { stations } from "./stations";
import { tenants } from "./tenants";
import { user } from "./auth";

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
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    input: text("input").notNull(),
    principalId: text("principal_id").notNull(),
    matrixStatus: text("matrix_status"),
    matrixError: text("matrix_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.stationId, t.tenantId, t.userId],
      foreignColumns: [stations.id, stations.tenantId, stations.userId],
      name: "station_setups_owner_fk",
    }).onDelete("cascade"),
  ],
);
