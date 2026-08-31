/**
 * Migration 0061's dedupe, proved against the exact case it exists for —
 * fix round 2 on Task 5.
 *
 * `stations_principal_id_idx` enforces "occupancy is exclusive" going
 * forward, but creating a unique index against data that already violates
 * it raises `23505` and kills the deploy — the review's finding: skipping
 * the collision in `0060`'s backfill (an earlier migration) without also
 * deduping it here just relocates that same failure one migration later.
 * This is what proves the relocation was actually closed, not moved again.
 *
 * Same pattern as `0060-backfill-collision.test.ts`, which the review
 * confirmed worked: read the migration's own SQL and adapt it onto a temp
 * table, because the real `stations` table — once this migration has run on
 * this very database — now enforces the constraint that makes the collision
 * this needs to create impossible to insert directly.
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

describe("migration 0061's dedupe, against data that would otherwise collide", () => {
  test("keeps the most recently adopted station for a colliding principal, clears the rest, and the unique index then creates cleanly", async () => {
    const raw = readFileSync(join(__dirname, "0061_occupancy_exclusive.sql"), "utf8");
    // The dedupe UPDATE is the file's first statement — everything after the
    // first `--> statement-breakpoint` is the schema change this proves is
    // now safe to run, not what this test exercises directly.
    const dedupeStatement = raw
      .split("--> statement-breakpoint")[0]!
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .replace(/"stations"/g, '"tmp_stations_0061"')
      .trim();
    expect(dedupeStatement.length, "the migration file's dedupe statement must still be there to adapt").toBeGreaterThan(0);

    await rawSql.begin(async (tx) => {
      // ON COMMIT DROP: cleaned up the instant this transaction ends,
      // regardless of which pooled connection runs the next test.
      await tx`
        CREATE TEMP TABLE tmp_stations_0061 (id text PRIMARY KEY, principal_id text, adopted_at timestamp)
        ON COMMIT DROP
      `;

      await tx`
        INSERT INTO tmp_stations_0061 (id, principal_id, adopted_at) VALUES
          ('st_old', 'prn_collide', '2026-01-01T00:00:00Z'),
          ('st_new', 'prn_collide', '2026-06-01T00:00:00Z'),
          ('st_solo', 'prn_solo', '2026-01-01T00:00:00Z')
      `;

      // The migration's own statement, verbatim apart from the table name.
      // Must not throw — against the real schema at this point in the
      // migration sequence, this exact shape of data would raise 23505 on
      // the very next statement without it.
      await tx.unsafe(dedupeStatement);

      const rows = await tx`SELECT id, principal_id FROM tmp_stations_0061 ORDER BY id`;
      const byId = new Map(rows.map((r) => [r.id as string, r.principal_id as string | null]));

      expect(byId.get("st_old"), "the older adoption is cleared").toBeNull();
      expect(byId.get("st_new"), "the more recently adopted station keeps the principal").toBe("prn_collide");
      expect(byId.get("st_solo"), "a principal with no collision is untouched").toBe("prn_solo");

      // Prove the post-dedupe data actually satisfies the constraint the
      // real migration creates next — not merely that the UPDATE ran
      // without throwing.
      await tx`
        CREATE UNIQUE INDEX tmp_stations_0061_principal_idx
        ON tmp_stations_0061 (principal_id) WHERE principal_id IS NOT NULL
      `;
    });
  });
});
