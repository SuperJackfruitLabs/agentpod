import { jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

/**
 * Every value `scripts/rewrite-user-ids.ts` rewrote, per row: which column of which row went from
 * `old_value` to `new_value`. Forward writes it in the same transaction as the rewrite; `--reverse`
 * restores those rows from it first and then empties it.
 *
 * Why not `legacy_user_principals`: that table is keyed by the old id and answers "which principal
 * was this hub user", which evidence lookups depend on. An operator's `--map default-user=prn_x`
 * can send two old values to one prn_ (default-user and a real Better Auth id), so a value-level
 * map cannot say which rows held which old value — only a per-row record can, and a per-row record
 * is not a user→principal map (security review finding 3).
 *
 * `row_key` is the row's primary key as JSON (or, for a table without one, its first unique index
 * minus the rewritten columns). Empty while `ORG_PLANE_*` is unset: only the cutover script writes it.
 */
export const userIdRewrites = pgTable(
  "user_id_rewrites",
  {
    tableName: text("table_name").notNull(),
    columnName: text("column_name").notNull(),
    rowKey: jsonb("row_key").notNull(),
    oldValue: text("old_value").notNull(),
    newValue: text("new_value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tableName, t.columnName, t.rowKey] })],
);
