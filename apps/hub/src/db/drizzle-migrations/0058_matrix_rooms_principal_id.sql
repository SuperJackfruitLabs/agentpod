ALTER TABLE "matrix_rooms" ADD COLUMN "principal_id" text;--> statement-breakpoint
ALTER TABLE "matrix_rooms" ADD CONSTRAINT "matrix_rooms_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "matrix_rooms_principal_idx" ON "matrix_rooms" USING btree ("principal_id");