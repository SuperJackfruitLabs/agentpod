-- Encrypted room events that arrived before their key wait here, not in memory, so a hub restart
-- no longer drops them (a gate approved from chat across a restart never reached the board).
CREATE TABLE IF NOT EXISTS "matrix_pending_decrypts" (
  "event_id" text PRIMARY KEY NOT NULL,
  "room_id" text NOT NULL,
  "event" jsonb NOT NULL,
  "first_seen_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_pending_decrypts_first_seen_at_idx"
  ON "matrix_pending_decrypts" ("first_seen_at");
