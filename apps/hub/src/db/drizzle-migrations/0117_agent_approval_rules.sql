-- Approval scopes part 2: an agent's standing "Always allow" rules, set by a workspace owner or admin.
CREATE TABLE "agent_approval_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE restrict,
	"station_id" text NOT NULL REFERENCES "stations"("id") ON DELETE cascade,
	"principal_id" text NOT NULL,
	"scope" text NOT NULL CHECK ("scope" IN ('workspace-write')),
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	"revoked_by" text
);--> statement-breakpoint
CREATE INDEX "agent_approval_rules_station_idx" ON "agent_approval_rules" ("station_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_approval_rules_live_idx" ON "agent_approval_rules" ("station_id","principal_id","scope") WHERE "revoked_at" IS NULL;
