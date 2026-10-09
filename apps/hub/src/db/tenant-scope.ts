/**
 * The tenant isolation guard.
 *
 * Isolation is a property of the data-access layer, not a filter every caller
 * has to remember to add. The principle is superpipeline's — *"there is NO unscoped
 * query builder"* — and it is the strongest thing in either codebase; the
 * implementation is not, because superpipeline builds raw SQL strings for D1 and this
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
import { matrixBoardRooms } from "./schema/board-rooms";
import { bridgeAgents, bridgeBoardSettings, bridgeDispatches } from "./schema/bridge";
import { adminAuditLog, systemSettings } from "./schema/admin";
import { stationAudit } from "./schema/audit";
import {
  matrixAsTransactions,
  matrixElicitationEvents,
  matrixGateEvents,
  matrixRooms,
  matrixMissions,
  matrixMissionMembers,
  matrixSpaces,
} from "./schema/matrix";
import { legacyUserPrincipals } from "./schema/legacy-user-principals";
import { userIdRewrites } from "./schema/user-id-rewrites";
import { hubOperators } from "./schema/operators";
import { liveActivityTokens } from "./schema/live-activity";
import { matrixCredentialAuthorizations } from "./schema/matrix-credentials";
import { stationGitIdentities } from "./schema/git-identities";
import { declaredHarnessConfig } from "./schema/harness-config";
import { appliedHarnessConfig, harnessConfigOptOut } from "./schema/harness-config-ops";
import { agentTasks, cloudflareSandboxes } from "./schema/cloudflare";
import { enrollmentTokens, nodes, provisionedRuntimes } from "./schema/nodes";
import { stations } from "./schema/stations";
import { stationSetups } from "./schema/station-setup";
import { stationTranscription } from "./schema/transcription";
import { stationSpeech } from "./schema/speech";
import {
  skillArtifacts,
  skillOperations,
  trustedSkillReleaseArtifacts,
  trustedSkillReleases,
  skillReleaseCohorts,
} from "./schema/skills";
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
 * Stricter than superpipeline's equivalent, which only checks for a non-empty string.
 * The extra check earns its place across the seam: `tnt_5f2b8c1a9d3e4076` is a
 * perfectly well-formed *superpipeline* tenant naming a boundary in a different
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
  skillArtifacts,
  skillOperations,
  trustedSkillReleases,
  trustedSkillReleaseArtifacts,
  skillReleaseCohorts,
  stationSetups,
  stationTranscription,
  stationSpeech,
  stationAudit,
  acpSessions,
  acpEvents,
  acpRuns,
  bridgeAgents,
  bridgeBoardSettings,
  bridgeDispatches,
  agentTasks,
  cloudflareSandboxes,
  matrixRooms,
  matrixGateEvents,
  matrixElicitationEvents,
  matrixBoardRooms,
  matrixMissions,
  matrixMissionMembers,
  matrixSpaces,
  matrixCredentialAuthorizations,
  stationGitIdentities,
  declaredHarnessConfig,
  appliedHarnessConfig,
  harnessConfigOptOut,
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

  // ── People, whose accounts and principals live at the organization plane ─────
  //
  // The hub's own `user`, `principals`, `principal_identities` and `principal_grants` were
  // dropped after the rollback window (P3 plan, Task 17). What is left here keys on a person's
  // `prn_`, and a person is not inside a fleet — they reach one.
  legacy_user_principals: {
    table: legacyUserPrincipals,
    reason:
      "The permanent copy of the old `principal_identities` better-auth rows, kept after the " +
      "org-plane cutover so a pre-cutover hub user id (superpipeline's `decided_by_hub_sub`) still " +
      "resolves. A person is not inside a fleet, they reach one. Read " +
      "only by `GET /api/evidence/principals/:id`, by an id the caller already holds; nothing lists it.",
  },

  user_id_rewrites: {
    table: userIdRewrites,
    reason:
      "The cutover script's per-row record of which user id it rewrote to which prn_. Written " +
      "only by that script (removed with the auth tables), read only by migration 0096's guard; " +
      "no route reads it. Its rows name rows of tenant-scoped tables, but the rewrite covered the " +
      "whole hub at once, never one fleet.",
  },

  hub_operators: {
    table: hubOperators,
    reason:
      "Who may operate this hub, by principal id (decision D4) — the hub's own seat, what " +
      "`user.role = 'admin'` was before the org plane. An operator operates the hub, not one " +
      "fleet inside it, and admin was never tenant-scoped. Read " +
      "only by `isUserAdmin` for an id the caller already holds; nothing lists it.",
  },


  matrix_as_transactions: {
    table: matrixAsTransactions,
    reason:
      "Applied Application Service transaction ids, so a homeserver's retry is a no-op rather " +
      "than a second conversation. A transaction id is the HOMESERVER's counter, not a fact " +
      "about any tenant — it names an envelope, and the events inside it belong to whichever " +
      "tenants their rooms do. Scoping this would mean asking which tenant a retry belongs to " +
      "before reading what is in it, which is backwards, and would let one tenant's replay " +
      "re-deliver another's.",
  },

  live_activity_tokens: {
    table: liveActivityTokens,
    reason:
      "A PERSON's phone, keyed by the Matrix id the homeserver vouched for — a person is not " +
      "inside a fleet, they reach one. The card these " +
      "tokens receive is built per reader from the rooms that reader owns (`readerForRoom`), so " +
      "which fleet's work reaches the phone is decided where the content is built, not here. " +
      "Nothing lists these rows over an API: the only routes write and delete the caller's own, " +
      "by the user id whoami returned.",
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
      "Records instance-admin actions, which cross tenants by definition: changing a hub-wide " +
      "setting is not an act performed inside a fleet. Scoping it would either lose " +
      "those rows or force them into a tenant that did not perform them. Per-tenant activity " +
      "is station_audit, which IS scoped.",
  },
};

/**
 * The tenant predicate, always bound first.
 *
 * Ordering is superpipeline's invariant and it costs nothing to keep: the tenant is
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
