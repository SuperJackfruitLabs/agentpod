CREATE TABLE "station_forge_api_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"station_id" text,
	"station_id_snapshot" text NOT NULL,
	"provider" text NOT NULL,
	"instance" text NOT NULL,
	"mode" text NOT NULL,
	"principal_id" text,
	"account" text NOT NULL,
	"expected_login" text,
	"repositories" jsonb NOT NULL,
	"preset" text NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allow_graphql" boolean DEFAULT false NOT NULL,
	"state" text NOT NULL,
	"state_reason" text,
	"token_handle" jsonb,
	"generation" integer NOT NULL,
	"isolation" text,
	"sealed_blob" text,
	"sealed_expires_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "station_forge_api_grants_state_check" CHECK ("station_forge_api_grants"."state" IN ('authorised','provisioned','delivered','verified','failed','revoking','revoked')),
	CONSTRAINT "station_forge_api_grants_provider_check" CHECK ("station_forge_api_grants"."provider" IN ('forgejo','gitea','github','bitbucket')),
	CONSTRAINT "station_forge_api_grants_mode_check" CHECK ("station_forge_api_grants"."mode" IN ('minted','app','supplied')),
	CONSTRAINT "station_forge_api_grants_preset_check" CHECK ("station_forge_api_grants"."preset" IN ('read','issues','pull-requests','maintain','none')),
	CONSTRAINT "station_forge_api_grants_isolation_check" CHECK ("station_forge_api_grants"."isolation" IS NULL OR "station_forge_api_grants"."isolation" IN ('separate-user','same-user'))
);
--> statement-breakpoint
ALTER TABLE "station_forge_api_grants" ADD CONSTRAINT "station_forge_api_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_forge_api_grants" ADD CONSTRAINT "station_forge_api_grants_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "station_forge_api_grants_live_idx" ON "station_forge_api_grants" USING btree ("station_id_snapshot","provider","instance") WHERE "station_forge_api_grants"."state" <> 'revoked';--> statement-breakpoint
CREATE INDEX "station_forge_api_grants_state_updated_idx" ON "station_forge_api_grants" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "station_forge_api_grants_tenant_idx" ON "station_forge_api_grants" USING btree ("tenant_id");