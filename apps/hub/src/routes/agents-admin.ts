/**
 * Creating an agent, and putting it somewhere.
 *
 * `charter → decisions/2026-08-30-an-agent-is-a-principal.md`: creating an
 * agent is "a deliberate act, not a side effect of a machine appearing" — and
 * until this file, the only way one came into existence was a seed script run
 * by hand. This is the HTTP surface that replaces it: minting the principal,
 * and putting it in a station so it becomes dispatchable.
 *
 * Mounted inside the same admin guard as the rest of `/api/admin`, no
 * exemption carved: minting an identity other systems will address by its
 * handle forever is at least as sensitive as the grants and suspensions that
 * already live there.
 *
 * Two refusals this file exists to get right:
 *
 *   - A handle is what an agent's Matrix address is built from
 *     (`services/matrix-as/names.ts`), and it is immutable once minted. A
 *     handle `clean()` would alter — case, or a character outside its kept
 *     set — must be refused here, not silently registered under a different
 *     address than the one typed. The character class below is deliberately
 *     the same one, kept in sync by hand rather than by import: `clean()` is
 *     private to that module, and duplicating a five-character regex is a
 *     smaller risk than reaching into a module this task does not otherwise
 *     touch.
 *   - Two principals cannot share a handle — `principals_org_handle_idx`
 *     enforces it at the database — and a race between two admins hitting
 *     this endpoint at once must still resolve to one winner and a 409, not
 *     a 500 leaking a constraint name.
 *
 * Assigning a suspended principal to a station is refused for a third reason
 * that belongs to the station side, not the handle side: a suspended agent
 * that can still be handed a station is a suspension that does not suspend.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq, ne, sql } from "drizzle-orm";

import { db } from "../db/drizzle";
import { matrixRooms } from "../db/schema/matrix";
import { stations } from "../db/schema/stations";
import { provisionStationNow } from "../services/matrix-as/hooks";
import { unboundRoomsForStation } from "../services/matrix-as/station-room";
import { createPrincipal, principalById } from "../services/principals";
import { createLogger } from "../utils/logger";

const log = createLogger("agents-admin");

/**
 * The same character class `clean()` in `matrix-as/names.ts` cleans a
 * localpart with. A handle outside it is not rejected there — it is
 * rewritten, quietly, into a different address than the one an admin typed.
 * Refusing it here is what makes the handle actually the address, rather
 * than a suggestion for one.
 */
const ILLEGAL_HANDLE_CHARS = /[^a-z0-9.=/-]/g;

function wouldBeMangled(handle: string): boolean {
  return handle.toLowerCase().replace(ILLEGAL_HANDLE_CHARS, "-") !== handle;
}

/**
 * `postgres`'s `PostgresError` isn't re-exported from its ESM entry point
 * (only its CJS build carries it), so this checks shape rather than
 * `instanceof` — the wire-protocol error code for a unique-violation, which
 * is what `principals_org_handle_idx` raises for a repeated handle. Drizzle
 * wraps the driver's error in its own `DrizzleQueryError`, with the original
 * on `.cause`, so both layers are checked.
 */
function hasCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === code;
}

function isHandleTaken(err: unknown): boolean {
  if (hasCode(err, "23505")) return true;
  const cause = err instanceof Error ? err.cause : undefined;
  return hasCode(cause, "23505");
}

const createAgentBody = z.object({
  handle: z.string().min(1),
  displayName: z.string().min(1).optional(),
});

const assignBody = z.object({
  principalId: z.string(),
});

