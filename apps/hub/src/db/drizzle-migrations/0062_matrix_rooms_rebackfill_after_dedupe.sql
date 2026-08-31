-- Custom SQL migration file, put your code below! --

-- Fix round 5 on Task 5. `0060`'s backfill deliberately SKIPS both rooms of
-- a principal that occupied more than one station at the moment it ran --
-- its `NOT IN (SELECT ... HAVING COUNT(*) > 1)` clause, added so the
-- migration could not raise 23505 against `matrix_rooms_principal_idx` and
-- fail the deploy partway through. `0061` then deduped exactly those
-- principals, clearing every station but the most recently adopted one --
-- and the survivor is RIGHTFULLY occupied. Nothing re-ran the backfill
-- afterwards, so that survivor's room sits at `principal_id IS NULL`
-- forever.
--
-- That was survivable only while `gates.ts`'s `roomAgentUser` fell back to
-- `stations.principal_id`, which answered such a room correctly by
-- accident. Fix round 4 removed that fallback -- rightly, because it also
-- answered rooms their station's occupant had never lived in, with the
-- wrong agent's name. Failing closed is only defensible if the rows that
-- legitimately deserve an answer are actually bound. This binds them.
--
-- **Not a verbatim re-run of `0060`.** By this point `0061`'s unique index
-- guarantees one station per principal, so `0060`'s skip clause has nothing
-- left to skip -- but two OTHER ways of violating
-- `matrix_rooms_principal_idx` have opened up since `0060` ran, both of
-- them reachable on the deployed box, and either would fail this deploy:
--
--  1. A principal that ALREADY holds a room. `matrix_rooms.principal_id`
--     has had a live writer since `routes/agents-admin.ts`'s bind-on-assign
--     shipped, and an agent that moved stations keeps its old room while
--     its new station may carry an unbound one. Binding that second room to
--     the same principal raises 23505. The `NOT EXISTS` clause below is the
--     same guard the assign endpoint already applies, for the same reason
--     -- and it is also correct on the merits: a room the station's
--     occupant demonstrably never lived in is not that occupant's room.
--
--  2. A station carrying MORE THAN ONE unbound room. `station_id` stopped
--     being unique in fix round 1 precisely so a departed occupant's room
--     could sit beside its successor's. A set-wide UPDATE would bind the
--     same principal onto every one of them in a single statement and raise
--     23505. The subquery below picks exactly ONE room per station, so the
--     statement can match at most one row per principal and the index has
--     nothing to refuse.
--
--     **This clause used to decline instead** -- `1 = (SELECT COUNT(*) ...)`,
--     on the reasoning that picking between siblings is guessing. The
--     whole-branch review pointed out that the LIVE writer
--     (`routes/agents-admin.ts`'s bind-on-assign) was picking anyway, with
--     an unordered `LIMIT 1`: same data, opposite policy, and the arbitrary
--     one was the one an operator actually hit. So the rule was decided
--     rather than avoided -- **oldest `created_at`, tie-broken by
--     `room_id`** -- and it is applied identically here, in that endpoint,
--     in `station-room.ts`'s `roomForStation`, and in
--     `roomAliasForStation`. Oldest, because the station's ORIGINAL room is
--     the one carrying the history this whole slice exists to preserve;
--     `room_id` breaks the tie because `created_at` is not unique and two
--     rooms provisioned in one batch can share it.
--
--     Declining was not the safer option it looked like. It left exactly
--     the rooms whose stations are rightfully occupied answering nothing,
--     which is what this file exists to stop.
--
-- Idempotent: every row it touches stops matching `r."principal_id" IS
-- NULL`, so a second run changes nothing.
UPDATE "matrix_rooms" AS r
SET "principal_id" = s."principal_id"
FROM "stations" AS s
WHERE s."id" = r."station_id"
  AND s."principal_id" IS NOT NULL
  AND r."principal_id" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "matrix_rooms" AS held
    WHERE held."principal_id" = s."principal_id"
  )
  AND r."room_id" = (
    SELECT sibling."room_id" FROM "matrix_rooms" AS sibling
    WHERE sibling."station_id" = s."id"
      AND sibling."principal_id" IS NULL
    ORDER BY sibling."created_at" ASC, sibling."room_id" ASC
    LIMIT 1
  );
