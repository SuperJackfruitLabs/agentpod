CREATE TABLE "declared_harness_config" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"setting_id" text NOT NULL,
	"station_id" text,
	"node_id" text,
	"value" jsonb NOT NULL,
	"declared_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "declared_harness_config" ADD CONSTRAINT "declared_harness_config_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "declared_cfg_station" ON "declared_harness_config" USING btree ("tenant_id","setting_id","station_id");--> statement-breakpoint
CREATE UNIQUE INDEX "declared_cfg_node" ON "declared_harness_config" USING btree ("tenant_id","setting_id","node_id");--> statement-breakpoint
CREATE INDEX "declared_cfg_setting" ON "declared_harness_config" USING btree ("tenant_id","setting_id");--> statement-breakpoint
-- Hand-added: drizzle's builder cannot express a PARTIAL unique index, and the
-- two above do not constrain the fleet-level row because Postgres treats NULLs
-- as distinct — so without this, "declared once for the whole fleet" is not
-- actually unique.
CREATE UNIQUE INDEX "declared_cfg_fleet"
  ON "declared_harness_config" ("tenant_id", "setting_id")
  WHERE "station_id" IS NULL AND "node_id" IS NULL;
