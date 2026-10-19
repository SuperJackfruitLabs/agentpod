ALTER TABLE "stations" ADD COLUMN "occupancy_epoch" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "acp_sessions" ADD COLUMN "execution_authority" jsonb;
--> statement-breakpoint
CREATE FUNCTION agentpod_station_occupancy_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.principal_id IS DISTINCT FROM OLD.principal_id OR NEW.node_id IS DISTINCT FROM OLD.node_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.station_key IS DISTINCT FROM OLD.station_key OR NEW.workspace_path IS DISTINCT FROM OLD.workspace_path THEN
    NEW.occupancy_epoch := OLD.occupancy_epoch + 1;
  ELSE
    NEW.occupancy_epoch := OLD.occupancy_epoch;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stations_occupancy_epoch BEFORE UPDATE ON stations FOR EACH ROW EXECUTE FUNCTION agentpod_station_occupancy_epoch();
--> statement-breakpoint
CREATE UNIQUE INDEX "acp_salaam_station_execution" ON "acp_sessions" USING btree (("execution_authority" #>> '{binding,station_id}')) WHERE "acp_sessions"."execution_authority"->>'state' IN ('active','revocation_pending');--> statement-breakpoint
CREATE UNIQUE INDEX "acp_salaam_principal_execution" ON "acp_sessions" USING btree (("execution_authority" #>> '{binding,organization_id}'),("execution_authority" #>> '{binding,principal_id}')) WHERE "acp_sessions"."execution_authority"->>'state' IN ('active','revocation_pending');--> statement-breakpoint
CREATE UNIQUE INDEX "acp_salaam_work_run_epoch" ON "acp_sessions" USING btree (("execution_authority" #>> '{binding,organization_id}'),("execution_authority" #>> '{binding,run,source}'),("execution_authority" #>> '{binding,run,id}'),("execution_authority" #>> '{binding,run,epoch}')) WHERE "acp_sessions"."execution_authority" IS NOT NULL;
