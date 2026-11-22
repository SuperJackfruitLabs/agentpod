/**
 * The superpipeline client, against a fake board. No network, no `wrangler dev`.
 *
 * The two failures that must never be collapsed into each other:
 *
 *   403 NOT_RUN_OWNER — this run belongs to another agent. A bug. Never retry.
 *   409 STALE_LEASE   — your lease lapsed. Stop work; the card is re-queued.
 *
 * superpipeline checks identity *before* the lease precisely so the two stay apart
 * (board-do.ts:1746-1766). A client that reported "conflict" for both would turn
 * a hijack into a retry loop, and the hijack is the one that cannot be fixed by
 * trying again.
 */

import { describe, expect, test } from "bun:test";

import { SuperpipelineApiError, SuperpipelineClient, isForeignRun, isLeaseSuperseded, isTransientBoardError, pathTemplate } from "./superpipeline";
import { context, trace } from "@opentelemetry/api";
import { tracer } from "../../telemetry/otel";
import { useTestTelemetry } from "../../../tests/helpers/telemetry";
import type { GatePendingDelivery } from "../board-chat/gates";
import { contractFetch } from "../../../tests/helpers/superpipeline-contract";

const TOKEN = `spa_${"a1b2c3d4".repeat(6)}`;
const BOARD = "brd_9c1d4e5f6a7b8c9d";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/**
 * A fake board. `reply` decides each response; every call is recorded, and every request is held to
 * SuperPipeline's contracts (agent-work.v1, decisions.v1) before it is answered: one that reaches
 * no operation, or sends a body its operation refuses, fails the test.
 */
function fakeBoard(reply: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch = contractFetch(async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    const { status, body } = reply(call);
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  });
  return { calls, client: new SuperpipelineClient({ baseUrl: "https://board.test", boardId: BOARD, token: TOKEN, fetch }) };
}

const claimed = {
  claimed: true,
  runId: "run_e074a2160c4b4f28",
  leaseEpoch: 1,
  card: { id: "card_1a2b3c4d5e6f7a8b", title: "Rebuild the index", attemptCount: 1 },
  stage: { key: "work", name: "Work" },
  handoff: null,
};

const work = { runId: "run_e074a2160c4b4f28", leaseEpoch: 1 };

const boardError = (code: string, message = "no") => ({ error: { ok: false, code, message } });

describe("SuperpipelineClient — credential", () => {
  test("refuses anything that is not a spa_ agent token", () => {
    const build = (token: string) =>
      new SuperpipelineClient({ baseUrl: "x", boardId: BOARD, token, fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }) });
    expect(() => build("sk-not-a-superpipeline-token")).toThrow(/spa_/);
    expect(() => build("")).toThrow(/spa_/);
  });

  test("authenticates with a bearer token and never sends a dev tenant header", () => {
    // The spike had to send `X-Tenant-Id: tnt_dev` because no agent-readable
    // read existed. It does now, and a deployed superpipeline rejects dev headers —
    // so sending one is a bug that only shows up against production.
    const { calls, client } = fakeBoard(() => ({ status: 200, body: { claimed: false } }));
    return client.claim().then(() => {
      expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(Object.keys(calls[0]!.headers).map((h) => h.toLowerCase())).not.toContain("x-tenant-id");
      expect(Object.keys(calls[0]!.headers).map((h) => h.toLowerCase())).not.toContain("x-agent-id");
    });
  });
});

