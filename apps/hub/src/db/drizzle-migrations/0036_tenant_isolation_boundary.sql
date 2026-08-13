-- AgentPod's local isolation boundary.
--
-- Before this migration every row in the hub hung off a `user_id` and nothing
-- above it. A `user_id` predicate is an ownership filter, not an isolation
-- boundary: it answers "whose is this" and cannot answer "which organisation is
-- this inside", because a user here belonged to no larger thing. This creates
-- the larger thing and puts every row that belongs to one inside it.
--
-- The boundary is LOCAL on purpose. Neither AgentPod nor kaambaan owns the
-- organisation — that belongs to an Organization plane that does not exist yet —
-- and both products must keep running standalone, so each keeps its own tenant
-- and records an optional external mapping to the same real organisation
-- elsewhere. Hence `fleet_`, not kaambaan's `tnt_`; hence external_id and
-- external_source, nullable and paired.
--
-- **This is a backfill migration, not a fresh-schema one.** The generated form
-- of this change was `ALTER TABLE … ADD COLUMN "tenant_id" text NOT NULL`, which
-- succeeds on an empty database and fails on every row the live hub holds. It
-- also emitted the composite foreign keys before the unique indexes they
-- reference, which fails even when empty. Both are rewritten below: add
-- nullable, backfill, then constrain — and indexes before the keys that need
-- them.

-- ─── The boundary ────────────────────────────────────────────────────────────

CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"external_id" text,
	"external_source" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_id_is_agentpod_fleet" CHECK ("tenants"."id" LIKE 'fleet\_%'),
	CONSTRAINT "tenants_external_is_not_agentpod" CHECK ("tenants"."external_id" IS NULL OR "tenants"."external_id" NOT LIKE 'fleet\_%'),
	CONSTRAINT "tenants_external_pair" CHECK (("tenants"."external_id" IS NULL) = ("tenants"."external_source" IS NULL))
);--> statement-breakpoint

-- NULLs are distinct in a Postgres unique index, so this constrains only the
-- tenants that ARE mapped: a given organisation maps to at most one AgentPod
-- tenant, and any number of unmapped tenants coexist.
CREATE UNIQUE INDEX "tenants_external_idx" ON "tenants" USING btree ("external_source","external_id");--> statement-breakpoint

-- The bootstrap tenant. A deterministic literal rather than a minted id,
-- because this migration runs independently on a fresh deploy and on the live
-- hub and both must land on the SAME boundary without coordinating — a
-- gen_random_uuid() here would give every environment a different tenant and
-- make the eventual external mapping environment-specific for no reason.
-- Mirrors BOOTSTRAP_TENANT_ID in src/db/schema/tenants.ts.
--
-- external_id/external_source stay NULL: nothing has linked this hub to a
-- kaambaan tenant, and ecosystem decision 2 requires that link to be minted
-- explicitly rather than inferred. Guessing it here is exactly the inference
-- that decision forbids.
INSERT INTO "tenants" ("id", "name") VALUES ('fleet_00000000000000000000', 'Default')
	ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- ─── Add nullable, so existing rows survive the statement ────────────────────

ALTER TABLE "nodes" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "provisioned_runtimes" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "station_audit" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "acp_sessions" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "acp_events" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "acp_runs" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "cloudflare_sandboxes" ADD COLUMN "tenant_id" text;--> statement-breakpoint

-- ─── Backfill ────────────────────────────────────────────────────────────────
--
-- Every existing row belongs to the one tenant that now exists. That is the
-- honest statement of the live dataset: one operator, one fleet, no boundary to
-- have crossed.
--
-- Parents take the constant. Children take THEIR PARENT'S tenant rather than the
-- constant — the same value today, but it says the right thing, and it is what
-- the composite foreign keys below check. Backfilling a child from a constant
-- would satisfy those keys by luck rather than by construction.

UPDATE "nodes" SET "tenant_id" = 'fleet_00000000000000000000' WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "provisioned_runtimes" SET "tenant_id" = 'fleet_00000000000000000000' WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "enrollment_tokens" SET "tenant_id" = 'fleet_00000000000000000000' WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "station_audit" SET "tenant_id" = 'fleet_00000000000000000000' WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "acp_sessions" SET "tenant_id" = 'fleet_00000000000000000000' WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "agent_tasks" SET "tenant_id" = 'fleet_00000000000000000000' WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "cloudflare_sandboxes" SET "tenant_id" = 'fleet_00000000000000000000' WHERE "tenant_id" IS NULL;--> statement-breakpoint

