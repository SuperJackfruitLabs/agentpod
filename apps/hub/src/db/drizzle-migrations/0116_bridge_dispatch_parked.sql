-- #786: a revoked strict run that never reported is parked for operator reconciliation, so it
-- stops holding its roster. Parking settles nothing; an operator settlement still retires it.
ALTER TABLE "bridge_dispatches" DROP CONSTRAINT "bridge_dispatches_outcome";--> statement-breakpoint
ALTER TABLE "bridge_dispatches" ADD CONSTRAINT "bridge_dispatches_outcome" CHECK ("bridge_dispatches"."outcome" IN ('working', 'produced', 'reported', 'released', 'abandoned', 'parked'));
