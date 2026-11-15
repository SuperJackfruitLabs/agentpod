-- Proposed default-disabled dedicated attempt ledger. No service grant or pilot is enabled.
CREATE TABLE checkpoint_dispatches (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  board_id text NOT NULL, run_id text NOT NULL, lease_epoch bigint NOT NULL,
  attempt_id text NOT NULL, profile text NOT NULL, claim text NOT NULL, authority text NOT NULL,
  prepare_request text NOT NULL, prepare_sha256 text NOT NULL, phase text NOT NULL,
  prepared text, source text, source_receipt text, execute_request text, execute_sha256 text,
  completion text, settlement_body text, settlement_sha256 text, settlement_receipt text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, attempt_id),
  CONSTRAINT checkpoint_dispatches_epoch CHECK (lease_epoch > 0 AND lease_epoch <= 9007199254740991),
  CONSTRAINT checkpoint_dispatches_phase CHECK (phase IN
    ('prepare_pending','prepared','source_pending','admitted','execute_pending','completed','submission_pending','reported'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX checkpoint_dispatches_run_epoch_idx
  ON checkpoint_dispatches(tenant_id,board_id,run_id,lease_epoch);
--> statement-breakpoint
CREATE FUNCTION checkpoint_dispatch_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
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
  THEN RAISE EXCEPTION 'immutable checkpoint evidence'; END IF;
  IF NEW.phase IS DISTINCT FROM OLD.phase AND NOT (
    OLD.phase='prepare_pending' AND NEW.phase='prepared' OR
    OLD.phase='prepared' AND NEW.phase='source_pending' OR
    OLD.phase='source_pending' AND NEW.phase='admitted' OR
    OLD.phase='admitted' AND NEW.phase='execute_pending' OR
    OLD.phase='execute_pending' AND NEW.phase='completed' OR
    OLD.phase='completed' AND NEW.phase='submission_pending' OR
    OLD.phase='submission_pending' AND NEW.phase='reported'
  ) THEN RAISE EXCEPTION 'checkpoint phase cannot rewind'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER checkpoint_dispatch_immutable BEFORE UPDATE OR DELETE ON checkpoint_dispatches
  FOR EACH ROW EXECUTE FUNCTION checkpoint_dispatch_immutable();
