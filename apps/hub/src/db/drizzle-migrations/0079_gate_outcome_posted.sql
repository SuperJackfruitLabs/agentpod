-- A gate's receipt is posted once: this column is the claim that makes a repeated
-- decision leave one line in the room rather than two (agentpod#614).
ALTER TABLE "matrix_gate_events" ADD COLUMN IF NOT EXISTS "outcome_posted_at" timestamp;
