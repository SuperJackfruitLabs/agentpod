/**
 * The tenant-isolation guard.
 *
 * AgentPod had no isolation boundary at all: every row hung off a `user_id` and
 * nothing above it. This suite pins the boundary's *shape* — which tables carry
 * a tenant, which deliberately do not, and that a scoped query cannot be built
 * without a tenant.
 *
 * The important test here is `every table in the schema is classified`. A list
 * someone has to remember to update is not a guard; #308 made that point for id
 * collisions by showing every validator every other entity's minted id rather
 * than enumerating the pairs that had gone wrong so far. The equivalent here is
 * to enumerate the *schema* rather than the whitelist: adding a table without
 * deciding whether it belongs to a tenant fails, and the decision is recorded in
 * code with a reason rather than left to review.
 *
 * No database — this is the config-level half. That the columns and constraints
 * actually reached Postgres is `tests/integration/tenant-isolation.test.ts`,
 * because a column declared in TypeScript and never migrated would pass every
 * assertion in this file and isolate nothing.
 */

import { describe, expect, test } from "bun:test";
import { eq, getTableName, is, Table } from "drizzle-orm";

import * as schema from "../../src/db/schema";
import {
  BOOTSTRAP_TENANT_ID,
  TENANT_EXEMPT_TABLES,
  TENANT_SCOPED_TABLES,
  TenantIsolationError,
  tenantScope,
  tenantScopedSelect,
} from "../../src/db/tenant-scope";
import { TenantId } from "@agentpod/contract";

/** Every Drizzle table the schema module exports, by SQL name. */
const allSchemaTables = (): string[] =>
  [...new Set(Object.values(schema).filter((v) => is(v, Table)).map((t) => getTableName(t as Table)))].sort();

const scopedNames = (): string[] =>
  Object.values(TENANT_SCOPED_TABLES).map((t) => getTableName(t)).sort();

const exemptNames = (): string[] => Object.keys(TENANT_EXEMPT_TABLES).sort();

