/**
 * Migration 0062, proved against the exact regression it exists to repair —
 * fix round 5 on Task 5.
 *
 * The chain the review found: `0060`'s backfill SKIPS both rooms of a
 * doubly-occupied principal (its `HAVING COUNT(*) > 1` clause, so the
 * deploy cannot die of 23505 partway through). `0061` then dedupes exactly
 * those principals and leaves the most recently adopted station
 * RIGHTFULLY occupied. Nothing re-runs the backfill, so that survivor's
 * room stays `principal_id IS NULL` forever — and once fix round 4 removed
 * `roomAgentUser`'s fallback to `stations.principal_id`, a room that used
 * to be answered correctly by accident began answering nothing at all.
 *
 * Two halves, because the migration has to be right about two different
 * things:
 *
 *  - **The chain**, on temp tables, running all three shipped files' own
 *    SQL read from disk (`0060-backfill-collision.test.ts`'s pattern, with
 *    `0061`'s content-based statement selection). A pasted copy of the SQL
 *    could drift from the file the deploy actually runs; this cannot.
 *  - **The behaviour**, on the real tables, because "the column got
 *    written" is not the thing that matters — `gates.ts`'s `roomAgentUser`
 *    answering again is.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { createTestUser } from "../../../tests/helpers/database";
import { rawSql } from "../drizzle";
import { resolveTenantForUser } from "../../auth/tenant";
import { createPrincipal } from "../../services/principals";
import { roomAgentUser } from "../../services/matrix-as/gates";
import { bridgeUserId } from "../../services/matrix-as/names";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * One shipped migration's real statements, comments stripped, selected by
 * CONTENT rather than by position — a slice by index silently becomes a
 * different statement the moment a file is reordered, and these are run
 * through `tx.unsafe()`.
 */
function statementsOf(file: string): string[] {
  return readFileSync(join(__dirname, file), "utf8")
    .split("--> statement-breakpoint")
    .map((stmt) =>
      stmt
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim()
    )
    .filter((stmt) => stmt.length > 0);
}

function statementStartingWith(file: string, prefix: string): string {
  const found = statementsOf(file).find((s) =>
    s.toUpperCase().replace(/\s+/g, " ").startsWith(prefix.toUpperCase())
  );
  expect(found, `${file} must still contain a statement starting "${prefix}"`).toBeTruthy();
  return found!;
}

const RUN = crypto.randomUUID().slice(0, 8);
const USER = `test-user-0062-${RUN}`;
const NODE = `node_0062_${RUN}`;
const STATION = `st_0062_${RUN}`;
const ROOM = `!room-0062-${RUN}:id.agentpod.dev`;
const HANDLE = `rebackfill-survivor-${RUN}`;
let PRINCIPAL: string;

