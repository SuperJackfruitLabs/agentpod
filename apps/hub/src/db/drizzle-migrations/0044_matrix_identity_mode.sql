-- Two different facts about one station, which an earlier draft of this
-- migration tried to keep in one column.
--
-- `matrix_id` is what the HARNESS reports: the node agent reads it off the host
-- from a profile, and owns it completely. That is how the 14 hermes agents have
-- identities. Guarding that column against its own writer broke the fix that
-- lets a station adopted before its profile was readable gain one later.
--
-- `bridge_matrix_id` is what the Application Service MINTED for a station whose
-- harness knows nothing about Matrix. Nobody on the host can report it, so
-- nothing on the host can erase it.
--
-- `matrix_identity_mode` says which one answers. Exactly one, always — two
-- answerers on one address is the failure these columns exist to prevent.
ALTER TABLE stations
  ADD COLUMN bridge_matrix_id text,
  ADD COLUMN matrix_identity_mode text NOT NULL DEFAULT 'bridge';

ALTER TABLE stations
  ADD CONSTRAINT stations_matrix_identity_mode_check
  CHECK (matrix_identity_mode IN ('bridge', 'harness'));

-- Every mxid that exists today was read off a host by the node agent: 14 hermes
-- stations, all from harness profiles, verified 2026-08-16. Those stations
-- answer for themselves until somebody moves them.
UPDATE stations SET matrix_identity_mode = 'harness' WHERE matrix_id IS NOT NULL;
