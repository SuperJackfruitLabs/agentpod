/**
 * Integration Test: 0027_backfill_last_seq migration
 *
 * Slice 4c added acp_sessions.last_seq with a NOT NULL DEFAULT 0. Rows
 * created before that migration are therefore stuck at last_seq = 0 even
 * though acp_events plainly has a transcript for them — the history dialog
 * then reports "no events" for a session that has plenty.
 *
 * The 0027 migration backfills those rows:
 *   UPDATE acp_sessions SET last_seq = MAX(acp_events.seq) WHERE last_seq = 0
 *
 * By the time this suite runs, drizzle's migrate() (via ensurePgMigrations)
 * has already applied 0027 once against the test DB — drizzle tracks applied
 * migrations and never re-runs them. To exercise 0027's SQL directly (and
 * prove it is idempotent) this test re-executes the migration file's own
 * UPDATE statement against rows it sets up itself, the same statement
 * drizzle ran at boot.
 *
 * DATABASE_URL must point to the local Docker test-postgres on localhost:5434.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";

import { db, rawSql } from "../../src/db/drizzle";
import { acpSessions, acpEvents } from "../../src/db/schema/acp";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const STATION_ID = "backfill-test-station";
const USER_ID = "backfill-test-user";

/**
 * The 0027 migration file is a single UPDATE statement (plus the drizzle
 * "custom migration" header comment). Strip the header and hand the bare
 * SQL to postgres.js — this is exactly the statement drizzle's migrate()
 * executed at boot, re-run here against rows this test controls.
 */
function loadBackfillSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationPath = join(
    here,
    "../../src/db/drizzle-migrations/0027_backfill_last_seq.sql"
  );
  const raw = readFileSync(migrationPath, "utf-8");
  return raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();
}

async function insertSession(id: string, lastSeq: number): Promise<void> {
  const now = new Date();
  await db.insert(acpSessions).values({
    id,
    stationId: STATION_ID,
    userId: USER_ID,
    mode: "full-auto",
    status: "ended",
    endedReason: "cleanup",
    nodeSessionId: null,
    title: null,
    lastSeq,
    createdAt: now,
    lastEventAt: now,
  });
}

async function insertEvent(sessionId: string, seq: number): Promise<void> {
  await db.insert(acpEvents).values({
    sessionId,
    seq,
    type: "state",
    payload: { status: "idle" },
    createdAt: new Date(),
  });
}

beforeAll(async () => {
  await ensurePgMigrations();
});

afterAll(async () => {
  await rawSql`DELETE FROM acp_events WHERE session_id LIKE ${STATION_ID + "%"}`;
  await rawSql`DELETE FROM acp_sessions WHERE station_id = ${STATION_ID}`;
});

test(
  "0027_backfill_last_seq: sets last_seq to MAX(seq) for pre-4c rows stuck at 0, leaves already-populated rows alone, and is idempotent",
  async () => {
    const staleId = `${STATION_ID}-stale`; // pre-4c row: last_seq=0 despite events
    const freshId = `${STATION_ID}-fresh`; // post-4c row: last_seq already correct
    const emptyId = `${STATION_ID}-empty`; // last_seq=0 AND genuinely no events

    await insertSession(staleId, 0);
    await insertEvent(staleId, 1);
    await insertEvent(staleId, 2);
    await insertEvent(staleId, 5); // out-of-order insert; MAX must still find it

    await insertSession(freshId, 3);
    await insertEvent(freshId, 1);
    await insertEvent(freshId, 3);

    await insertSession(emptyId, 0);

    const backfillSql = loadBackfillSql();
    await rawSql.unsafe(backfillSql);

    const rows = await db
      .select()
      .from(acpSessions)
      .where(eq(acpSessions.stationId, STATION_ID));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId[staleId]!.lastSeq).toBe(5);
    expect(byId[freshId]!.lastSeq).toBe(3); // untouched — WHERE last_seq = 0 excluded it
    expect(byId[emptyId]!.lastSeq).toBe(0); // COALESCE(MAX(...), 0) — no events, no change

    // Idempotent: running it again changes nothing further.
    await rawSql.unsafe(backfillSql);
    const rowsAgain = await db
      .select()
      .from(acpSessions)
      .where(eq(acpSessions.stationId, STATION_ID));
    const byIdAgain = Object.fromEntries(rowsAgain.map((r) => [r.id, r]));

    expect(byIdAgain[staleId]!.lastSeq).toBe(5);
    expect(byIdAgain[freshId]!.lastSeq).toBe(3);
    expect(byIdAgain[emptyId]!.lastSeq).toBe(0);
  }
);
