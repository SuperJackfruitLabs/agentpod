-- kaambaan was renamed to superpipeline (charter, 2026-09-16).
--
-- `principal_identities.system` names which plane knows a principal, and a CHECK
-- constraint whitelists the legal values. The old name is in that whitelist, so
-- renaming it in the schema source alone leaves the running database rejecting
-- every write the new code makes:
--
--   new row for relation "principal_identities" violates check constraint
--   "principal_identities_system_known"
--
-- Earlier migrations are deliberately left naming `kaambaan`. They are a record
-- of what was applied on their date, drizzle tracks them by hash, and rewriting
-- an applied migration changes nothing in the database it already ran against.
-- This is the forward fix instead.

-- Rows first, then the constraint. The other order would fail: the new
-- constraint would reject the rows that still carry the old value.
UPDATE "principal_identities" SET "system" = 'superpipeline' WHERE "system" = 'kaambaan';

ALTER TABLE "principal_identities" DROP CONSTRAINT "principal_identities_system_known";--> statement-breakpoint
ALTER TABLE "principal_identities" ADD CONSTRAINT "principal_identities_system_known" CHECK ("principal_identities"."system" IN ('better-auth', 'matrix', 'superpipeline', 'agentpod', 'org-plane'));
