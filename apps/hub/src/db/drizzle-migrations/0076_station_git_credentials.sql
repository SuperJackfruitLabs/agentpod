CREATE TABLE "station_git_credentials" (
	"station_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" text DEFAULT 'forge' NOT NULL,
	"username" text NOT NULL,
	"token_encrypted" text NOT NULL,
	"token_name" text NOT NULL,
	"repositories" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "station_git_credentials" ADD CONSTRAINT "station_git_credentials_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_git_credentials" ADD CONSTRAINT "station_git_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "station_git_credentials_tenant_idx" ON "station_git_credentials" USING btree ("tenant_id");
