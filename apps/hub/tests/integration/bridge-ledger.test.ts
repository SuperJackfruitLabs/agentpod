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
