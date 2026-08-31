/**
 * The one place a station is resolved to its room.
 *
 * Fix round 2 on Task 5. `matrix_rooms.station_id` stopped being unique in
 * fix round 1, so a station can now carry more than one row: a departed
 * occupant's room, kept for its history and address, alongside its new
 * occupant's own. A bare `leftJoin(matrixRooms, eq(matrixRooms.stationId,
 * stations.id))` — no `ORDER BY`, `[row]` picked off whatever Postgres
 * happens to return first — is not safe anywhere in this codebase after
 * that: it names an ARBITRARY room, which can belong to whoever occupied
 * the station before.
 *
 * Round 1 patched the two call sites it knew about (`gates.ts`'s
 * `roomForCard`, `routes/agents-admin.ts`'s bind-on-assign write). A
 * second review swept the rest of the codebase and found two more still
 * making the identical mistake — `routes/station-say.ts` (speaking as the
 * CURRENT occupant into whatever room the arbitrary join returned) and
 * `provision.ts` (deciding "this station already has a room" from the same
 * arbitrary join, so a new occupant with no room of its own never got one
 * provisioned, silently, forever). Patching call sites one at a time
 * leaves the next one for the next agent to find. Every reader that needs
 * "the room for this station's occupant" goes through this function now.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { matrixRooms } from "../../db/schema/matrix";
import { stations } from "../../db/schema/stations";

export interface StationRoom {
  roomId: string;
  spaceRoomId: string | null;
}

export interface StationOccupancy {
  /** The station's current occupant, or null. */
  principalId: string | null;
  /**
   * The room that occupant owns — or, when there is no current occupant,
   * the station's own unbound room. Never a departed occupant's room that
   * merely happens to share this station's `station_id`.
   */
  room: StationRoom | null;
}

/**
 * The room a station's CURRENT occupant answers in.
 *
 * Two different "no room" answers, because two different situations need
 * telling apart:
 *
 *  - The station has an occupant, and that occupant already has a room of
 *    its own (`matrix_rooms.principal_id` bound to it): returned.
 *  - The station has an occupant with NO room of its own yet: `room` is
 *    `null` — an honest "not yet", never a departed occupant's room. This
 *    is what tells `provision.ts` a room genuinely needs creating, and
 *    what tells `gates.ts` there is nowhere to post yet.
 *  - The station has NO occupant at all: the station's own UNBOUND room
 *    (`station_id = stationId AND principal_id IS NULL`), if one exists.
 *    This is the one case a plain `station_id` lookup is still correct,
 *    because there is no current occupant whose room it could be mistaken
 *    for — it is also what keeps a harness-mode or pre-this-slice room
 *    (never bound to any principal) resolvable exactly as it always was.
 */
export async function roomForStation(stationId: string): Promise<StationOccupancy> {
  const [station] = await db
    .select({ principalId: stations.principalId })
    .from(stations)
    .where(eq(stations.id, stationId))
    .limit(1);
  const principalId = station?.principalId ?? null;

  if (principalId) {
    const [own] = await db
      .select({ roomId: matrixRooms.roomId, spaceRoomId: matrixRooms.spaceRoomId })
      .from(matrixRooms)
      .where(eq(matrixRooms.principalId, principalId))
      .limit(1);
    return { principalId, room: own ?? null };
  }

  const [unbound] = await db
    .select({ roomId: matrixRooms.roomId, spaceRoomId: matrixRooms.spaceRoomId })
    .from(matrixRooms)
    .where(and(eq(matrixRooms.stationId, stationId), isNull(matrixRooms.principalId)))
    .limit(1);
  return { principalId: null, room: unbound ?? null };
}
