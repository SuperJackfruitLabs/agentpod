/**
 * The APNs tokens the fleet Live Activity is pushed to (spec A1).
 *
 * Two kinds in one table, told apart by `kind`:
 * - `start` — a device's push-to-start token (iOS 17.2+), one per
 *   `(user_id, device_id)`. The hub starts the fleet card with it when the
 *   reader has no activity up.
 * - `update` — one running activity's token, one per
 *   `(user_id, device_id, activity_id)`. The hub updates and ends that card
 *   with it, and deletes it after the end.
 *
 * `user_id` is the Matrix id the homeserver's `whoami` returned for the
 * app's access token — the reader, never a value the app asserted. Partial
 * unique indexes carry the two keys; a token APNs refuses (410,
 * `BadDeviceToken`) is deleted.
 */
import { sql } from "drizzle-orm";
import { check, index, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const liveActivityTokens = pgTable(
  "live_activity_tokens",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id").notNull(),
    /** `start` | `update`. */
    kind: text("kind").notNull(),
    /** ActivityKit's id for the activity an update token belongs to; null for a start token. */
    activityId: text("activity_id"),
    /** Lowercase hex. */
    token: text("token").notNull(),
    /** `production` | `sandbox` — which APNs host the token belongs to. */
    environment: text("environment").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("live_activity_tokens_start_key")
      .on(t.userId, t.deviceId)
      .where(sql`${t.kind} = 'start'`),
    uniqueIndex("live_activity_tokens_update_key")
      .on(t.userId, t.deviceId, t.activityId)
      .where(sql`${t.kind} = 'update'`),
    index("live_activity_tokens_user_idx").on(t.userId),
    check("live_activity_tokens_kind_check", sql`${t.kind} IN ('start', 'update')`),
    check("live_activity_tokens_environment_check", sql`${t.environment} IN ('production', 'sandbox')`),
    check(
      "live_activity_tokens_activity_check",
      sql`(${t.kind} = 'start' AND ${t.activityId} IS NULL) OR (${t.kind} = 'update' AND ${t.activityId} IS NOT NULL)`
    ),
  ]
);
