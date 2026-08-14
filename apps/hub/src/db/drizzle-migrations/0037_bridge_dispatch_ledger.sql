CREATE TABLE "bridge_dispatches" (
	"external_source" text NOT NULL,
	"external_run_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"board_id" text NOT NULL,
	"external_card_id" text NOT NULL,
	"agent_key" text NOT NULL,
	"station_id" text NOT NULL,
	"lease_epoch" integer NOT NULL,
	"acp_run_id" text,
	"outcome" text NOT NULL,
	"reason" text,
	"result" jsonb,
	"started_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "bridge_dispatches_external_source_external_run_id_pk" PRIMARY KEY("external_source","external_run_id"),
	CONSTRAINT "bridge_dispatches_external_is_not_agentpod" CHECK ("bridge_dispatches"."external_run_id" NOT LIKE 'attempt\_%'),
	CONSTRAINT "bridge_dispatches_outcome" CHECK ("bridge_dispatches"."outcome" IN ('working', 'produced', 'reported', 'abandoned'))
);
--> statement-breakpoint
ALTER TABLE "bridge_dispatches" ADD CONSTRAINT "bridge_dispatches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_dispatches" ADD CONSTRAINT "bridge_dispatches_acp_run_id_acp_runs_id_fk" FOREIGN KEY ("acp_run_id") REFERENCES "public"."acp_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_dispatches_card_idx" ON "bridge_dispatches" USING btree ("tenant_id","external_source","board_id","external_card_id");--> statement-breakpoint
CREATE INDEX "bridge_dispatches_tenant_id_idx" ON "bridge_dispatches" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "bridge_dispatches_attempt_idx" ON "bridge_dispatches" USING btree ("acp_run_id");