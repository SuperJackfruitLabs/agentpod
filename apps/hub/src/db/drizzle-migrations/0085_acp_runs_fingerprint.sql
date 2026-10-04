-- What executed an attempt, recorded once when it opens (charter
-- decisions/2026-09-29-evidence-joins-on-the-work-run.md, decision 3; superwitness contract C3).
--
-- Two columns, not five: the digest is what an evaluation groups by, so it is a plain indexed
-- column; the readable fields stay next to it as one jsonb object, so adding a field later is a
-- contract change rather than a migration.
--
-- Nullable on purpose. Every row written before this shipped has no fingerprint, and NULL is the
-- honest record of that: the evidence route reads it as "unknown", never as a fingerprint
-- reconstructed after the fact. Purely additive; rollback is two DROP COLUMNs.
ALTER TABLE "acp_runs" ADD COLUMN "fingerprint_digest" text;--> statement-breakpoint
ALTER TABLE "acp_runs" ADD COLUMN "fingerprint" jsonb;--> statement-breakpoint
ALTER TABLE "acp_runs" ADD CONSTRAINT "acp_runs_fingerprint_pair" CHECK (("acp_runs"."fingerprint_digest" IS NULL) = ("acp_runs"."fingerprint" IS NULL));--> statement-breakpoint
ALTER TABLE "acp_runs" ADD CONSTRAINT "acp_runs_fingerprint_digest_shape" CHECK ("acp_runs"."fingerprint_digest" IS NULL OR "acp_runs"."fingerprint_digest" ~ '^sha256:[0-9a-f]{64}$');--> statement-breakpoint
CREATE INDEX "acp_runs_fingerprint_idx" ON "acp_runs" USING btree ("fingerprint_digest");
