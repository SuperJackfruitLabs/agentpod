/**
 * The kaambaan client, against a fake board. No network, no `wrangler dev`.
 *
 * The two failures that must never be collapsed into each other:
 *
 *   403 NOT_RUN_OWNER — this run belongs to another agent. A bug. Never retry.
 *   409 STALE_LEASE   — your lease lapsed. Stop work; the card is re-queued.
 *
 * kaambaan checks identity *before* the lease precisely so the two stay apart
 * (board-do.ts:1746-1766). A client that reported "conflict" for both would turn
 * a hijack into a retry loop, and the hijack is the one that cannot be fixed by
 * trying again.
 */

import { describe, expect, test } from "bun:test";

import { KaambaanApiError, KaambaanClient, isForeignRun, isLeaseSuperseded } from "./kaambaan";
import type { GatePendingDelivery } from "../matrix-as/gates";

const TOKEN = `kbn_${"a1b2c3d4".repeat(6)}`;
const BOARD = "brd_9c1d4e5f6a7b8c9d";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** A fake board. `reply` decides each response; every call is recorded. */
function fakeBoard(reply: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    const { status, body } = reply(call);
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  return { calls, client: new KaambaanClient({ baseUrl: "https://board.test", boardId: BOARD, token: TOKEN, fetch }) };
}

const claimed = {
  claimed: true,
  runId: "run_e074a2160c4b4f28",
  leaseEpoch: 1,
  card: { id: "crd_1a2b3c4d5e6f7a8b", title: "Rebuild the index", attemptCount: 1 },
  stage: { key: "work", name: "Work" },
  handoff: null,
};

const work = { runId: "run_e074a2160c4b4f28", leaseEpoch: 1 };

const boardError = (code: string, message = "no") => ({ error: { ok: false, code, message } });

describe("KaambaanClient — credential", () => {
  test("refuses anything that is not a kbn_ agent token", () => {
    const build = (token: string) =>
      new KaambaanClient({ baseUrl: "x", boardId: BOARD, token, fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }) });
    expect(() => build("sk-not-a-kaambaan-token")).toThrow(/kbn_/);
    expect(() => build("")).toThrow(/kbn_/);
  });

  test("authenticates with a bearer token and never sends a dev tenant header", () => {
    // The spike had to send `X-Tenant-Id: tnt_dev` because no agent-readable
    // read existed. It does now, and a deployed kaambaan rejects dev headers —
    // so sending one is a bug that only shows up against production.
    const { calls, client } = fakeBoard(() => ({ status: 200, body: { claimed: false } }));
    return client.claim().then(() => {
      expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(Object.keys(calls[0]!.headers).map((h) => h.toLowerCase())).not.toContain("x-tenant-id");
      expect(Object.keys(calls[0]!.headers).map((h) => h.toLowerCase())).not.toContain("x-agent-id");
    });
  });
});

describe("KaambaanClient — claim", () => {
  test("returns the work packet", async () => {
    const { calls, client } = fakeBoard(() => ({ status: 200, body: claimed }));
    const got = await client.claim({ maxConcurrency: 2, profileKey: "codex" });

    expect(calls[0]!.url).toBe(`https://board.test/v1/boards/${BOARD}/claims`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ maxConcurrency: 2, profileKey: "codex" });
    expect(got).toMatchObject({ runId: claimed.runId, leaseEpoch: 1 });
    expect(got!.card.attemptCount).toBe(1);
  });

  test("a claim never carries an agentId — identity comes from the token", () => {
    // Decision 3: an agent's authority is its own. A client-asserted agentId is
    // a request to be treated as someone else, and kaambaan ignores it anyway
    // (index.ts:365-372 reads the principal, never the body).
    const { calls, client } = fakeBoard(() => ({ status: 200, body: { claimed: false } }));
    return client.claim().then(() => {
      expect(calls[0]!.body).not.toContain("agentId");
    });
  });

  test("nothing to claim is null, not an error", async () => {
    const { client } = fakeBoard(() => ({ status: 200, body: { claimed: false } }));
    expect(await client.claim()).toBeNull();
  });

  test("a board over its budget ceiling is indistinguishable from no work — and stays that way", async () => {
    // kaambaan returns a bare `{claimed:false}` for over-budget, at-concurrency
    // and nothing-ready alike (board-do.ts:1301-1320). The client must not
    // invent a reason it was not told.
    const { client } = fakeBoard(() => ({ status: 200, body: { claimed: false } }));
    expect(await client.claim()).toBeNull();
  });

  test("a rejected token is an error, never 'no work available'", async () => {
    const { client } = fakeBoard(() => ({ status: 401, body: { error: "a valid agent token is required" } }));
    await expect(client.claim()).rejects.toThrow(KaambaanApiError);
  });

  test("a claimed:true response missing its run is treated as no work", async () => {
    const { client } = fakeBoard(() => ({ status: 200, body: { claimed: true } }));
    expect(await client.claim()).toBeNull();
  });
});

