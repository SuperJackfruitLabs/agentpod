ALTER TABLE salaam_work_owners ADD COLUMN telemetry_status text CHECK (telemetry_status IN ('recorded','unavailable'));
