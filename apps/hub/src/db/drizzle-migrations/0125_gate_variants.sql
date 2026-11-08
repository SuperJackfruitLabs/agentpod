-- A gate may offer a choice of variants (charter, 2026-11-09).
--
-- The variants a gate was projected with — each one's id, label, subject id and digest, whether its
-- own preview reached the room in full, and its expiry — so an approving decision.v2 is judged
-- against exactly what the room was shown. Null on every gate that is not a choice.
ALTER TABLE "matrix_gate_events" ADD COLUMN IF NOT EXISTS "approval_variants" jsonb;