describe("SuperpipelineClient — claim", () => {
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
    // a request to be treated as someone else, and superpipeline ignores it anyway
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
    // superpipeline returns a bare `{claimed:false}` for over-budget, at-concurrency
    // and nothing-ready alike (board-do.ts:1301-1320). The client must not
    // invent a reason it was not told.
    const { client } = fakeBoard(() => ({ status: 200, body: { claimed: false } }));
    expect(await client.claim()).toBeNull();
  });

  test("a rejected token is an error, never 'no work available'", async () => {
    const { client } = fakeBoard(() => ({ status: 401, body: { error: "a valid agent token is required" } }));
    await expect(client.claim()).rejects.toThrow(SuperpipelineApiError);
  });

  test("no work says why: the board's reason is kept, not dropped", async () => {
    // agent-work.v1 ClaimResult "Unclaimed": `reason` tells an empty queue from an over-budget
    // board and an agent at its cap. The client used to throw it away.
    for (const reason of ["no_matching_card", "board_over_budget", "concurrency_reached", "a_reason_from_later"]) {
      const { client } = fakeBoard(() => ({ status: 200, body: { claimed: false, reason } }));
      expect(await client.claimNext()).toEqual({ work: null, reason });
    }
    expect(await fakeBoard(() => ({ status: 200, body: { claimed: false } })).client.claimNext()).toEqual({ work: null, reason: null });
  });

  test("a claim after a failure carries why the last attempt died", async () => {
    const lastFailure = { reason: "harness died", agentId: "agt_31d0a1b2c3d4e5f6", stageKey: "work", endedAt: "2026-11-22T09:00:00.000Z" };
    const got = await fakeBoard(() => ({ status: 200, body: { ...claimed, lastFailure } })).client.claimNext();
    expect(got.work?.lastFailure).toEqual(lastFailure);
    const none = await fakeBoard(() => ({ status: 200, body: { ...claimed, lastFailure: null } })).client.claim();
    expect(none && "lastFailure" in none).toBe(false);
  });

  test("a claimed:true response missing its run is treated as no work", async () => {
    const { client } = fakeBoard(() => ({ status: 200, body: { claimed: true } }));
    expect(await client.claim()).toBeNull();
  });

  test("a claimed:true response whose card has no id or title is no work, not a card to cast", async () => {
    for (const card of [{ title: "t" }, { id: "card_1a2b3c4d5e6f7a8b" }, "card_1a2b3c4d5e6f7a8b"]) {
      expect(await fakeBoard(() => ({ status: 200, body: { ...claimed, card } })).client.claim()).toBeNull();
    }
    expect(await fakeBoard(() => ({ status: 200, body: { ...claimed, leaseEpoch: "1" } })).client.claim()).toBeNull();
  });
});

