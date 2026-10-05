import { pgTable, text, jsonb, timestamp, integer, unique } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

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
    stationId: text("station_id").notNull(),
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
 * An operator's explicit opt-out. Keyed on the STATION KEY rather than the row
 * id so it survives unadopt/re-adopt (ruling R1's stated mitigation).
 */
export const harnessConfigOptOut = pgTable(
  "harness_config_opt_out",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    stationKey: text("station_key").notNull(),
    settingId: text("setting_id").notNull(),
    reason: text("reason"),
    optedOutBy: text("opted_out_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("cfg_opt_out_key_setting").on(t.tenantId, t.stationKey, t.settingId)],
);

export type HarnessConfigOptOutRow = typeof harnessConfigOptOut.$inferSelect;
export type InsertHarnessConfigOptOutRow = typeof harnessConfigOptOut.$inferInsert;
