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
 *
 * The whole-branch review found the second half of the same problem: once
 * a station can carry several rooms, *choosing between the unbound ones*
 * was being done four different ways, three of them by an unordered
 * `LIMIT 1`. `unboundRoomsForStation` below is that choice, made once —
 * see its comment for the rule and why the earlier alias-matching rule was
 * withdrawn.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { matrixRooms } from "../../db/schema/matrix";
import { stations } from "../../db/schema/stations";
import { nodes } from "../../db/schema/nodes";
import { roomAliasFor } from "./names";
import { principalHandle } from "../principals";
import { createLogger } from "../../utils/logger";

const log = createLogger("station-room");

export interface StationRoom {
  roomId: string;
  spaceRoomId: string | null;
  /**
   * The address this room is actually reachable at, as recorded when it was
   * created. Read rather than re-derived — a room created before the alias
   * followed its occupant still answers at the address it was created with,
   * and deriving one afresh is how `routes/station-matrix.ts` came to hand
   * out an alias no room held.
   */
  alias: string;
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
 * **The rule for choosing among a station's UNBOUND rooms: oldest
 * `created_at` wins, tie-broken by `room_id`.**
 *
 * One rule, applied at every site that has to make this choice — here, at
 * `roomAliasForStation` below, at `routes/agents-admin.ts`'s bind-on-assign
 * `UPDATE` (as an inline `ORDER BY`, because that write must stay a single
 * atomic statement), and in migration `0062`. Four sites making the same
 * choice by four different accidents is how this codebase acquired the bug
 * class this whole task has been closing.
 *
 * Oldest, because the station's ORIGINAL room is the one carrying the
 * history — the room adoption provisioned, the one an operator has been
 * reading for months. `room_id` breaks a tie because `created_at` has no
 * uniqueness of its own and two rooms provisioned in the same batch can
 * share a timestamp to the microsecond; without it the "rule" would still
 * be an arbitrary pick, just a better-dressed one.
 *
 * A previously-proposed rule — match the sibling whose stored alias equals
 * `bridgeAliasForHandle(handle)` — was withdrawn as unsound: `provision.ts`
 * binds `principal_id` at CREATION, so every room that is still unbound
 * carries the STATION-derived alias. That rule matches all of a station's
 * siblings or none of them, and at the assign site it would refuse the
 * ordinary adoption-time room and hand the agent a fresh one, abandoning
 * exactly the history this slice exists to preserve.
 *
 * **Logged whenever it actually had to choose.** A deterministic pick out of
 * two candidates is still a guess about which room an operator meant; the
 * point of the log line is that the ambiguity is visible in the record
 * rather than settled in silence. One candidate is the ordinary case and
 * says nothing.
 */
export async function unboundRoomsForStation(stationId: string): Promise<StationRoom[]> {
  return db
    .select({
      roomId: matrixRooms.roomId,
      spaceRoomId: matrixRooms.spaceRoomId,
      alias: matrixRooms.alias,
    })
    .from(matrixRooms)
    .where(and(eq(matrixRooms.stationId, stationId), isNull(matrixRooms.principalId)))
    .orderBy(asc(matrixRooms.createdAt), asc(matrixRooms.roomId));
}

/**
 * The one unbound room a station's history lives in, under the rule above,
 * or null. `where` names the caller so an ambiguity log line says which
 * decision was made on incomplete information.
 */
export async function oldestUnboundRoom(
  stationId: string,
  where: string
): Promise<StationRoom | null> {
  const rooms = await unboundRoomsForStation(stationId);
  if (rooms.length > 1) {
    log.warn("station carries more than one unbound room; chose the oldest", {
      stationId,
      where,
      chose: rooms[0]!.roomId,
      among: rooms.map((r) => r.roomId),
    });
  }
  return rooms[0] ?? null;
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
      .select({
        roomId: matrixRooms.roomId,
        spaceRoomId: matrixRooms.spaceRoomId,
        alias: matrixRooms.alias,
      })
      .from(matrixRooms)
      .where(eq(matrixRooms.principalId, principalId))
      .limit(1);
    return { principalId, room: own ?? null };
  }

  // Ordered by `unboundRoomsForStation`'s rule rather than picked off an
  // unordered `LIMIT 1` — with no `ORDER BY`, `routes/station-say.ts` and
  // `gates.ts` could resolve the SAME unoccupied station to two different
  // rooms across two calls and split one conversation in half.
  return { principalId: null, room: await oldestUnboundRoom(stationId, "roomForStation") };
}

/**
 * The address this station's room is reachable at — the one answer to that
 * question, for anything that reports or logs an alias.
 *
 * Fix round 5 on Task 5, and the fourth time in this task that a rule was
 * fixed one layer inside the entry point that serves it. Round 3 made a
 * room's alias follow its occupant (`bridgeAliasForHandle`) inside
 * `provision.ts`, and `routes/station-matrix.ts` went on deriving
 * `bridgeAlias(nodeName, stationKey)` for its response — an address no room
 * holds, for precisely the stations that endpoint answers for, since it
 * 409s unless the station has an occupant. The AS route would even 200 on
 * it through `stationForAlias`'s legacy fallback, and then create nothing,
 * because provisioning sees the station already has a room; the directory
 * lookup fails and the caller is left with a name that goes nowhere.
 *
 * A STORED alias beats a derived one whenever there is a room: a room
 * created before the derivation changed still answers at the address it was
 * actually created with, and re-deriving would misreport it. The derivation
 * (`names.ts`'s `roomAliasFor`, which `provision.ts` also uses, so there is
 * one rule rather than two) is only for a station whose room does not exist
 * yet — the honest answer to "where it will be", not a claim about where it
 * is.
 *
 * Null only for a station that does not exist.
 */
export async function roomAliasForStation(
  stationId: string,
  domain: string
): Promise<string | null> {
  const occupancy = await roomForStation(stationId);
  if (occupancy.room) return occupancy.room.alias;

  // An OCCUPIED station whose occupant holds no bound room yet is the case
  // this branch used to misreport. `roomForStation` answers `null` there, on
  // purpose — an honest "not yet" rather than a departed occupant's room —
  // and deriving from here would then claim an address that is wrong twice
  // over: the station carries a real room already, at a real stored alias,
  // and bind-on-assign's `UPDATE` is going to hand the occupant THAT room
  // under the same oldest-wins rule. Reporting where it will be, when the
  // answer to where it IS is sitting in the table, is the same class of
  // mistake as `routes/station-matrix.ts` re-deriving a station-keyed alias.
  //
  // Derivation is kept for what it is actually honest about: a station with
  // no room at all, where "here is where it will be" is the only answer
  // there is.
  const unbound = await oldestUnboundRoom(stationId, "roomAliasForStation");
  if (unbound) return unbound.alias;

  const [station] = await db
    .select({
      nodeName: nodes.name,
      stationKey: stations.stationKey,
      principalId: stations.principalId,
    })
    .from(stations)
    .innerJoin(nodes, eq(nodes.id, stations.nodeId))
    .where(eq(stations.id, stationId))
    .limit(1);
  if (!station) return null;

  const handle = station.principalId ? await principalHandle(station.principalId) : null;
  return roomAliasFor(
    { handle, nodeName: station.nodeName, stationKey: station.stationKey },
    domain
  );
}
