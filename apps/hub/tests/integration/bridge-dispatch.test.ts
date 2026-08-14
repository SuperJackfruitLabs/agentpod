/**
 * One claim, start to finish, against a fake board and a fake ACP port.
 *
 * The three behaviours that earn their own tests here are the ones the spike
 * measured and could not fix in throwaway code:
 *
 *   409 STALE_LEASE — kaambaan fences its own state; NOTHING fences the machine.
 *     The original harness kept working with no idea its lease had been revoked.
 *     A 409 must stop the harness, not just the loop.
 *   403 NOT_RUN_OWNER — a different fact entirely, and never a retry.
 *   at-least-once — a finished-but-unreported run comes back. Its output is
 *     replayed; the harness is not run again.
 *
 * DATABASE_URL must point at the local Docker test-postgres on localhost:5434.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import type { AcpEvent } from "@agentpod/contract";
import { eq } from "drizzle-orm";

import { db, rawSql } from "../../src/db/drizzle";
import { acpRuns, acpSessions } from "../../src/db/schema/acp";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import type { BridgeAgentConfig } from "../../src/services/bridge/config";
import { runOnce, type AcpPort } from "../../src/services/bridge/dispatch";
import { KaambaanClient } from "../../src/services/bridge/kaambaan";
import { dispatchOutcome, openDispatch, recordProduced } from "../../src/services/bridge/ledger";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const STATION_ID = "bridge-dispatch-station";
const SESSION_ID = "acps_33333333-4444-4555-8666-777777777777";
const USER_ID = "bridge-dispatch-user";
const BOARD_ID = "brd_9c1d4e5f6a7b8c9d";
const CARD_ID = "crd_1a2b3c4d5e6f7a8b";
const RUN_ID = "run_e074a2160c4b4f28";
const TOKEN = `kbn_${"a1b2c3d4".repeat(6)}`;

const agent: BridgeAgentConfig = {
  key: "codex-mac",
  boardId: BOARD_ID,
  token: TOKEN,
  stationId: STATION_ID,
  hubUserId: USER_ID,
  mode: "full-auto",
};

// ─── fakes ───────────────────────────────────────────────────────────────────

type Handler = (path: string, body: unknown) => { status: number; body: unknown };

function fakeBoard(handler: Handler) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = new KaambaanClient({
    baseUrl: "https://board.test",
    boardId: BOARD_ID,
    token: TOKEN,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ path, body });
      const { status, body: res } = handler(path, body);
      return { status, ok: status >= 200 && status < 300, json: async () => res };
    },
  });
  const verbs = () => calls.map((c) => c.path.split("/").pop()!);
  return { calls, client, verbs };
}

let seq = 0;
const ev = (type: AcpEvent["type"], payload: unknown): AcpEvent => ({
  sessionId: SESSION_ID,
  seq: ++seq,
  type,
  payload,
  createdAt: new Date().toISOString(),
});

const chunk = (text: string): AcpEvent =>
  ev("agent-update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

const idle = (): AcpEvent => ev("state", { status: "idle" });

interface FakeAcpOpts {
  /** What the readiness probe answers. Ready unless a test says otherwise. */
  ready?: { ready: boolean; reason?: string };
  /** Fail the session open — a node that went offline between the two. */
  failCreate?: string;
  /** Fail the first prompt — a session that opened and then lost its wire. */
  failPrompt?: string;
}

