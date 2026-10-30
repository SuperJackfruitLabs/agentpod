-- Item 9 (operator approval 2026-10-30): a Salaam station is bridge-only on Matrix.
UPDATE "stations" SET "matrix_identity_mode" = 'bridge' WHERE "harness" = 'salaam';--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_salaam_bridge_only" CHECK ("harness" <> 'salaam' OR "matrix_identity_mode" = 'bridge');
