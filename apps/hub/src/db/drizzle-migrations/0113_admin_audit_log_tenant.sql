-- Workspace authority spec (2026-10-22): a workspace admin reads their own workspace's audit log,
-- so a row records the tenant the actor acted in. Every row written before this was written by a
-- hub operator acting in the bootstrap tenant (the only tenant a deployed hub has had), so that is
-- where they go. A hub operator still reads every row.
ALTER TABLE admin_audit_log ADD COLUMN tenant_id text;
--> statement-breakpoint
UPDATE admin_audit_log SET tenant_id = 'fleet_00000000000000000000' WHERE tenant_id IS NULL;
--> statement-breakpoint
ALTER TABLE admin_audit_log ALTER COLUMN tenant_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX admin_audit_log_tenant_id_idx ON admin_audit_log (tenant_id);
