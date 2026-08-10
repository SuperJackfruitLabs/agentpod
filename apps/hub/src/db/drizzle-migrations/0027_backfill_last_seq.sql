-- Custom SQL migration file, put your code below! -----
-- Backfill last_seq for acp_sessions rows created before slice 4c added the
-- column (they default to 0), so the history dialog stops reporting
-- "no events" for sessions that have a real transcript.
UPDATE "acp_sessions"
SET "last_seq" = (
  SELECT COALESCE(MAX("seq"), 0)
  FROM "acp_events" e
  WHERE e."session_id" = "acp_sessions"."id"
)
WHERE "last_seq" = 0;