describe("KaambaanClient — the agent read surface", () => {
  test("reads a run's context without a lease", async () => {
    const context = {
      run: { runId: work.runId, cardId: "crd_1", stageKey: "work", leaseEpoch: 1, status: "working", outcome: null, startedAt: "t", endedAt: null },
      card: { id: "crd_1", title: "t", spec: null, currentStageKey: "work", state: "working", attemptCount: 2 },
      stage: { key: "work", name: "Work" },
      handoff: { summary: "prior" },
      references: [],
    };
    const { calls, client } = fakeBoard(() => ({ status: 200, body: context }));
    const got = await client.context(work.runId);

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`https://board.test/v1/boards/${BOARD}/runs/${work.runId}`);
    expect(got.card.attemptCount).toBe(2);
    expect(got.handoff).toEqual({ summary: "prior" });
  });

  test("reading another agent's run is a 403 that names the reason", async () => {
    const { client } = fakeBoard(() => ({ status: 403, body: boardError("NOT_RUN_OWNER") }));
    const err = await client.context(work.runId).catch((e) => e);
    expect(isForeignRun(err)).toBe(true);
  });
});

describe("KaambaanClient — verbs", () => {
  test("every run verb carries the lease epoch, and lands on kaambaan's own action names", async () => {
    const seen: string[] = [];
    const { client } = fakeBoard((c) => {
      seen.push(new URL(c.url).pathname.split("/").pop()!);
      expect(JSON.parse(c.body!).leaseEpoch).toBe(1);
      return { status: 200, body: { run: {} } };
    });

    await client.heartbeat(work);
    await client.activity(work, { type: "thought", body: "x", ephemeral: true });
    await client.complete(work, { summary: "done" });
    await client.submitForReview(work, { diff: "…" });
    await client.block(work, "needs a human");
    await client.fail(work, "harness died");
    await client.release(work);

    // `activities` and `submit`, not `postActivity` and `submitForReview` —
    // the verb names in the switch at kaambaan index.ts:414-443.
    expect(seen).toEqual(["heartbeat", "activities", "complete", "submit", "block", "fail", "release"]);
  });

  test("an activity is sent in the fields kaambaan actually reads", async () => {
    const { calls, client } = fakeBoard(() => ({ status: 200, body: { activity: {} } }));
    await client.activity(work, { type: "action", action: "Read a.ts", parameter: { path: "a.ts" }, result: "ok" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      leaseEpoch: 1,
      type: "action",
      action: "Read a.ts",
      parameter: { path: "a.ts" },
      result: "ok",
    });
  });
});

