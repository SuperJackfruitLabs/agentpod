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
import { bridgeDispatches } from "../../src/db/schema/bridge";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import type { BridgeAgentConfig } from "../../src/services/bridge/config";
import { runOnce, type AcpPort, type DispatchDeps } from "../../src/services/bridge/dispatch";
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

/** A durable event: one in, exactly one activity out. The 1:1 shape. */
const toolCall = (title: string): AcpEvent =>
  ev("agent-update", { sessionUpdate: "tool_call", title, rawInput: { path: "./data" } });

/** A kind with no board representation at all: N in, zero activities out. */
const droppedKind = (): AcpEvent => ev("agent-update", { sessionUpdate: "available_commands_update" });

interface FakeAcpOpts {
  /** What the readiness probe answers. Ready unless a test says otherwise. */
  ready?: { ready: boolean; reason?: string };
  /** Fail the session open — a node that went offline between the two. */
  failCreate?: string;
  /** Fail the first prompt — a session that opened and then lost its wire. */
  failPrompt?: string;
  /**
   * What the harness does once a permission answer reaches it. A real one
   * resumes the turn; the option it was given decides what it resumes doing.
   */
  onAnswer?: (optionId: string) => AcpEvent[];
}

/** An ACP port that scripts a turn instead of talking to a station. */
function fakeAcp(script: () => AcpEvent[], opts: FakeAcpOpts = {}) {
  const subs = new Set<(e: AcpEvent) => void>();
  const state = {
    created: 0,
    readyChecks: 0,
    prompts: [] as string[],
    ended: [] as string[],
    answers: [] as Array<{ requestSeq: number; optionId: string }>,
  };
  const emit = (e: AcpEvent) => subs.forEach((fn) => fn(e));
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
        for (const e of script()) emit(e);
      });
    },
    subscribe(_sessionId, fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    async endSession(_u, _s, reason) {
      state.ended.push(reason);
    },
    async answerPermission(_u, _s, requestSeq, optionId) {
      state.answers.push({ requestSeq, optionId });
      queueMicrotask(() => {
        for (const e of opts.onAnswer?.(optionId) ?? []) emit(e);
      });
    },
  };
  return { port, state, emit };
}

// ─── a board that can be asked a question ────────────────────────────────────

/** One row of kaambaan's `elicitations`, as the run read surface returns it. */
interface Question {
  id: string;
  question: string;
  options: Array<{ name: string; title: string }>;
  status: "pending" | "answered" | "cancelled";
  answer: { option: string | null; text: string | null; answeredBy: string; answeredAt: string } | null;
  createdAt: string;
}

/**
 * A board that stores elicitations, supersedes the pending one when a new
 * question arrives (kaambaan's `openElicitation` does exactly that), and lets
 * the test decide what happens to the pending question on each read.
 */
function askingBoard(
  onRead: (q: Question, reads: number) => void = () => {},
  override?: (path: string, body: unknown) => { status: number; body: unknown } | null,
) {
  const elicitations: Question[] = [];
  let reads = 0;
  const handler: Handler = (path, body) => {
    const forced = override?.(path, body);
    if (forced) return forced;
    if (path.endsWith("/claims")) return { status: 200, body: claimBody };
    if (path.endsWith(`/runs/${RUN_ID}`)) {
      const pending = elicitations.find((q) => q.status === "pending");
      if (pending) onRead(pending, ++reads);
      return { status: 200, body: { ...contextBody, elicitations: elicitations.map((q) => ({ ...q })) } };
    }
    if (path.endsWith("/activities")) {
      const a = body as { type?: string; body?: string; parameter?: { options?: Question["options"] } };
      if (a.type === "elicitation") {
        for (const q of elicitations) if (q.status === "pending") q.status = "cancelled";
        elicitations.push({
          id: `elc_${elicitations.length + 1}`,
          question: a.body ?? "",
          options: a.parameter?.options ?? [],
          status: "pending",
          answer: null,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, elicitations.length)).toISOString(),
        });
      }
      return { status: 200, body: { activity: { accepted: true } } };
    }
    return { status: 200, body: { ok: true } };
  };
  return { handler, elicitations };
}

