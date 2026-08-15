/**
 * Principal identities — the same person or agent, known by another system.
 *
 * The Organization plane owns principals and their identity mappings
 * (charter decisions/2026-08-13-ecosystem-identity.md). It does not exist. So
 * this is the same manoeuvre the tenancy decision already proved
 * (decisions/2026-08-15-tenancy-is-local-and-mapped.md): each plane keeps what
 * it legitimately owns and records an *optional* mapping to the same real
 * identity elsewhere, so adopting a canonical principal later is a data move
 * rather than a redesign.
 *
 * A TABLE rather than columns on `user`, which is where this differs from
 * tenancy: a tenant maps to one external organisation, but a principal is
 * legitimately known to several systems at once — Matrix, kaambaan, and
 * eventually the Organization plane. Columns would mean a migration per system.
 *
 * **This is a record of sameness, never a grant.** Nothing may read authority
 * out of it. The moment something does, the Organization plane has been built by
 * accident, in the wrong repository, without the control pair that was supposed
 * to come with it. That risk is named in the layer plan and it is named here
 * because this table is where it would happen.
 */

import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * The systems a principal can be known to.
 *
 * Deliberately a CHECK rather than a Postgres enum: adding a system should be a
 * one-line migration, and an enum makes removing one painful. `org-plane` is
 * listed before it exists, because the whole point is that adopting it is a
 * data move.
 */
export const IDENTITY_SYSTEMS = ["matrix", "kaambaan", "org-plane"] as const;
export type IdentitySystem = (typeof IDENTITY_SYSTEMS)[number];

export const principalIdentities = pgTable(
  "principal_identities",
  {
    id: text("id").primaryKey(),

    /** The local principal. Today a Better Auth user; a canonical principal later. */
    principalId: text("principal_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    /** Which system knows them. */
    system: text("system").notNull(),

    /**
     * That system's id for them — `@olivia:id.agentpod.dev`, a `tnt_`-scoped
     * principal id, whatever the Organization plane eventually mints.
     *
     * Deliberately opaque: no grammar is imposed, for the same reason kaambaan's
     * migration 0002 imposes none on its external ids. A shape assumption here
     * would be a shape assumption about a system that has not been built.
     */
    externalId: text("external_id").notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    /**
     * One external identity belongs to at most one principal.
     *
     * This is the constraint that makes the table usable for the thing it
     * exists for: an Application Service bridge asking "who sent this Matrix
     * message" needs one answer. Two principals claiming one mxid would make
     * that question unanswerable exactly when it matters — attributing a human's
     * approval, which charter decisions/2026-08-14-approvals-cross-planes-as-events.md
     * says must carry its sender or kaambaan's separation-of-duties check is void.
     */
    uniqueIndex("principal_identities_system_external_idx").on(t.system, t.externalId),

    /**
     * And at most one identity per system per principal. A person has one Matrix
     * account here, not three; the reverse direction ("which mxid do I message
     * this principal at") needs a single answer too.
     */
    uniqueIndex("principal_identities_principal_system_idx").on(t.principalId, t.system),

    index("principal_identities_principal_idx").on(t.principalId),

    check(
      "principal_identities_system_known",
      sql`${t.system} IN ('matrix', 'kaambaan', 'org-plane')`
    ),

    /** An empty external id is not a mapping; it is a row that looks like one. */
    check("principal_identities_external_id_present", sql`length(${t.externalId}) > 0`),
  ]
);