-- Children, from their parents. Ordered after the parents above.
UPDATE "stations" SET "tenant_id" = "nodes"."tenant_id"
	FROM "nodes" WHERE "stations"."node_id" = "nodes"."id" AND "stations"."tenant_id" IS NULL;--> statement-breakpoint
UPDATE "acp_events" SET "tenant_id" = "acp_sessions"."tenant_id"
	FROM "acp_sessions" WHERE "acp_events"."session_id" = "acp_sessions"."id" AND "acp_events"."tenant_id" IS NULL;--> statement-breakpoint
UPDATE "acp_runs" SET "tenant_id" = "acp_sessions"."tenant_id"
	FROM "acp_sessions" WHERE "acp_runs"."session_id" = "acp_sessions"."id" AND "acp_runs"."tenant_id" IS NULL;--> statement-breakpoint

-- ─── Constrain ───────────────────────────────────────────────────────────────
--
-- SET NOT NULL is the assertion that the backfill above was complete: a row the
-- UPDATEs missed fails the migration here rather than sitting unscoped in a
-- table the guard believes is scoped. Deliberately no DEFAULT — a default would
-- make a forgotten tenant on some future INSERT land silently in the bootstrap
-- tenant, which is the per-query-discipline failure this whole change exists to
-- replace.

ALTER TABLE "nodes" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "provisioned_runtimes" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "stations" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "station_audit" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "acp_sessions" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "acp_events" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "acp_runs" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cloudflare_sandboxes" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint

-- ─── Composite targets, BEFORE the keys that reference them ──────────────────
--
-- The generated migration emitted these after the foreign keys below, which
-- cannot work: a composite FK requires a unique constraint on the referenced
-- pair to already exist.

CREATE UNIQUE INDEX "nodes_id_tenant_idx" ON "nodes" USING btree ("id","tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "acp_sessions_id_tenant_idx" ON "acp_sessions" USING btree ("id","tenant_id");--> statement-breakpoint

-- ─── Foreign keys ────────────────────────────────────────────────────────────
--
-- ON DELETE restrict on the tenant: deleting a tenant that still owns nodes must
-- fail loudly rather than cascade a fleet away. Nothing deletes tenants today,
-- and this is the posture to have before something does.

ALTER TABLE "nodes" ADD CONSTRAINT "nodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioned_runtimes" ADD CONSTRAINT "provisioned_runtimes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_audit" ADD CONSTRAINT "station_audit_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_sessions" ADD CONSTRAINT "acp_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_events" ADD CONSTRAINT "acp_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_runs" ADD CONSTRAINT "acp_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloudflare_sandboxes" ADD CONSTRAINT "cloudflare_sandboxes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- A child's tenant is its parent's, copied — and a copied fact drifts unless
-- something stops it. These make a station in one tenant on a node in another
-- unrepresentable rather than merely unwritten, which is what lets the tenant
-- live on the row instead of being reached through a join on every read.
ALTER TABLE "stations" ADD CONSTRAINT "stations_node_tenant_fk" FOREIGN KEY ("node_id","tenant_id") REFERENCES "public"."nodes"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_events" ADD CONSTRAINT "acp_events_session_tenant_fk" FOREIGN KEY ("session_id","tenant_id") REFERENCES "public"."acp_sessions"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_runs" ADD CONSTRAINT "acp_runs_session_tenant_fk" FOREIGN KEY ("session_id","tenant_id") REFERENCES "public"."acp_sessions"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ─── Lookup indexes ──────────────────────────────────────────────────────────
--
-- Every scoped read now leads with tenant_id, so every scoped table needs one.

CREATE INDEX "nodes_tenant_id_idx" ON "nodes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "provisioned_runtimes_tenant_id_idx" ON "provisioned_runtimes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "enrollment_tokens_tenant_id_idx" ON "enrollment_tokens" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "stations_tenant_id_idx" ON "stations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "station_audit_tenant_id_idx" ON "station_audit" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "acp_sessions_tenant_id_idx" ON "acp_sessions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "acp_events_tenant_id_idx" ON "acp_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "acp_runs_tenant_id_idx" ON "acp_runs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "agent_tasks_tenant_id_idx" ON "agent_tasks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "cloudflare_sandboxes_tenant_id_idx" ON "cloudflare_sandboxes" USING btree ("tenant_id");
