-- Fix round 2 on Task 5. The unique index below enforces "occupancy is
-- exclusive" going forward, but creating it against data that already
-- violates it raises 23505 and kills the deploy — exactly the failure
-- `0060`'s own backfill was hardened to skip past, one migration earlier.
-- Skipping there without deduping here just relocates the failure rather
-- than removing it.
--
-- Deterministic, not "first row Postgres happens to return": for any
-- principal already on more than one station, the station it adopted MOST
-- RECENTLY keeps it, and every other one is cleared. `id DESC` breaks a tie
-- on identical `adopted_at` timestamps (two stations adopted in the same
-- transaction, mainly) so this is reproducible rather than order-dependent.
UPDATE "stations" AS s
SET "principal_id" = NULL
WHERE s."principal_id" IS NOT NULL
  AND s."id" <> (
    SELECT s2."id" FROM "stations" AS s2
    WHERE s2."principal_id" = s."principal_id"
    ORDER BY s2."adopted_at" DESC, s2."id" DESC
    LIMIT 1
  );
--> statement-breakpoint
DROP INDEX "matrix_rooms_station_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "stations_principal_id_idx" ON "stations" USING btree ("principal_id") WHERE "stations"."principal_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "matrix_rooms_station_idx" ON "matrix_rooms" USING btree ("station_id");
