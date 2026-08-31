DROP INDEX "matrix_rooms_station_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "stations_principal_id_idx" ON "stations" USING btree ("principal_id") WHERE "stations"."principal_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "matrix_rooms_station_idx" ON "matrix_rooms" USING btree ("station_id");