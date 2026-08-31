/**
 * Grants — the control pair, as data the issuer can read.
 *
 * Decision 4 of charter decisions/2026-08-13-ecosystem-identity.md gives the
 * Organization plane authority over two questions: who may dispatch which agent,
 * and who may grant an agent its reach. That decision also blessed an interim
 * where the grant lived as static configuration **provided it took the shape of
 * the eventual claim** — which it did (`CONTROL_PAIR_GRANTS`). This is the
 * eventual claim arriving.
 *
 * Values are bare principal ids (`prn_…`), matched by equality, per
 * decisions/2026-08-30-an-agent-is-a-principal.md §3 — which replaced the two
 * namespaced, pattern-matched forms this table used to carry with one
 * enumeration. A value that is not a recognised principal id is ignored rather
 * than refused — a claim is read by more planes over time, not fewer.
 *
 * **A grant is authority, unlike `principal_identities` next door, which is only
 * sameness.** The distinction is the whole reason they are two tables: reading
 * authority out of an identity mapping is how the Organization plane gets built
 * by accident. Here it is deliberate, and the table is named for it.
 */

import { sql } from "drizzle-orm";
import { pgTable, text, boolean, timestamp, check } from "drizzle-orm/pg-core";
import { principals } from "./organization";

export const principalGrants = pgTable(
  "principal_grants",
  {
    /**
     * One row per principal. The primary key IS the principal, because a
     * principal has one grant: two rows would be two answers to a question that
     * must have one, and "which row wins" is not a question an authorization
     * check should ever ask.
     */
    principalId: text("principal_id")
      .primaryKey()
      .references(() => principals.id, { onDelete: "cascade" }),

    /**
     * The ids of the agents this principal may dispatch.
     *
     * Stored as JSON text rather than a Postgres array: the value travels into a
     * JWT claim verbatim, and a round trip through `text[]` adds a shape
     * conversion at exactly the point where the wire format and the stored
     * format must not diverge.
     */
    mayDispatch: text("may_dispatch").notNull().default("[]"),

    /** The second half of the pair. Not optional — see the service. */
    mayGrantReach: boolean("may_grant_reach").notNull().default(false),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    /**
     * A JSON array, checked in the database as well as in the service.
     *
     * The service is where a good error message lives; this is where the
     * guarantee lives. A grant is authorization data, and the one thing worse
     * than a missing grant is a malformed one that some reader interprets
     * generously.
     */
    check("principal_grants_may_dispatch_is_array", sql`${t.mayDispatch} LIKE '[%]'`),
  ]
);
