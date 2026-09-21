CREATE TABLE "trusted_skill_release_artifacts" (
	"release_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"harness" text NOT NULL,
	"bundle_digest" text NOT NULL,
	CONSTRAINT "trusted_skill_release_artifacts_digest_check" CHECK ("trusted_skill_release_artifacts"."bundle_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "trusted_skill_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"version" text NOT NULL,
	"profile" text NOT NULL,
	"record_digest" text NOT NULL,
	"record" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trusted_skill_releases_digest_check" CHECK ("trusted_skill_releases"."record_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "trusted_skill_releases_owner_digest_idx" ON "trusted_skill_releases" USING btree ("tenant_id","user_id","record_digest");
--> statement-breakpoint
CREATE UNIQUE INDEX "trusted_skill_releases_owner_version_profile_idx" ON "trusted_skill_releases" USING btree ("tenant_id","user_id","version","profile");
--> statement-breakpoint
CREATE UNIQUE INDEX "trusted_skill_releases_owner_id_idx" ON "trusted_skill_releases" USING btree ("id","tenant_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "trusted_skill_release_artifacts_release_harness_idx" ON "trusted_skill_release_artifacts" USING btree ("release_id","tenant_id","user_id","harness");
--> statement-breakpoint
CREATE UNIQUE INDEX "trusted_skill_release_artifacts_artifact_idx" ON "trusted_skill_release_artifacts" USING btree ("artifact_id","tenant_id","user_id");
--> statement-breakpoint
ALTER TABLE "trusted_skill_release_artifacts" ADD CONSTRAINT "trusted_skill_release_artifacts_release_owner_fk" FOREIGN KEY ("release_id","tenant_id","user_id") REFERENCES "public"."trusted_skill_releases"("id","tenant_id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trusted_skill_release_artifacts" ADD CONSTRAINT "trusted_skill_release_artifacts_artifact_owner_fk" FOREIGN KEY ("artifact_id","tenant_id","user_id") REFERENCES "public"."skill_artifacts"("id","tenant_id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trusted_skill_release_artifacts" ADD CONSTRAINT "trusted_skill_release_artifacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trusted_skill_releases" ADD CONSTRAINT "trusted_skill_releases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trusted_skill_releases" ADD CONSTRAINT "trusted_skill_releases_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