beforeAll(async () => {
  await ensurePgMigrations();
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${STATION}`;
    await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM principals WHERE handle = ${HANDLE}`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

describe("migration 0062 re-runs the backfill 0061's dedupe left half-done", () => {
  test("0060 skips a doubly-occupied principal, 0061 leaves one station rightfully occupied, and 0062 binds that survivor's room — without 23505 on either way a room can be unbindable", async () => {
    const backfill0060 = statementStartingWith(
      "0060_matrix_rooms_backfill_principal_id.sql",
      'UPDATE "matrix_rooms"'
    )
      .replace(/"matrix_rooms"/g, '"tmp_rooms_0062"')
      .replace(/"stations"/g, '"tmp_stations_0062"');
    const dedupe0061 = statementStartingWith(
      "0061_occupancy_exclusive.sql",
      'UPDATE "stations"'
    ).replace(/"stations"/g, '"tmp_stations_0062"');
    const rebackfill0062 = statementStartingWith(
      "0062_matrix_rooms_rebackfill_after_dedupe.sql",
      'UPDATE "matrix_rooms"'
    )
      .replace(/"matrix_rooms"/g, '"tmp_rooms_0062"')
      .replace(/"stations"/g, '"tmp_stations_0062"');

    await rawSql.begin(async (tx) => {
      // ON COMMIT DROP: gone the instant this transaction ends, whichever
      // pooled connection runs the next test.
      await tx`
        CREATE TEMP TABLE tmp_stations_0062 (id text PRIMARY KEY, principal_id text, adopted_at timestamp)
        ON COMMIT DROP
      `;
      await tx`
        CREATE TEMP TABLE tmp_rooms_0062 (room_id text PRIMARY KEY, station_id text, principal_id text)
        ON COMMIT DROP
      `;
      // The index that makes every "would raise 23505" claim in these three
      // migrations' comments real. Without it this test proves nothing about
      // the guards.
      await tx`CREATE UNIQUE INDEX tmp_rooms_0062_principal_idx ON tmp_rooms_0062 (principal_id)`;

      // The state at the moment 0060 runs: `principal_id` has no writer yet,
      // so every room is unbound, and one principal is doubly occupied.
      await tx`
        INSERT INTO tmp_stations_0062 (id, principal_id, adopted_at) VALUES
          ('st_old',  'prn_collide', '2026-01-01T00:00:00Z'),
          ('st_new',  'prn_collide', '2026-06-01T00:00:00Z'),
          ('st_solo', 'prn_solo',    '2026-01-01T00:00:00Z')
      `;
      await tx`
        INSERT INTO tmp_rooms_0062 (room_id, station_id, principal_id) VALUES
          ('!r-old',  'st_old',  NULL),
          ('!r-new',  'st_new',  NULL),
          ('!r-solo', 'st_solo', NULL)
      `;

      await tx.unsafe(backfill0060);
      const after0060 = new Map(
        (await tx`SELECT room_id, principal_id FROM tmp_rooms_0062`).map((r) => [
          r.room_id as string,
          r.principal_id as string | null,
        ])
      );
      expect(after0060.get("!r-old"), "0060 skips the colliding principal's rooms").toBeNull();
      expect(after0060.get("!r-new")).toBeNull();
      expect(after0060.get("!r-solo"), "and backfills a clean one").toBe("prn_solo");

      await tx.unsafe(dedupe0061);
      const stations0061 = new Map(
        (await tx`SELECT id, principal_id FROM tmp_stations_0062`).map((r) => [
          r.id as string,
          r.principal_id as string | null,
        ])
      );
      expect(stations0061.get("st_old"), "0061 clears the older adoption").toBeNull();
      expect(
        stations0061.get("st_new"),
        "and leaves the survivor RIGHTFULLY occupied — with its room still unbound"
      ).toBe("prn_collide");

      // Between 0061 and 0062, on the deployed box: `agents-admin.ts`'s
      // bind-on-assign has been live, so bound rooms and unbound leftovers
      // both exist now. Each of these would make a verbatim re-run of 0060
      // raise 23505 here.
      await tx`
        INSERT INTO tmp_stations_0062 (id, principal_id, adopted_at) VALUES
          ('st_moved', 'prn_moved', '2026-02-01T00:00:00Z'),
          ('st_ambig', 'prn_ambig', '2026-03-01T00:00:00Z')
      `;
      await tx`
        INSERT INTO tmp_rooms_0062 (room_id, station_id, principal_id) VALUES
          -- an agent that moved stations keeps its old room; its new
          -- station carries an unbound one it never lived in
          ('!r-moved-own',    'st_elsewhere', 'prn_moved'),
          ('!r-moved-orphan', 'st_moved',     NULL),
          -- one station, two unbound rooms: nothing to pick between them
          ('!r-ambig-1', 'st_ambig', NULL),
          ('!r-ambig-2', 'st_ambig', NULL)
      `;

      await tx.unsafe(rebackfill0062);
      const after0062 = new Map(
        (await tx`SELECT room_id, principal_id FROM tmp_rooms_0062`).map((r) => [
          r.room_id as string,
          r.principal_id as string | null,
        ])
      );

      expect(
        after0062.get("!r-new"),
        "the survivor's room is bound at last — the whole point of 0062"
      ).toBe("prn_collide");
      expect(
        after0062.get("!r-old"),
        "the cleared station's room is not: it has no occupant to be bound to"
      ).toBeNull();
      expect(
        after0062.get("!r-moved-orphan"),
        "a room its station's occupant never lived in stays unattributable, rather than raising 23505 against the room that occupant does hold"
      ).toBeNull();
      expect(after0062.get("!r-moved-own"), "and that occupant's own room is untouched").toBe("prn_moved");
      expect(
        after0062.get("!r-ambig-1"),
        "two unbound rooms at one station is a guess, so 0062 declines to make it"
      ).toBeNull();
      expect(after0062.get("!r-ambig-2")).toBeNull();
      expect(after0062.get("!r-solo"), "already bound, so a no-op").toBe("prn_solo");

      // Idempotent: a re-deploy must change nothing.
      await tx.unsafe(rebackfill0062);
      const twice = new Map(
        (await tx`SELECT room_id, principal_id FROM tmp_rooms_0062`).map((r) => [
          r.room_id as string,
          r.principal_id as string | null,
        ])
      );
      expect([...twice.entries()].sort()).toEqual([...after0062.entries()].sort());
    });
  });

  test("and the room answers again: roomAgentUser goes from silence to the station's rightful occupant", async () => {
    // Behaviour, on the real tables, because the column is not the point.
    // The state 0061 leaves behind, reproduced directly: a station with its
    // rightful occupant and a room of its own that nothing ever bound.
    await createTestUser({ id: USER, email: `rebackfill-${RUN}@example.com`, name: "RB" });
    const tenant = await resolveTenantForUser(USER);
    PRINCIPAL = await createPrincipal({ kind: "agent", handle: HANDLE });
    await rawSql`
      INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
      VALUES (${NODE}, ${tenant}, ${USER}, ${"rebackfill-box-" + RUN}, 'rb', 'linux', 'amd64', 2, 'online', 'x', now())`;
    await rawSql`
      INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, principal_id, adopted_at, created_at)
      VALUES (${STATION}, ${tenant}, ${USER}, ${NODE}, 'opencode', ${"opencode:" + RUN}, 'leaf', 'Survivor',
              '["acp"]'::jsonb, ${PRINCIPAL}, now(), now())`;
    await rawSql`
      INSERT INTO matrix_rooms (room_id, tenant_id, station_id, alias, created_at)
      VALUES (${ROOM}, ${tenant}, ${STATION}, ${"#rebackfill-" + RUN + ":id.agentpod.dev"}, now())`;

    // The regression, stated as behaviour: the room's rightful occupant is
    // sitting right there on the station, and the room answers nothing.
    expect(
      await roomAgentUser(ROOM, "id.agentpod.dev"),
      "before the backfill re-runs, a rightfully occupied station's room is unattributable"
    ).toBeNull();

    // The shipped file, verbatim, against the real schema — the same
    // statement a deploy runs. Safe to run suite-wide: its `NOT EXISTS` and
    // single-candidate clauses mean it can only bind a room whose station's
    // occupant holds no other room and has no other unbound room to be
    // confused with.
    const rebackfill = statementStartingWith(
      "0062_matrix_rooms_rebackfill_after_dedupe.sql",
      'UPDATE "matrix_rooms"'
    );
    await rawSql.unsafe(rebackfill);

    expect(
      await roomAgentUser(ROOM, "id.agentpod.dev"),
      "afterwards it answers as its station's rightful occupant again"
    ).toBe(bridgeUserId(HANDLE, "id.agentpod.dev"));
  });
});
