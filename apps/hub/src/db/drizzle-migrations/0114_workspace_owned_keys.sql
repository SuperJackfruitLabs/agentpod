-- Workspace authority spec (2026-10-22), W4: a station, a skill artifact and a trusted release
-- belong to the workspace; `user_id` records who created the row and is no longer who may use it.
-- Six composite foreign keys bound a child row's `user_id` to its parent's, so a second admin of
-- the same workspace could not write a setup receipt at a station another member adopted, install
-- another member's artifact, or pin, or roll out, another member's release: the database refused
-- what the routes now allow. Each key is re-pointed at (id, tenant_id), which keeps the part that
-- matters (a child can never name a parent in another tenant) and drops the part that does not.
-- No row changes; every existing row already satisfies the narrower key.
CREATE UNIQUE INDEX IF NOT EXISTS "skill_artifacts_id_tenant_idx" ON "skill_artifacts" USING btree ("id","tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trusted_skill_releases_id_tenant_idx" ON "trusted_skill_releases" USING btree ("id","tenant_id");
--> statement-breakpoint
ALTER TABLE "station_setups" DROP CONSTRAINT "station_setups_owner_fk";
--> statement-breakpoint
ALTER TABLE "station_setups" ADD CONSTRAINT "station_setups_station_tenant_fk" FOREIGN KEY ("station_id","tenant_id") REFERENCES "public"."stations"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_operations" DROP CONSTRAINT "skill_operations_station_owner_fk";
--> statement-breakpoint
ALTER TABLE "skill_operations" ADD CONSTRAINT "skill_operations_station_tenant_fk" FOREIGN KEY ("station_id","tenant_id") REFERENCES "public"."stations"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_operations" DROP CONSTRAINT "skill_operations_artifact_owner_fk";
--> statement-breakpoint
ALTER TABLE "skill_operations" ADD CONSTRAINT "skill_operations_artifact_tenant_fk" FOREIGN KEY ("artifact_id","tenant_id") REFERENCES "public"."skill_artifacts"("id","tenant_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trusted_skill_release_artifacts" DROP CONSTRAINT "trusted_skill_release_artifacts_release_owner_fk";
--> statement-breakpoint
ALTER TABLE "trusted_skill_release_artifacts" ADD CONSTRAINT "trusted_skill_release_artifacts_release_tenant_fk" FOREIGN KEY ("release_id","tenant_id") REFERENCES "public"."trusted_skill_releases"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trusted_skill_release_artifacts" DROP CONSTRAINT "trusted_skill_release_artifacts_artifact_owner_fk";
--> statement-breakpoint
ALTER TABLE "trusted_skill_release_artifacts" ADD CONSTRAINT "trusted_skill_release_artifacts_artifact_tenant_fk" FOREIGN KEY ("artifact_id","tenant_id") REFERENCES "public"."skill_artifacts"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_release_cohorts" DROP CONSTRAINT "skill_release_cohorts_release_owner_fk";
--> statement-breakpoint
ALTER TABLE "skill_release_cohorts" ADD CONSTRAINT "skill_release_cohorts_release_tenant_fk" FOREIGN KEY ("release_id","tenant_id") REFERENCES "public"."trusted_skill_releases"("id","tenant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Referenced by nothing now: each existed only as the target of a key above.
DROP INDEX IF EXISTS "stations_skill_owner_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "skill_artifacts_owner_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "trusted_skill_releases_owner_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "skill_release_cohorts_owner_id_idx";