/** A human picking one of the offered options. */
const answers = (option: string | null, text: string | null = null) => (q: Question) => {
  q.status = "answered";
  q.answer = { option, text, answeredBy: "usr_the_human", answeredAt: "2026-01-01T00:00:00.000Z" };
};

/** The ACP options a harness offers before running a command. */
const RUN_TESTS_OPTIONS = [
  { optionId: "allow_once", name: "Yes, run it", kind: "allow_once" },
  { optionId: "reject_once", name: "No, don't", kind: "reject_once" },
];

const permissionRequest = (options = RUN_TESTS_OPTIONS, extra: Record<string, unknown> = {}): AcpEvent =>
  ev("permission-request", { toolCall: { title: "Run `bun test`", kind: "execute" }, options, ...extra });

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

const deps = (
  client: KaambaanClient,
  acp: AcpPort,
  log?: (message: string, meta?: Record<string, unknown>) => void,
  over: Partial<DispatchDeps> = {},
): DispatchDeps => ({
  client,
  acp,
  agent,
  tenantId: BOOTSTRAP_TENANT_ID,
  source: "kaambaan",
  // Long enough never to fire inside a test; the turn ends on an idle event.
  heartbeatMs: 60_000,
  turnTimeoutMs: 5_000,
  // A human answers in milliseconds here. The shipped defaults are minutes.
  permissionPollMs: 1,
  permissionWaitMs: 2_000,
  log,
  ...over,
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

/**
 * A permission request, asked of a human and waited for.
 *
 * The failure this replaces happened in production on 2026-08-14: an agent
 * wrote two files, asked permission to run the tests, and the bridge failed the
 * run with "the agent asked for permission, which the board cannot answer" —
 * leaving the partial work in the workspace and the card parked. Since
 * `accept-edits` auto-approves file writes but not command execution, EVERY
 * card whose work involves running something died that way.
 *
 * kaambaan PR #36 built the return path, so the question now goes to a human
 * and the answer comes back on the same lease.
 */
describe("a permission request is asked of a human", () => {
  test("it becomes an elicitation, with its options intact", async () => {
    const asked = askingBoard(answers("allow_once"));
    const board = fakeBoard(asked.handler);
    const acp = fakeAcp(() => [permissionRequest()], {
      onAnswer: () => [chunk("412 tests passed."), idle()],
    });

    await runOnce(deps(board.client, acp.port));

    const posted = board.calls
      .filter((c) => c.path.endsWith("/activities"))
      .map((c) => c.body as { type?: string; signal?: string; body?: string; parameter?: unknown })
      .find((a) => a.type === "elicitation")!;

    expect(posted).toBeDefined();
    expect(posted.signal).toBe("select");
    expect(posted.body).toContain("Run `bun test`");
    // In `parameter`, which kaambaan stores — not `signalMetadata`, which it
    // removed from its contract entirely because nothing ever read it.
    expect(posted.parameter).toMatchObject({
      options: [
        { name: "allow_once", title: "Yes, run it" },
        { name: "reject_once", title: "No, don't" },
      ],
    });
    expect(asked.elicitations[0]!.options).toHaveLength(2);
  });

  test("the lease is held throughout — the run is never handed back to ask", async () => {
    const asked = askingBoard(answers("allow_once"));
    const board = fakeBoard(asked.handler);
    const acp = fakeAcp(() => [permissionRequest()], {
      onAnswer: () => [chunk("412 tests passed."), idle()],
    });

    await runOnce(deps(board.client, acp.port));

    // Asking is not blocking, releasing or failing: the same run finishes the
    // work, so the agent resumes as itself rather than re-claiming.
    expect(board.verbs()).not.toContain("block");
    expect(board.verbs()).not.toContain("release");
    expect(board.verbs()).not.toContain("fail");
    expect(board.calls.filter((c) => c.path.endsWith("/claims"))).toHaveLength(1);
  });

  test("the answer resumes the harness, and the work finishes", async () => {
    const asked = askingBoard(answers("allow_once"));
    const board = fakeBoard(asked.handler);
    const acp = fakeAcp(() => [permissionRequest()], {
      onAnswer: (optionId) =>
        optionId === "allow_once" ? [chunk("412 tests passed."), idle()] : [chunk("Skipped."), idle()],
    });

    const result = await runOnce(deps(board.client, acp.port));

    expect(result.status).toBe("reported");
    expect(acp.state.answers).toHaveLength(1);
    expect(acp.state.answers[0]!.optionId).toBe("allow_once");
    expect(board.verbs()).toContain("complete");

    const complete = board.calls.find((c) => c.path.endsWith("/complete"))!;
    expect(JSON.stringify((complete.body as { handoff: unknown }).handoff)).toContain("412 tests passed.");
    expect(acp.state.ended).toHaveLength(1);
  });

  test("a DENIAL is delivered as the human gave it", async () => {
    // The mutation this kills: an answer path that approves regardless of what
    // came back. The board says `reject_once`; the harness must be told
    // `reject_once`, and must not be told any allow option.
    const asked = askingBoard(answers("reject_once"));
    const board = fakeBoard(asked.handler);
    const acp = fakeAcp(() => [permissionRequest()], {
      onAnswer: (optionId) =>
        optionId === "reject_once"
          ? [chunk("Understood — I did not run the tests."), idle()]
          : [chunk("Ran the tests anyway."), idle()],
    });

    const result = await runOnce(deps(board.client, acp.port));

    expect(acp.state.answers[0]!.optionId).toBe("reject_once");
    expect(acp.state.answers[0]!.optionId).not.toBe("allow_once");
    expect(result.status).toBe("reported");
    // And the harness's own account of the denial is what reached the board.
    const complete = board.calls.find((c) => c.path.endsWith("/complete"))!;
    const handoff = JSON.stringify((complete.body as { handoff: unknown }).handoff);
    expect(handoff).toContain("did not run the tests");
    expect(handoff).not.toContain("anyway");
  });

  test("the answer is matched to the request the harness is blocked on", async () => {
    const asked = askingBoard(answers("allow_once"));
    const board = fakeBoard(asked.handler);
    const request = permissionRequest();
    const acp = fakeAcp(() => [request], { onAnswer: () => [idle()] });

    await runOnce(deps(board.client, acp.port));

    expect(acp.state.answers[0]!.requestSeq).toBe(request.seq);
  });

  test("a second question in the same turn is asked and answered too", async () => {
    let pending: AcpEvent | null = null;
    const asked = askingBoard(answers("allow_once"));
    const board = fakeBoard(asked.handler);
    const acp = fakeAcp(() => [permissionRequest()], {
      onAnswer: () => {
        if (pending) return [chunk("Both done."), idle()];
        pending = permissionRequest([{ optionId: "allow_once", name: "Yes, deploy" }]);
        return [pending];
      },
    });

    const result = await runOnce(deps(board.client, acp.port));

    expect(result.status).toBe("reported");
    expect(acp.state.answers).toHaveLength(2);
    expect(asked.elicitations).toHaveLength(2);
  });
});

describe("a question nobody answers", () => {
  test("the wait is bounded, and the run fails rather than holding the harness", async () => {
    const asked = askingBoard(() => {
      /* the question stays pending: nobody is at the keyboard */
    });
    const board = fakeBoard(asked.handler);
    const acp = fakeAcp(() => [permissionRequest()]);

    const result = await runOnce(
      deps(board.client, acp.port, undefined, { permissionWaitMs: 25, permissionPollMs: 1 }),
    );

    expect(result.status).toBe("unanswered");
    expect(result.reason).toMatch(/answer/i);
    // Nothing was decided on the human's behalf.
    expect(acp.state.answers).toHaveLength(0);
    expect(acp.state.ended).toHaveLength(1);
  });

  test("it FAILS, not releases — a session started and the workspace may hold partial work", async () => {
    const asked = askingBoard(() => {});
    const board = fakeBoard(asked.handler);
    const acp = fakeAcp(() => [permissionRequest()]);

    await runOnce(deps(board.client, acp.port, undefined, { permissionWaitMs: 25, permissionPollMs: 1 }));

    expect(board.verbs()).toContain("fail");
    expect(board.verbs()).not.toContain("release");
    expect(board.verbs()).not.toContain("complete");

    const outcome = await dispatchOutcome(key());
    expect(outcome!.outcome).toBe("abandoned");
    expect(outcome!.reason!.toLowerCase()).toContain("permission");
  });

  test("the harness is still heartbeating while it waits — the lease is not silent", async () => {
    const asked = askingBoard(() => {});
    const board = fakeBoard(asked.handler);
    const acp = fakeAcp(() => [permissionRequest()]);

    await runOnce(
      deps(board.client, acp.port, undefined, {
        permissionWaitMs: 60,
        permissionPollMs: 1,
        heartbeatMs: 5,
      }),
    );

    // kaambaan reclaims a lease that goes quiet for 15 minutes. Waiting for a
    // human is not going quiet, so the bound on the wait is policy, not the
    // lease — and that only holds if the beat carries on through it.
    expect(board.verbs().filter((v) => v === "heartbeat").length).toBeGreaterThan(0);
  });
});

describe("a question that will never be answered", () => {
  test("a cancelled question stops the wait instead of running it out", async () => {
    // kaambaan cancels a pending question when its run ends or is reclaimed,
    // when the card is moved, or when a newer question supersedes it. All three
    // arrive as `cancelled`, and all three mean: stop waiting.
    const asked = askingBoard((q) => {
      q.status = "cancelled";
    });
    const board = fakeBoard(asked.handler);
    const acp = fakeAcp(() => [permissionRequest()]);

    const started = Date.now();
    const result = await runOnce(
      deps(board.client, acp.port, undefined, { permissionWaitMs: 30_000, permissionPollMs: 1 }),
    );

    expect(result.status).toBe("unanswered");
    expect(result.reason!.toLowerCase()).toContain("cancel");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(acp.state.answers).toHaveLength(0);
    expect(board.verbs()).toContain("fail");
  });

  test("an answer with no option in it is not a decision", async () => {
    // A human who typed free text and chose nothing has not selected an option.
    // Picking one for them is the mis-mapping this whole seam exists to avoid.
    const asked = askingBoard(answers(null, "do whatever you think is best"));
    const board = fakeBoard(asked.handler);
    const acp = fakeAcp(() => [permissionRequest()]);

    const result = await runOnce(deps(board.client, acp.port));

    expect(acp.state.answers).toHaveLength(0);
    expect(result.status).toBe("unanswered");
    expect(result.reason!.toLowerCase()).toContain("option");
  });

  test("an answer naming an option that was never offered is not a decision either", async () => {
    const asked = askingBoard(answers("rm_rf"));
    const board = fakeBoard(asked.handler);
    const acp = fakeAcp(() => [permissionRequest()]);

    const result = await runOnce(deps(board.client, acp.port));

    expect(acp.state.answers).toHaveLength(0);
    expect(result.status).toBe("unanswered");
  });

  test("a question the board never recorded is not waited on", async () => {
    // The elicitation post failed; waiting for an answer to a question nobody
    // can see would burn the whole wait and tell the human nothing.
    const asked = askingBoard(answers("allow_once"), (path) =>
      path.endsWith("/activities") ? { status: 502, body: "gateway" } : null,
    );
    const board = fakeBoard(asked.handler);
    const acp = fakeAcp(() => [permissionRequest()]);

    const result = await runOnce(
      deps(board.client, acp.port, undefined, { permissionWaitMs: 30_000, permissionPollMs: 1 }),
    );

    expect(result.status).toBe("unanswered");
    expect(result.reason!.toLowerCase()).toContain("board");
    expect(acp.state.answers).toHaveLength(0);
  });

  test("a lease lost while waiting stops the harness and touches nothing", async () => {
    const asked = askingBoard(() => {}, (path) =>
      path.endsWith("/heartbeat") ? { status: 409, body: boardError("STALE_LEASE") } : null,
    );
    const board = fakeBoard(asked.handler);
    const acp = fakeAcp(() => [permissionRequest()]);

    const result = await runOnce(
      deps(board.client, acp.port, undefined, {
        permissionWaitMs: 30_000,
        permissionPollMs: 1,
        heartbeatMs: 1,
      }),
    );

    expect(result.status).toBe("lease-superseded");
    expect(acp.state.ended).toHaveLength(1);
    expect(board.verbs()).not.toContain("fail");
    expect(board.verbs()).not.toContain("release");
  });
});

describe("a permission the hub answers itself is not a question", () => {
  test("accept-edits still auto-approves an edit, with no human involved", async () => {
    // Unchanged by any of this. `handlePermissionRequest` answers it inside the
    // hub and persists the request event marked `auto` — so the bridge must not
    // read one as a question. A card parked in `input-required` on a decision
    // already made is a card nobody can un-park.
    const asked = askingBoard(answers("allow_once"));
    const board = fakeBoard(asked.handler);
    const acp = fakeAcp(() => [
      permissionRequest([{ optionId: "allow_once", name: "Allow" }], { auto: true }),
      ev("permission-answer", { requestSeq: 1, optionId: "allow_once", auto: true }),
      chunk("Wrote a.ts."),
      idle(),
    ]);

    const result = await runOnce(
      deps(board.client, acp.port, undefined, { agent: { ...agent, mode: "accept-edits" } }),
    );

    expect(result.status).toBe("reported");
    expect(asked.elicitations).toHaveLength(0);
    expect(acp.state.answers).toHaveLength(0);
    expect(board.calls.filter((c) => c.path.endsWith("/activities")).map((c) => c.body)).not.toContainEqual(
      expect.objectContaining({ type: "elicitation" }),
    );
  });

  test("accept-edits DOES ask about a command — the production failure, fixed", async () => {
    // The 2026-08-14 card: two files written (auto-approved), then permission to
    // run the tests (not an edit, so parked), which used to end the run.
    const asked = askingBoard(answers("allow_once"));
    const board = fakeBoard(asked.handler);
    const acp = fakeAcp(
      () => [
        permissionRequest([{ optionId: "allow_once", name: "Allow" }], { auto: true }),
        chunk("Wrote two files."),
        permissionRequest(),
      ],
      { onAnswer: () => [chunk("412 tests passed."), idle()] },
    );

    const result = await runOnce(
      deps(board.client, acp.port, undefined, { agent: { ...agent, mode: "accept-edits" } }),
    );

    expect(result.status).toBe("reported");
    expect(result.status).not.toBe("blocked");
    expect(asked.elicitations).toHaveLength(1);
    expect(acp.state.answers[0]!.optionId).toBe("allow_once");
  });
});

/**
 * The bridge ran a real card on a real harness and the hub could count the
 * events *arriving* — 142 rows in `acp_events`, 135 of them `agent-update` —
 * but had no way at all to count the activities it posted *out*. Coalescing
 * could have been completely broken and nothing would have shown it: its unit
 * tests passed, and that is not the same as knowing.
 *
 * These tests are what stop the number becoming decorative. Every one of them
 * ties the count written to the ledger to something independently observed —
 * the activities the fake board actually received — so a counter that reports
 * a constant, and a counter that reports the event count, both fail here.
 */
describe("coalescing is countable from the hub alone", () => {
  const counts = async (externalRunId = RUN_ID) => {
    const [row] = await db
      .select({
        eventsReceived: bridgeDispatches.eventsReceived,
        activitiesPosted: bridgeDispatches.activitiesPosted,
      })
      .from(bridgeDispatches)
      .where(eq(bridgeDispatches.externalRunId, externalRunId));
    return row!;
  };

  const activityCalls = (board: ReturnType<typeof fakeBoard>) =>
    board.calls.filter((c) => c.path.endsWith("/activities")).length;

  test("a chunk storm is recorded as many events in and few activities out", async () => {
    // The Hermes shape in miniature: 1,051 events for one trivial prompt. If
    // coalescing works, one ledger row says so; if it has silently become 1:1,
    // this is the row that shows it.
    const board = fakeBoard(happyBoard);
    const acp = fakeAcp(() => [...Array.from({ length: 300 }, (_, i) => chunk(`${i} `)), idle()]);

    await runOnce(deps(board.client, acp.port));

    const row = await counts();
    // 300 chunks plus the `state: idle` that ended the turn — every event the
    // dispatch saw, which is what `acp_events` counts too.
    expect(row.eventsReceived).toBe(301);
    // Tied to what the board actually received, not to an internal opinion.
    expect(row.activitiesPosted).toBe(activityCalls(board));
    expect(row.activitiesPosted).toBeLessThan(10);
    expect(row.activitiesPosted).toBeGreaterThan(0);
  });

  test("a 1:1 transcript is recorded as 1:1 — the ratio is not assumed", async () => {
    // The counter must report what happened, not what coalescing is supposed
    // to achieve. Five durable events project to five activities, and a
    // counter hard-wired to look impressive gets this wrong.
    const board = fakeBoard(happyBoard);
    const acp = fakeAcp(() => [
      toolCall("read a"),
      toolCall("read b"),
      toolCall("read c"),
      toolCall("read d"),
      toolCall("read e"),
      idle(),
    ]);

    await runOnce(deps(board.client, acp.port));

    const row = await counts();
    expect(row.eventsReceived).toBe(6);
    expect(row.activitiesPosted).toBe(5);
    expect(row.activitiesPosted).toBe(activityCalls(board));
  });

  test("a flush that produced nothing is recorded as zero, not as missing", async () => {
    // Worth seeing on its own: a run whose whole transcript projected to
    // nothing looks identical to a healthy quiet run unless zero is written
    // down as zero.
    const board = fakeBoard(happyBoard);
    const acp = fakeAcp(() => [droppedKind(), droppedKind(), droppedKind(), idle()]);

    await runOnce(deps(board.client, acp.port));

    const row = await counts();
    expect(row.eventsReceived).toBe(4);
    expect(row.activitiesPosted).toBe(0);
    expect(row.activitiesPosted).not.toBeNull();
    expect(activityCalls(board)).toBe(0);
  });

  test("a run that never opened a session is not measured, and says so", async () => {
    // Null is not zero. A replay starts no harness, so there is no transcript
    // to have coalesced — and recording 0/0 for it would drop a fake data
    // point into every ratio an operator computes.
    await openDispatch({ ...key("run_a1b2c3d4e5f60718"), agentKey: "codex-mac", stationId: STATION_ID, leaseEpoch: 1 });
    await recordProduced(key("run_a1b2c3d4e5f60718"), { summary: "wrote three files" });

    const board = fakeBoard(happyBoard);
    const result = await runOnce(deps(board.client, fakeAcp(() => [chunk("never runs"), idle()]).port));

    expect(result.status).toBe("replayed");
    const row = await counts();
    expect(row.eventsReceived).toBeNull();
    expect(row.activitiesPosted).toBeNull();
  });

  test("the counts survive a run that ended badly", async () => {
    // A lost lease is where an operator most wants the number: it says how far
    // the run got before the board took the card away.
    const board = fakeBoard((path) => {
      if (path.endsWith("/claims")) return { status: 200, body: claimBody };
      if (path.endsWith(`/runs/${RUN_ID}`)) return { status: 200, body: contextBody };
      if (path.endsWith("/activities")) return { status: 409, body: boardError("STALE_LEASE") };
      return { status: 200, body: { ok: true } };
    });
    const acp = fakeAcp(() => [toolCall("read a"), chunk("thinking"), idle()]);

    const result = await runOnce(deps(board.client, acp.port));

    expect(result.status).toBe("lease-superseded");
    const row = await counts();
    expect(row.eventsReceived).toBeGreaterThan(0);
    expect(row.activitiesPosted).toBeGreaterThan(0);
  });
});

describe("the one log line a dispatch is allowed to spend on this", () => {
  const lines: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const capture = (message: string, meta?: Record<string, unknown>) => lines.push({ message, meta });
  const summaries = () => lines.filter((l) => l.message.includes("coalesced"));

  beforeEach(() => {
    lines.length = 0;
  });

  test("one line per dispatch carries the counts and the ratio", async () => {
    const board = fakeBoard(happyBoard);
    const acp = fakeAcp(() => [...Array.from({ length: 200 }, () => chunk("x")), idle()]);

    await runOnce(deps(board.client, acp.port, capture));

    // ONE. Not one per event — that is the volume problem coalescing exists to
    // solve, and issue #231 is a live example of a per-cycle line making
    // `apn logs` unusable.
    expect(summaries()).toHaveLength(1);
    const meta = summaries()[0]!.meta!;
    expect(meta.events).toBe(201);
    expect(meta.activities).toBe(1);
    expect(meta.eventsPerActivity).toBe(201);
    expect(meta.run).toBe(RUN_ID);
  });

  test("nothing that ran through the coalescer appears in the line", async () => {
    // The bridge deliberately never logs its token; work content is treated
    // the same way. Counts and ids, not payloads.
    const board = fakeBoard(happyBoard);
    const acp = fakeAcp(() => [chunk("the secret contents of the workspace"), toolCall("Delete ./data"), idle()]);

    await runOnce(deps(board.client, acp.port, capture));

    const line = JSON.stringify(summaries()[0]);
    expect(line).not.toContain("the secret contents of the workspace");
    expect(line).not.toContain("Delete ./data");
    // Nor the card's own spec, its title, or the agent's credential.
    expect(line).not.toContain("Reindex everything under ./data.");
    expect(line).not.toContain("Rebuild the index");
    expect(line).not.toContain(TOKEN);
  });

  test("a summary that cannot be written does not change what the run returned", async () => {
    // It is emitted from a `finally`, and a throw there REPLACES the returned
    // value — so a broken logger could swallow the `foreign-run` that is meant
    // to halt the loop. The measurement never outranks the work.
    const board = fakeBoard((path) => {
      if (path.endsWith("/claims")) return { status: 200, body: claimBody };
      if (path.endsWith(`/runs/${RUN_ID}`)) return { status: 200, body: contextBody };
      if (path.endsWith("/activities")) return { status: 403, body: boardError("NOT_RUN_OWNER") };
      return { status: 200, body: { ok: true } };
    });
    const acp = fakeAcp(() => [chunk("working"), idle()]);

    const result = await runOnce(
      deps(board.client, acp.port, () => {
        throw new Error("the log sink is gone");
      }),
    );

    expect(result.status).toBe("foreign-run");
  });

  test("a cycle that claimed nothing spends no line at all", async () => {
    // The loop polls every 5 seconds forever. A summary on an idle cycle is
    // 17,000 lines a day saying nothing happened.
    const board = fakeBoard(() => ({ status: 200, body: { claimed: false } }));

    await runOnce(deps(board.client, fakeAcp(() => []).port, capture));

    expect(summaries()).toHaveLength(0);
  });
});
