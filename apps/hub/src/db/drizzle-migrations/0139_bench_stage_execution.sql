-- Per stage: how its agent works in the card's bench. `one-shot` (every existing stage) runs the
-- worker on the bench host; `remote` has the station's agent work there over SSH from its own node,
-- through the bench host's node, `bench_node_id`, which only a remote stage names.
ALTER TABLE bench_stages ADD COLUMN execution text NOT NULL DEFAULT 'one-shot';
--> statement-breakpoint
ALTER TABLE bench_stages ADD COLUMN bench_node_id text;
--> statement-breakpoint
ALTER TABLE bench_stages ADD CONSTRAINT bench_stages_execution CHECK (execution IN ('one-shot','remote'));
--> statement-breakpoint
ALTER TABLE bench_stages ADD CONSTRAINT bench_stages_remote_bench_node CHECK ((execution = 'remote') = (bench_node_id IS NOT NULL));
