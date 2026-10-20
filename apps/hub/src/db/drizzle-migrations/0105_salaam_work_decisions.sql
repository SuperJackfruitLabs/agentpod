CREATE TABLE "salaam_work_decisions" (
 "request_id" text PRIMARY KEY,
 "work_request_id" text NOT NULL REFERENCES "salaam_work_owners"("request_id") ON DELETE RESTRICT,
 "decision" jsonb NOT NULL,
 "producer_receipt" jsonb,
 "answer" jsonb,
 "daemon_receipt" jsonb,
 CHECK (("decision"->>'request_id' = "request_id") IS TRUE),
 CHECK (("decision"->>'work_request_id' = "work_request_id") IS TRUE)
);
