-- P3 plan, Task 17. After P4's cutover + 7 days only (design §8: "The hub's auth tables stay,
-- read-only, for 7 days, then are dropped"). Merging this ends the rollback window: the rewrite
-- script's --reverse needs "user" and principal_identities, and they are gone after this.
--
-- Idempotent: the cutover script (scripts/rewrite-user-ids.ts) already dropped the 18 product →
-- "user" foreign keys in production, so every DROP CONSTRAINT is IF EXISTS. No DROP TABLE uses
-- CASCADE: a foreign key into a dropped table that this file does not name must fail the
-- migration loudly, not vanish silently.
--
-- GUARD (security review finding 1): refuse to drop anything unless the user-id rewrite ran.
-- Dropping "user" and principal_identities ends the rollback window; doing it on a database whose
-- product columns still hold Better Auth ids would leave every fleet owned by ids nothing can map
-- any more. Two checks, and the RAISE aborts the whole migration run (drizzle applies pending
-- migrations in one transaction), so nothing below is dropped:
--   1. every one of the 23 rewritten columns (USER_ID_COLUMNS in scripts/rewrite-user-ids.ts, as of
--      its deletion) holds only prn_ ids — except a value the rewrite itself recorded writing
--      (user_id_rewrites.new_value: what forward applied, --map pairs included);
--   2. legacy_user_principals is not empty while principal_identities holds better-auth rows —
--      forward seeds it in the same transaction, so empty-with-identities means it never ran.
-- An empty database (a fresh install, CI) passes both: no rows, no identities.
DO $$
DECLARE
  col record;
  bad bigint;
  sample text;
BEGIN
  FOR col IN SELECT * FROM (VALUES
    ('admin_audit_log', 'admin_user_id'), ('admin_audit_log', 'target_user_id'),
    ('agent_tasks', 'user_id'), ('bridge_agents', 'created_by'), ('cloudflare_sandboxes', 'user_id'),
    ('enrollment_tokens', 'user_id'), ('matrix_missions', 'user_id'), ('nodes', 'user_id'),
    ('provisioned_runtimes', 'user_id'), ('skill_artifacts', 'user_id'), ('skill_operations', 'user_id'),
    ('skill_release_cohorts', 'user_id'), ('station_setups', 'user_id'), ('station_speech', 'updated_by'),
    ('station_transcription', 'updated_by'), ('stations', 'user_id'), ('system_settings', 'updated_by'),
    ('trusted_skill_releases', 'user_id'), ('acp_sessions', 'user_id'), ('station_audit', 'user_id'),
    ('trusted_skill_release_artifacts', 'user_id'), ('declared_harness_config', 'declared_by'),
    ('harness_config_opt_out', 'opted_out_by')
  ) AS t(tbl, col)
  LOOP
    EXECUTE format(
      'SELECT count(*), min(%2$I) FROM %1$I t WHERE %2$I IS NOT NULL AND %2$I !~ ''^prn_[0-9a-f]{20}$'' '
      'AND NOT EXISTS (SELECT 1 FROM user_id_rewrites r WHERE r.new_value = t.%2$I)',
      col.tbl, col.col) INTO bad, sample;
    IF bad > 0 THEN
      RAISE EXCEPTION 'refusing to drop the hub auth tables: %.% still holds % non-prn_ value(s) (e.g. %); run scripts/rewrite-user-ids.ts --apply first', col.tbl, col.col, bad, sample;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM legacy_user_principals)
     AND EXISTS (SELECT 1 FROM principal_identities WHERE system = 'better-auth') THEN
    RAISE EXCEPTION 'refusing to drop the hub auth tables: legacy_user_principals is empty while principal_identities holds Better Auth identities; the user-id rewrite has not run';
  END IF;
END $$;--> statement-breakpoint
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
