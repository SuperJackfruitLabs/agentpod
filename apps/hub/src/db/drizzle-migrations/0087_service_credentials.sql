-- A service principal's credential (superwitness contract C6). See schema/service-credentials.ts.
-- Purely additive; rollback is DROP TABLE, which signs superwitness out of every source.
CREATE TABLE "service_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"oauth_client" text NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "service_credentials" ADD CONSTRAINT "service_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_credentials" ADD CONSTRAINT "service_credentials_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_credentials_principal_idx" ON "service_credentials" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "service_credentials_tenant_id_idx" ON "service_credentials" USING btree ("tenant_id");
