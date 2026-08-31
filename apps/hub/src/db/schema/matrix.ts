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
import { principals } from "./organization";

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
    /**
     * The occupying agent this room speaks to — added, not swapped in for
     * `stationId`.
     *
     * **Has TWO writers, and they agree.** The whole-branch review found this
     * comment still claiming one, which by then was false:
     *
     *  - `routes/agents-admin.ts`'s assign endpoint binds an EXISTING unbound
     *    room — the oldest at the station, under the rule in
     *    `matrix-as/station-room.ts` — and only under `NOT EXISTS (… WHERE
     *    principal_id = …)`, because the row it is updating was created for
     *    somebody else's benefit and it has no other way to know whether this
     *    principal is already housed.
     *  - `matrix-as/provision.ts` binds a room it is CREATING, at insert,
     *    unconditionally.
     *
     * The two policies read as a disagreement and are not: provisioning only
     * reaches its insert when `roomForStation` has already answered "this
     * occupant has no room", which is the same predicate assign spells out as
     * `NOT EXISTS`. One checks it by having asked a moment earlier; the other
     * checks it in the statement, because it is racing other assigns.
     * `matrix_rooms_principal_idx` is what makes the agreement enforced
     * rather than merely intended — if either ever stopped holding, the
     * second write raises 23505 instead of quietly giving an agent two rooms.
     *
     * Once bound, never moved or cleared — an agent keeps the room it was
     * first bound to for as long as it exists, however many stations it
     * occupies afterward, which is the entire point of keying gates on the
     * agent rather than on wherever it currently sits.
     * Migration `0060_matrix_rooms_backfill_principal_id`
     * backfilled every room that predates the writer from its station's
     * occupant at the time, so no pre-existing room reads null forever for
     * having existed before this column had one.
     *
     * `matrix-as/station-room.ts`'s `roomForStation` is the ONE place this
     * resolves for every reader now — `gates.ts`, `routes/station-say.ts`,
     * and `provision.ts` all call into it rather than joining on `stationId`
     * themselves, so a reassigned agent's gates, unprompted messages, and
     * provisioning all keep landing in its original room rather than
     * whatever room its new station happens to have.
     *
     * **The `stationId` fallback is scoped, not unconditional — fix round 1
     * on Task 5, then centralised in fix round 2.** The first cut fell back
     * to the `stationId` join whenever this column was null, which included
     * a station whose CURRENT occupant simply hadn't been bound yet — and
     * since a departed principal's room keeps its `stationId`, that fallback
     * could hand a new occupant's gates (and, a second review found, its
     * unprompted messages, and its provisioning) to the room, and the
     * address, of whoever used to be there. `roomForStation` falls back to
     * `stationId` only when the station has NO occupant at all; an occupied
     * station whose occupant has no room of its own answers "no room yet"
     * instead of guessing. `gate-sweep.ts` — deployed in production, and
     * unaware it depends on this — is unaffected: it calls into `gates.ts`
     * rather than querying this table itself, and the fallback it actually
     * exercises (an unoccupied station's own room) is untouched. `stationId`
     * stays the column every current reader still needs; this is redundant
     * with it, not a replacement for it. Retiring `stationId` is a later
     * slice's own migration, once every reader has moved.
     *
     * Nullable because a room this hasn't reached is still nullable, and
     * because a station can lose its occupant (`stations.principalId` is
     * itself nullable) without this column following it down — a room's own
     * binding does not un-bind just because its station's current occupant
     * changed — so it would stay nullable even with a writer in place.
     */
    principalId: text("principal_id").references(() => principals.id, { onDelete: "set null" }),
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
    /**
     * NOT unique, as of the fix round on Task 5 — deliberately. A station
     * can now carry more than one room: a departed principal's, kept so it
     * keeps its history and address, alongside its new occupant's own. A
     * unique index here would refuse the second row outright, which is
     * exactly what "the room follows the agent" requires being able to do.
     */
    index("matrix_rooms_station_idx").on(t.stationId),
    /** One room per occupying agent — enforceable now that occupancy
     *  itself is exclusive (`stations_principal_id_idx`); multiple NULLs
     *  are still fine, for every room with no bound occupant. */
    uniqueIndex("matrix_rooms_principal_idx").on(t.principalId),
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
 * One space per node, plus one for missions.
 *
 * Keyed by (tenant, key) rather than by an alias: an alias is a global address
 * on the homeserver, and a node called `laptop` is exactly what two tenants
 * would both have. Nobody types this room's address anyway — it is a
 * container, not a destination.
 *
 * The key is a node's name, or [`GENERAL_MISSIONS_KEY`] for the one space that
 * holds missions. It used to be a purpose; see migration 0052 for why the
 * grouping moved to the machine.
 */
export const matrixSpaces = pgTable(
  "matrix_spaces",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    spaceKey: text("space_key").notNull(),
    roomId: text("room_id").notNull(),
    /**
     * The agent that created the space, and therefore the only one that can
     * write its `m.space.child` state — child edges live on the space, and a
     * room's own agent is a member of its room and of nothing else.
     *
     * Null only for rows written before this was recorded.
     */
    creator: text("creator"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.spaceKey] })]
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

/**
 * One kaambaan gate, one Matrix event.
 *
 * The record that makes the delivery path safe to retry. kaambaan's push is
 * at-least-once within a cap, its alarm re-picks failed rows, and the
 * reconciliation sweep asks independently which pending gates have no event —
 * so the same gate arrives here more than once **by design**. Without this, each
 * arrival would post the question again and a reader would be asked to approve
 * one thing three times.
 *
 * `gateId` is the primary key rather than a surrogate with a unique index,
 * because the gate is the identity: there is no such thing as two projections
 * of one gate, and a schema able to represent one will eventually hold one.
 */
export const matrixGateEvents = pgTable(
  "matrix_gate_events",
  {
    gateId: text("gate_id").primaryKey(),
    /**
     * Carried rather than derived through the room, for the same reason
     * `matrixRooms` carries it: "reachable only through a scoped parent" is a
     * claim about the routes that exist today.
     */
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    /** kaambaan's board, needed to address the resolution endpoint. */
    boardId: text("board_id").notNull(),
    cardId: text("card_id").notNull(),
    roomId: text("room_id").notNull(),
    /** The event the gate was posted as — what a decision references. */
    eventId: text("event_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("matrix_gate_events_tenant_id_idx").on(t.tenantId),
    /**
     * The reverse direction. A decision arrives holding the event it references
     * and needing the gate; the sweep goes the other way. Unique because two
     * gates projected onto one event would make the first question
     * unanswerable.
     */
    uniqueIndex("matrix_gate_events_event_idx").on(t.eventId),
  ]
);
