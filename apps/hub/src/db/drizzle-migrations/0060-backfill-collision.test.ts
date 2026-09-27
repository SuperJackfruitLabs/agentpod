/**
 * Migration 0060's backfill, proved against the exact case it was
 * hardened for — fix round on Task 5.
 *
 * The review's finding C: `0060_matrix_rooms_backfill_principal_id.sql`
 * raises `23505` and fails the deploy if one principal ever holds two
 * stations at the moment it runs, because its `UPDATE` would then try to
 * write that principal onto two different `matrix_rooms` rows, and
 * `matrix_rooms_principal_idx` refuses a repeat. Occupancy is exclusive as
 * of this same fix round (`stations_principal_id_idx`), but that
 * constraint's own migration (`0061`) runs AFTER this one — a fresh
 * database applying every migration in order still reaches 0060 before
 * anything has ever ruled the collision out. This is what makes 0060 safe
 * on its own terms rather than hopeful about migration order.
 *
 * Run against temporary tables shaped like the real ones, not the real
 * `stations` and `matrix_rooms` — the real `stations` table, on this very
 * database, now REFUSES the collision this test needs to create
 * (`stations_principal_id_idx`). Reproducing it requires a schema that
 * predates that constraint, which is exactly what the migration itself had
 * to survive.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { rawSql } from "../drizzle";

const __dirname = dirname(fileURLToPath(import.meta.url));

beforeAll(async () => {
  await ensurePgMigrations();
});

describe("migration 0060's backfill, against data where a principal would otherwise collide", () => {
  test("skips a principal occupying more than one station instead of raising 23505, and still backfills a clean one", async () => {
    const raw = readFileSync(join(__dirname, "0060_matrix_rooms_backfill_principal_id.sql"), "utf8");
    // The one real statement in the file — everything else is comment —
    // adapted onto temp tables so this exercises the migration's own SQL,
    // not a hand-copied duplicate that could quietly drift from it.
    const statement = raw
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .replace(/"matrix_rooms"/g, '"tmp_rooms"')
      .replace(/"stations"/g, '"tmp_stations"')
      .trim();
    expect(statement.length, "the migration file's one real statement must still be there to adapt").toBeGreaterThan(0);

    await rawSql.begin(async (tx) => {
      // ON COMMIT DROP: cleaned up the instant this transaction ends,
      // regardless of which pooled connection happens to run the next test.
      await tx`CREATE TEMP TABLE tmp_stations (id text PRIMARY KEY, principal_id text) ON COMMIT DROP`;
      await tx`CREATE TEMP TABLE tmp_rooms (room_id text PRIMARY KEY, station_id text, principal_id text) ON COMMIT DROP`;

      await tx`
        INSERT INTO tmp_stations (id, principal_id) VALUES
          ('st_collide_1', 'prn_shared_collision'),
          ('st_collide_2', 'prn_shared_collision'),
          ('st_clean', 'prn_solo_occupant')
      `;
      await tx`
        INSERT INTO tmp_rooms (room_id, station_id, principal_id) VALUES
          ('!r-collide-1', 'st_collide_1', NULL),
          ('!r-collide-2', 'st_collide_2', NULL),
          ('!r-clean', 'st_clean', NULL)
      `;

      // The migration's own statement. Must not throw — against the real
      // schema before this fix round, this exact shape of data would raise
      // 23505 here.
      await tx.unsafe(statement);

      const rows = await tx`SELECT room_id, principal_id FROM tmp_rooms ORDER BY room_id`;
      const byId = new Map(rows.map((r) => [r.room_id as string, r.principal_id as string | null]));

      expect(byId.get("!r-collide-1"), "a colliding principal's rooms are left alone, not half-backfilled").toBeNull();
      expect(byId.get("!r-collide-2")).toBeNull();
      expect(byId.get("!r-clean"), "a principal with no collision is still backfilled").toBe("prn_solo_occupant");
    });
  });
});
