-- A retained checkpoint attempt the node definitely refused ends as `failed`, never parked forever.
-- `failure_pending` holds the ruling and the node's exact reply before SuperPipeline is told;
-- `failed` adds how SuperPipeline was told. Both cells are set once; nothing is deleted.
ALTER TABLE checkpoint_dispatches ADD COLUMN failure text;
--> statement-breakpoint
ALTER TABLE checkpoint_dispatches ADD COLUMN failure_report text;
--> statement-breakpoint
ALTER TABLE checkpoint_dispatches DROP CONSTRAINT checkpoint_dispatches_phase;
--> statement-breakpoint
ALTER TABLE checkpoint_dispatches ADD CONSTRAINT checkpoint_dispatches_phase CHECK (phase IN
  ('prepare_pending','prepared','source_pending','admitted','execute_pending','completed','submission_pending','reported','retired',
   'failure_pending','failed'));
--> statement-breakpoint
-- A failure is held from failure_pending on. An owner or admin may still retire a failure_pending row
-- whose report cannot be delivered, so a retired row may carry one too.
ALTER TABLE checkpoint_dispatches ADD CONSTRAINT checkpoint_dispatches_failure
  CHECK ((phase NOT IN ('failure_pending','failed') OR failure IS NOT NULL)
    AND (failure IS NULL OR phase IN ('failure_pending','failed','retired')));
--> statement-breakpoint
ALTER TABLE checkpoint_dispatches ADD CONSTRAINT checkpoint_dispatches_failure_report
  CHECK ((phase = 'failed') = (failure_report IS NOT NULL));
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
    OR OLD.failure IS NOT NULL AND NEW.failure IS DISTINCT FROM OLD.failure
    OR OLD.failure_report IS NOT NULL AND NEW.failure_report IS DISTINCT FROM OLD.failure_report
  THEN RAISE EXCEPTION 'immutable checkpoint evidence'; END IF;
  IF NEW.phase IS DISTINCT FROM OLD.phase AND NOT (
    OLD.phase='prepare_pending' AND NEW.phase='prepared' OR
    OLD.phase='prepared' AND NEW.phase='source_pending' OR
    OLD.phase='source_pending' AND NEW.phase='admitted' OR
    OLD.phase='admitted' AND NEW.phase='execute_pending' OR
    OLD.phase='execute_pending' AND NEW.phase='completed' OR
    OLD.phase='completed' AND NEW.phase='submission_pending' OR
    OLD.phase='submission_pending' AND NEW.phase='reported' OR
    -- Only the two phases that ask the node can take its definite refusal.
    OLD.phase IN ('prepare_pending','execute_pending') AND NEW.phase='failure_pending' OR
    OLD.phase='failure_pending' AND NEW.phase='failed' OR
    -- Any unended phase may end retired; reported, retired and failed are terminal.
    OLD.phase NOT IN ('reported','retired','failed') AND NEW.phase='retired'
  ) THEN RAISE EXCEPTION 'checkpoint phase cannot rewind'; END IF;
  RETURN NEW;
END;
$$;
