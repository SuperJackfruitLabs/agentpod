ALTER TABLE "harness_config_opt_out" DROP CONSTRAINT "cfg_opt_out_key_setting";--> statement-breakpoint
ALTER TABLE "harness_config_opt_out" ALTER COLUMN "station_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "harness_config_opt_out" ADD COLUMN "node_id" text;--> statement-breakpoint
ALTER TABLE "harness_config_opt_out" ADD COLUMN "opted_out" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "harness_config_opt_out" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "applied_harness_config" ADD CONSTRAINT "applied_harness_config_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_config_opt_out" ADD CONSTRAINT "cfg_opt_out_one_level" CHECK (("harness_config_opt_out"."station_key" IS NULL) <> ("harness_config_opt_out"."node_id" IS NULL));
--> statement-breakpoint
-- Postgres never conflicts on NULL, so one index per level, each scoped to
-- the level it covers. A single unique constraint over both nullable columns
-- would let duplicate node-level rows insert — the Plan 1 defect, repeated.
CREATE UNIQUE INDEX "cfg_opt_out_station" ON "harness_config_opt_out"
  ("tenant_id", "station_key", "setting_id") WHERE "node_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "cfg_opt_out_node" ON "harness_config_opt_out"
  ("tenant_id", "node_id", "setting_id") WHERE "station_key" IS NULL;