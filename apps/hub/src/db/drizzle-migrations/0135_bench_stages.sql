-- Bench stages: checkpoint profiles written by `fleet bench stage`, replacing the private profile
-- file and its hub.env lines. Existing file profiles keep loading; an empty table changes nothing.
CREATE TABLE bench_stages (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL, board_id text NOT NULL, station_id text NOT NULL, stage_id text,
  origin text NOT NULL, profile text NOT NULL, created_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name),
  CONSTRAINT bench_stages_origin CHECK (origin IN ('fleet','file'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX bench_stages_selector_idx ON bench_stages(tenant_id,board_id,station_id);
