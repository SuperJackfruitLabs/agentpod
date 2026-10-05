import { pgTable, text, jsonb, timestamp, integer, unique, boolean, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { stations } from "./stations";

/**
 * What this system has actually written to a station, and the gateway it was
 * written under. The pid is the restart evidence `awaiting-restart` needs:
 * Hermes multiplexes one gateway across profiles, so that pid IS the process
 * that re-reads config. See plan ruling R2.
 *
 * Keyed on (tenantId, stationId, settingId) — no nullable column in that key,
 * unlike `declared_harness_config`'s fleet/node levels, so a plain unique
 * constraint is correct here: Postgres only treats NULL as distinct from NULL,
 * and nothing in this key can be NULL.
 */
export const appliedHarnessConfig = pgTable(
  "applied_harness_config",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    stationId: text("station_id").notNull().references(() => stations.id, { onDelete: "cascade" }),
    settingId: text("setting_id").notNull(),
    value: jsonb("value").notNull(),
    gatewayPid: integer("gateway_pid"),
    gatewayUptimeSec: integer("gateway_uptime_sec"),
    appliedAt: timestamp("applied_at").defaultNow().notNull(),
  },
  (t) => [unique("applied_cfg_station_setting").on(t.tenantId, t.stationId, t.settingId)],
);

export type AppliedHarnessConfigRow = typeof appliedHarnessConfig.$inferSelect;
export type InsertAppliedHarnessConfigRow = typeof appliedHarnessConfig.$inferInsert;

/**
 * An operator's explicit exemption. Exactly one of `stationKey` / `nodeId` is
 * set — the level CHECK below makes any other row unrepresentable, and there
 * is deliberately no fleet level (D9: `fleet config unset` already says that).
 *
 * `optedOut` is a boolean rather than the row's mere existence because D9 says
 * station beats node, and that is only expressible if a station row can say
 * "NOT exempt" against a node row that says "exempt". See the plan's R1.
 *
 * Keyed on the station KEY, not the station row id, so an exemption survives
 * unadopt and re-adopt.
 */
export const harnessConfigOptOut = pgTable(
  "harness_config_opt_out",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    stationKey: text("station_key"),
    nodeId: text("node_id"),
    settingId: text("setting_id").notNull(),
    optedOut: boolean("opted_out").notNull().default(true),
    reason: text("reason"),
    optedOutBy: text("opted_out_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    check(
      "cfg_opt_out_one_level",
      sql`(${t.stationKey} IS NULL) <> (${t.nodeId} IS NULL)`,
    ),
  ],
);

export type HarnessConfigOptOutRow = typeof harnessConfigOptOut.$inferSelect;
export type InsertHarnessConfigOptOutRow = typeof harnessConfigOptOut.$inferInsert;
