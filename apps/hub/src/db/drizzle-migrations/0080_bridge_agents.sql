CREATE TABLE IF NOT EXISTS "bridge_agents" (
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"board_id" text NOT NULL,
	"station_id" text NOT NULL,
	"mode" text DEFAULT 'full-auto' NOT NULL,
	"permission_wait_ms" integer,
	"max_concurrency" integer,
	"profile_key" text,
	"token_encrypted" text NOT NULL,
	"mcp_token_encrypted" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_agents_tenant_id_key_pk" PRIMARY KEY("tenant_id","key"),
	CONSTRAINT "bridge_agents_mode_check" CHECK ("bridge_agents"."mode" IN ('ask', 'accept-edits', 'full-auto')),
	CONSTRAINT "bridge_agents_wait_check" CHECK ("bridge_agents"."permission_wait_ms" IS NULL OR "bridge_agents"."permission_wait_ms" > 0),
	CONSTRAINT "bridge_agents_concurrency_check" CHECK ("bridge_agents"."max_concurrency" IS NULL OR "bridge_agents"."max_concurrency" > 0),
	CONSTRAINT "bridge_agents_board_grammar_check" CHECK ("bridge_agents"."board_id" ~ '^brd_[0-9a-f]{16}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stations_id_tenant_idx" ON "stations" USING btree ("id","tenant_id");--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "bridge_agents" ADD CONSTRAINT "bridge_agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "bridge_agents" ADD CONSTRAINT "bridge_agents_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "bridge_agents" ADD CONSTRAINT "bridge_agents_station_tenant_fk" FOREIGN KEY ("station_id","tenant_id") REFERENCES "public"."stations"("id","tenant_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bridge_agents_station_idx" ON "bridge_agents" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bridge_agents_board_idx" ON "bridge_agents" USING btree ("board_id");