/** An ACP port that scripts a turn instead of talking to a station. */
function fakeAcp(script: () => AcpEvent[], opts: FakeAcpOpts = {}) {
  const subs = new Set<(e: AcpEvent) => void>();
  const state = { created: 0, readyChecks: 0, prompts: [] as string[], ended: [] as string[] };
  const port: AcpPort = {
    async stationReady() {
      state.readyChecks++;
      return opts.ready ?? { ready: true };
    },
    async createSession() {
      if (opts.failCreate) throw new Error(opts.failCreate);
      state.created++;
      return { id: SESSION_ID };
    },
    async promptSession(_u, _s, text) {
      if (opts.failPrompt) throw new Error(opts.failPrompt);
      state.prompts.push(text);
      // Events arrive after the prompt returns, as they do from a real station.
      queueMicrotask(() => {
        for (const e of script()) for (const fn of subs) fn(e);
      });
    },
    subscribe(_sessionId, fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    async endSession(_u, _s, reason) {
      state.ended.push(reason);
    },
  };
  return { port, state, emit: (e: AcpEvent) => subs.forEach((fn) => fn(e)) };
}

// ─── board responses ─────────────────────────────────────────────────────────

const claimBody = {
  claimed: true,
  runId: RUN_ID,
  leaseEpoch: 1,
  card: { id: CARD_ID, title: "Rebuild the index", attemptCount: 1 },
  stage: { key: "work", name: "Work" },
  handoff: null,
};

const contextBody = {
  run: { runId: RUN_ID, cardId: CARD_ID, stageKey: "work", leaseEpoch: 1, status: "working", outcome: null, startedAt: "t", endedAt: null },
  card: { id: CARD_ID, title: "Rebuild the index", spec: "Reindex everything under ./data.", currentStageKey: "work", state: "working", attemptCount: 1 },
  stage: { key: "work", name: "Work" },
  handoff: { summary: "schema migrated" },
  references: [{ id: "ref_1", url: "https://example.test/doc", title: "Index format", provider: "web", sourceType: "document" }],
};

const happyBoard: Handler = (path) => {
  if (path.endsWith("/claims")) return { status: 200, body: claimBody };
  if (path.endsWith(`/runs/${RUN_ID}`)) return { status: 200, body: contextBody };
  return { status: 200, body: { ok: true } };
};

const boardError = (code: string) => ({ error: { ok: false, code, message: code } });

const key = (externalRunId = RUN_ID) => ({
  tenantId: BOOTSTRAP_TENANT_ID,
  externalSource: "kaambaan",
  boardId: BOARD_ID,
  externalCardId: CARD_ID,
  externalRunId,
});

const deps = (client: KaambaanClient, acp: AcpPort) => ({
  client,
  acp,
  agent,
  tenantId: BOOTSTRAP_TENANT_ID,
  source: "kaambaan",
  // Long enough never to fire inside a test; the turn ends on an idle event.
  heartbeatMs: 60_000,
  turnTimeoutMs: 5_000,
});

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

describe("a claim with nothing to claim", () => {
  test("opens no session and writes nothing", async () => {
    const board = fakeBoard(() => ({ status: 200, body: { claimed: false } }));
    const acp = fakeAcp(() => []);

    expect(await runOnce(deps(board.client, acp.port))).toMatchObject({ status: "idle" });
    expect(acp.state.created).toBe(0);
    expect(await db.select().from(acpRuns).where(eq(acpRuns.stationId, STATION_ID))).toHaveLength(0);
  });
});

describe("a card worked start to finish", () => {
  test("the harness is prompted with the assembled card, not the title", async () => {
    // What the spike got wrong: it sent `work.card.title` and dropped the spec,
    // the handoff and every reference.
    const board = fakeBoard(happyBoard);
    const acp = fakeAcp(() => [chunk("Reindexed 412 documents."), idle()]);

    await runOnce(deps(board.client, acp.port));

    const prompt = acp.state.prompts[0]!;
    expect(prompt).toContain("# Rebuild the index");
    expect(prompt).toContain("Reindex everything under ./data.");
    expect(prompt).toContain("schema migrated");
    expect(prompt).toContain("https://example.test/doc");
    expect(prompt).toContain("attempt 1");
    expect(prompt).not.toContain(TOKEN);
  });

  test("the run join is written, and the board is told once", async () => {
    const board = fakeBoard(happyBoard);
    const acp = fakeAcp(() => [chunk("Reindexed 412 documents."), idle()]);

    const result = await runOnce(deps(board.client, acp.port));
    expect(result.status).toBe("reported");

    const [run] = await db.select().from(acpRuns).where(eq(acpRuns.stationId, STATION_ID));
    expect(run!.externalRunId).toBe(RUN_ID);
    expect(run!.externalSource).toBe("kaambaan");
    expect(run!.state).toBe("completed");
    expect(run!.endedAt).toBeInstanceOf(Date);

    expect(board.verbs().filter((v) => v === "complete")).toHaveLength(1);
    expect(await dispatchOutcome(key())).toMatchObject({ outcome: "reported" });
  });

  test("what the agent said reaches the board, coalesced", async () => {
    const board = fakeBoard(happyBoard);
    // 300 chunks of one sentence: the Hermes shape, in miniature.
    const acp = fakeAcp(() => [...Array.from({ length: 300 }, (_, i) => chunk(`${i} `)), idle()]);

    await runOnce(deps(board.client, acp.port));
    const activities = board.calls.filter((c) => c.path.endsWith("/activities"));
    expect(activities.length).toBeLessThan(10);
    expect(JSON.stringify(activities)).toContain("299");
  });

  test("the session is closed when the work is done", async () => {
    const board = fakeBoard(happyBoard);
    const acp = fakeAcp(() => [chunk("done"), idle()]);
    await runOnce(deps(board.client, acp.port));
    expect(acp.state.ended).toHaveLength(1);
  });

  test("the output is recorded before the board is told", async () => {
    // The ordering that makes at-least-once recoverable: if `complete` never
    // lands, the row already says what the work produced.
    const board = fakeBoard((path) => {
      if (path.endsWith("/claims")) return { status: 200, body: claimBody };
      if (path.endsWith(`/runs/${RUN_ID}`)) return { status: 200, body: contextBody };
      if (path.endsWith("/complete")) return { status: 502, body: "gateway" };
      return { status: 200, body: { ok: true } };
    });
    const acp = fakeAcp(() => [chunk("Reindexed 412 documents."), idle()]);

    const result = await runOnce(deps(board.client, acp.port));
    expect(result.status).toBe("unreported");
    expect(await dispatchOutcome(key())).toMatchObject({ outcome: "produced" });
  });
});

describe("409 STALE_LEASE — the lease is gone, so the harness must stop", () => {
  const staleBoard: Handler = (path) => {
    if (path.endsWith("/claims")) return { status: 200, body: claimBody };
    if (path.endsWith(`/runs/${RUN_ID}`)) return { status: 200, body: contextBody };
    if (path.endsWith("/activities")) return { status: 409, body: boardError("STALE_LEASE") };
    return { status: 200, body: { ok: true } };
  };

  test("the ACP session is ended — kaambaan fences its data, nothing else fences the machine", async () => {
    const board = fakeBoard(staleBoard);
    const acp = fakeAcp(() => [chunk("still working"), chunk("and working"), idle()]);

    const result = await runOnce(deps(board.client, acp.port));

    expect(result.status).toBe("lease-superseded");
    expect(acp.state.ended).toHaveLength(1);
    expect(acp.state.ended[0]!.toLowerCase()).toContain("lease");
  });

  test("no verb is sent on a run we no longer hold", async () => {
    // Not even the `fail` or `release` a tidy error path would send: both would
    // 409 too, and both are an attempt to write to someone else's card.
    const board = fakeBoard(staleBoard);
    const acp = fakeAcp(() => [chunk("still working"), idle()]);

    await runOnce(deps(board.client, acp.port));

    expect(board.verbs()).not.toContain("complete");
    expect(board.verbs()).not.toContain("fail");
    expect(board.verbs()).not.toContain("release");
  });

  test("the attempt is closed as canceled and nothing is left to replay", async () => {
    const board = fakeBoard(staleBoard);
    const acp = fakeAcp(() => [chunk("still working"), idle()]);

    await runOnce(deps(board.client, acp.port));

    const [run] = await db.select().from(acpRuns).where(eq(acpRuns.stationId, STATION_ID));
    expect(run!.state).toBe("canceled");
    expect(await dispatchOutcome(key())).toMatchObject({ outcome: "abandoned" });
    // The card is someone else's now: replaying our half-done handoff onto it
    // would report work this bridge cannot vouch for.
    expect((await dispatchOutcome(key()))!.reason!.toLowerCase()).toContain("lease");
  });
});

describe("403 NOT_RUN_OWNER — a different fact, and never a retry", () => {
  const foreignBoard: Handler = (path) => {
    if (path.endsWith("/claims")) return { status: 200, body: claimBody };
    if (path.endsWith(`/runs/${RUN_ID}`)) return { status: 200, body: contextBody };
    if (path.endsWith("/activities")) return { status: 403, body: boardError("NOT_RUN_OWNER") };
    return { status: 200, body: { ok: true } };
  };

  test("it is reported as its own outcome, not as a lost lease", async () => {
    const board = fakeBoard(foreignBoard);
    const acp = fakeAcp(() => [chunk("working"), idle()]);

    const result = await runOnce(deps(board.client, acp.port));

    expect(result.status).toBe("foreign-run");
    expect(result.status).not.toBe("lease-superseded");
  });

  test("the harness is stopped and the reason names the fault", async () => {
    const board = fakeBoard(foreignBoard);
    const acp = fakeAcp(() => [chunk("working"), idle()]);

    await runOnce(deps(board.client, acp.port));

    expect(acp.state.ended).toHaveLength(1);
    expect(acp.state.ended[0]!.toLowerCase()).toContain("another agent");
    const outcome = await dispatchOutcome(key());
    expect(outcome!.reason!.toLowerCase()).toContain("another agent");
    expect(outcome!.reason!.toLowerCase()).not.toContain("lapsed");
  });

  test("the run is never touched again", async () => {
    const board = fakeBoard(foreignBoard);
    const acp = fakeAcp(() => [chunk("working"), idle()]);

    await runOnce(deps(board.client, acp.port));

    expect(board.verbs()).not.toContain("complete");
    expect(board.verbs()).not.toContain("fail");
    expect(board.verbs()).not.toContain("release");
  });
});

describe("at-least-once — a finished-but-unreported run comes back", () => {
  test("the prior output is reported and the harness is not run again", async () => {
    // RQ4's timeline: work done at t+180s, card re-offered at t+900s. The work
    // is not idempotent — it edited a workspace — but the REPORT is.
    await openDispatch({ ...key("run_a1b2c3d4e5f60718"), agentKey: "codex-mac", stationId: STATION_ID, leaseEpoch: 1 });
    await recordProduced(key("run_a1b2c3d4e5f60718"), { summary: "wrote three files" });

    const board = fakeBoard(happyBoard);
    const acp = fakeAcp(() => [chunk("should never run"), idle()]);

    const result = await runOnce(deps(board.client, acp.port));

    expect(result.status).toBe("replayed");
    expect(acp.state.created).toBe(0);
    expect(acp.state.prompts).toHaveLength(0);

    const complete = board.calls.find((c) => c.path.endsWith("/complete"))!;
    expect((complete.body as { handoff: unknown }).handoff).toEqual({ summary: "wrote three files" });
  });

  test("both the replayed run and the new one end up reported", async () => {
    await openDispatch({ ...key("run_a1b2c3d4e5f60718"), agentKey: "codex-mac", stationId: STATION_ID, leaseEpoch: 1 });
    await recordProduced(key("run_a1b2c3d4e5f60718"), { summary: "done" });

    const board = fakeBoard(happyBoard);
    await runOnce(deps(board.client, fakeAcp(() => []).port));

    expect(await dispatchOutcome(key("run_a1b2c3d4e5f60718"))).toMatchObject({ outcome: "reported" });
    expect(await dispatchOutcome(key())).toMatchObject({ outcome: "reported" });
  });
});

describe("a station with nowhere to run the work is never claimed", () => {
  // The live failure: the bridge's first cycle ran ~2s after a hub restart,
  // before the node-agents had reconnected. It claimed a card, could not open a
  // session, and left the card held by a run that never did anything.
  test("no claim is made at all", async () => {
    const board = fakeBoard(happyBoard);
    const acp = fakeAcp(() => [], { ready: { ready: false, reason: "Node is offline." } });

    const result = await runOnce(deps(board.client, acp.port));

    expect(result.status).toBe("not-ready");
    expect(result.reason).toContain("Node is offline.");
    // Not "claimed and released" — never claimed. The board saw no request at all.
    expect(board.calls).toHaveLength(0);
    expect(acp.state.created).toBe(0);
    expect(await dispatchOutcome(key())).toBeNull();
  });

  test("a ready station still claims — the check gates the race, not the work", async () => {
    const board = fakeBoard(happyBoard);
    const acp = fakeAcp(() => [chunk("Reindexed 412 documents."), idle()]);

    const result = await runOnce(deps(board.client, acp.port));

    expect(acp.state.readyChecks).toBe(1);
    expect(result.status).toBe("reported");
  });
});

describe("a claim that never started is handed straight back", () => {
  test("the session open failing releases the run, and the ledger says nothing ran", async () => {
    const board = fakeBoard(happyBoard);
    const acp = fakeAcp(() => [], { failCreate: "Node is offline." });

    const result = await runOnce(deps(board.client, acp.port));

    expect(result.status).toBe("released");
    // Released, not failed and not left to the 15-minute reclaim: no session
    // opened, so nothing can have touched the workspace.
    expect(board.verbs()).toContain("release");
    expect(board.verbs()).not.toContain("fail");
    expect(board.verbs()).not.toContain("block");

    const outcome = await dispatchOutcome(key());
    expect(outcome!.outcome).toBe("released");
    expect(outcome!.reason!.toLowerCase()).toContain("no session");
    expect(await db.select().from(acpRuns).where(eq(acpRuns.stationId, STATION_ID))).toHaveLength(0);
  });

  test("a prompt that cannot be assembled releases the same way", async () => {
    const board = fakeBoard((path) => {
      if (path.endsWith("/claims")) return { status: 200, body: claimBody };
      if (path.endsWith(`/runs/${RUN_ID}`)) return { status: 500, body: "boom" };
      return { status: 200, body: { ok: true } };
    });
    const acp = fakeAcp(() => []);

    const result = await runOnce(deps(board.client, acp.port));

    expect(result.status).toBe("released");
    expect(board.verbs()).toContain("release");
    expect(acp.state.created).toBe(0);
    expect((await dispatchOutcome(key()))!.outcome).toBe("released");
  });

  test("a run we no longer hold is not released — a 409 is not ours to hand back", async () => {
    const board = fakeBoard((path) => {
      if (path.endsWith("/claims")) return { status: 200, body: claimBody };
      if (path.endsWith(`/runs/${RUN_ID}`)) return { status: 409, body: boardError("STALE_LEASE") };
      return { status: 200, body: { ok: true } };
    });
    const acp = fakeAcp(() => []);

    const result = await runOnce(deps(board.client, acp.port));

    expect(result.status).toBe("lease-superseded");
    expect(board.verbs()).not.toContain("release");
    expect((await dispatchOutcome(key()))!.outcome).toBe("abandoned");
  });
});

describe("a failure after the session started is not released", () => {
  // Releasing here would hand a card whose workspace may already be half-edited
  // to the next claimer, with nothing recording that. kaambaan's `fail` re-queues
  // it with a reason and a failure count, and the circuit breaker parks it for a
  // human if it keeps happening.
  test("the board is told it failed, and the reason says a session had started", async () => {
    const board = fakeBoard(happyBoard);
    const acp = fakeAcp(() => [], { failPrompt: "the wire dropped" });

    const result = await runOnce(deps(board.client, acp.port));

    expect(result.status).toBe("failed");
    expect(board.verbs()).toContain("fail");
    expect(board.verbs()).not.toContain("release");

    const failCall = board.calls.find((c) => c.path.endsWith("/fail"))!;
    expect(String((failCall.body as { reason: string }).reason).toLowerCase()).toContain("session had started");

    const outcome = await dispatchOutcome(key());
    expect(outcome!.outcome).toBe("abandoned");
    expect(outcome!.outcome).not.toBe("released");
    expect(outcome!.reason!.toLowerCase()).toContain("session had started");
  });

  test("the harness is stopped — nothing else fences the machine", async () => {
    const board = fakeBoard(happyBoard);
    const acp = fakeAcp(() => [], { failPrompt: "the wire dropped" });

    await runOnce(deps(board.client, acp.port));

    expect(acp.state.ended).toHaveLength(1);
  });
});

describe("a permission request has nowhere to go", () => {
  test("the card is blocked for a human and the session is closed", async () => {
    // RQ2: an elicitation is a dead end in kaambaan — the transition exists and
    // nothing invokes it. Parking the harness until the 15-minute reclaim is
    // the alternative, and it is worse.
    const board = fakeBoard(happyBoard);
    const acp = fakeAcp(() => [
      ev("permission-request", { toolCall: { title: "Delete ./data" }, options: [{ optionId: "allow_once" }] }),
    ]);

    const result = await runOnce(deps(board.client, acp.port));

    expect(result.status).toBe("blocked");
    expect(board.verbs()).toContain("block");
    expect(acp.state.ended).toHaveLength(1);
  });
});
