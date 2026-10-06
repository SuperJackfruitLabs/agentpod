-- P3 plan, Task 17. After P4's cutover + 7 days only (design §8: "The hub's auth tables stay,
-- read-only, for 7 days, then are dropped"). Merging this ends the rollback window: the rewrite
-- script's --reverse needs "user" and principal_identities, and they are gone after this.
--
-- Idempotent: the cutover script (scripts/rewrite-user-ids.ts) already dropped the 18 product →
-- "user" foreign keys in production, so every DROP CONSTRAINT is IF EXISTS. No DROP TABLE uses
-- CASCADE: a foreign key into a dropped table that this file does not name must fail the
-- migration loudly, not vanish silently.
--
-- The 18 product columns that held a Better Auth user id (P3 plan, "Hub user.id column inventory").
-- They keep their values (prn_ after the rewrite) as plain text.
ALTER TABLE "admin_audit_log" DROP CONSTRAINT IF EXISTS "admin_audit_log_admin_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "admin_audit_log" DROP CONSTRAINT IF EXISTS "admin_audit_log_target_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "agent_tasks" DROP CONSTRAINT IF EXISTS "agent_tasks_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "bridge_agents" DROP CONSTRAINT IF EXISTS "bridge_agents_created_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "cloudflare_sandboxes" DROP CONSTRAINT IF EXISTS "cloudflare_sandboxes_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "enrollment_tokens" DROP CONSTRAINT IF EXISTS "enrollment_tokens_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "matrix_missions" DROP CONSTRAINT IF EXISTS "matrix_missions_user_id_fkey";--> statement-breakpoint
ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "nodes_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "provisioned_runtimes" DROP CONSTRAINT IF EXISTS "provisioned_runtimes_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "skill_artifacts" DROP CONSTRAINT IF EXISTS "skill_artifacts_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "skill_operations" DROP CONSTRAINT IF EXISTS "skill_operations_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "skill_release_cohorts" DROP CONSTRAINT IF EXISTS "skill_release_cohorts_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "station_setups" DROP CONSTRAINT IF EXISTS "station_setups_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "station_speech" DROP CONSTRAINT IF EXISTS "station_speech_updated_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "station_transcription" DROP CONSTRAINT IF EXISTS "station_transcription_updated_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "stations" DROP CONSTRAINT IF EXISTS "stations_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "system_settings" DROP CONSTRAINT IF EXISTS "system_settings_updated_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "trusted_skill_releases" DROP CONSTRAINT IF EXISTS "trusted_skill_releases_user_id_user_id_fk";--> statement-breakpoint
-- Product columns that point into "principals". They already hold prn_ ids the plane issued, and
-- stay as plain text.
ALTER TABLE "stations" DROP CONSTRAINT IF EXISTS "stations_principal_id_principals_id_fk";--> statement-breakpoint
ALTER TABLE "matrix_rooms" DROP CONSTRAINT IF EXISTS "matrix_rooms_principal_id_principals_id_fk";--> statement-breakpoint
-- The hub's issuer: one-time codes, device and service credentials, its own signing key.
DROP TABLE IF EXISTS "oauth_codes";--> statement-breakpoint
DROP TABLE IF EXISTS "device_credentials";--> statement-breakpoint
DROP TABLE IF EXISTS "service_credentials";--> statement-breakpoint
DROP TABLE IF EXISTS "service_signing_keys";--> statement-breakpoint
-- The hub's principals and their organization (the plane owns both).
DROP TABLE IF EXISTS "principal_grants";--> statement-breakpoint
DROP TABLE IF EXISTS "principal_identities";--> statement-breakpoint
DROP TABLE IF EXISTS "principals";--> statement-breakpoint
DROP TABLE IF EXISTS "organizations";--> statement-breakpoint
-- Better Auth.
DROP TABLE IF EXISTS "session";--> statement-breakpoint
DROP TABLE IF EXISTS "account";--> statement-breakpoint
DROP TABLE IF EXISTS "verification";--> statement-breakpoint
DROP TABLE IF EXISTS "jwks";--> statement-breakpoint
DROP TABLE IF EXISTS "user";
