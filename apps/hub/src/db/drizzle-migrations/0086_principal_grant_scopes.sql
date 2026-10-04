-- Read permissions beyond the control pair, starting with `evidence:read` (superwitness contract C6;
-- charter decisions/2026-10-04-superwitness-owns-observability-and-evaluation.md, decision 3).
--
-- On the grant row rather than a new table: a principal has one grant, and "which row wins" is
-- not a question an authorization check should ever ask (see the table's own comment). JSON text,
-- like may_dispatch, because it travels into a claim. Existing rows get '[]' — no scope.
ALTER TABLE "principal_grants" ADD COLUMN "scopes" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "principal_grants" ADD CONSTRAINT "principal_grants_scopes_is_array" CHECK ("principal_grants"."scopes" LIKE '[%]');
