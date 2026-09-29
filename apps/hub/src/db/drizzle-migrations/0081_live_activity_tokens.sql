CREATE TABLE IF NOT EXISTS "live_activity_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"kind" text NOT NULL,
	"activity_id" text,
	"token" text NOT NULL,
	"environment" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_activity_tokens_kind_check" CHECK ("live_activity_tokens"."kind" IN ('start', 'update')),
	CONSTRAINT "live_activity_tokens_environment_check" CHECK ("live_activity_tokens"."environment" IN ('production', 'sandbox')),
	CONSTRAINT "live_activity_tokens_activity_check" CHECK (("live_activity_tokens"."kind" = 'start' AND "live_activity_tokens"."activity_id" IS NULL) OR ("live_activity_tokens"."kind" = 'update' AND "live_activity_tokens"."activity_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "live_activity_tokens_start_key" ON "live_activity_tokens" USING btree ("user_id","device_id") WHERE "live_activity_tokens"."kind" = 'start';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "live_activity_tokens_update_key" ON "live_activity_tokens" USING btree ("user_id","device_id","activity_id") WHERE "live_activity_tokens"."kind" = 'update';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_activity_tokens_user_idx" ON "live_activity_tokens" USING btree ("user_id");
