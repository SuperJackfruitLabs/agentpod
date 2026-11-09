-- A gate may need more than one approver (charter, 2026-11-09).
--
-- The quorum a gate was projected with, or last reported with by the board — `required`, `from`
-- and the approvals recorded so far, snake_case as gate.v2 carries it — so an approving answer
-- short of the quorum does not post "Approved — the board has it". Null on every gate that passes
-- on one approval.
ALTER TABLE "matrix_gate_events" ADD COLUMN IF NOT EXISTS "approval_quorum" jsonb;--> statement-breakpoint
-- Each recorded approval this hub posted progress for, once per gate and person: claimed before it
-- is sent, so a redelivered `gate.approval_recorded` posts nothing twice.
CREATE TABLE IF NOT EXISTS "matrix_gate_approvals" (
  "gate_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "approved_at" text NOT NULL,
  "event_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "matrix_gate_approvals_pk" PRIMARY KEY ("gate_id", "principal_id"),
  CONSTRAINT "matrix_gate_approvals_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_gate_approvals_tenant_id_idx"
  ON "matrix_gate_approvals" ("tenant_id");
