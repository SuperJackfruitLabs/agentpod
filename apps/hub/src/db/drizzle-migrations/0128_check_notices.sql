-- A gate may be decided by checks (charter, 2026-11-09).
--
-- Each `check.failed` and `check.overridden` this hub said in a board's room, once per check set's
-- arrival, notice and check: claimed before it is sent and given back when the send fails, so a
-- redelivered push posts nothing twice, the board's retry of a failed one posts it, and the same
-- check failing on the card's next arrival is said again (`check-notices.ts`).
CREATE TABLE IF NOT EXISTS "matrix_check_notices" (
  "board_id" text NOT NULL,
  "card_id" text NOT NULL,
  "arrival_id" text NOT NULL,
  "notice" text NOT NULL,
  "check_name" text NOT NULL,
  "tenant_id" text NOT NULL,
  "room_id" text NOT NULL,
  "event_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "matrix_check_notices_pk" PRIMARY KEY ("board_id", "card_id", "arrival_id", "notice", "check_name"),
  CONSTRAINT "matrix_check_notices_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_check_notices_tenant_id_idx"
  ON "matrix_check_notices" ("tenant_id");--> statement-breakpoint
-- The checks.waiting card an escalation of overdue checks posted, once per check set (the board's
-- arrival id): what an override from chat must reference, and what an admin who joins later gets
-- posted again. Closed when a failed check sends the card back.
CREATE TABLE IF NOT EXISTS "matrix_checks_waiting" (
  "board_id" text NOT NULL,
  "decision_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "card_id" text NOT NULL,
  "card_title" text NOT NULL,
  "stage_key" text NOT NULL,
  "room_id" text NOT NULL,
  "event_id" text,
  "closed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "matrix_checks_waiting_pk" PRIMARY KEY ("board_id", "decision_id"),
  CONSTRAINT "matrix_checks_waiting_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_checks_waiting_tenant_id_idx"
  ON "matrix_checks_waiting" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_checks_waiting_event_id_idx"
  ON "matrix_checks_waiting" ("event_id");--> statement-breakpoint
-- A reminder of overdue checks has no card to reply to (none is posted before an escalation), so
-- a notice's card event may be absent.
ALTER TABLE "matrix_decision_notices" ALTER COLUMN "card_event_id" DROP NOT NULL;
