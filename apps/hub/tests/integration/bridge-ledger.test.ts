/**
 * The bridge's two writes, against the real test Postgres.
 *
 * 1. **The run join** (requirement 4). `acp_runs` has never had a writer — no
 *    statement inserting into it exists at any commit in this repository, and
 *    production holds zero rows. This is its first one, and the thing it must
 *    carry is the paired fact the CHECK enforces: `external_run_id` =
 *    kaambaan's run id, `external_source` = "kaambaan". Its own id is
 *    `attempt_<uuid>` — AgentPod is the executor, not the minter.
 *
 * 2. **The at-least-once ledger** (requirement 3). Spike RQ4: a harness finished
 *    at t+180s and the board re-dispatched the same card at t+900s, because the
 *    bridge died before calling `complete`. `produced` without `reported` is
 *    that state, and finding it is what stops the work being done twice.
 *
 * DATABASE_URL must point at the local Docker test-postgres on localhost:5434.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { AcpRunId, KaambaanRunId } from "@agentpod/contract";
import { eq } from "drizzle-orm";

import { db, rawSql } from "../../src/db/drizzle";
import { acpRuns, acpSessions } from "../../src/db/schema/acp";
import { bridgeDispatches } from "../../src/db/schema/bridge";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import {
  findUnreportedOutput,
  markAbandoned,
  markReported,
  openDispatch,
  recordCoalescing,
  recordProduced,
  startAttempt,
  endAttempt,
} from "../../src/services/bridge/ledger";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const STATION_ID = "bridge-ledger-station";
const SESSION_ID = "acps_22222222-3333-4444-8555-666666666666";
const USER_ID = "bridge-ledger-user";
const BOARD_ID = "brd_9c1d4e5f6a7b8c9d";
const CARD_ID = "crd_1a2b3c4d5e6f7a8b";
const RUN_ID = "run_e074a2160c4b4f28";
const RUN_ID_2 = "run_a1b2c3d4e5f60718";

const key = (externalRunId = RUN_ID) => ({
  tenantId: BOOTSTRAP_TENANT_ID,
  externalSource: "kaambaan",
  boardId: BOARD_ID,
  externalCardId: CARD_ID,
  externalRunId,
});

const open = (externalRunId = RUN_ID, over: Record<string, unknown> = {}) =>
  openDispatch({ ...key(externalRunId), agentKey: "codex-mac", stationId: STATION_ID, leaseEpoch: 1, ...over });

beforeAll(async () => {
  await ensurePgMigrations();
  const now = new Date();
  await rawSql`DELETE FROM bridge_dispatches WHERE station_id = ${STATION_ID}`;
  await rawSql`DELETE FROM acp_runs WHERE station_id = ${STATION_ID}`;
  await rawSql`DELETE FROM acp_sessions WHERE station_id = ${STATION_ID}`;
  await db.insert(acpSessions).values({
    tenantId: BOOTSTRAP_TENANT_ID,
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

beforeEach(async () => {
  await rawSql`DELETE FROM bridge_dispatches WHERE station_id = ${STATION_ID}`;
  await rawSql`DELETE FROM acp_runs WHERE station_id = ${STATION_ID}`;
});

afterAll(async () => {
  await rawSql`DELETE FROM bridge_dispatches WHERE station_id = ${STATION_ID}`;
  await rawSql`DELETE FROM acp_runs WHERE station_id = ${STATION_ID}`;
  await rawSql`DELETE FROM acp_sessions WHERE station_id = ${STATION_ID}`;
});

describe("the run join — acp_runs' first writer", () => {
  test("an attempt carries kaambaan's run id and says who minted it", async () => {
    await open();
    const attemptId = await startAttempt({
      ...key(),
      sessionId: SESSION_ID,
      stationId: STATION_ID,
      startSeq: 4,
    });

    const [row] = await db.select().from(acpRuns).where(eq(acpRuns.id, attemptId));
    expect(row!.externalRunId).toBe(RUN_ID);
    expect(row!.externalSource).toBe("kaambaan");
    expect(row!.state).toBe("working");
    expect(row!.startSeq).toBe(4);
    expect(row!.endSeq).toBeNull();
    expect(row!.tenantId).toBe(BOOTSTRAP_TENANT_ID);
  });

  test("the attempt's own id is AgentPod's, and kaambaan's is not restated as it", async () => {
    await open();
    const attemptId = await startAttempt({ ...key(), sessionId: SESSION_ID, stationId: STATION_ID, startSeq: 0 });

    expect(AcpRunId.safeParse(attemptId).success).toBe(true);
    expect(KaambaanRunId.safeParse(attemptId).success).toBe(false);
    expect(attemptId).not.toBe(RUN_ID);
  });

  test("the dispatch points at the attempt that executed it", async () => {
    await open();
    const attemptId = await startAttempt({ ...key(), sessionId: SESSION_ID, stationId: STATION_ID, startSeq: 0 });

    const [row] = await db.select().from(bridgeDispatches).where(eq(bridgeDispatches.externalRunId, RUN_ID));
    expect(row!.acpRunId).toBe(attemptId);
  });

  test("ending an attempt closes both the sequence and the clock", async () => {
    await open();
    const attemptId = await startAttempt({ ...key(), sessionId: SESSION_ID, stationId: STATION_ID, startSeq: 4 });
    await endAttempt(attemptId, "completed", 37);

    const [row] = await db.select().from(acpRuns).where(eq(acpRuns.id, attemptId));
    expect(row!.state).toBe("completed");
    expect(row!.endSeq).toBe(37);
    expect(row!.endedAt).toBeInstanceOf(Date);
  });

  test("a run id from AgentPod's own space is refused before it reaches the table", async () => {
    // The reverse join through acp_runs_external_idx would point back at this
    // hub. The CHECK catches it; the writer should not get that far.
    await expect(
      startAttempt({
        ...key("attempt_3d4e5f60-7182-4a4b-8c56-51b6c7e8f0a2"),
        sessionId: SESSION_ID,
        stationId: STATION_ID,
        startSeq: 0,
      }),
    ).rejects.toThrow();
  });
});

describe("the ledger — at-least-once reclaim", () => {
  test("a finished-but-unreported run is findable by its card", async () => {
    // The RQ4 failure, exactly: work done, board never told.
    await open();
    await recordProduced(key(), { summary: "wrote three files" });

    const prior = await findUnreportedOutput(key(RUN_ID_2));
    expect(prior).not.toBeNull();
    expect(prior!.externalRunId).toBe(RUN_ID);
    expect(prior!.result).toEqual({ summary: "wrote three files" });
  });

  test("once reported, it is not offered again", async () => {
    await open();
    await recordProduced(key(), { summary: "done" });
    await markReported(key());

    expect(await findUnreportedOutput(key(RUN_ID_2))).toBeNull();
  });

  test("a run still working has produced nothing to replay", async () => {
    await open();
    expect(await findUnreportedOutput(key(RUN_ID_2))).toBeNull();
  });

  test("an abandoned run is not treated as output", async () => {
    // A lost lease means someone else has the card. Replaying our half-done
    // handoff onto their run would report work we cannot vouch for.
    await open();
    await markAbandoned(key(), "lease superseded");
    expect(await findUnreportedOutput(key(RUN_ID_2))).toBeNull();
  });

  test("the lookup is scoped to one card, one board and one tenant", async () => {
    await open();
    await recordProduced(key(), { summary: "done" });

    expect(await findUnreportedOutput({ ...key(RUN_ID_2), externalCardId: "crd_other" })).toBeNull();
    expect(await findUnreportedOutput({ ...key(RUN_ID_2), boardId: "brd_other" })).toBeNull();
    expect(await findUnreportedOutput({ ...key(RUN_ID_2), externalSource: "temporal" })).toBeNull();
    expect(await findUnreportedOutput({ ...key(RUN_ID_2), tenantId: "fleet_ffffffffffffffffffff" })).toBeNull();
  });

  test("a run never rediscovers its own output", async () => {
    // Otherwise the recovery path is a loop: find prior output, report it,
    // find it again.
    await open();
    await recordProduced(key(), { summary: "done" });
    expect(await findUnreportedOutput(key(RUN_ID))).toBeNull();
  });

  test("re-opening the same run updates its lease rather than duplicating it", async () => {
    // A hub restart re-claims; the board may hand back the same run.
    await open(RUN_ID, { leaseEpoch: 1 });
    await open(RUN_ID, { leaseEpoch: 2 });

    const rows = await db.select().from(bridgeDispatches).where(eq(bridgeDispatches.externalRunId, RUN_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.leaseEpoch).toBe(2);
    expect(rows[0]!.outcome).toBe("working");
  });

  test("every dispatch row carries a tenant", async () => {
    await open();
    const [row] = await db.select().from(bridgeDispatches).where(eq(bridgeDispatches.externalRunId, RUN_ID));
    expect(row!.tenantId).toBe(BOOTSTRAP_TENANT_ID);
  });
});

describe("the coalescing summary — one row per dispatch, not one per event", () => {
  test("a claim starts unmeasured, and unmeasured is not zero", async () => {
    // The distinction the whole column pair rests on: a run that produced no
    // activities and a run nobody counted must not read the same.
    await open();
    const [row] = await db.select().from(bridgeDispatches).where(eq(bridgeDispatches.externalRunId, RUN_ID));
    expect(row!.eventsReceived).toBeNull();
    expect(row!.activitiesPosted).toBeNull();
  });

  test("the counts are written where the ratio can be computed from them", async () => {
    await open();
    await recordCoalescing(key(), { eventsReceived: 1051, activitiesPosted: 7 });

    const [row] = await db.select().from(bridgeDispatches).where(eq(bridgeDispatches.externalRunId, RUN_ID));
    expect(row!.eventsReceived).toBe(1051);
    expect(row!.activitiesPosted).toBe(7);
  });

  test("zero activities is stored as zero", async () => {
    await open();
    await recordCoalescing(key(), { eventsReceived: 12, activitiesPosted: 0 });

    const [row] = await db.select().from(bridgeDispatches).where(eq(bridgeDispatches.externalRunId, RUN_ID));
    expect(row!.activitiesPosted).toBe(0);
    expect(row!.activitiesPosted).not.toBeNull();
  });

  test("the write does not disturb the outcome it lands next to", async () => {
    // It runs on every exit a session had, including the failures — and a
    // measurement that overwrote `abandoned` with `working` would make the
    // ledger lie about something that matters far more than a count.
    await open();
    await markAbandoned(key(), "the lease was superseded");
    await recordCoalescing(key(), { eventsReceived: 40, activitiesPosted: 2 });

    const [row] = await db.select().from(bridgeDispatches).where(eq(bridgeDispatches.externalRunId, RUN_ID));
    expect(row!.outcome).toBe("abandoned");
    expect(row!.reason).toBe("the lease was superseded");
    expect(row!.eventsReceived).toBe(40);
  });

  test("the counts are scoped to one run, and one tenant", async () => {
    await open(RUN_ID);
    await open(RUN_ID_2);
    await recordCoalescing(key(RUN_ID), { eventsReceived: 9, activitiesPosted: 1 });

    const [other] = await db.select().from(bridgeDispatches).where(eq(bridgeDispatches.externalRunId, RUN_ID_2));
    expect(other!.eventsReceived).toBeNull();

    await recordCoalescing({ ...key(RUN_ID), tenantId: "fleet_ffffffffffffffffffff" }, {
      eventsReceived: 999,
      activitiesPosted: 999,
    });
    const [mine] = await db.select().from(bridgeDispatches).where(eq(bridgeDispatches.externalRunId, RUN_ID));
    expect(mine!.eventsReceived).toBe(9);
  });
});

/**
 * A migration tested only on an empty database has not been tested.
 *
 * `bridge_dispatches` holds live rows in production, and Drizzle's own first
 * instinct for a new column is `ADD COLUMN … NOT NULL`, which fails outright
 * against a table that already has any. This replays the shipped SQL — read
 * from the file that will actually run, not a copy of it — against a table
 * with a row in it, inside a transaction that rolls back so the suite's schema
 * is exactly as it found it.
 */
