-- Referenced unique indexes must exist before the composite ownership FKs.
CREATE TABLE "skill_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"archive_sha256" text NOT NULL,
	"harness" text NOT NULL,
	"profile" text NOT NULL,
	"size" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_artifacts_size_check" CHECK ("skill_artifacts"."size">0 AND "skill_artifacts"."size"<=33554432 AND "skill_artifacts"."size"=octet_length("skill_artifacts"."bytes")),
	CONSTRAINT "skill_artifacts_digest_check" CHECK ("skill_artifacts"."archive_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "skill_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"station_id" text NOT NULL,
	"node_id" text NOT NULL,
	"station_key" text NOT NULL,
	"harness" text NOT NULL,
	"profile" text NOT NULL,
	"action" text NOT NULL,
	"artifact_id" text,
	"state" text DEFAULT 'requested' NOT NULL,
	"plan" jsonb,
	"receipt" jsonb,
	"error" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"download_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_operations_identity_check" CHECK ("skill_operations"."id" ~ '^[a-f0-9]{32}$' AND "skill_operations"."action" IN ('install','rollback') AND (("skill_operations"."action"='install')=("skill_operations"."artifact_id" IS NOT NULL))),
	CONSTRAINT "skill_operations_state_check" CHECK ("skill_operations"."state" IN ('requested','planning','planned','applying','applied','unknown','conflict')),
	CONSTRAINT "skill_operations_metadata_check" CHECK (octet_length("skill_operations"."plan"::text)<=4194304 AND octet_length("skill_operations"."receipt"::text)<=4194304 AND length("skill_operations"."error")<=2048)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_artifacts_owner_digest_idx" ON "skill_artifacts" USING btree ("tenant_id","user_id","archive_sha256");
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_artifacts_owner_id_idx" ON "skill_artifacts" USING btree ("id","tenant_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "stations_skill_owner_idx" ON "stations" USING btree ("id","tenant_id","user_id");
--> statement-breakpoint
ALTER TABLE "skill_artifacts" ADD CONSTRAINT "skill_artifacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_artifacts" ADD CONSTRAINT "skill_artifacts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_operations" ADD CONSTRAINT "skill_operations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_operations" ADD CONSTRAINT "skill_operations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_operations" ADD CONSTRAINT "skill_operations_station_owner_fk" FOREIGN KEY ("station_id","tenant_id","user_id") REFERENCES "public"."stations"("id","tenant_id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_operations" ADD CONSTRAINT "skill_operations_artifact_owner_fk" FOREIGN KEY ("artifact_id","tenant_id","user_id") REFERENCES "public"."skill_artifacts"("id","tenant_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "skill_operations_station_idx" ON "skill_operations" USING btree ("tenant_id","user_id","station_id","created_at");
