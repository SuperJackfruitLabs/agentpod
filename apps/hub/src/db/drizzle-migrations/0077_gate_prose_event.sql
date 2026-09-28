-- A gate now also rides inside its prose message (`dev.superpipeline.gate`), so a
-- decision may reference that message instead of the legacy custom event.
-- (drizzle-kit also re-emitted 0076's station_git_identities DDL here because 0076
-- shipped without a snapshot; 0077_snapshot.json now carries that table, and the
-- DDL itself stays in 0076 where it already ran.)
ALTER TABLE "matrix_gate_events" ADD COLUMN IF NOT EXISTS "prose_event_id" text;