describe("migration 0039, against a table that already has rows", () => {
  class Rollback extends Error {}

  test("an existing row survives and reads as not-measured", async () => {
    const path = new URL(
      "../../src/db/drizzle-migrations/0039_bridge_dispatch_coalescing.sql",
      import.meta.url,
    ).pathname;
    const sql = await Bun.file(path).text();
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);

    let observed: { events_received: number | null; activities_posted: number | null } | undefined;
    try {
      await rawSql.begin(async (tx) => {
        // Rewind to the pre-migration shape, then put a row in it — the state
        // production is in, which an empty test database never reproduces.
        await tx`ALTER TABLE bridge_dispatches DROP COLUMN events_received, DROP COLUMN activities_posted`;
        await tx`
          INSERT INTO bridge_dispatches
            (external_source, external_run_id, tenant_id, board_id, external_card_id,
             agent_key, station_id, lease_epoch, outcome, started_at, updated_at)
          VALUES
            ('kaambaan', ${RUN_ID_2}, ${BOOTSTRAP_TENANT_ID}, ${BOARD_ID}, ${CARD_ID},
             'codex-mac', ${STATION_ID}, 1, 'reported', now(), now())
        `;

        for (const statement of statements) await tx.unsafe(statement);

        const rows = await tx<Array<{ events_received: number | null; activities_posted: number | null }>>`
          SELECT events_received, activities_posted
          FROM bridge_dispatches WHERE external_run_id = ${RUN_ID_2}
        `;
        observed = rows[0];
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }

    // The row is still there — the migration did not need to be told what a
    // dispatch from before it was counted had counted.
    expect(observed).toBeDefined();
    expect(observed!.events_received).toBeNull();
    expect(observed!.activities_posted).toBeNull();
  });
});
