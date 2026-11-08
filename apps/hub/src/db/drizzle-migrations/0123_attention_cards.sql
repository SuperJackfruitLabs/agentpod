-- Waiting cards and broker approvals reach chat (charter, 2026-11-08).
--
-- attention.v2: a card parked for a person (repeated failure, blocked, not authorised) posted into
-- its board room, once per wait — claimed before it is sent like a gate (`matrix_gate_events`), so
-- push, redelivery and the sweep overlapping post it once. A card that parks again is a new wait
-- and a new row. The answer is checked against the options recorded here; `outcome_posted_at`
-- claims the receipt so a repeated answer, or the sweep racing one, leaves one.
CREATE TABLE IF NOT EXISTS "matrix_attention_events" (
  "board_id" text NOT NULL,
  "card_id" text NOT NULL,
  "wait_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "room_id" text NOT NULL,
  "event_id" text NOT NULL,
  "options" jsonb NOT NULL,
  "outcome_posted_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "matrix_attention_events_board_id_card_id_wait_id_pk" PRIMARY KEY ("board_id", "card_id", "wait_id"),
  CONSTRAINT "matrix_attention_events_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_attention_events_tenant_id_idx"
  ON "matrix_attention_events" ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "matrix_attention_events_event_idx"
  ON "matrix_attention_events" ("event_id");--> statement-breakpoint
-- A SuperToolkit approval request carried as a board-less question (charter §3-4): recorded so an
-- answer to it is judged as one — by a person only, never an unbound approval — and so a typed
-- reply meant for an agent's question in the same room is not taken as its answer.
ALTER TABLE "matrix_elicitation_events" ADD COLUMN IF NOT EXISTS "approval_request" boolean DEFAULT false NOT NULL;
