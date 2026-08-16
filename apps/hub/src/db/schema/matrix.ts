import { pgTable, text, timestamp, index, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { stations } from "./stations";

/**
 * Applied Application Service transactions.
 *
 * The homeserver retries what it did not see acknowledged. This is what makes a
 * retry a no-op instead of a second conversation.
 */
export const matrixAsTransactions = pgTable("matrix_as_transactions", {
  txnId: text("txn_id").primaryKey(),
  appliedAt: timestamp("applied_at").notNull().defaultNow(),
});

/**
 * Which room belongs to which station, and the conversation running in it.
 *
 * Keyed by room id because that is what an inbound event carries. The alias is
 * derived and stored only so this table is readable by a person.
 */
export const matrixRooms = pgTable(
  "matrix_rooms",
  {
    roomId: text("room_id").primaryKey(),
    /**
     * Carried rather than inferred from the station: "reachable only through a
     * scoped parent" is a claim about the routes that happen to exist today
     * (db/tenant-scope.ts). The composite FK below keeps the copy honest.
     */
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    stationId: text("station_id").notNull(),
    alias: text("alias").notNull(),
    /** The ACP session this room is talking to, if one is open. */
    acpSessionId: text("acp_session_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("matrix_rooms_tenant_id_idx").on(t.tenantId),
    uniqueIndex("matrix_rooms_station_idx").on(t.stationId),
    foreignKey({
      columns: [t.stationId, t.tenantId],
      foreignColumns: [stations.id, stations.tenantId],
      name: "matrix_rooms_station_tenant_fk",
    }).onDelete("cascade"),
  ]
);
