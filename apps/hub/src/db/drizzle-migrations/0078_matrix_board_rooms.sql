CREATE TABLE "matrix_board_rooms" (
	"board_id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"speaker_mxid" text NOT NULL,
	"alias" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "matrix_board_rooms_room_id_unique" UNIQUE("room_id")
);
--> statement-breakpoint
ALTER TABLE "matrix_board_rooms" ADD CONSTRAINT "matrix_board_rooms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "matrix_board_rooms_tenant_id_idx" ON "matrix_board_rooms" USING btree ("tenant_id");
