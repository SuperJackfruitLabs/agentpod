-- A retained checkpoint attempt can end as `retired`: settled without a report, with the evidence
-- that it may be. The row and every evidence cell it already holds stay; nothing is deleted.
ALTER TABLE checkpoint_dispatches ADD COLUMN retirement text;
--> statement-breakpoint
ALTER TABLE checkpoint_dispatches DROP CONSTRAINT checkpoint_dispatches_phase;
--> statement-breakpoint
ALTER TABLE checkpoint_dispatches ADD CONSTRAINT checkpoint_dispatches_phase CHECK (phase IN
  ('prepare_pending','prepared','source_pending','admitted','execute_pending','completed','submission_pending','reported','retired'));
--> statement-breakpoint
ALTER TABLE checkpoint_dispatches ADD CONSTRAINT checkpoint_dispatches_retirement
  CHECK ((phase = 'retired') = (retirement IS NOT NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION checkpoint_dispatch_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'immutable checkpoint attempt'; END IF;
  IF (NEW.tenant_id,NEW.board_id,NEW.run_id,NEW.lease_epoch,NEW.attempt_id,NEW.profile,NEW.claim,
      NEW.authority,NEW.prepare_request,NEW.prepare_sha256,NEW.created_at)
    IS DISTINCT FROM
     (OLD.tenant_id,OLD.board_id,OLD.run_id,OLD.lease_epoch,OLD.attempt_id,OLD.profile,OLD.claim,
      OLD.authority,OLD.prepare_request,OLD.prepare_sha256,OLD.created_at)
    OR OLD.prepared IS NOT NULL AND NEW.prepared IS DISTINCT FROM OLD.prepared
    OR OLD.source IS NOT NULL AND NEW.source IS DISTINCT FROM OLD.source
    OR OLD.source_receipt IS NOT NULL AND NEW.source_receipt IS DISTINCT FROM OLD.source_receipt
    OR OLD.execute_request IS NOT NULL AND NEW.execute_request IS DISTINCT FROM OLD.execute_request
    OR OLD.execute_sha256 IS NOT NULL AND NEW.execute_sha256 IS DISTINCT FROM OLD.execute_sha256
    OR OLD.completion IS NOT NULL AND NEW.completion IS DISTINCT FROM OLD.completion
    OR OLD.settlement_body IS NOT NULL AND NEW.settlement_body IS DISTINCT FROM OLD.settlement_body
    OR OLD.settlement_sha256 IS NOT NULL AND NEW.settlement_sha256 IS DISTINCT FROM OLD.settlement_sha256
    OR OLD.settlement_receipt IS NOT NULL AND NEW.settlement_receipt IS DISTINCT FROM OLD.settlement_receipt
    OR OLD.retirement IS NOT NULL AND NEW.retirement IS DISTINCT FROM OLD.retirement
  THEN RAISE EXCEPTION 'immutable checkpoint evidence'; END IF;
  IF NEW.phase IS DISTINCT FROM OLD.phase AND NOT (
    OLD.phase='prepare_pending' AND NEW.phase='prepared' OR
    OLD.phase='prepared' AND NEW.phase='source_pending' OR
    OLD.phase='source_pending' AND NEW.phase='admitted' OR
    OLD.phase='admitted' AND NEW.phase='execute_pending' OR
    OLD.phase='execute_pending' AND NEW.phase='completed' OR
    OLD.phase='completed' AND NEW.phase='submission_pending' OR
    OLD.phase='submission_pending' AND NEW.phase='reported' OR
    -- Any unreported phase may end retired; reported and retired are terminal.
    OLD.phase NOT IN ('reported','retired') AND NEW.phase='retired'
  ) THEN RAISE EXCEPTION 'checkpoint phase cannot rewind'; END IF;
  RETURN NEW;
END;
$$;
