-- A question this hub posted into a board's room, and what it said about it.
--
-- The mirror of `matrix_gate_events`, and for the same reasons. The INSERT is the
-- projection rather than a record of one: `ON CONFLICT DO NOTHING` returning no row
-- means another delivery of the same question got here first, so this one stops
-- without posting. Recording after sending would post twice under a redelivery and
-- record once.
--
-- `outcome_posted_at` is the claim that stops a second receipt: an answer delivered
-- twice — a double tap, a re-sent appservice transaction — must leave one line in the
-- room rather than two that read as though the question were answered twice.
CREATE TABLE IF NOT EXISTS "matrix_elicitation_events" (
  "elicitation_id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "board_id" text NOT NULL,
  "card_id" text NOT NULL,
  "room_id" text NOT NULL,
  "event_id" text NOT NULL,
  -- The options the question was ASKED with, as `[{id,label}]`.
  --
  -- Stored rather than re-fetched because a typed reply is matched against them, and a
  -- question must be answered against the set it was asked with: an agent that asked
  -- again with different options would otherwise change the question out from under
  -- the person answering it. It is also what lets a reply be matched without a round
  -- trip to the board on every message in the room.
  "options_json" text DEFAULT '[]' NOT NULL,
  "outcome_posted_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "matrix_elicitation_events_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE restrict
);

CREATE INDEX IF NOT EXISTS "matrix_elicitation_events_tenant_id_idx"
  ON "matrix_elicitation_events" ("tenant_id");

-- A reply arrives holding the room and needing the question; the sweep goes the other
-- way. UNIQUE because two questions projected onto one event would make the first
-- unanswerable.
CREATE UNIQUE INDEX IF NOT EXISTS "matrix_elicitation_events_event_idx"
  ON "matrix_elicitation_events" ("event_id");

-- The inbound lookup: the question currently open in this room. A room holds at most
-- one unanswered question, because the board retires the previous one when an agent
-- asks again, so this is how a typed reply finds what it is answering.
CREATE INDEX IF NOT EXISTS "matrix_elicitation_events_room_idx"
  ON "matrix_elicitation_events" ("room_id");