describe("tenant guard — every table is a decision", () => {
  test("every table in the schema is classified as scoped or exempt", () => {
    // THE GUARD. Not a list of tables someone remembered: the schema itself is
    // the source, so a new pgTable that belongs to a tenant and was never scoped
    // fails here on the commit that adds it, with no test to remember to write.
    const classified = new Set([...scopedNames(), ...exemptNames()]);
    const unclassified = allSchemaTables().filter((t) => !classified.has(t));

    expect(unclassified).toEqual([]);
  });

  test("no table is both scoped and exempt", () => {
    const exempt = new Set(exemptNames());
    expect(scopedNames().filter((t) => exempt.has(t))).toEqual([]);
  });

  test("nothing is classified that is not in the schema", () => {
    // The mirror: a stale entry left behind by a dropped table would make the
    // guard above pass while covering a table that no longer exists.
    const known = new Set(allSchemaTables());
    expect([...scopedNames(), ...exemptNames()].filter((t) => !known.has(t))).toEqual([]);
  });

  test("every scoped table actually carries a tenantId column", () => {
    const missing = Object.entries(TENANT_SCOPED_TABLES)
      .filter(([, t]) => !("tenantId" in t))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  test("no exempt table carries a tenantId column", () => {
    // Catches the half-done change: a table given a tenant_id column but never
    // added to the whitelist would be scoped in the database and unscoped in
    // every query — the worst of both, and invisible without this.
    const stray = Object.entries(TENANT_EXEMPT_TABLES)
      .filter(([, e]) => "tenantId" in e.table)
      .map(([name]) => name);
    expect(stray).toEqual([]);
  });

  test("every exemption records why", () => {
    // An exemption without a reason is a todo. These are the ones that need a
    // real argument, so the argument has to be written down next to the entry.
    for (const [name, entry] of Object.entries(TENANT_EXEMPT_TABLES)) {
      expect(entry.reason.length, `${name} must record why it is not tenant-scoped`).toBeGreaterThan(
        30,
      );
    }
  });
});

describe("tenant guard — unscoped tables are legitimate, and stay refusable", () => {
  // These are what fails if the guard is made unconditional — if "every table
  // must be scoped" replaced the classification. Some tables genuinely belong to
  // no tenant, and a guard that cannot say so would force a meaningless tenant
  // onto them.
  test("the Better Auth family is exempt, not forgotten", () => {
    // AgentPod declares these tables but Better Auth owns their lifecycle: it
    // inserts and deletes them through its own adapter, so a NOT NULL column
    // AgentPod has to populate is a column Better Auth will not populate. The
    // strategy also assigns principals to the Organization plane, so pinning a
    // user to an AgentPod-local tenant would model the org in the wrong plane —
    // exactly what MT-1 (#145) was rewritten to avoid.
    for (const t of ["user", "session", "account", "verification"]) {
      expect(TENANT_EXEMPT_TABLES[t], `${t} must be an explicit exemption`).toBeDefined();
    }
  });

  test("instance-wide tables are exempt", () => {
    // system_settings is one row per key for the whole hub (signup open/closed);
    // admin_audit_log records instance-admin actions that cross tenants by
    // definition — banning a user is not an act inside a fleet.
    expect(TENANT_EXEMPT_TABLES["system_settings"]).toBeDefined();
    expect(TENANT_EXEMPT_TABLES["admin_audit_log"]).toBeDefined();
  });

  test("the tenants table is exempt from itself", () => {
    expect(TENANT_EXEMPT_TABLES["tenants"]).toBeDefined();
  });

  test("the exemption list is not empty", () => {
    // Guard the guard: if exemptions were ever removed as a concept, the tests
    // above would vanish with them and this one would not.
    expect(exemptNames().length).toBeGreaterThan(0);
  });
});

describe("tenant guard — a scoped predicate cannot be built without a tenant", () => {
  const TENANT = BOOTSTRAP_TENANT_ID;

  test("refuses a table that is not registered as tenant-scoped", () => {
    // The kaambaan principle, transferred: the helper is not a convenience that
    // also happens to filter. Asking it to scope `user` is a bug, and it says so
    // rather than quietly building a predicate against a column that is absent.
    expect(() => tenantScope(schema.user as never, TENANT)).toThrow(TenantIsolationError);
    expect(() => tenantScope(schema.systemSettings as never, TENANT)).toThrow(/not registered/);
  });

  test("refuses an absent, empty or blank tenant", () => {
    for (const bad of [undefined, null, "", "   "]) {
      expect(() => tenantScope(schema.nodes, bad as never)).toThrow(TenantIsolationError);
    }
  });

  test("refuses an id that is not an AgentPod tenant id", () => {
    // `tnt_…` is kaambaan's tenant, for rows in a different database. A value
    // that arrived across the seam must not silently become a predicate here.
    expect(() => tenantScope(schema.nodes, "tnt_5f2b8c1a9d3e4076")).toThrow(TenantIsolationError);
    expect(() => tenantScope(schema.nodes, "node_9f1c2ab04d7e6b3a5c88")).toThrow(
      TenantIsolationError,
    );
  });

  test("binds tenant_id as the first predicate, ahead of the caller's own", () => {
    // Ordering is the kaambaan invariant and it costs nothing to keep: the
    // tenant is never one condition among several that a later edit might
    // reorder away. Rendered rather than inspected — what matters is the SQL
    // that reaches Postgres, not the shape of the builder that produced it.
    const { sql, params } = tenantScopedSelect(
      schema.nodes,
      TENANT,
      eq(schema.nodes.userId, "some-user"),
    ).toSQL();

    expect(sql).toContain("tenant_id");
    expect(sql.indexOf("tenant_id")).toBeLessThan(sql.indexOf("user_id"));
    expect(params[0]).toBe(TENANT);
  });

  test("accepts a valid tenant on a registered table", () => {
    expect(() => tenantScope(schema.nodes, TENANT)).not.toThrow();
    expect(() => tenantScope(schema.acpEvents, TENANT)).not.toThrow();
  });
});

describe("the bootstrap tenant", () => {
  test("is a valid AgentPod tenant id by the shared corpus grammar", () => {
    // Same validator the ecosystem-identity corpus drives, so the hub and the
    // cross-repo fixture cannot drift on what a tenant id looks like.
    expect(TenantId.safeParse(BOOTSTRAP_TENANT_ID).success).toBe(true);
  });

  test("is deterministic, not minted", () => {
    // A fresh deploy and the live hub must land on the SAME tenant id without
    // coordinating — the migration creates this exact value on both.
    expect(BOOTSTRAP_TENANT_ID).toBe("fleet_00000000000000000000");
  });

  test("is not kaambaan's tenant id space", () => {
    expect(BOOTSTRAP_TENANT_ID.startsWith("tnt_")).toBe(false);
  });
});
