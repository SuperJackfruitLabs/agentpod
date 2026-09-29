/**
 * The Live Activity token store against Postgres: the two keys (spec A1), the
 * upserts that replace a device's token rather than adding one, and deletion.
 * The same assertions run against the in-memory store the unit tests use, so
 * the two cannot drift apart.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { like } from "drizzle-orm";

import { ensurePgMigrations } from "../helpers/pg-migrations";
import { db } from "../../src/db/drizzle";
import { liveActivityTokens } from "../../src/db/schema/live-activity";
import {
  dbLiveActivityTokenStore,
  memoryLiveActivityTokenStore,
  type LiveActivityTokenStore,
} from "../../src/services/push/fleet/tokens";

const U = "@test-live-activity-a:id.agentpod.dev";
const V = "@test-live-activity-b:id.agentpod.dev";
const hex = (c: string) => c.repeat(64);

async function wipe() {
  await db.delete(liveActivityTokens).where(like(liveActivityTokens.userId, "@test-live-activity-%"));
}

beforeAll(async () => {
  await ensurePgMigrations();
  await wipe();
});
afterAll(wipe);

const stores: Array<[string, () => LiveActivityTokenStore]> = [
  ["postgres", () => dbLiveActivityTokenStore],
  ["memory", () => memoryLiveActivityTokenStore()],
];

describe.each(stores)("the %s token store", (_name, make) => {
  let store: LiveActivityTokenStore;
  beforeEach(async () => {
    await wipe();
    store = make();
  });

  test("one start token per device: a new one replaces the old", async () => {
    await store.upsert({ userId: U, deviceId: "D1", kind: "start", activityId: null, token: hex("a"), environment: "production" });
    await store.upsert({ userId: U, deviceId: "D1", kind: "start", activityId: null, token: hex("b"), environment: "sandbox" });
    await store.upsert({ userId: U, deviceId: "D2", kind: "start", activityId: null, token: hex("c"), environment: "production" });
    const rows = (await store.list(U)).filter((r) => r.kind === "start");
    expect(rows.map((r) => [r.deviceId, r.token, r.environment]).sort()).toEqual([
      ["D1", hex("b"), "sandbox"],
      ["D2", hex("c"), "production"],
    ]);
  });

  test("one update token per activity, beside the device's start token", async () => {
    await store.upsert({ userId: U, deviceId: "D1", kind: "start", activityId: null, token: hex("a"), environment: "production" });
    await store.upsert({ userId: U, deviceId: "D1", kind: "update", activityId: "act-1", token: hex("d"), environment: "production" });
    await store.upsert({ userId: U, deviceId: "D1", kind: "update", activityId: "act-1", token: hex("e"), environment: "production" });
    await store.upsert({ userId: U, deviceId: "D1", kind: "update", activityId: "act-2", token: hex("f"), environment: "production" });
    const rows = await store.list(U);
    expect(rows.filter((r) => r.kind === "update").map((r) => [r.activityId, r.token]).sort()).toEqual([
      ["act-1", hex("e")],
      ["act-2", hex("f")],
    ]);
    expect(rows.filter((r) => r.kind === "start")).toHaveLength(1);
  });

  test("a user sees only their own tokens", async () => {
    await store.upsert({ userId: U, deviceId: "D1", kind: "start", activityId: null, token: hex("a"), environment: "production" });
    await store.upsert({ userId: V, deviceId: "D1", kind: "start", activityId: null, token: hex("b"), environment: "production" });
    expect((await store.list(U)).map((r) => r.token)).toEqual([hex("a")]);
  });

  test("delete by key: a device's start token, one activity's update token, or all of a device's update tokens", async () => {
    await store.upsert({ userId: U, deviceId: "D1", kind: "start", activityId: null, token: hex("a"), environment: "production" });
    await store.upsert({ userId: U, deviceId: "D1", kind: "update", activityId: "act-1", token: hex("d"), environment: "production" });
    await store.upsert({ userId: U, deviceId: "D1", kind: "update", activityId: "act-2", token: hex("e"), environment: "production" });

    expect(await store.remove(U, { kind: "update", deviceId: "D1", activityId: "act-1" })).toBe(1);
    expect((await store.list(U)).map((r) => r.activityId).sort()).toEqual(["act-2", null].sort() as never);

    expect(await store.remove(U, { kind: "update", deviceId: "D1" })).toBe(1);
    expect(await store.remove(U, { kind: "start", deviceId: "D1" })).toBe(1);
    expect(await store.list(U)).toEqual([]);
    expect(await store.remove(U, { kind: "start", deviceId: "D1" })).toBe(0);
  });

  test("a token APNs refused is deleted wherever it is", async () => {
    await store.upsert({ userId: U, deviceId: "D1", kind: "update", activityId: "act-1", token: hex("d"), environment: "production" });
    await store.removeToken(U, hex("d"));
    expect(await store.list(U)).toEqual([]);
  });

  test("the readers with an activity up, for a restart to pick back up", async () => {
    await store.upsert({ userId: U, deviceId: "D1", kind: "update", activityId: "act-1", token: hex("d"), environment: "production" });
    await store.upsert({ userId: V, deviceId: "D1", kind: "start", activityId: null, token: hex("b"), environment: "production" });
    const readers = (await store.readersWithUpdateTokens()).filter((r) => r.startsWith("@test-live-activity-"));
    expect(readers).toEqual([U]);
  });
});
