-- gate.v2 (charter: decisions/2026-11-07-gate-v2-is-the-decision-envelope.md): a decision.v2 is
-- checked against the options THIS gate offered, and an answer to a subject-bound gate must carry
-- the subject binding, and an approving answer is refused when the subject's preview was
-- not shown in full. All of it is recorded when the gate is projected. Null for older gates.
ALTER TABLE "matrix_gate_events" ADD COLUMN IF NOT EXISTS "options" jsonb;--> statement-breakpoint
ALTER TABLE "matrix_gate_events" ADD COLUMN IF NOT EXISTS "approval_subject_id" text;--> statement-breakpoint
ALTER TABLE "matrix_gate_events" ADD COLUMN IF NOT EXISTS "approval_subject_digest" text;--> statement-breakpoint
ALTER TABLE "matrix_gate_events" ADD COLUMN IF NOT EXISTS "approval_subject_preview_complete" boolean;
