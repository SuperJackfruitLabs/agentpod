CREATE TABLE "acp_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"station_id" text NOT NULL,
	"external_run_id" text,
	"external_source" text,
	"state" text NOT NULL,
	"start_seq" integer NOT NULL,
	"end_seq" integer,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "acp_runs" ADD CONSTRAINT "acp_runs_session_id_acp_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."acp_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acp_runs_session_idx" ON "acp_runs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "acp_runs_station_started_idx" ON "acp_runs" USING btree ("station_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "acp_runs_external_idx" ON "acp_runs" USING btree ("external_run_id");--> statement-breakpoint
CREATE INDEX "acp_events_created_at_idx" ON "acp_events" USING btree ("created_at");