-- Strict decisions and harness permissions bind their subject (charter, 2026-11-07).
--
-- A question with a subject (a strict decision, or a poster-bound harness permission on a board):
-- the subject's binding as its question.v2 carried it, so a question.answer.v2 is judged against
-- the version the person saw — a binding that does not match, an approval when the preview was
-- incomplete, and an answer after expiry are refused here before the board judges them again.
-- Null on a question with no subject, and on questions posted before this.
ALTER TABLE "matrix_elicitation_events" ADD COLUMN IF NOT EXISTS "approval_subject_id" text;--> statement-breakpoint
ALTER TABLE "matrix_elicitation_events" ADD COLUMN IF NOT EXISTS "approval_subject_digest" text;--> statement-breakpoint
ALTER TABLE "matrix_elicitation_events" ADD COLUMN IF NOT EXISTS "approval_subject_preview_complete" boolean;--> statement-breakpoint
ALTER TABLE "matrix_elicitation_events" ADD COLUMN IF NOT EXISTS "approval_subject_expires_at" timestamp;--> statement-breakpoint
-- permission.v2: a harness permission request projected into a station room, and its binding.
-- Durable, where the room's pending request used to live only in memory: an answer is judged
-- against the digest, the options and the expiry recorded here, a late or stale answer is refused
-- (never passed to the agent as a prompt), and who answered is kept. One row per request,
-- `<session_id>:<request_seq>`.
CREATE TABLE IF NOT EXISTS "matrix_permission_requests" (
  "request_id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "room_id" text NOT NULL,
  "session_id" text NOT NULL,
  "request_seq" integer NOT NULL,
  "event_id" text,
  "subject_digest" text NOT NULL,
  "preview_complete" boolean NOT NULL,
  "options" jsonb NOT NULL,
  "expires_at" timestamp NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "option_id" text,
  "answered_by_principal" text,
  "answered_by_mxid" text,
  "answered_via" text,
  "closed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "matrix_permission_requests_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_permission_requests_tenant_id_idx"
  ON "matrix_permission_requests" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_permission_requests_room_idx"
  ON "matrix_permission_requests" ("room_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_permission_requests_pending_idx"
  ON "matrix_permission_requests" ("status", "expires_at");
