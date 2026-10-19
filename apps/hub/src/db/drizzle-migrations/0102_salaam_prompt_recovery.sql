CREATE TABLE "acp_prompt_requests" (
	"session_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"request_id" text NOT NULL,
	"input_digest" text NOT NULL,
	"input_text" text NOT NULL,
	"state" text NOT NULL,
	"attempt_id" text,
	CONSTRAINT "acp_prompt_requests_session_id_request_id_pk" PRIMARY KEY("session_id","request_id"),
	CONSTRAINT "acp_prompt_requests_state" CHECK ("acp_prompt_requests"."state" IN ('prepared','dispatched','accepted','completed','interrupted','unknown'))
);
--> statement-breakpoint
ALTER TABLE "acp_prompt_requests" ADD CONSTRAINT "acp_prompt_requests_session_id_acp_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."acp_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_prompt_requests" ADD CONSTRAINT "acp_prompt_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_prompt_requests" ADD CONSTRAINT "acp_prompt_requests_session_tenant_fk" FOREIGN KEY ("session_id","tenant_id") REFERENCES "public"."acp_sessions"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acp_prompt_requests_tenant_id_idx" ON "acp_prompt_requests" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "acp_events_salaam_update_id" ON "acp_events" USING btree ("session_id",("payload" #>> '{_meta,salaam.dev/updateId}')) WHERE "acp_events"."type" = 'agent-update' AND "acp_events"."payload" #>> '{_meta,salaam.dev/updateId}' IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "acp_events_salaam_prompt_id" ON "acp_events" USING btree ("session_id",("payload"->>'requestId')) WHERE "acp_events"."type" = 'user-prompt' AND "acp_events"."payload"->>'requestId' IS NOT NULL;