/**
 * Bench stages: the hub's checkpoint profiles, one per stage, written by `fleet bench stage`.
 *
 * This replaces the hand-written private profile file and its two `hub.env` lines. `profile` is
 * the complete checkpoint profile as canonical JSON, built by the hub from the roster, the station
 * and the node's own registry reply, so its `registry_sha256` is the node's word, never typed.
 * No clone identity, argument or credential is stored here: those go to the node and stay there.
 *
 * `origin` is `fleet` for a stage written through the verbs, and `file` for a profile adopted from
 * the legacy file, which the hub does the first time it rewrites that node's registry (the node's
 * digest changes for every profile it serves, so the file's pin would be stale).
 */
import { pgTable, text, timestamp, primaryKey, uniqueIndex, check, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";

export const benchStages = pgTable("bench_stages", {
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /** The coordinator profile id: the node registry's profile id and the profile's `coordinatorProfileId`. */
  name: text("name").notNull(),
  boardId: text("board_id").notNull(),
  stationId: text("station_id").notNull(),
  /** The SuperPipeline stage this serves, when given: only used to name it in the printed policy's next step. */
  stageId: text("stage_id"),
  origin: text("origin").notNull(),
  /** Keep a card's bench after its checkpoint settles (`--keep-bench`); off means it is reclaimed. */
  keepBench: boolean("keep_bench").notNull().default(false),
  profile: text("profile").notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.name] }),
  uniqueIndex("bench_stages_selector_idx").on(t.tenantId, t.boardId, t.stationId),
  check("bench_stages_origin", sql`${t.origin} IN ('fleet','file')`),
]);
export type BenchStageRow = typeof benchStages.$inferSelect;
