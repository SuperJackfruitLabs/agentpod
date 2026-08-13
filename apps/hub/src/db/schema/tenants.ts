/**
 * Tenant Schema — AgentPod's local isolation boundary.
 *
 * Before this table every row in the hub hung off a `user_id` and nothing above
 * it: there was no boundary a row could be inside, so there was nothing for a
 * query to be scoped *to*. A `user_id` predicate is an ownership filter, not an
 * isolation boundary — it answers "whose is this", never "which organisation is
 * this inside", and it cannot answer the second one because a user belongs to no
 * larger thing here.
 *
 * **This tenant is local, and deliberately so.** Neither AgentPod nor kaambaan
 * owns the organisation: Principal, Team, Role and authority belong to an
 * Organization plane that does not exist yet
 * (docs/strategy/2026-08-13-ecosystem-identity-decisions.md). Both products must
 * keep running standalone in the meantime, so each keeps its own boundary and
 * records an *optional* mapping to the same real organisation elsewhere — which
 * is what `externalId` + `externalSource` below are for. kaambaan is taking the
 * identical shape in parallel.
 *
 * Concretely that means AgentPod does **not** mint kaambaan's `tnt_`. Two
 * products minting one prefix for rows in two different databases is exactly the
 * `run_` collision undone in #308, and doing it deliberately would be worse than
 * doing it by accident. AgentPod's tenant id space is `fleet_<20 hex>`; the
 * reasoning is in packages/contract/src/ids.ts and pinned across both repos by
 * fixtures/ecosystem-identity/id_grammar.json.
 */

import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";

/**
 * The one tenant that exists, created by migration 0036.
 *
 * Deterministic rather than minted, and that is the requirement rather than a
 * shortcut: the migration runs on a fresh deploy and on the live hub
 * independently, and both must land on the same tenant id without coordinating.
 * A `crypto.randomUUID()` in a migration would give every environment a
 * different boundary and make the eventual external mapping environment-specific
 * for no reason.
 *
 * All-zero so it is unmistakable in a log line as the tenant a migration
 * created rather than one a person did. It is a legal `fleet_<20 hex>` id, so it
 * satisfies the same validator and the same CHECK as any future tenant.
 */
export const BOOTSTRAP_TENANT_ID = "fleet_00000000000000000000";

export const tenants = pgTable(
  "tenants",
  {
    id: text("id").primaryKey(), // "fleet_" + 20 hex (TenantId)
    name: text("name").notNull(),

    // ── The optional external mapping ───────────────────────────────────────
    //
    // The id this tenant has in the system that actually owns the organisation,
    // and which system that is — "kaambaan" today, "org-plane" when it exists.
    // Null on a standalone deployment, which is the default and must stay
    // workable: AgentPod cannot require a peer product to boot.
    //
    // Shape copied verbatim from acp_runs.externalRunId/externalSource rather
    // than invented, including the paired-presence CHECK below. Same problem,
    // same answer: a foreign id with no source cannot be resolved back to the
    // system that minted it, and a source with no id names an origin nothing
    // points at.
    externalId: text("external_id"),
    externalSource: text("external_source"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    // A given organisation maps to at most one AgentPod tenant. Without this,
    // two tenants could both claim to be the same kaambaan tenant and the
    // mapping would stop being a mapping. Partial by construction — NULLs are
    // distinct in a Postgres unique index, so any number of unmapped tenants
    // coexist.
    uniqueIndex("tenants_external_idx").on(t.externalSource, t.externalId),

    // Our own key is ours — the acp_runs precedent, for the same reason. A
    // `tnt_…` here would be kaambaan's boundary standing in as this hub's
    // primary key. Prefix-only, deliberately: the suffix family may change, the
    // id space may not.
    check("tenants_id_is_agentpod_fleet", sql`${t.id} LIKE 'fleet\\_%'`),
    // The mirror: an external id may be any shape the owning system mints, but
    // it may never be one of ours — a `fleet_…` external id would mean this hub
    // pointing at itself and calling it an organisation elsewhere.
    check(
      "tenants_external_is_not_agentpod",
      sql`${t.externalId} IS NULL OR ${t.externalId} NOT LIKE 'fleet\\_%'`,
    ),
    // One fact, two columns. Both present or both absent.
    check(
      "tenants_external_pair",
      sql`(${t.externalId} IS NULL) = (${t.externalSource} IS NULL)`,
    ),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type InsertTenant = typeof tenants.$inferInsert;
