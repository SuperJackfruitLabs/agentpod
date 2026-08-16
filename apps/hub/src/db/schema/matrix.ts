import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
  foreignKey,
  primaryKey,
} from "drizzle-orm/pg-core";
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
    /**
     * The purpose space this room currently hangs under, if any.
     *
     * Remembered rather than recomputed because a purpose can change, and
     * re-filing means removing the OLD `m.space.child` edge as well as adding
     * the new one — a room that only ever gained parents would show up under
     * every purpose it had ever been given.
     */
    spaceRoomId: text("space_room_id"),
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

/**
 * A room where several agents work together.
 *
 * A per-agent room is a DM — one correspondent, filed under People. A mission is
 * the other shape, and is an ordinary room precisely because it is not one-to-one.
 */
/**
 * One space per purpose — personal, work, whatever the operator types.
 *
 * Keyed by (tenant, purpose) rather than by an alias: an alias is a global
 * address on the homeserver, and "personal" is exactly the kind of everyday
 * word two tenants would both use. Nobody types this room's address anyway;
 * it is a container, not a destination.
 */
export const matrixPurposeSpaces = pgTable(
  "matrix_purpose_spaces",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    purpose: text("purpose").notNull(),
    roomId: text("room_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.purpose] })]
);

export const matrixMissions = pgTable(
  "matrix_missions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    roomId: text("room_id"),
    alias: text("alias").notNull(),
    /** The space this mission hangs under, once it has one. */
    spaceRoomId: text("space_room_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("matrix_missions_tenant_id_idx").on(t.tenantId),
    uniqueIndex("matrix_missions_alias_idx").on(t.alias),
  ]
);

/**
 * Which stations are in a mission.
 *
 * A station may be in several at once: an agent is not consumed by the work it
 * is doing, and one-mission-per-agent is the DM we already have.
 */
export const matrixMissionMembers = pgTable(
  "matrix_mission_members",
  {
    missionId: text("mission_id").notNull(),
    stationId: text("station_id").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    addedAt: timestamp("added_at").notNull().defaultNow(),
  },
  (t) => [index("matrix_mission_members_tenant_id_idx").on(t.tenantId)]
);
