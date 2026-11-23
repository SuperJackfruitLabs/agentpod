-- SuperPipeline events this hub has acted on, by the event id the direct push and the event relay
-- share (`<boardId>:<event seq>`), so an event that arrives by both is acted on once.
CREATE TABLE IF NOT EXISTS "superpipeline_event_receipts" (
	"event_id" text PRIMARY KEY NOT NULL,
	"via" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "superpipeline_event_receipts_received_idx" ON "superpipeline_event_receipts" USING btree ("received_at");
