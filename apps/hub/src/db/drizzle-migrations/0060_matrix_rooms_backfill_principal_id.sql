-- Custom SQL migration file, put your code below! --

-- `matrix_rooms.principal_id` gains its first writer alongside this
-- migration — `routes/agents-admin.ts`'s assign endpoint binds it the first
-- time a station's own room finds an occupant with no room of its own yet.
-- This is the one-time half of that: every room that already exists, from
-- before there was a writer, is exactly as "bound" as its station's current
-- occupant already made it in practice — that occupant IS who the room has
-- been speaking as all along, this simply makes the column agree.
--
-- `WHERE r.principal_id IS NULL` makes this safe to run more than once.
--
-- Fix-round correction: the column's own unique index
-- (`matrix_rooms_principal_idx`) does not merely "catch" two rooms ever
-- claiming the same principal — it makes this UPDATE raise 23505 and fail
-- the deploy outright, on a database where that had never been prevented.
-- Occupancy is exclusive as of this fix round
-- (`stations_principal_id_idx`), but that constraint's own migration runs
-- AFTER this one in sequence, so it cannot be relied on to have already
-- ruled this out on every database this runs against. The
-- `NOT IN (SELECT ... GROUP BY ... HAVING COUNT(*) > 1)` clause below is
-- this migration's own defence: a principal occupying more than one station
-- at the moment this runs is skipped rather than backfilled, so the
-- migration finishes instead of failing partway through leaving some rooms
-- backfilled and others not. A skipped room is not silently wrong — its
-- `principal_id` simply stays null until the operator resolves the
-- double-occupancy and the write path (`routes/agents-admin.ts`, now the
-- exclusive one) binds it going forward.
UPDATE "matrix_rooms" AS r
SET "principal_id" = s."principal_id"
FROM "stations" AS s
WHERE s."id" = r."station_id"
  AND s."principal_id" IS NOT NULL
  AND r."principal_id" IS NULL
  AND s."principal_id" NOT IN (
    SELECT "principal_id" FROM "stations"
    WHERE "principal_id" IS NOT NULL
    GROUP BY "principal_id"
    HAVING COUNT(*) > 1
  );
