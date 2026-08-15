/**
 * The tenant isolation guard.
 *
 * Isolation is a property of the data-access layer, not a filter every caller
 * has to remember to add. The principle is kaambaan's — *"there is NO unscoped
 * query builder"* — and it is the strongest thing in either codebase; the
 * implementation is not, because kaambaan builds raw SQL strings for D1 and this
 * is Drizzle over Postgres. What transfers is the shape: a tenant predicate that
 * is built first, a table whitelist that refuses anything not registered, and a
 * tenant that cannot be absent.
 *
 * Two entry points, because this codebase has both kinds of query:
 *
 * - `tenantScope(table, tenantId, ...extra)` returns the predicate, for the
 *   selects that project specific columns or join (`listNodes` left-joins
 *   provisioned_runtimes) and for updates and deletes. The predicate is the unit
 *   that composes with what is already written.
 * - `tenantScopedSelect(table, tenantId, ...extra)` returns a builder with the
 *   predicate already bound, for the plain case.
 *
 * Neither can be constructed for an unregistered table or without a tenant, so
 * the mistake this exists to prevent is a thrown error rather than a silent
 * cross-tenant read.
 *
 * **What this does not claim.** Drizzle exposes `db.select()` directly and this
 * module cannot take it away, so a determined caller can still write an unscoped
 * query. What closes that gap is the guard in `tests/unit/tenant-scope.test.ts`,
 * which enumerates the *schema* rather than the whitelist: a tenant-scoped table
 * added without being classified fails on the commit that adds it.
 */

import { and, eq, getTableName, type SQL, type Table } from "drizzle-orm";
import { TenantId } from "@agentpod/contract";

import { db } from "./drizzle";
import { acpEvents, acpRuns, acpSessions } from "./schema/acp";
import { bridgeDispatches } from "./schema/bridge";
import { adminAuditLog, systemSettings } from "./schema/admin";
import { stationAudit } from "./schema/audit";
import { account, session, user, verification, jwks } from "./schema/auth";
import { principalIdentities } from "./schema/identities";
import { agentTasks, cloudflareSandboxes } from "./schema/cloudflare";
import { enrollmentTokens, nodes, provisionedRuntimes } from "./schema/nodes";
import { stations } from "./schema/stations";
import { tenants } from "./schema/tenants";

export { BOOTSTRAP_TENANT_ID } from "./schema/tenants";

export class TenantIsolationError extends Error {
  constructor(message = "a tenant scope is required to access tenant-scoped data") {
    super(message);
    this.name = "TenantIsolationError";
  }
}

/**
 * Narrow `tenantId` to a real AgentPod tenant id or throw.
 *
 * Stricter than kaambaan's equivalent, which only checks for a non-empty string.
 * The extra check earns its place across the seam: `tnt_5f2b8c1a9d3e4076` is a
 * perfectly well-formed *kaambaan* tenant naming a boundary in a different
 * database, and once a bridge exists it is a value that can reach this function.
 * A non-empty-string check would accept it and build a predicate that matches
 * nothing — a query that returns zero rows and looks like an empty fleet rather
 * than like a bug.
 */
export function assertTenantId(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new TenantIsolationError("a non-empty tenantId is required");
  }
  if (!TenantId.safeParse(tenantId).success) {
    throw new TenantIsolationError(
      `"${tenantId}" is not an AgentPod tenant id (expected "fleet_<20 hex>")`,
    );
  }
}

/** A table registered as tenant-scoped: it has a `tenantId` column by construction. */
export type TenantScopedTable = Table & { tenantId: Parameters<typeof eq>[0] };

/**
 * Tables whose rows belong to exactly one tenant.
 *
 * The membership rule is deliberately about the row, not about today's query
 * paths: *does this row belong to one tenant?* That has an objective answer.
 * The tempting alternative — "is it reachable only through an already-scoped
 * parent?" — is a claim about the routes that happen to exist, and it stops
 * being true the moment someone adds one. So `acp_events` is scoped even though
 * it is only ever read through its session, and the copy is held honest by a
 * composite FK rather than by the rule.
 */
export const TENANT_SCOPED_TABLES = {
  nodes,
  provisionedRuntimes,
  enrollmentTokens,
  stations,
  stationAudit,
  acpSessions,
  acpEvents,
  acpRuns,
  bridgeDispatches,
  agentTasks,
  cloudflareSandboxes,
} as const satisfies Record<string, TenantScopedTable>;

/**
 * Tables that deliberately belong to no tenant, and why.
 *
 * These need an argument, not an omission — an exemption without a reason is a
 * todo — so the reason lives here and the guard test asserts every entry has
 * one. Keyed by SQL table name so the guard can compare against the schema.
 */
