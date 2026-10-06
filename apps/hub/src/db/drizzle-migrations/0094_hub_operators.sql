CREATE TABLE "hub_operators" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text
);
