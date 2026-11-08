-- Unanswered decisions remind, then escalate (charter, 2026-11-08).
--
-- A reminder or escalation posted in reply to a waiting card, once per decision and notice: claimed
-- before it is sent, so a redelivered push posts nothing. What it said is kept so an escalation can
-- be posted again for an admin who joins the room after it.
CREATE TABLE IF NOT EXISTS "matrix_decision_notices" (
  "board_id" text NOT NULL,
  "decision_kind" text NOT NULL,
  "decision_id" text NOT NULL,
  "notice" text NOT NULL,
  "tenant_id" text NOT NULL,
  "card_id" text NOT NULL,
  "card_title" text NOT NULL,
  "stage_key" text NOT NULL,
  "stage_name" text,
  "room_id" text NOT NULL,
  "card_event_id" text NOT NULL,
  "waiting_since" text NOT NULL,
  "noticed_at" text NOT NULL,
  "event_id" text,
  "card_moved_at" timestamp,
  "reposted_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "matrix_decision_notices_pk" PRIMARY KEY ("board_id", "decision_kind", "decision_id", "notice"),
  CONSTRAINT "matrix_decision_notices_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_decision_notices_tenant_id_idx"
  ON "matrix_decision_notices" ("tenant_id");--> statement-breakpoint
-- The workspace owners and admins an escalation invited into a board room, once per board and
-- person; somebody who leaves is not invited back by the next escalation.
CREATE TABLE IF NOT EXISTS "matrix_escalation_invites" (
  "board_id" text NOT NULL,
  "mxid" text NOT NULL,
  "tenant_id" text NOT NULL,
  "room_id" text NOT NULL,
  "invited_at" timestamp DEFAULT now() NOT NULL,
  "joined_at" timestamp,
  "reposted_at" timestamp,
  "repost_attempts" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "matrix_escalation_invites_pk" PRIMARY KEY ("board_id", "mxid"),
  CONSTRAINT "matrix_escalation_invites_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_escalation_invites_tenant_id_idx"
  ON "matrix_escalation_invites" ("tenant_id");--> statement-breakpoint
-- A board-dispatched permission's wait, durable (charter §8): set while a run is parked on a
-- person's answer, cleared when the wait ends. One still set after a restart is a wait the restart
-- cut short, and the run is ended as unanswered.
ALTER TABLE "bridge_dispatches" ADD COLUMN IF NOT EXISTS "permission_session_id" text;--> statement-breakpoint
ALTER TABLE "bridge_dispatches" ADD COLUMN IF NOT EXISTS "permission_request_seq" integer;--> statement-breakpoint
ALTER TABLE "bridge_dispatches" ADD COLUMN IF NOT EXISTS "permission_wait_until" timestamp;