export const agentsAdminRouter = new Hono()
  /**
   * Mint a new agent principal.
   *
   * 201 with the created principal — the id is the whole point of the call,
   * since nothing else in the fleet can predict a `prn_` id in advance.
   */
  .post("/agents", zValidator("json", createAgentBody), async (c) => {
    const { handle, displayName } = c.req.valid("json");

    if (wouldBeMangled(handle)) {
      return c.json(
        { error: "handle would be altered when built into a Matrix address; choose one clean() leaves unchanged" },
        400
      );
    }

    let id: string;
    try {
      id = await createPrincipal({ kind: "agent", handle, displayName });
    } catch (err) {
      if (isHandleTaken(err)) {
        return c.json({ error: "handle already taken" }, 409);
      }
      throw err;
    }

    const principal = await principalById(id);
    log.info("agent principal created", { id, handle, by: c.get("user")?.id });
    return c.json(
      {
        id,
        kind: principal!.kind,
        handle,
        displayName: displayName ?? null,
        suspendedAt: principal!.suspendedAt,
      },
      201
    );
  })

  /**
   * Assign an agent to a station, which is what makes the station
   * dispatchable — an unoccupied station is a machine, not an agent.
   *
   * Refused for a suspended principal: a suspension that can still be handed
   * a station is a suspension that does not suspend.
   *
   * **Occupancy is exclusive — a principal runs in one station at a time.**
   * Fix-round ruling: nothing had ever decided this, so the code assumed
   * both answers at once — `stations.principal_id` carried no constraint
   * against a principal appearing twice, while `matrix_rooms_principal_idx`
   * only ever allowed it one room. Assigning an already-placed principal is
   * therefore a MOVE: its previous station (if any) is vacated in the same
   * transaction this writes the new one, and `stations_principal_id_idx` (a
   * partial unique index, not-null only) is what makes a principal in two
   * stations impossible at the schema itself rather than merely unusual.
   */
  .put("/stations/:stationId/agent", zValidator("json", assignBody), async (c) => {
    const stationId = c.req.param("stationId");
    const { principalId } = c.req.valid("json");

    const [station] = await db
      .select({ id: stations.id, principalId: stations.principalId })
      .from(stations)
      .where(eq(stations.id, stationId));
    if (!station) return c.json({ error: "no such station" }, 404);

    const principal = await principalById(principalId);
    if (!principal) return c.json({ error: "no such principal" }, 404);
    if (principal.suspendedAt) {
      return c.json({ error: "principal is suspended" }, 403);
    }

    // Read BEFORE the transaction overwrites it — fix round 2: assigning a
    // NEW principal to a station that already holds a DIFFERENT one evicts
    // that one silently otherwise. It is a legitimate operation (Ruling 6's
    // "assign a different agent" reassigns exactly this way), but a silent
    // one is how an operator loses track of an agent without ever seeing it
    // happen — logged below once the eviction actually lands.
    const evictedPrincipalId =
      station.principalId && station.principalId !== principalId ? station.principalId : null;

    // Read for the log line below, not for the write: the `UPDATE` picks its
    // own row atomically. Held so that if the bind lands on one of several
    // candidates, the choice is visible in the record — see
    // `unboundRoomsForStation`.
    const candidates = await unboundRoomsForStation(stationId);

    await db.transaction(async (tx) => {
      // Vacate wherever this principal already is — including this same
      // station, harmlessly — BEFORE placing it here. Done first and in the
      // same transaction so a crash between the two steps cannot leave the
      // principal occupying two stations, which `stations_principal_id_idx`
      // would refuse anyway; doing it in this order is what makes that
      // index's own errno the exception rather than the ordinary path.
      await tx
        .update(stations)
        .set({ principalId: null })
        .where(and(eq(stations.principalId, principalId), ne(stations.id, stationId)));

      await tx.update(stations).set({ principalId }).where(eq(stations.id, stationId));

      // `matrix_rooms.principal_id`'s one writer — `charter →
      // decisions/2026-08-30-an-agent-is-a-principal.md`'s whole reason a
      // room's identity comes from a handle rather than a station. Binds this
      // station's own room to this principal EXACTLY ONCE: only when that room
      // exists, has no binding yet, and this principal has no room bound
      // anywhere else. Every later assignment — this principal moving to a
      // different station, or a different principal taking this one — leaves
      // the binding alone, which is what makes the room follow the agent
      // rather than the station: `gates.ts`'s `roomForCard` finds THIS
      // principal's room from wherever it is dispatched next, not a fresh room
      // its new station happens to have. Conditioned on `NOT EXISTS` rather
      // than checked-then-written so two assignments racing each other cannot
      // both decide the room is free and violate `matrix_rooms_principal_idx`.
      //
      // Targets exactly ONE unbound row via a `LIMIT 1` subquery, not a bare
      // `WHERE station_id = … AND principal_id IS NULL` — a station can carry
      // more than one room since fix round 1 (`matrix_rooms_station_idx` is
      // no longer unique), and a plain multi-row UPDATE binding the SAME
      // principal onto every unbound row at this station in one statement
      // would itself violate `matrix_rooms_principal_idx` the moment more
      // than one existed — a real, reachable crash a fix-round-2 test found,
      // not a hypothetical one.
      //
      // WHICH one is decided by the rule in `matrix-as/station-room.ts`'s
      // `unboundRoomsForStation`: oldest `created_at`, tie-broken by
      // `room_id`. Written out here as an inline `ORDER BY` rather than read
      // through that function because this must stay ONE atomic statement —
      // a select-then-update would reopen the race the `NOT EXISTS` clause
      // exists to close. Until the whole-branch review this was an unordered
      // `LIMIT 1`: the live writer guessed in exactly the state migration
      // `0062` was declining to guess in, and could hand the agent a
      // departed occupant's leftover room instead of the station's own.
      await tx.execute(sql`
        UPDATE matrix_rooms
        SET principal_id = ${principalId}
        WHERE room_id = (
          SELECT room_id FROM matrix_rooms
          WHERE station_id = ${stationId} AND principal_id IS NULL
          ORDER BY created_at ASC, room_id ASC
          LIMIT 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM matrix_rooms already_bound WHERE already_bound.principal_id = ${principalId}
        )
      `);
    });

    if (evictedPrincipalId) {
      log.warn("assigning a new occupant evicted the station's previous one", {
        stationId,
        principalId,
        evictedPrincipalId,
        by: c.get("user")?.id,
      });
    }

    // Did the bind actually have to choose? Only worth a line when more than
    // one unbound room was available AND one of them is now this principal's
    // — a station with several unbound rooms whose occupant already held a
    // room elsewhere made no choice at all, and saying it did would be the
    // same sort of untrue record this branch has spent five rounds removing.
    if (candidates.length > 1) {
      const [bound] = await db
        .select({ roomId: matrixRooms.roomId })
        .from(matrixRooms)
        .where(eq(matrixRooms.principalId, principalId));
      if (bound && candidates.some((r) => r.roomId === bound.roomId)) {
        log.warn("station carried more than one unbound room; bound the oldest", {
          stationId,
          principalId,
          chose: bound.roomId,
          among: candidates.map((r) => r.roomId),
        });
      }
    }

    log.info("station assigned", { stationId, principalId, by: c.get("user")?.id });

    // **Provisioning runs here, and its failure does NOT undo the
    // assignment.** The whole-branch review's Critical was that it did not
    // run at all: the console reaches no other trigger, and a bridge-mode
    // station with no occupant is exactly the case `provision.ts` returns
    // early from — so adoption made no room, assignment made no room, and
    // the first anyone heard of it was a gate that resolved to nowhere.
    //
    // Why the assignment stands when the homeserver does not:
    //
    //  - Occupancy is a fact in the organization plane; a Matrix room is
    //    that plane's shadow on a system this hub does not own. Letting an
    //    unreachable homeserver veto who occupies a station inverts which of
    //    the two is authoritative.
    //  - A rollback here could not be partial. Assignment is a MOVE — it has
    //    already vacated wherever this principal was — so undoing it would
    //    have to restore an occupancy the operator deliberately ended, or
    //    leave the principal nowhere. Both are worse lies than a missing
    //    room.
    //  - `provisionStation` is idempotent and re-runs at boot and on every
    //    later trigger, so a recorded assignment with no room self-heals. A
    //    rolled-back assignment heals nothing, and the operator's retry is
    //    the same call either way.
    //
    // What it must not do is read as success. The outcome is logged at error
    // level by `provisionStationNow` and returned in the body, so the console
    // can say "assigned, but it has no room yet" instead of nothing at all.
    const room = await provisionStationNow(stationId);

    return c.json({ stationId, principalId, room });
  })

  /**
   * Unassign — the station goes back to being nobody's, dispatchable by
   * nobody, exactly the state an unoccupied station is already in.
   */
  .delete("/stations/:stationId/agent", async (c) => {
    const stationId = c.req.param("stationId");

    const [station] = await db.select({ id: stations.id }).from(stations).where(eq(stations.id, stationId));
    if (!station) return c.json({ error: "no such station" }, 404);

    await db.update(stations).set({ principalId: null }).where(eq(stations.id, stationId));
    log.info("station unassigned", { stationId, by: c.get("user")?.id });
    return c.json({ stationId, principalId: null });
  });
