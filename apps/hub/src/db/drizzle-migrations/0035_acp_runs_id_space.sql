-- acp_runs.id moves out of kaambaan's `run_` id space and into AgentPod's own,
-- `attempt_`. There is NO data migration: no statement inserting into acp_runs
-- exists at any commit in this repository, the table has never had a writer, and
-- production holds zero rows — which is precisely why this was free to do now and
-- would not have been once the bridge wrote its first run.
--
-- The constraints therefore validate against an empty table everywhere. They are
-- the point of the change: the old prefix was governed by a schema comment that
-- sat six lines above another comment promising the opposite.
ALTER TABLE "acp_runs" ADD CONSTRAINT "acp_runs_id_is_agentpod_attempt" CHECK ("acp_runs"."id" LIKE 'attempt\_%');--> statement-breakpoint
ALTER TABLE "acp_runs" ADD CONSTRAINT "acp_runs_external_is_not_agentpod" CHECK ("acp_runs"."external_run_id" IS NULL OR "acp_runs"."external_run_id" NOT LIKE 'attempt\_%');--> statement-breakpoint
ALTER TABLE "acp_runs" ADD CONSTRAINT "acp_runs_external_pair" CHECK (("acp_runs"."external_run_id" IS NULL) = ("acp_runs"."external_source" IS NULL));