CREATE TABLE "acp_events" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "acp_events_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "acp_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"user_id" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"ended_reason" text,
	"node_session_id" text,
	"created_at" timestamp NOT NULL,
	"last_event_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acp_events" ADD CONSTRAINT "acp_events_session_id_acp_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."acp_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acp_sessions_station_id_idx" ON "acp_sessions" USING btree ("station_id");