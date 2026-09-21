CREATE TABLE "skill_release_cohorts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"release_id" text NOT NULL,
	"record_digest" text NOT NULL,
	"station_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_release_cohorts_digest_check" CHECK ("skill_release_cohorts"."record_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "skill_release_cohorts_station_ids_check" CHECK (jsonb_typeof("skill_release_cohorts"."station_ids")='array' AND jsonb_array_length("skill_release_cohorts"."station_ids") BETWEEN 1 AND 256)
);
--> statement-breakpoint
ALTER TABLE "skill_release_cohorts" ADD CONSTRAINT "skill_release_cohorts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_release_cohorts" ADD CONSTRAINT "skill_release_cohorts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_release_cohorts" ADD CONSTRAINT "skill_release_cohorts_release_owner_fk" FOREIGN KEY ("release_id","tenant_id","user_id") REFERENCES "public"."trusted_skill_releases"("id","tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_release_cohorts_owner_id_idx" ON "skill_release_cohorts" USING btree ("id","tenant_id","user_id");