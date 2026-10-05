CREATE TABLE "applied_harness_config" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"station_id" text NOT NULL,
	"setting_id" text NOT NULL,
	"value" jsonb NOT NULL,
	"gateway_pid" integer,
	"gateway_uptime_sec" integer,
	"applied_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "applied_cfg_station_setting" UNIQUE("tenant_id","station_id","setting_id")
);
--> statement-breakpoint
CREATE TABLE "harness_config_opt_out" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"station_key" text NOT NULL,
	"setting_id" text NOT NULL,
	"reason" text,
	"opted_out_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cfg_opt_out_key_setting" UNIQUE("tenant_id","station_key","setting_id")
);
--> statement-breakpoint
ALTER TABLE "applied_harness_config" ADD CONSTRAINT "applied_harness_config_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_config_opt_out" ADD CONSTRAINT "harness_config_opt_out_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;