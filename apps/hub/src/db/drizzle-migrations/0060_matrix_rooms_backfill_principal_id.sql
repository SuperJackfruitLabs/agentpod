-- Custom SQL migration file, put your code below! --

-- `matrix_rooms.principal_id` gains its first writer alongside this
-- migration — `routes/agents-admin.ts`'s assign endpoint binds it the first
-- time a station's own room finds an occupant with no room of its own yet.
-- This is the one-time half of that: every room that already exists, from
-- before there was a writer, is exactly as "bound" as its station's current
-- occupant already made it in practice — that occupant IS who the room has
-- been speaking as all along, this simply makes the column agree.
--
-- `WHERE r.principal_id IS NULL` makes this safe to run more than once, and
-- the column's own unique index (`matrix_rooms_principal_idx`) is what would
-- catch two rooms ever claiming the same principal — a state this backfill
-- does not expect to find, and does not need to guard against by hand.
UPDATE "matrix_rooms" AS r
SET "principal_id" = s."principal_id"
FROM "stations" AS s
WHERE s."id" = r."station_id"
  AND s."principal_id" IS NOT NULL
  AND r."principal_id" IS NULL;
