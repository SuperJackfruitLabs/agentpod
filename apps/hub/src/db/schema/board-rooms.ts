/**
 * The Matrix room a board's gates close in.
 *
 * `charter → decisions/2026-09-28-a-gate-belongs-to-its-board-not-to-an-agents-room.md`.
 * A gate used to be projected into the station's own room, speaking as the agent
 * that produced it. That cannot work: the hub encrypts as the agent outbound —
 * which `bridge-agents.ts` says it must never do — and correctly refuses to
 * decrypt for it inbound, so a gate could be delivered there and never answered.
 *
 * **Its own table rather than a nullable `matrix_rooms.station_id`.** That column
 * is `NOT NULL` and `roomContext` inner-joins stations on the inbound hot path;
 * loosening it would make every station-room lookup answerable with a row that has
 * no station. A board room shares nothing with a station room except being a room.
 */
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { tenants } from "./tenants";

export const matrixBoardRooms = pgTable(
  "matrix_board_rooms",
  {
    /** superpipeline's board. One room each, which is the unit a person watches. */
    boardId: text("board_id").primaryKey(),
    roomId: text("room_id").notNull().unique(),
    /**
     * Carried rather than inferred, for the same reason `matrix_rooms` carries it:
     * "reachable only through a scoped parent" is a claim about the routes that
     * happen to exist today (`db/tenant-scope.ts`).
     */
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    /**
     * The identity that speaks here, and whose keys the hub owns outright.
     *
     * Stored rather than derived because it is the whole reason this room exists:
     * a room the hub can both encrypt for and decrypt for. If the speaker ever
     * changes, a row that named the old one is how the change is noticed rather
     * than silently mixed.
     */
    speakerMxid: text("speaker_mxid").notNull(),
    alias: text("alias").notNull(),
    /**
     * What the room is CALLED, as last set by this service.
     *
     * Stored so "has the name changed" is a local comparison rather than a
     * homeserver read on every gate — and so a rename that FAILED is not recorded
     * as though it landed, which would leave the room misnamed forever because the
     * next pass would see nothing to do.
     *
     * Null means never set. That is every room that existed when this column was
     * added, each named after the product rather than its board, and it is what
     * makes the backfill happen on a room's next gate rather than in a migration.
     */
    name: text("name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("matrix_board_rooms_tenant_id_idx").on(t.tenantId)],
);
