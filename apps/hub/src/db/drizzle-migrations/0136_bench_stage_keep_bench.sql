-- Per stage: keep a card's bench after its checkpoint settles. Off (the default) reclaims it.
ALTER TABLE bench_stages ADD COLUMN keep_bench boolean NOT NULL DEFAULT false;
