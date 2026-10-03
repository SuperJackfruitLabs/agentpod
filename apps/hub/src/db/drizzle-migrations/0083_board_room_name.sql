-- What a board's room is CALLED, as last set by this service.
--
-- Stored so "has the name changed" is a local comparison rather than a homeserver
-- read on every gate. NULL means never set, which is every room that existed when
-- this shipped — each of them named after the product rather than its board — and
-- is what makes the backfill happen on the room's next gate instead of in a
-- migration.
ALTER TABLE "matrix_board_rooms" ADD COLUMN IF NOT EXISTS "name" text;
