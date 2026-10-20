CREATE TABLE "salaam_work_owners" (
  "external_source" text NOT NULL,
  "external_run_id" text NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE RESTRICT,
  "session_id" text NOT NULL UNIQUE REFERENCES "acp_sessions"("id") ON DELETE RESTRICT,
  "request_id" text NOT NULL UNIQUE,
  "payload" jsonb NOT NULL,
  "receipt" jsonb,
  PRIMARY KEY ("external_source", "external_run_id"),
  FOREIGN KEY ("external_source", "external_run_id") REFERENCES "bridge_dispatches"("external_source", "external_run_id") ON DELETE RESTRICT,
  CHECK ("external_source" = 'superpipeline'),
  CHECK (("payload"->'admission'->>'request_id' = "request_id") IS TRUE),
  CHECK (("payload"->'admission'->'binding'->'run'->>'id' = "external_run_id") IS TRUE),
  CHECK (("payload"->'admission'->'binding'->>'hub_session_id' = "session_id") IS TRUE)
);
