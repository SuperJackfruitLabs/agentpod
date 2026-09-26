CREATE TABLE "station_transcription" (
	"station_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"mode" text DEFAULT 'inherit' NOT NULL,
	"url" text,
	"model" text,
	"api_key_encrypted" text,
	"max_seconds" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "station_transcription" ADD CONSTRAINT "station_transcription_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_transcription" ADD CONSTRAINT "station_transcription_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_transcription" ADD CONSTRAINT "station_transcription_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_transcription" ADD CONSTRAINT "station_transcription_station_tenant_fk" FOREIGN KEY ("station_id","tenant_id") REFERENCES "public"."stations"("id","tenant_id") ON DELETE cascade ON UPDATE no action;