CREATE TABLE execution_exports (
 request_id text PRIMARY KEY,
 tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
 principal_id text NOT NULL,
 manifest jsonb NOT NULL,
 digest text NOT NULL,
 status text NOT NULL CHECK(status IN ('prepared','declaring','uploading','commit_unconfirmed','committed','integrity_failed')),
 upload_id text,
 receipt jsonb
);
