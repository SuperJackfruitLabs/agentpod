/**
 * The Organization plane's tables, living in the hub until the plane is extracted.
 *
 * `charter → decisions/2026-08-30-an-agent-is-a-principal.md`. The hub already
 * IS the issuer; it is the Organization plane on the same terms, and extraction
 * moves these rows without changing their meaning. That is what
 * `2026-08-15-one-issuer-and-offline-verification` meant by "only the issuer
 * URL changes".
 */
import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";

/** Fixed, for the same reason `BOOTSTRAP_TENANT_ID` is: a fresh deploy and the
 *  live hub must agree, and a random id cannot guarantee that. */
export const BOOTSTRAP_ORG_ID = "org_00000000000000000000";

export const PRINCIPAL_KINDS = ["human", "agent", "service"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [check("organizations_id_is_org", sql`${t.id} LIKE 'org\\_%'`)]
);

export const principals = pgTable(
  "principals",
  {
    id: text("id").primaryKey(),
    /**
     * Explicit, never inferred from which identities exist. An agent with no
     * identities linked yet is still an agent, and inference would default it
     * to human — which is the one wrong answer that fails open.
     */
    kind: text("kind").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /**
     * Immutable, and what an agent's mxid is built from. `display_name` moves;
     * this does not, exactly as Matrix separates an mxid from a displayname.
     */
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    check("principals_id_is_prn", sql`${t.id} LIKE 'prn\\_%'`),
    check("principals_kind_known", sql`${t.kind} IN ('human','agent','service')`),
    /** One handle, one principal: it is an address, and two claimants make the
     *  mxid it produces ambiguous. */
    uniqueIndex("principals_org_handle_idx").on(t.orgId, t.handle),
  ]
);
