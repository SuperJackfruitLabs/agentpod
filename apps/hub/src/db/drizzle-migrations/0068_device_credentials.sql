-- A long-lived credential bound to one machine, which a human exchanges for a
-- five-minute token.
--
-- charter → decisions/2026-09-18-a-human-at-a-terminal-has-nothing-to-exchange.md,
-- accepted 2026-09-20. An agent re-mints by exchanging the credential it already
-- holds and a browser re-mints from its session cookie; a human at a terminal held
-- neither, so a token expiring cost a browser, a person and a click — four times in
-- one session on the day this was accepted.
--
-- Purely additive: one new table, two FKs, two indexes, and nothing existing is
-- touched. Rolling back is DROP TABLE, and doing so while credentials are
-- outstanding logs every holder out to the browser flow rather than breaking them.
--
-- Only the SHA-256 of the secret is stored, as nodes.secret_hash already is.

CREATE TABLE "device_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_credentials_user_id_idx" ON "device_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "device_credentials_tenant_id_idx" ON "device_credentials" USING btree ("tenant_id");