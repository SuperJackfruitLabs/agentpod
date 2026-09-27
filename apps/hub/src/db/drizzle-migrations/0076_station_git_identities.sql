CREATE TABLE "station_git_identities" (
	"station_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" text DEFAULT 'forge' NOT NULL,
	"username" text NOT NULL,
	"key_id" integer NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "station_git_identities" ADD CONSTRAINT "station_git_identities_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_git_identities" ADD CONSTRAINT "station_git_identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "station_git_identities_tenant_idx" ON "station_git_identities" USING btree ("tenant_id");
