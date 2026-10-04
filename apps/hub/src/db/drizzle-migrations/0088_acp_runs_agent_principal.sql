-- The agent principal an attempt ran as (superwitness contract C5, `attempts[].agent_principal_id`).
--
-- Recorded when the attempt opens, from stations.principal_id, and never recomputed: occupancy
-- moves when an operator reassigns an agent, and evidence read later must name who ran THEN.
-- This is the key superwitness's self-judgement refusal reads (contract C6b).
--
-- Not a foreign key, for the reason acp_runs.station_id is not: a transcript outlives the
-- principal it names. Nullable: an unoccupied station has no agent, and rows written before
-- this shipped are not back-filled from today's occupancy, which would be a guess.
ALTER TABLE "acp_runs" ADD COLUMN "agent_principal_id" text;--> statement-breakpoint
ALTER TABLE "acp_runs" ADD CONSTRAINT "acp_runs_agent_principal_shape" CHECK ("acp_runs"."agent_principal_id" IS NULL OR "acp_runs"."agent_principal_id" ~ '^prn_[0-9a-f]{20}$');
