import { pgTable, text, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * What the fleet wants a harness setting to be.
 *
 * One row per (setting, level). A level is a station, a node, or the fleet —
 * and exactly one of `stationId`/`nodeId` is set, or neither for the fleet.
 * Two set is not a level, which the contract's `DeclaredSetting` refuses and
 * the unique indexes below cannot express, so the service checks it
 * (`assertOneLevel` in `services/harness-config.ts`).
 *
 * This table says nothing about what any station HAS. Observations are read
 * live from the node and never cached here: a cached observation is a claim
 * about a machine that may have changed since, which is the class of bug this
 * whole design exists to end.
 *
 * Three levels, three constraints, because Postgres treats NULLs as distinct
 * in a unique index:
 *   - `declared_cfg_station` constrains real station rows (stationId not null).
 *   - `declared_cfg_node` constrains real node rows (nodeId not null).
 *   - `declared_cfg_fleet`, a PARTIAL index added by hand to the generated
 *     migration (drizzle's builder cannot express a WHERE clause on an
 *     index), constrains fleet rows (both null). Without it, Postgres would
 *     happily hold any number of fleet-level declarations for the same
 *     setting — the two ordinary unique indexes above never see a fleet row
 *     as a duplicate of another, because NULL never equals NULL.
 */
export const declaredHarnessConfig = pgTable(
  "declared_harness_config",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    settingId: text("setting_id").notNull(),
    /** Null for a node-level or fleet-level declaration. */
    stationId: text("station_id"),
    /** Null for a station-level or fleet-level declaration. */
    nodeId: text("node_id"),
    /** The declared value, as the harness would hold it. */
    value: jsonb("value").notNull(),
    declaredBy: text("declared_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    // One declaration per level. Postgres treats NULLs as distinct in a unique
    // index, so the fleet level needs its own partial index below rather than
    // relying on this one.
    perStation: uniqueIndex("declared_cfg_station").on(t.tenantId, t.settingId, t.stationId),
    perNode: uniqueIndex("declared_cfg_node").on(t.tenantId, t.settingId, t.nodeId),
    bySetting: index("declared_cfg_setting").on(t.tenantId, t.settingId),
  }),
);

export type DeclaredHarnessConfigRow = typeof declaredHarnessConfig.$inferSelect;
export type InsertDeclaredHarnessConfigRow = typeof declaredHarnessConfig.$inferInsert;