export const TENANT_EXEMPT_TABLES: Record<string, { table: Table; reason: string }> = {
  tenants: {
    table: tenants,
    reason:
      "It IS the boundary. A tenant inside a tenant is the membership/hierarchy model the " +
      "Organization plane owns, and building it here is what MT-1 (#145) was rewritten to avoid.",
  },

  // ── The Better Auth family ────────────────────────────────────────────────
  //
  // AgentPod declares these four tables but does not own them: Better Auth
  // inserts, updates and deletes them through its own adapter, so a NOT NULL
  // `tenant_id` here is a column AgentPod would have to populate on writes it
  // does not make. Every such write is a signup, a login or a token refresh.
  //
  // The deeper reason is the strategy's, not convenience: principals belong to
  // the Organization plane, which owns "Principal, Team, Role, objective,
  // identity mappings, authority". Pinning a user to an AgentPod-local tenant
  // models the org in the wrong plane and would have to be migrated out — the
  // exact objection that reshaped MT-1. AgentPod scopes its own rows and
  // consumes principals; it does not own them.
  //
  // What a user is *allowed to reach* is therefore not answered here. It is
  // answered today by the bootstrap constant in the auth middleware, and later
  // by a membership lookup at the same layer — see `resolveTenantId`.
  principal_identities: {
    table: principalIdentities,
    reason:
      "Hangs off `user`, which is exempt for the same reason: a principal is not INSIDE a fleet, " +
      "it reaches one. The mapping says a person here is the same person on Matrix or kaambaan, " +
      "which is true regardless of which fleet they reach — a tenant column would imply an " +
      "identity could differ per fleet, and it cannot. " +
      "REVISIT IF THIS BECOMES REACHABLE OVER AN API: nothing today lists these rows, and every " +
      "lookup is by principal id or by an external id the caller already holds. A route that " +
      "listed them would leak one tenant's people to another, and that route would need scoping " +
      "this table does not have.",
  },

  user: {
    table: user,
    reason:
      "Better Auth owns the lifecycle of this table; the Organization plane owns principals. " +
      "A user is not inside an AgentPod fleet — it reaches one, which is a membership question " +
      "and not this plane's to answer.",
  },
  session: {
    table: session,
    reason:
      "Better Auth writes this on every login and refresh. Belongs to a user, and a user " +
      "belongs to no AgentPod tenant.",
  },
  account: {
    table: account,
    reason:
      "OAuth provider linkage, written by Better Auth. A GitHub identity is a property of a " +
      "principal, not of a fleet.",
  },
  jwks: {
    table: jwks,
    reason:
      "The issuer's signing keys. Deliberately instance-wide, not per-tenant: the hub signs " +
      "every token with one key set, and peers verify against ONE published JWKS — a per-tenant " +
      "key would mean a verifier had to know which tenant a token belonged to before it could " +
      "check the signature that tells it, which is backwards. The tenant a token names travels " +
      "INSIDE it, as the `tenant` claim " +
      "(fixtures/ecosystem-identity/token_claims.json).",
  },

  verification: {
    table: verification,
    reason:
      "Email-verification and password-reset challenges, written by Better Auth and keyed by " +
      "an email address that no tenant owns.",
  },

  // ── Instance-wide ─────────────────────────────────────────────────────────
  system_settings: {
    table: systemSettings,
    reason:
      "One key-value row per setting for the whole hub — whether signup is open, for instance. " +
      "Per-tenant configuration would be a different table with a different primary key, not a " +
      "column added to this one.",
  },
  admin_audit_log: {
    table: adminAuditLog,
    reason:
      "Records instance-admin actions, which cross tenants by definition: banning a user or " +
      "changing a role is not an act performed inside a fleet. Scoping it would either lose " +
      "those rows or force them into a tenant that did not perform them. Per-tenant activity " +
      "is station_audit, which IS scoped.",
  },
};

/**
 * The tenant predicate, always bound first.
 *
 * Ordering is kaambaan's invariant and it costs nothing to keep: the tenant is
 * never one condition among several that a later edit might reorder away.
 */
export function tenantScope<T extends TenantScopedTable>(
  table: T,
  tenantId: string,
  ...extra: (SQL | undefined)[]
): SQL {
  assertTenantId(tenantId);

  const registered = Object.values(TENANT_SCOPED_TABLES) as readonly Table[];
  if (!registered.includes(table as Table)) {
    throw new TenantIsolationError(
      `table "${getTableName(table as Table)}" is not registered as tenant-scoped`,
    );
  }

  // `and()` with a single argument still returns a SQL node, so the non-null
  // assertion is safe: the tenant predicate is always present.
  return and(eq(table.tenantId, tenantId), ...extra)!;
}

/**
 * A select that is structurally incapable of crossing tenants.
 *
 * For the plain case. Queries that project columns or join should compose
 * `tenantScope()` into their own `.where()` instead — the predicate is the part
 * that has to be right, and wrapping a builder that cannot express a join would
 * only push those call sites back to a raw `db.select()`.
 */
export function tenantScopedSelect<T extends TenantScopedTable>(
  table: T,
  tenantId: string,
  ...extra: (SQL | undefined)[]
) {
  const where = tenantScope(table, tenantId, ...extra);
  return db.select().from(table as never).where(where);
}
