ALTER TYPE "public"."runtime_status" ADD VALUE 'starting' BEFORE 'online';--> statement-breakpoint
ALTER TABLE "provisioned_runtimes" ADD COLUMN "status_reason" text;