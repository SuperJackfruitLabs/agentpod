/**
 * Integration Test: acp_runs id-space constraints (migration 0035)
 *
 * `acp_runs.id` used to be spelled `run_…`, the same prefix kaambaan mints for a
 * work run — and the schema file said so six lines above a comment reading "We
 * never mint a rival id". Two products, one id space, indistinguishable strings.
 *
 * AgentPod's key is now `attempt_<uuid>`. A comment did not keep the two apart,
 * so the database does: three CHECK constraints, exercised here against the real
 * test Postgres rather than against drizzle's in-memory table config, because
 * what matters is that the constraints reached the schema — a check declared in
 * TypeScript but never migrated would pass a config assertion and enforce
 * nothing.
 *
 * DATABASE_URL must point to the local Docker test-postgres on localhost:5434.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, describe, beforeAll, afterAll } from "bun:test";

import { db, rawSql } from "../../src/db/drizzle";
import { acpSessions, acpRuns } from "../../src/db/schema/acp";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const STATION_ID = "acp-runs-id-space-station";
const SESSION_ID = "acps_11111111-2222-4333-8444-555555555555";
const USER_ID = "acp-runs-id-space-user";

const OWN_ID = "attempt_9f1c2ab0-4d7e-4b3a-8c88-0d6e2f7c1b90";
/** A real kaambaan work run id: `run_<16 hex>`. */
const KAAMBAAN_RUN_ID = "run_e074a2160c4b4f28";

type RunRow = typeof acpRuns.$inferInsert;

const runRow = (over: Partial<RunRow>): RunRow => ({
  id: OWN_ID,
  sessionId: SESSION_ID,
  stationId: STATION_ID,
  state: "working",
  startSeq: 0,
  startedAt: new Date(),
  ...over,
});

const ACCEPTED = "(accepted — no constraint rejected the row)";

/**
 * Insert and report the constraint that rejected it, or ACCEPTED if it went in.
 *
 * Drizzle wraps the driver error, so the postgres.js `constraint_name` is on the
 * cause rather than the thrown error; fall back to the whole message so a
 * failure is still legible if that ever changes.
 */
async function violation(row: RunRow): Promise<string> {
  try {
    await db.insert(acpRuns).values(row);
    await rawSql`DELETE FROM acp_runs WHERE id = ${row.id}`;
    return ACCEPTED;
  } catch (err) {
    const cause = (err as { cause?: { constraint_name?: string } })?.cause;
    return String(
      (err as { constraint_name?: string })?.constraint_name ?? cause?.constraint_name ?? err,
    );
  }
}

beforeAll(async () => {
  await ensurePgMigrations();
  const now = new Date();
  await rawSql`DELETE FROM acp_runs WHERE station_id = ${STATION_ID}`;
  await rawSql`DELETE FROM acp_sessions WHERE station_id = ${STATION_ID}`;
  await db.insert(acpSessions).values({
    id: SESSION_ID,
    stationId: STATION_ID,
    userId: USER_ID,
    mode: "full-auto",
    status: "idle",
    lastSeq: 0,
    createdAt: now,
    lastEventAt: now,
  });
});

afterAll(async () => {
  await rawSql`DELETE FROM acp_runs WHERE station_id = ${STATION_ID}`;
  await rawSql`DELETE FROM acp_sessions WHERE station_id = ${STATION_ID}`;
});

describe("acp_runs — AgentPod's own id space, enforced by the database", () => {
  test("no row anywhere carries the old `run_` prefix", async () => {
    // The evidence behind "no data migration is needed". Nothing in apps/hub/src
    // inserts into acp_runs and no such statement exists at any commit, so the
    // table has never held a row — which is what made the rename free. If this
    // ever fails, the constraints below could not have been added without one.
    const [{ count }] = await rawSql<
      { count: string }[]
    >`SELECT count(*)::text AS count FROM acp_runs WHERE id LIKE 'run\\_%'`;
    expect(count).toBe("0");
  });

  test("accepts an attempt id", async () => {
    expect(await violation(runRow({}))).toBe(ACCEPTED);
  });

  test("refuses a kaambaan work run id as its own primary key", async () => {
    // The collision itself. Reverting the prefix to `run_` makes this insert
    // succeed, and this test fail.
    expect(await violation(runRow({ id: KAAMBAAN_RUN_ID }))).toContain(
      "acp_runs_id_is_agentpod_attempt",
    );
  });

  test("refuses the old prefix even on a locally-shaped id", async () => {
    // Not just kaambaan's minted shape: the prefix itself is what is gone.
    expect(await violation(runRow({ id: `run_${OWN_ID.slice("attempt_".length)}` }))).toContain(
      "acp_runs_id_is_agentpod_attempt",
    );
  });

  test("keeps a dispatched run's two ids in their own spaces", async () => {
    expect(
      await violation(
        runRow({ externalRunId: KAAMBAAN_RUN_ID, externalSource: "kaambaan" }),
      ),
    ).toBe(ACCEPTED);
  });

  test("refuses one of its own attempt ids as an external run id", async () => {
    expect(
      await violation(
        runRow({
          externalRunId: "attempt_3d4e5f60-7182-4a4b-8c56-51b6c7e8f0a2",
          externalSource: "kaambaan",
        }),
      ),
    ).toContain("acp_runs_external_is_not_agentpod");
  });

  test("refuses an external run id with no source, and a source with no id", async () => {
    // #307 made these a paired presence in the contract; the storage layer is
    // where a future writer that bypasses the contract still gets caught.
    expect(await violation(runRow({ externalRunId: KAAMBAAN_RUN_ID }))).toContain(
      "acp_runs_external_pair",
    );
    expect(await violation(runRow({ externalSource: "kaambaan" }))).toContain(
      "acp_runs_external_pair",
    );
  });

  test("leaves a local run with no board attached alone", async () => {
    expect(await violation(runRow({ externalRunId: null, externalSource: null }))).toBe(ACCEPTED);
  });
});
