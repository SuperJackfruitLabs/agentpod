CREATE TABLE "salaam_work_reports" (
 "work_request_id" text PRIMARY KEY REFERENCES "salaam_work_owners"("request_id") ON DELETE RESTRICT,
 "request_id" text NOT NULL UNIQUE,
 "completion" jsonb NOT NULL,
 "handoff" jsonb NOT NULL,
 "handoff_digest" text NOT NULL,
 "state" text NOT NULL CHECK ("state" IN ('prepared','reported')),
 "board_receipt" jsonb
);
