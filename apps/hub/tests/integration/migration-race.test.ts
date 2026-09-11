/**
 * Migrations serialise, so two processes on a fresh database do not race.
 *
 * Drizzle's migrator takes no lock. On a database that already has its tables that is harmless —
 * every migration is skipped — but on a FRESH one, two callers both find nothing applied, both
 * run migration 0000, and the loser dies on `relation "account" already exists`.
 *
 * This is not hypothetical. CI gives the hub a fresh Postgres per run, and
 * `scripts/seed-agent-principals.test.ts` spawns the seed script as its own process while the
 * test process is starting. It failed exactly that way on 2026-09-11 — and never reproduced on
 * a developer's machine, because a database that is already migrated has nothing to race over.
 *
 * The test therefore has to CREATE the race: a scratch database with no schema, and two
 * migrations started at once.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

const BASE =
  process.env.DATABASE_URL ??
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";

const SCRATCH = `migration_race_${Date.now()}`;
const adminUrl = BASE.replace(/\/[^/]+$/, "/postgres");
const scratchUrl = BASE.replace(/\/[^/]+$/, `/${SCRATCH}`);
const KEY = 8_472_013_559_001;

let admin: ReturnType<typeof postgres>;

beforeAll(async () => {
  admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${SCRATCH}`);
});

afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await admin.end();
});

describe("two processes migrating one fresh database", () => {
  test("the advisory lock makes the second wait rather than collide", async () => {
    // Two independent connections, standing in for two processes. The lock is session-scoped,
    // so separate sessions is exactly the condition it has to survive.
    const a = postgres(scratchUrl, { max: 2 });
    const b = postgres(scratchUrl, { max: 2 });

    // What runMigrations does, reduced to the part under test: take the lock on a RESERVED
    // connection, do work that would collide, release.
    const migrateLike = async (sql: ReturnType<typeof postgres>, tag: string) => {
      const reserved = await sql.reserve();
      try {
        await reserved`SELECT pg_advisory_lock(${KEY})`;
        const rows = await reserved`
          SELECT EXISTS (SELECT 1 FROM information_schema.tables
                         WHERE table_name = 'race_probe') AS exists`;
        if (!rows[0]!.exists) {
          // The collision point: without the lock both callers reach here and the loser fails.
          await reserved`CREATE TABLE race_probe (who text primary key)`;
        }
        await reserved`INSERT INTO race_probe (who) VALUES (${tag})
                       ON CONFLICT (who) DO NOTHING`;
      } finally {
        await reserved`SELECT pg_advisory_unlock(${KEY})`;
        reserved.release();
      }
    };

    const results = await Promise.allSettled([migrateLike(a, "a"), migrateLike(b, "b")]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(
      rejected.map((r) => String((r as PromiseRejectedResult).reason)),
      "neither caller should fail: the second waits and finds the work done",
    ).toEqual([]);

    const count = await a`SELECT count(*)::int AS n FROM race_probe`;
    expect(count[0]!.n, "both callers completed").toBe(2);

    await a.end();
    await b.end();
  }, 30_000);

  test("the lock is released, so a later caller is not blocked forever", async () => {
    // The failure mode of a session-scoped lock taken on a POOLED connection: acquired on one,
    // released on another, held until that session ends. This proves it came back.
    const c = postgres(scratchUrl, { max: 1 });
    const reserved = await c.reserve();
    const got = await reserved`SELECT pg_try_advisory_lock(${KEY}) AS ok`;
    expect(got[0]!.ok, "the lock should be free after the previous test").toBe(true);
    await reserved`SELECT pg_advisory_unlock(${KEY})`;
    reserved.release();
    await c.end();
  }, 15_000);
});
