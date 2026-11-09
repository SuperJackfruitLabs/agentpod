-- An approval may wait for its release time (charter, 2026-11-09).
--
-- Each `decision.released` and `decision.pulled_back` this hub replied to the gate's card with, once
-- per gate and notice: claimed before it is sent and given back when the send fails, so a
-- redelivered push posts nothing twice and the board's retry of a failed one posts it.
CREATE TABLE IF NOT EXISTS "matrix_gate_hold_notices" (
  "gate_id" text NOT NULL,
  "notice" text NOT NULL,
  "tenant_id" text NOT NULL,
  "event_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "matrix_gate_hold_notices_pk" PRIMARY KEY ("gate_id", "notice"),
  CONSTRAINT "matrix_gate_hold_notices_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_gate_hold_notices_tenant_id_idx"
  ON "matrix_gate_hold_notices" ("tenant_id");
