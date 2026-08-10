ALTER TABLE "acp_sessions" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "acp_sessions" ADD COLUMN "last_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "acp_sessions_station_activity_idx" ON "acp_sessions" USING btree ("station_id","last_event_at" DESC NULLS LAST);