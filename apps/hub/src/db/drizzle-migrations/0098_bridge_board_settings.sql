CREATE TABLE "bridge_board_settings" (
	"tenant_id" text NOT NULL,
	"board_id" text NOT NULL,
	"related_work" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_board_settings_tenant_id_board_id_pk" PRIMARY KEY("tenant_id","board_id"),
	CONSTRAINT "bridge_board_settings_board_grammar_check" CHECK ("bridge_board_settings"."board_id" ~ '^brd_[0-9a-f]{16}$')
);
--> statement-breakpoint
ALTER TABLE "bridge_board_settings" ADD CONSTRAINT "bridge_board_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;