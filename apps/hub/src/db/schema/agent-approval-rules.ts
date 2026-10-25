import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { stations } from "./stations";
import { tenants } from "./tenants";

/**
 * An agent's standing "Always allow" approval rules (approval scopes, part 2). A workspace owner or
 * admin sets one on the agent's station; it binds the occupant at the time (`principal_id`), so a
 * new occupant never inherits it. The hub sends the active rules to Salaam at admission and every
 * renewal; Salaam pins them per run and drops one at the first renewal that no longer lists it.
 *
 * v1 has one scope, `workspace-write`: writes inside the workspace, never deletes, hidden paths,
 * commands, network or anything outside it (Salaam enforces this, not the hub).
 */
export const agentApprovalRules = pgTable(
  "agent_approval_rules",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    stationId: text("station_id")
      .notNull()
      .references(() => stations.id, { onDelete: "cascade" }),
    principalId: text("principal_id").notNull(),
    scope: text("scope").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
    revokedBy: text("revoked_by"),
  },
  (t) => [
    index("agent_approval_rules_station_idx").on(t.stationId),
    // One live rule per occupant and scope.
    uniqueIndex("agent_approval_rules_live_idx")
      .on(t.stationId, t.principalId, t.scope)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);
export type AgentApprovalRule = typeof agentApprovalRules.$inferSelect;
