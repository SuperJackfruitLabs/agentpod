-- Which Application Service transactions have been applied.
--
-- A table rather than a set in memory: the homeserver retries a transaction it
-- did not see acknowledged, and a crash mid-transaction is exactly when that
-- happens. Idempotency that forgets on restart forgets precisely when it is
-- needed, and the symptom is every conversation answered twice.
CREATE TABLE matrix_as_transactions (
  txn_id     text PRIMARY KEY,
  applied_at timestamp NOT NULL DEFAULT now()
);
