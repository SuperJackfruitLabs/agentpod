import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { ForgeApiMode, ForgeApiPreset, ForgeApiProvider } from "@agentpod/contract";

import { stations } from "./stations";
import { tenants } from "./tenants";

export interface ForgeTokenRef {
  id?: number;
  name: string;
}
/**
 * What `token_handle` records, so reconcile can act from the jsonb alone:
 * - the top level is the CURRENT token (the generation in `generation`);
 * - `previous` is the generation the current one replaced, with what to do with it:
 *   - `live-until-verified`: a rotation is under way (or crashed). The node may still hold
 *     `previous`; it is revoked only once the node has ACKED the current token (delivered_at set,
 *     no sealed blob) and it verifies. A rotation clears delivered_at when it starts.
 *   - `revoke`: superseded and held by nobody — revoke it (a rotation whose final revoke failed,
 *     or one that failed definitively after the node took the new token).
 * - `orphan` is a token a failed rotation minted and could not take back. It was never the
 *   node's credential; revoke it.
 */
export interface ForgeTokenHandle extends ForgeTokenRef {
  previous?: ForgeTokenRef & {
    disposition: "live-until-verified" | "revoke";
    /** Set by a rotation: the generation and delivered_at to restore if it is undone. */
    generation?: number;
    deliveredAt?: string | null;
  };
  orphan?: ForgeTokenRef;
}

export type ForgeGrantState =
  | "authorised"
  | "provisioned"
  | "delivered"
  | "verified"
  | "failed"
  | "revoking"
  | "revoked";

/**
 * A station's repository-restricted API access to a forge (spec 2026-10-17-forge-api-access-design).
 *
 * **There is no token in this table, on purpose.** The hub mints a token, seals it to the node's
 * public key and forgets it. `tokenHandle` is the provider-side handle (id and name) that revocation
 * needs; `sealedBlob` is ciphertext only the node can open, kept until delivery is acknowledged.
 *
 * **`stationId` is nullable and `set null` on station deletion; `stationIdSnapshot` is the station id
 * for the life of the row.** A grant must outlive its station: a deleted station with a live grant
 * still has a provider-side token to revoke, and a revoked tombstone is the audit record. The live
 * uniqueness and the monotonic `generation` therefore key on the snapshot, never on `stationId`.
 */
export const stationForgeApiGrants = pgTable(
  "station_forge_api_grants",
  {
    id: text("id").primaryKey(),

    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),

    stationId: text("station_id").references(() => stations.id, { onDelete: "set null" }),
    stationIdSnapshot: text("station_id_snapshot").notNull(),

    provider: text("provider").$type<ForgeApiProvider>().notNull(),
    /** The forge base URL: one provider can have several instances on one station. */
    instance: text("instance").notNull(),
    mode: text("mode").$type<ForgeApiMode>().notNull(),

    principalId: text("principal_id"),
    /** Derived by the hub from the occupying principal, never from a request body or a node. */
    account: text("account").notNull(),
    expectedLogin: text("expected_login"),

    repositories: jsonb("repositories").$type<string[]>().notNull(),
    preset: text("preset").$type<ForgeApiPreset>().notNull(),
    rules: jsonb("rules").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    allowGraphql: boolean("allow_graphql").notNull().default(false),

    state: text("state").$type<ForgeGrantState>().notNull(),
    stateReason: text("state_reason"),

    /**
     * Persisted before delivery is attempted so reconcile can retry or revoke. See
     * ForgeTokenHandle for `previous` (persisted before a rotation mints) and `orphan`.
     */
    tokenHandle: jsonb("token_handle").$type<ForgeTokenHandle>(),
    /** Never resets across re-grants; see nextGeneration(). */
    generation: integer("generation").notNull(),
    isolation: text("isolation").$type<"separate-user" | "same-user">(),

    sealedBlob: text("sealed_blob"),
    sealedExpiresAt: timestamp("sealed_expires_at", { withTimezone: true }),

    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("station_forge_api_grants_live_idx")
      .on(t.stationIdSnapshot, t.provider, t.instance)
      .where(sql`${t.state} <> 'revoked'`),
    index("station_forge_api_grants_state_updated_idx").on(t.state, t.updatedAt),
    index("station_forge_api_grants_tenant_idx").on(t.tenantId),
    check(
      "station_forge_api_grants_state_check",
      sql`${t.state} IN ('authorised','provisioned','delivered','verified','failed','revoking','revoked')`,
    ),
    check("station_forge_api_grants_provider_check", sql`${t.provider} IN ('forgejo','gitea','github','bitbucket')`),
    check("station_forge_api_grants_mode_check", sql`${t.mode} IN ('minted','app','supplied')`),
    check(
      "station_forge_api_grants_preset_check",
      sql`${t.preset} IN ('read','issues','pull-requests','maintain','none')`,
    ),
    uniqueIndex("station_forge_api_grants_generation_idx").on(
      t.stationIdSnapshot,
      t.provider,
      t.instance,
      t.generation,
    ),
    check("station_forge_api_grants_generation_check", sql`${t.generation} >= 1`),
    check("station_forge_api_grants_revoked_at_check", sql`(${t.state} = 'revoked') = (${t.revokedAt} IS NOT NULL)`),
    check(
      "station_forge_api_grants_sealed_check",
      sql`(${t.sealedBlob} IS NULL) = (${t.sealedExpiresAt} IS NULL)`,
    ),
    check(
      "station_forge_api_grants_isolation_check",
      sql`${t.isolation} IS NULL OR ${t.isolation} IN ('separate-user','same-user')`,
    ),
  ],
);

export type StationForgeApiGrant = typeof stationForgeApiGrants.$inferSelect;
export type NewStationForgeApiGrant = typeof stationForgeApiGrants.$inferInsert;