describe("SuperpipelineClient — the agent read surface", () => {
  test("reads a run's context without a lease", async () => {
    const context = {
      run: { runId: work.runId, cardId: "card_1a2b3c4d5e6f7a8b", stageKey: "work", leaseEpoch: 1, status: "working", outcome: null, startedAt: "t", endedAt: null },
      card: { id: "card_1a2b3c4d5e6f7a8b", title: "t", spec: null, currentStageKey: "work", state: "working", attemptCount: 2 },
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

  test("a run context is checked where every reader leans on it, not cast", async () => {
    // agent-work.v1's RunContext: a run, and a card with its id and title. A body without them
    // used to pass as a RunContext and fail later, as a TypeError in whichever reader got there first.
    for (const body of [{}, null, { run: {}, card: { title: "no id" } }, { card: { id: "card_1", title: "t" } }]) {
      await expect(fakeBoard(() => ({ status: 200, body })).client.context(work.runId)).rejects.toThrow(/run context/);
    }
  });

  test("reading another agent's run is a 403 that names the reason", async () => {
    const { client } = fakeBoard(() => ({ status: 403, body: boardError("NOT_RUN_OWNER") }));
    const err = await client.context(work.runId).catch((e) => e);
    expect(isForeignRun(err)).toBe(true);
  });
});

describe("SuperpipelineClient — verbs", () => {
  test("every run verb carries the lease epoch, and lands on superpipeline's own action names", async () => {
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
    // the verb names in the switch at superpipeline index.ts:414-443.
    expect(seen).toEqual(["heartbeat", "activities", "complete", "submit", "block", "fail", "release"]);
  });

  test("an activity is sent in the fields superpipeline actually reads", async () => {
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

describe("SuperpipelineClient — ids are path segments, never more path", () => {
  test("a run id and a board id are encoded where they sit in the path", async () => {
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      return { status: 200, ok: true, json: async () => ({ run: {} }) };
    };
    const client = new SuperpipelineClient({ baseUrl: "https://board.test", boardId: "brd_a/b?c", token: TOKEN, fetch });
    const odd = { runId: "run_x/../y?z", leaseEpoch: 1 };
    await client.heartbeat(odd);
    await client.completeVerified(odd, {});
    await client.fail(odd, "x");
    await client.claim();
    await client.context(odd.runId).catch(() => undefined);
    expect(urls).toEqual([
      "https://board.test/v1/boards/brd_a%2Fb%3Fc/runs/run_x%2F..%2Fy%3Fz/heartbeat",
      "https://board.test/v1/boards/brd_a%2Fb%3Fc/runs/run_x%2F..%2Fy%3Fz/complete",
      "https://board.test/v1/boards/brd_a%2Fb%3Fc/runs/run_x%2F..%2Fy%3Fz/fail",
      "https://board.test/v1/boards/brd_a%2Fb%3Fc/claims",
      "https://board.test/v1/boards/brd_a%2Fb%3Fc/runs/run_x%2F..%2Fy%3Fz",
    ]);
  });
});

describe("SuperpipelineClient — 403 and 409 are different facts", () => {
  test("409 STALE_LEASE says the lease lapsed", async () => {
    const { client } = fakeBoard(() => ({ status: 409, body: boardError("STALE_LEASE", "no active lease for this run") }));
    const err = (await client.heartbeat(work).catch((e) => e)) as SuperpipelineApiError;

    expect(isLeaseSuperseded(err)).toBe(true);
    expect(isForeignRun(err)).toBe(false);
    expect(err.code).toBe("STALE_LEASE");
    expect(err.status).toBe(409);
  });

  test("403 NOT_RUN_OWNER says the run is someone else's", async () => {
    const { client } = fakeBoard(() => ({ status: 403, body: boardError("NOT_RUN_OWNER", "this run belongs to another agent") }));
    const err = (await client.complete(work).catch((e) => e)) as SuperpipelineApiError;

    expect(isForeignRun(err)).toBe(true);
    expect(isLeaseSuperseded(err)).toBe(false);
    expect(err.code).toBe("NOT_RUN_OWNER");
    expect(err.status).toBe(403);
  });

  test("the code decides, not the status — 403 and 409 carry other codes too", async () => {
    // superpipeline answers 403 for SEPARATION_OF_DUTIES and 409 for GATE_NOT_PENDING
    // (index.ts:31-58). Classifying on status alone would call a gate conflict a
    // lost lease and end a healthy harness mid-run.
    const sod = fakeBoard(() => ({ status: 403, body: boardError("SEPARATION_OF_DUTIES") }));
    expect(isForeignRun(await sod.client.heartbeat(work).catch((e) => e))).toBe(false);

    const gate = fakeBoard(() => ({ status: 409, body: boardError("GATE_NOT_PENDING") }));
    expect(isLeaseSuperseded(await gate.client.heartbeat(work).catch((e) => e))).toBe(false);
  });

  test("neither predicate fires on a plain failure or a non-error value", async () => {
    const { client } = fakeBoard(() => ({ status: 500, body: "gateway exploded" }));
    const err = (await client.heartbeat(work).catch((e) => e)) as SuperpipelineApiError;
    expect(isForeignRun(err)).toBe(false);
    expect(isLeaseSuperseded(err)).toBe(false);
    expect(err.code).toBeNull();

    expect(isForeignRun(new Error("something else"))).toBe(false);
    expect(isLeaseSuperseded(undefined)).toBe(false);
  });

  test("the error message names the verb, so a log line identifies the call", async () => {
    const { client } = fakeBoard(() => ({ status: 409, body: boardError("STALE_LEASE", "no active lease for this run") }));
    const err = (await client.activity(work, { type: "thought" }).catch((e) => e)) as SuperpipelineApiError;
    expect(err.message).toContain("activities");
    expect(err.message).toContain("no active lease for this run");
  });
});

describe("SuperpipelineClient — a board that did not answer for itself", () => {
  test("a 5xx or a timeout is transient; a refusal never is", async () => {
    for (const status of [500, 502, 503, 504]) {
      const { client } = fakeBoard(() => ({ status, body: null }));
      expect(isTransientBoardError(await client.heartbeat(work).catch((e) => e))).toBe(true);
    }
    for (const [status, code] of [[409, "STALE_LEASE"], [403, "NOT_RUN_OWNER"], [401, null], [404, null], [429, null]] as const) {
      const { client } = fakeBoard(() => ({ status, body: code ? boardError(code, "refused") : null }));
      expect(isTransientBoardError(await client.heartbeat(work).catch((e) => e))).toBe(false);
    }
    expect(isTransientBoardError(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isTransientBoardError(Error("Strict work renewal unavailable"))).toBe(false);
    expect(isTransientBoardError(null)).toBe(false);
  });
});

describe("SuperpipelineClient — pending gates", () => {
  const gate: GatePendingDelivery = {
    event: "gate.pending",
    boardId: BOARD,
    cardId: "card_1a2b3c4d5e6f7a8b",
    gateId: "gate_4e8b1c2d3f4a5b6c",
    stageKey: "review",
    returnStageKey: "code",
    cardTitle: "Add OAuth login",
    producedBy: "agt_31d0a1b2c3d4e5f6",
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
    await expect(client.pendingGates()).rejects.toBeInstanceOf(SuperpipelineApiError);
  });
});

describe("SuperpipelineClient — pending delivery follow-ups", () => {
  test("reads the follow-ups a board is still owed, from the sweep's route", async () => {
    const followUp = { event: "delivery.pending", gateId: "gate_8f3a1b2c3d4e5f60" };
    const { client, calls } = fakeBoard(() => ({ status: 200, body: { deliveries: [followUp] } }));
    expect(await client.pendingDeliveries()).toEqual([followUp]);
    expect(calls[0]?.url).toBe(`https://board.test/v1/boards/${BOARD}/deliveries/pending`);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("reads a body with no list as nothing owed", async () => {
    const { client } = fakeBoard(() => ({ status: 200, body: {} }));
    expect(await client.pendingDeliveries()).toEqual([]);
  });

  test("throws on a refusal rather than reporting nothing owed", async () => {
    const { client } = fakeBoard(() => ({ status: 401, body: boardError("UNAUTHORIZED") }));
    await expect(client.pendingDeliveries()).rejects.toBeInstanceOf(SuperpipelineApiError);
  });
});

describe("SuperpipelineClient — cards waiting on a person", () => {
  test("reads the cards a board says are waiting, from the sweep's route", async () => {
    const waiting = { event: "attention.pending", cardId: "card_1a2b3c4d5e6f7a8b", waitId: "wait_0123456789abcdef" };
    const { client, calls } = fakeBoard(() => ({ status: 200, body: { attention: [waiting] } }));
    expect(await client.pendingAttention()).toEqual([waiting]);
    expect(calls[0]?.url).toBe(`https://board.test/v1/boards/${BOARD}/attention/pending`);
    expect(calls[0]?.method).toBe("GET");
  });

  test("reads a body with no list as nothing waiting, and throws on a refusal", async () => {
    expect(await fakeBoard(() => ({ status: 200, body: {} })).client.pendingAttention()).toEqual([]);
    const { client } = fakeBoard(() => ({ status: 401, body: boardError("UNAUTHORIZED") }));
    await expect(client.pendingAttention()).rejects.toBeInstanceOf(SuperpipelineApiError);
  });
});

const tel = useTestTelemetry();

describe("SuperpipelineClient: tracing", () => {
  test("pathTemplate keeps ids out of span names", () => {
    expect(pathTemplate(`/v1/boards/${BOARD}/runs/run_1/heartbeat`)).toBe("/v1/boards/{boardId}/runs/{runId}/heartbeat");
    expect(pathTemplate(`/v1/boards/${BOARD}/gates/gate_9`)).toBe("/v1/boards/{boardId}/gates/{gateId}");
    expect(pathTemplate(`/v1/boards/${BOARD}/gates/pending`)).toBe("/v1/boards/{boardId}/gates/pending");
  });

  test("outside a trace: no span, no traceparent (idle polls stay out of the trace store)", async () => {
    const { calls, client } = fakeBoard(() => ({ status: 200, body: { claimed: false } }));
    await client.claim();
    expect(calls[0]!.headers.traceparent).toBeUndefined();
    expect(tel.spans()).toHaveLength(0);
  });

  test("inside a trace: a CLIENT span per call, and the header names that span", async () => {
    const body = {
      run: { runId: "run_e074a2160c4b4f28", cardId: "card_1a2b3c4d5e6f7a8b", stageKey: "work", leaseEpoch: 1, status: "working", outcome: null, startedAt: "t", endedAt: null },
      card: { id: "card_1a2b3c4d5e6f7a8b", title: "Rebuild the index" },
      stage: null,
      handoff: null,
      references: [],
    };
    const { calls, client } = fakeBoard(() => ({ status: 200, body }));
    const parent = tracer().startSpan("dispatch");
    await context.with(trace.setSpan(context.active(), parent), () => client.context("run_e074a2160c4b4f28"));
    parent.end();

    const span = tel.named("GET /v1/boards/{boardId}/runs/{runId}")[0]!;
    expect(span.attributes["run.id"]).toBe("run_e074a2160c4b4f28");
    expect(span.attributes["http.response.status_code"]).toBe(200);
    expect(span.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(calls[0]!.headers.traceparent).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
  });

  test("a refused call marks the span and still throws the typed error", async () => {
    const { client } = fakeBoard(() => ({ status: 409, body: boardError("STALE_LEASE") }));
    const parent = tracer().startSpan("dispatch");
    const err = await context
      .with(trace.setSpan(context.active(), parent), () => client.heartbeat(work))
      .catch((e) => e);
    parent.end();
    expect(isLeaseSuperseded(err)).toBe(true);
    const span = tel.spans().find((s) => s.name.startsWith("POST /v1/boards/{boardId}/runs/{runId}/"))!;
    expect(span.attributes["http.response.status_code"]).toBe(409);
    expect(span.status.code).toBe(2);
  });
});

test('trusted credentials are refreshed per request and completion guard runs after exchange', async () => {
  const order:string[]=[];
  const client=new SuperpipelineClient({baseUrl:'https://board.test',boardId:BOARD,token:'',credential:async()=>{order.push('credential');return 'signed-agent-token';},fetch:async()=>{order.push('send');return{status:200,ok:true,json:async()=>({card:{id:'x'}})}}});
  await client.completeVerified({runId:'run_x',leaseEpoch:1},{},async()=>{order.push('guard');});
  expect(order).toEqual(['credential','guard','send']);
  order.length=0;
  await expect(client.completeVerified({runId:'run_x',leaseEpoch:1},{},async()=>{order.push('guard');throw Error('revoked');})).rejects.toThrow('revoked');
  expect(order).toEqual(['credential','guard']);
});

test("strict activity unwraps actual REST receipt and never substitutes a bare response", async () => {
  const strictDecision = {version:1 as const, request_id:crypto.randomUUID(), decision_digest:"a".repeat(64), expires_at:Date.now()+60000};
  const receipt = {accepted:true,cardState:"input-required",elicitationId:"elc_123456",strictDecision};
  // As the board's contract has a strict decision: the question and its options ride with it.
  const activity = {type:"elicitation" as const,signal:"select",body:"Push the release branch?",strictDecision,
    parameter:{options:[{name:"approve",title:"Approve"},{name:"deny",title:"Deny"}]}};
  const wrapped = fakeBoard(()=>({status:200,body:{activity:receipt}}));
  expect(await wrapped.client.activity(work,activity)).toEqual(receipt);
  const bare = fakeBoard(()=>({status:200,body:receipt}));
  expect(await bare.client.activity(work,activity)).toBeUndefined();
  expect(await bare.client.activity(work,{type:"thought",body:"legacy"})).toEqual(receipt);
});

test("evidence reference uses original run and existing principal credential with unverified metadata", async () => {
  const seen: { url: string; body: any; authorization: string }[] = [];
  const client = new SuperpipelineClient({
    baseUrl: "https://board.test",
    boardId: BOARD,
    token: "",
    credential: async () => "existing-original-principal",
    fetch: async (url, init) => {
      seen.push({
        url,
        body: JSON.parse(init.body!),
        authorization: init.headers.Authorization!,
      });
      return {
        status: 200,
        ok: true,
        json: async () => ({
          reference_id: "ref_abcdef",
          verification: "unverified",
        }),
      };
    },
  });
  const input = {
    leaseEpoch: 7,
    cardId: "card_abcdef",
    stageKey: "build",
    export_id: "11111111-1111-4111-8111-111111111111",
    manifest_sha256: "a".repeat(64),
  };
  expect(await client.addEvidenceReference("run_original", input)).toEqual({
    reference_id: "ref_abcdef",
    verification: "unverified",
  });
  expect(seen).toEqual([
    {
      url: `https://board.test/v1/boards/${BOARD}/runs/run_original/evidence-reference`,
      body: input,
      authorization: "Bearer existing-original-principal",
    },
  ]);
});

// An agent token cannot use the card route (a human route: 401 "sign in to continue", staging
// run_b2bfa162da60440f). The run holder links its item through its own run, under its lease.
test("a run reference posts to the run's own references verb with the lease", async () => {
  const { calls, client } = fakeBoard(() => ({ status: 200, body: { reference: { id: "ref_1" } } }));
  await client.addRunReference(
    { runId: "run_abc123def", leaseEpoch: 3 },
    { url: "https://library.test/a/itm_1", title: "answer.md", provider: "superlibrary" },
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url).toBe(`https://board.test/v1/boards/${BOARD}/runs/run_abc123def/references`);
  expect(JSON.parse(calls[0]!.body!)).toEqual({
    leaseEpoch: 3,
    url: "https://library.test/a/itm_1",
    title: "answer.md",
    provider: "superlibrary",
  });
  expect(calls.some((c) => c.url.includes("/cards/"))).toBe(false);
});
