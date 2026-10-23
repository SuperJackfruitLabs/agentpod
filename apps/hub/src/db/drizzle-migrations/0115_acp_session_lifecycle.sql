-- Salaam session lifecycle (2026-10-23): idle sessions end on their own, an ended session can be
-- resumed under a fresh execution authority, and a workspace admin can end another person's.
-- ended_cause says who ended a session when it was not its owner ("idle", "admin"). resumed_from
-- and resumed_as link a resume to the session it continues; resumed_as is set once (a resume
-- claims it with a conditional update), so one conversation never forks into two live branches.
ALTER TABLE "acp_sessions" ADD COLUMN IF NOT EXISTS "ended_cause" text;
--> statement-breakpoint
ALTER TABLE "acp_sessions" ADD COLUMN IF NOT EXISTS "resumed_from" text;
--> statement-breakpoint
ALTER TABLE "acp_sessions" ADD COLUMN IF NOT EXISTS "resumed_as" text;
