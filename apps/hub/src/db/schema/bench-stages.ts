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
  /** The hub never clears this stage's benches (`--keep-bench`); off, a card's bench is cleared once the card is done, cancelled or dormant. */
  keepBench: boolean("keep_bench").notNull().default(false),
  /**
   * `one-shot`: the bench host's node runs the stage's worker as one task. `remote`: the station's
   * agent works in the card's bench from its own node, and `bench_node_id` is the bench host's node.
   * Both follow the profile (its `executor`), written together by `upsertStage`.
   */
  execution: text("execution").notNull().default("one-shot"),
  benchNodeId: text("bench_node_id"),
  profile: text("profile").notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.name] }),
  uniqueIndex("bench_stages_selector_idx").on(t.tenantId, t.boardId, t.stationId),
  check("bench_stages_origin", sql`${t.origin} IN ('fleet','file')`),
  check("bench_stages_execution", sql`${t.execution} IN ('one-shot','remote')`),
  check("bench_stages_remote_bench_node", sql`(${t.execution} = 'remote') = (${t.benchNodeId} IS NOT NULL)`),
]);
export type BenchStageRow = typeof benchStages.$inferSelect;
