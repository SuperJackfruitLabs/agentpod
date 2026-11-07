-- The decision envelope covers questions and follow-ups (charter, 2026-11-07).
--
-- question.v2: a question.answer.v2 is checked against the options THIS question offered, as its
-- question.v2 carried them, and a free-text answer against the length it allowed. Both are
-- recorded when the question is posted. Null for older questions: a structured answer to one is
-- refused, and a typed reply is unaffected.
ALTER TABLE "matrix_elicitation_events" ADD COLUMN IF NOT EXISTS "options_v2" jsonb;--> statement-breakpoint
ALTER TABLE "matrix_elicitation_events" ADD COLUMN IF NOT EXISTS "free_text_max_length" integer;--> statement-breakpoint
-- delivery.v2: the follow-up a post approved for manual delivery owes — record its live link, or
-- switch it to automatic delivery. One per gate, claimed before it is sent like a gate
-- (`matrix_gate_events`), so push, redelivery and the sweep overlapping post it once. The answer
-- is checked against the options and the preview completeness recorded here;
-- `outcome_posted_at` claims the receipt so a repeated answer leaves one line.
CREATE TABLE IF NOT EXISTS "matrix_delivery_events" (
  "gate_id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "board_id" text NOT NULL,
  "card_id" text NOT NULL,
  "room_id" text NOT NULL,
  "event_id" text NOT NULL,
  "options" jsonb NOT NULL,
  "approval_subject_id" text,
  "approval_subject_digest" text,
  "approval_subject_preview_complete" boolean,
  "outcome_posted_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "matrix_delivery_events_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_delivery_events_tenant_id_idx"
  ON "matrix_delivery_events" ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "matrix_delivery_events_event_idx"
  ON "matrix_delivery_events" ("event_id");
