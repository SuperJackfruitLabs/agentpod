/**
 * Where the fleet Live Activity's APNs tokens are kept (spec A1).
 *
 * An interface with two implementations — Postgres for the hub, memory for
 * unit tests — and `tests/integration/live-activity-tokens.test.ts` runs the
 * same assertions against both, so they cannot come to disagree.
 */

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../../db/drizzle";
import { liveActivityTokens } from "../../../db/schema/live-activity";
import type { ApnsEnvironment } from "../config";

export type LiveActivityTokenKind = "start" | "update";

export interface LiveActivityToken {
  userId: string;
  deviceId: string;
  kind: LiveActivityTokenKind;
  /** Null for a start token. */
  activityId: string | null;
  token: string;
  environment: ApnsEnvironment;
}

export interface LiveActivityTokenStore {
  /** A device's start token, or an activity's update token — replacing the one under the same key. */
  upsert(t: LiveActivityToken): Promise<void>;
  /**
   * Delete by key. An update with no `activityId` removes every update token
   * the device has (the app signing out). Returns how many went.
   */
  remove(userId: string, key: { kind: LiveActivityTokenKind; deviceId: string; activityId?: string }): Promise<number>;
  /** A token APNs refused. */
  removeToken(userId: string, token: string): Promise<void>;
  list(userId: string): Promise<LiveActivityToken[]>;
  /** Readers with at least one update token: an activity may be up. */
  readersWithUpdateTokens(): Promise<string[]>;
}

export const dbLiveActivityTokenStore: LiveActivityTokenStore = {
  async upsert(t) {
    const now = new Date();
    const values = { ...t, token: t.token.toLowerCase(), updatedAt: now };
    if (t.kind === "start") {
      await db
        .insert(liveActivityTokens)
        .values({ ...values, activityId: null })
        .onConflictDoUpdate({
          target: [liveActivityTokens.userId, liveActivityTokens.deviceId],
          targetWhere: sql`${liveActivityTokens.kind} = 'start'`,
          set: { token: values.token, environment: t.environment, updatedAt: now },
        });
    } else {
      await db
        .insert(liveActivityTokens)
        .values(values)
        .onConflictDoUpdate({
          target: [liveActivityTokens.userId, liveActivityTokens.deviceId, liveActivityTokens.activityId],
          targetWhere: sql`${liveActivityTokens.kind} = 'update'`,
          set: { token: values.token, environment: t.environment, updatedAt: now },
        });
    }
  },

  async remove(userId, key) {
    const conditions = [
      eq(liveActivityTokens.userId, userId),
      eq(liveActivityTokens.deviceId, key.deviceId),
      eq(liveActivityTokens.kind, key.kind),
    ];
    if (key.kind === "start") conditions.push(isNull(liveActivityTokens.activityId));
    else if (key.activityId !== undefined) conditions.push(eq(liveActivityTokens.activityId, key.activityId));
    const gone = await db
      .delete(liveActivityTokens)
      .where(and(...conditions))
      .returning({ id: liveActivityTokens.id });
    return gone.length;
  },

  async removeToken(userId, token) {
    await db
      .delete(liveActivityTokens)
      .where(and(eq(liveActivityTokens.userId, userId), eq(liveActivityTokens.token, token.toLowerCase())));
  },

  async list(userId) {
    const rows = await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.userId, userId));
    return rows.map((r) => ({
      userId: r.userId,
      deviceId: r.deviceId,
      kind: r.kind as LiveActivityTokenKind,
      activityId: r.activityId,
      token: r.token,
      environment: r.environment as ApnsEnvironment,
    }));
  },

  async readersWithUpdateTokens() {
    const rows = await db
      .selectDistinct({ userId: liveActivityTokens.userId })
      .from(liveActivityTokens)
      .where(eq(liveActivityTokens.kind, "update"));
    return rows.map((r) => r.userId);
  },
};

/** The same contract in memory, for unit tests. */
export function memoryLiveActivityTokenStore(): LiveActivityTokenStore {
  let rows: LiveActivityToken[] = [];
  const sameKey = (a: LiveActivityToken, b: LiveActivityToken) =>
    a.userId === b.userId &&
    a.deviceId === b.deviceId &&
    a.kind === b.kind &&
    (a.kind === "start" || a.activityId === b.activityId);
  return {
    async upsert(t) {
      const row = { ...t, token: t.token.toLowerCase(), activityId: t.kind === "start" ? null : t.activityId };
      rows = [...rows.filter((r) => !sameKey(r, row)), row];
    },
    async remove(userId, key) {
      const before = rows.length;
      rows = rows.filter(
        (r) =>
          !(
            r.userId === userId &&
            r.deviceId === key.deviceId &&
            r.kind === key.kind &&
            (key.kind === "start" || key.activityId === undefined || r.activityId === key.activityId)
          )
      );
      return before - rows.length;
    },
    async removeToken(userId, token) {
      rows = rows.filter((r) => !(r.userId === userId && r.token === token.toLowerCase()));
    },
    async list(userId) {
      return rows.filter((r) => r.userId === userId).map((r) => ({ ...r }));
    },
    async readersWithUpdateTokens() {
      return [...new Set(rows.filter((r) => r.kind === "update").map((r) => r.userId))];
    },
  };
}
