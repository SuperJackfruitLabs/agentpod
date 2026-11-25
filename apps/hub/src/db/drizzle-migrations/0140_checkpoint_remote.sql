-- A remote bench stage's attempt: after admission the station's agent attaches to the card's bench
-- over SSH from its own node (`attach_pending`), works in it through one ACP turn (`working`), and
-- hands the bench host's node its report (`finish_pending`), which checkpoints, stops and releases.
-- `remote` is the attempt's live remote state (canonical JSON): the public key's fingerprint, where
-- the bench is, when the certificate expires, how many dirty-tree retries were spent. Never a
-- certificate, a private key or a lease token. It changes while the attempt is remote, so it is the
-- one cell that may be rewritten; once set it is never cleared.
ALTER TABLE checkpoint_dispatches ADD COLUMN remote text;
--> statement-breakpoint
ALTER TABLE checkpoint_dispatches DROP CONSTRAINT checkpoint_dispatches_phase;
--> statement-breakpoint
ALTER TABLE checkpoint_dispatches ADD CONSTRAINT checkpoint_dispatches_phase CHECK (phase IN
  ('prepare_pending','prepared','source_pending','admitted','execute_pending','completed','submission_pending','reported','retired',
   'failure_pending','failed','attach_pending','working','finish_pending'));
--> statement-breakpoint
-- A remote phase always holds its state once attached; the attach is the only phase that may start without it.
ALTER TABLE checkpoint_dispatches ADD CONSTRAINT checkpoint_dispatches_remote
  CHECK (phase NOT IN ('working','finish_pending') OR remote IS NOT NULL);
--> statement-breakpoint
-- A remote attempt never takes the one-shot execute: the two paths never share a row.
ALTER TABLE checkpoint_dispatches ADD CONSTRAINT checkpoint_dispatches_remote_not_execute
  CHECK (remote IS NULL OR execute_request IS NULL);
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
    OR OLD.remote IS NOT NULL AND NEW.remote IS NULL
  THEN RAISE EXCEPTION 'immutable checkpoint evidence'; END IF;
  IF NEW.phase IS DISTINCT FROM OLD.phase AND NOT (
    OLD.phase='prepare_pending' AND NEW.phase='prepared' OR
    OLD.phase='prepared' AND NEW.phase='source_pending' OR
    OLD.phase='source_pending' AND NEW.phase='admitted' OR
    OLD.phase='admitted' AND NEW.phase='execute_pending' OR
    OLD.phase='execute_pending' AND NEW.phase='completed' OR
    OLD.phase='completed' AND NEW.phase='submission_pending' OR
    OLD.phase='submission_pending' AND NEW.phase='reported' OR
    -- A remote stage: attach, work, finish; a dirty tree sends the finish back to work.
    OLD.phase='admitted' AND NEW.phase='attach_pending' OR
    OLD.phase='attach_pending' AND NEW.phase='working' OR
    OLD.phase='working' AND NEW.phase='finish_pending' OR
    OLD.phase='finish_pending' AND NEW.phase='working' OR
    OLD.phase='finish_pending' AND NEW.phase='completed' OR
    -- Only the phases that ask a node can take its definite refusal.
    OLD.phase IN ('prepare_pending','execute_pending','attach_pending','working','finish_pending') AND NEW.phase='failure_pending' OR
    OLD.phase='failure_pending' AND NEW.phase='failed' OR
    -- Any unended phase may end retired; reported, retired and failed are terminal.
    OLD.phase NOT IN ('reported','retired','failed') AND NEW.phase='retired'
  ) THEN RAISE EXCEPTION 'checkpoint phase cannot rewind'; END IF;
  RETURN NEW;
END;
$$;
