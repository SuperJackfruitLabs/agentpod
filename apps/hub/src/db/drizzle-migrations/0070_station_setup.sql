CREATE TABLE "station_setups" (
	"request_id" text PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"input" text NOT NULL,
	"principal_id" text NOT NULL,
	"matrix_status" text,
	"matrix_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "station_setups" ADD CONSTRAINT "station_setups_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_setups" ADD CONSTRAINT "station_setups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_setups" ADD CONSTRAINT "station_setups_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_setups" ADD CONSTRAINT "station_setups_owner_fk" FOREIGN KEY ("station_id","tenant_id","user_id") REFERENCES "public"."stations"("id","tenant_id","user_id") ON DELETE cascade ON UPDATE no action;