describe("KaambaanClient — 403 and 409 are different facts", () => {
  test("409 STALE_LEASE says the lease lapsed", async () => {
    const { client } = fakeBoard(() => ({ status: 409, body: boardError("STALE_LEASE", "no active lease for this run") }));
    const err = (await client.heartbeat(work).catch((e) => e)) as KaambaanApiError;

    expect(isLeaseSuperseded(err)).toBe(true);
    expect(isForeignRun(err)).toBe(false);
    expect(err.code).toBe("STALE_LEASE");
    expect(err.status).toBe(409);
  });

  test("403 NOT_RUN_OWNER says the run is someone else's", async () => {
    const { client } = fakeBoard(() => ({ status: 403, body: boardError("NOT_RUN_OWNER", "this run belongs to another agent") }));
    const err = (await client.complete(work).catch((e) => e)) as KaambaanApiError;

    expect(isForeignRun(err)).toBe(true);
    expect(isLeaseSuperseded(err)).toBe(false);
    expect(err.code).toBe("NOT_RUN_OWNER");
    expect(err.status).toBe(403);
  });

  test("the code decides, not the status — 403 and 409 carry other codes too", async () => {
    // kaambaan answers 403 for SEPARATION_OF_DUTIES and 409 for GATE_NOT_PENDING
    // (index.ts:31-58). Classifying on status alone would call a gate conflict a
    // lost lease and end a healthy harness mid-run.
    const sod = fakeBoard(() => ({ status: 403, body: boardError("SEPARATION_OF_DUTIES") }));
    expect(isForeignRun(await sod.client.heartbeat(work).catch((e) => e))).toBe(false);

    const gate = fakeBoard(() => ({ status: 409, body: boardError("GATE_NOT_PENDING") }));
    expect(isLeaseSuperseded(await gate.client.heartbeat(work).catch((e) => e))).toBe(false);
  });

  test("neither predicate fires on a plain failure or a non-error value", async () => {
    const { client } = fakeBoard(() => ({ status: 500, body: "gateway exploded" }));
    const err = (await client.heartbeat(work).catch((e) => e)) as KaambaanApiError;
    expect(isForeignRun(err)).toBe(false);
    expect(isLeaseSuperseded(err)).toBe(false);
    expect(err.code).toBeNull();

    expect(isForeignRun(new Error("something else"))).toBe(false);
    expect(isLeaseSuperseded(undefined)).toBe(false);
  });

  test("the error message names the verb, so a log line identifies the call", async () => {
    const { client } = fakeBoard(() => ({ status: 409, body: boardError("STALE_LEASE", "no active lease for this run") }));
    const err = (await client.activity(work, { type: "thought" }).catch((e) => e)) as KaambaanApiError;
    expect(err.message).toContain("activities");
    expect(err.message).toContain("no active lease for this run");
  });
});

describe("KaambaanClient — pending gates", () => {
  const gate: GatePendingDelivery = {
    event: "gate.pending",
    boardId: BOARD,
    cardId: "crd_1a2b3c4d5e6f7a8b",
    gateId: "gate_4e8b",
    stageKey: "review",
    returnStageKey: "code",
    cardTitle: "Add OAuth login",
    producedBy: "agt_31d0",
    handoffSummary: "Wrote the haiku.",
    options: [{ id: "approve", label: "Approve" }],
    ts: "2026-08-30T00:00:00.000Z",
  };

  test("reads the gates a board is still waiting on", async () => {
    const { client, calls } = fakeBoard(() => ({ status: 200, body: { gates: [gate] } }));

    expect(await client.pendingGates()).toEqual([gate]);
    expect(calls[0]!.url).toBe(`https://board.test/v1/boards/${BOARD}/gates/pending`);
    expect(calls[0]!.method).toBe("GET");
    // The agent's own token. The board snapshot carrying the same gates is a
    // human route, and reaching it would mean asserting a person on a timer.
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("reads an empty board as no gates, not as a failure", async () => {
    const { client } = fakeBoard(() => ({ status: 200, body: { gates: [] } }));
    expect(await client.pendingGates()).toEqual([]);
  });

  test("throws on a refusal rather than reporting a quiet board", async () => {
    // A rejected token that read as "no gates pending" would let the sweep
    // report healthy forever while every gate it exists to catch stayed silent.
    const { client } = fakeBoard(() => ({ status: 401, body: boardError("UNAUTHORIZED") }));
    await expect(client.pendingGates()).rejects.toBeInstanceOf(KaambaanApiError);
  });
});
