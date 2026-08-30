import { describe, expect, test } from "bun:test";

import {
  GATE_EVENT_TYPE,
  GATE_OPTION_IDS,
  gateEventContent,
  gateProseBody,
  isGateOptionId,
  type GatePendingDelivery,
} from "./gates";

/**
 * What a gate looks like on the wire.
 *
 * Pinned against `fixtures/ecosystem-identity/matrix_gate_events.json`, which
 * kaambaan and supermessage validate against too. A rename on any of the three
 * sides is a gate that silently never resolves — which reads, to the person who
 * tapped, as a button that did nothing.
 */

const DELIVERY: GatePendingDelivery = {
  event: "gate.pending",
  boardId: "brd_7c1f",
  cardId: "crd_9a22",
  gateId: "gate_4e8b",
  stageKey: "review",
  returnStageKey: "code",
  cardTitle: "Add OAuth login",
  producedBy: "agt_31d0",
  options: [
    { id: "approve", label: "Approve" },
    { id: "request_changes", label: "Request changes" },
    { id: "reject", label: "Reject" },
  ],
  ts: "2026-08-30T00:00:00.000Z",
};

describe("the gate event's wire shape", () => {
  test("carries every field the fixture requires", () => {
    const c = gateEventContent(DELIVERY);
    for (const key of [
      "body", "schema_version", "board_id", "card_id", "gate_id",
      "stage_key", "return_stage_key", "card_title", "produced_by",
      "prompt", "options",
    ]) {
      expect(c[key], `${key} is required by the shared corpus`).toBeDefined();
    }
  });

  test("carries none of the four fields kaambaan#34 proposed that do not exist", () => {
    // run_id and task_id name no column; gates do not expire; tenant_id is
    // kaambaan's internal boundary and a room can be wider than a board.
    const c = gateEventContent(DELIVERY);
    for (const absent of ["run_id", "task_id", "expires_at", "tenant_id"]) {
      expect(c[absent], `${absent} was dropped deliberately`).toBeUndefined();
    }
  });

  test("drops an option kaambaan could not resolve", () => {
    const c = gateEventContent({
      ...DELIVERY,
      options: [{ id: "approve", label: "Approve" }, { id: "ship_it", label: "Ship it" }],
    });
    expect(c.options).toEqual([{ id: "approve", label: "Approve" }]);
  });

  test("names the type kaambaan owns, not the plane that carries it", () => {
    // AgentPod sends this; kaambaan owns what a gate means. The ownership map
    // in charter's layer reference gives Gate to the work plane.
    expect(GATE_EVENT_TYPE).toBe("dev.kaambaan.gate.v1");
  });

  test("the option ids are exactly kaambaan's GateDecision union", () => {
    expect([...GATE_OPTION_IDS]).toEqual(["approve", "request_changes", "reject"]);
    expect(isGateOptionId("approve")).toBe(true);
    expect(isGateOptionId("ship_it")).toBe(false);
    expect(isGateOptionId(1)).toBe(false);
  });

  test("omits the deep link rather than sending a broken one", () => {
    expect(gateEventContent(DELIVERY).deep_link).toBeUndefined();
    expect(gateEventContent(DELIVERY, "https://kaambaan.dev/b/brd_7c1f/c/crd_9a22").deep_link)
      .toBe("https://kaambaan.dev/b/brd_7c1f/c/crd_9a22");
  });
});

describe("the prose a stock client sees", () => {
  test("names the card and the stage in a sentence", () => {
    // A stock Matrix client renders an unknown EVENT TYPE as nothing at all —
    // not as fallback text. This companion message is the whole of what
    // someone on Element gets, so it has to stand alone.
    expect(gateProseBody(DELIVERY)).toBe(
      'Approval needed — "Add OAuth login" at stage `review`. Approve, request changes, or reject.'
    );
  });

  test("appends the deep link when there is one", () => {
    expect(gateProseBody(DELIVERY, "https://k.dev/x")).toEndWith(" https://k.dev/x");
  });

  test("is the same sentence the custom event carries as its body", () => {
    // supermessage falls back to `body` when the renderer cannot draw the card.
    // Two different sentences would mean the fallback said something the card
    // did not.
    expect(gateEventContent(DELIVERY).body).toBe(gateProseBody(DELIVERY));
  });
});

import {
  GATE_DECISION_SUITE_TYPE,
  handleGateDecision,
  parseGateDecision,
  type GateDecisionDeps,
} from "./gates";

/**
 * The way back — and it is entirely about refusing.
 *
 * This is the only path in the suite where a message in a room becomes
 * authority somewhere else, so every branch that is not "resolved" must leave
 * the gate untouched.
 */

const GATE_EVENT_ID = "$gateEvent";

function decision(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msgtype: "m.text",
    body: "Approved — Ship the OAuth change to staging?",
    schema_version: 1,
    suite_event_type: GATE_DECISION_SUITE_TYPE,
    gate_id: "gate_4e8b",
    option_id: "approve",
    "m.relates_to": { rel_type: "m.reference", event_id: GATE_EVENT_ID },
    ...over,
  };
}

function decisionDeps(over: Partial<GateDecisionDeps> = {}) {
  const resolved: unknown[] = [];
  const replies: string[] = [];
  const deps: GateDecisionDeps = {
    principalForMatrixId: async () => "68jYD9VOCmXlPhIYGFOgoZVE6vDUVHPA",
    projectionFor: async () => ({
      tenantId: "fleet_1", boardId: "brd_7c1f", eventId: GATE_EVENT_ID,
    }),
    resolveGate: async (i) => { resolved.push(i); return { ok: true }; },
    reply: async (_r, b) => { replies.push(b); return null; },
    ...over,
  };
  return { deps, resolved, replies };
}

describe("reading a decision", () => {
  test("accepts the shape the fixture pins", () => {
    const p = parseGateDecision(decision());
    expect(p).toMatchObject({ gateId: "gate_4e8b", optionId: "approve", comment: null });
    expect(p!.referencedEventId).toBe(GATE_EVENT_ID);
  });

  test("keeps the feedback that becomes the rework's context", () => {
    const p = parseGateDecision(decision({ option_id: "request_changes", comment: "Add a test." }));
    expect(p!.comment).toBe("Add a test.");
  });

  test("treats a blank comment as none", () => {
    expect(parseGateDecision(decision({ comment: "   " }))!.comment).toBeNull();
  });

  test("refuses an option kaambaan could not resolve", () => {
    expect(parseGateDecision(decision({ option_id: "ship_it" }))).toBeNull();
  });

  test("refuses a reply relation, which every client sets when quoting", () => {
    const p = parseGateDecision(
      decision({ "m.relates_to": { "m.in_reply_to": { event_id: GATE_EVENT_ID } } })
    );
    expect(p!.referencedEventId, "a quoted reply must not be able to resolve a gate").toBeNull();
  });

  test("ignores an ordinary message", () => {
    expect(parseGateDecision({ msgtype: "m.text", body: "approve" })).toBeNull();
  });
});

describe("acting on a decision", () => {
  test("resolves as the human, never as this service", async () => {
    const { deps, resolved } = decisionDeps();
    const r = await handleGateDecision({ sender: "@rakesh:id.agentpod.dev", content: decision() }, "!room", deps);
    expect(r.status).toBe("resolved");
    expect(resolved[0]).toMatchObject({
      principalId: "68jYD9VOCmXlPhIYGFOgoZVE6vDUVHPA",
      decision: "approve",
      gateId: "gate_4e8b",
    });
  });

  test("refuses a sender nobody has linked", async () => {
    const { deps, resolved } = decisionDeps({ principalForMatrixId: async () => null });
    const r = await handleGateDecision({ sender: "@stranger:elsewhere.org", content: decision() }, "!room", deps);
    expect(r).toEqual({ status: "refused", reason: "unlinked-sender" });
    expect(resolved, "nothing may resolve for someone with no principal").toHaveLength(0);
  });

  test("refuses when the reference and the gate id disagree", async () => {
    const { deps, resolved } = decisionDeps();
    const content = decision({ "m.relates_to": { rel_type: "m.reference", event_id: "$someOtherEvent" } });
    const r = await handleGateDecision({ sender: "@rakesh:id.agentpod.dev", content }, "!room", deps);
    expect(r).toEqual({ status: "refused", reason: "reference-mismatch" });
    expect(resolved).toHaveLength(0);
  });

  test("refuses a decision with no reference at all", async () => {
    const { deps, resolved } = decisionDeps();
    const content = decision({ "m.relates_to": undefined });
    const r = await handleGateDecision({ sender: "@rakesh:id.agentpod.dev", content }, "!room", deps);
    expect(r).toEqual({ status: "refused", reason: "reference-mismatch" });
    expect(resolved).toHaveLength(0);
  });

  test("refuses a gate this hub never posted", async () => {
    const { deps, resolved } = decisionDeps({ projectionFor: async () => null });
    const r = await handleGateDecision({ sender: "@rakesh:id.agentpod.dev", content: decision() }, "!room", deps);
    expect(r).toEqual({ status: "refused", reason: "unknown-gate" });
    expect(resolved).toHaveLength(0);
  });

  test("says so in the room when the gate was already decided", async () => {
    // Two clients may render one gate, and a slow connection invites a double
    // tap. The person who tapped is owed the reason nothing happened.
    const { deps, replies } = decisionDeps({
      resolveGate: async () => ({ ok: false, code: "GATE_NOT_PENDING" }),
    });
    await handleGateDecision({ sender: "@rakesh:id.agentpod.dev", content: decision() }, "!room", deps);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("already");
  });

  test("checks attribution before it resolves anything", async () => {
    // Order matters: an unlinked sender must not reach kaambaan even once.
    const calls: string[] = [];
    const { deps } = decisionDeps({
      principalForMatrixId: async () => { calls.push("principal"); return null; },
      resolveGate: async () => { calls.push("resolve"); return { ok: true }; },
    });
    await handleGateDecision({ sender: "@x:y", content: decision() }, "!room", deps);
    expect(calls).toEqual(["principal"]);
  });
});

import { resolveGateAtKaambaan } from "./gates";

/**
 * Calling kaambaan as the person, not as this service.
 *
 * The alternative — using the bridge's own `kbn_` agent token — would work on
 * the first try and make every approval in the suite attribute to one account.
 * It fails in the direction that looks like success, which is why the token is
 * minted per decision rather than held.
 */
describe("resolving at the board", () => {
  function capture(status = 200, body: unknown = {}) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { calls, f };
  }

  const input = {
    boardId: "brd_7c1f",
    gateId: "gate_4e8b",
    decision: "approve" as const,
    comment: null,
    principalId: "68jYD9VOCmXlPhIYGFOgoZVE6vDUVHPA",
  };

  test("carries a freshly minted assertion for that principal", async () => {
    const minted: string[] = [];
    const { calls, f } = capture();
    await resolveGateAtKaambaan(input, {
      baseUrl: "https://kaambaan.dev/",
      mint: async (p) => { minted.push(p); return "the.jwt.here"; },
      fetch: f,
    });
    expect(minted, "one token, for the person who tapped").toEqual([input.principalId]);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization)
      .toBe("Bearer the.jwt.here");
  });

  test("addresses the gate on its own board, with a trimmed base url", async () => {
    const { calls, f } = capture();
    await resolveGateAtKaambaan(input, {
      baseUrl: "https://kaambaan.dev/", mint: async () => "t", fetch: f,
    });
    expect(calls[0]!.url).toBe("https://kaambaan.dev/v1/boards/brd_7c1f/gates/gate_4e8b/resolve");
  });

  test("omits a comment rather than sending null", async () => {
    const { calls, f } = capture();
    await resolveGateAtKaambaan(input, { baseUrl: "https://k.dev", mint: async () => "t", fetch: f });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ decision: "approve" });
  });

  test("sends the feedback that becomes the rework's context", async () => {
    const { calls, f } = capture();
    await resolveGateAtKaambaan(
      { ...input, decision: "request_changes", comment: "Add a test." },
      { baseUrl: "https://k.dev", mint: async () => "t", fetch: f }
    );
    expect(JSON.parse(String(calls[0]!.init.body)))
      .toEqual({ decision: "request_changes", comment: "Add a test." });
  });

  test("reports kaambaan's own code, not the status it arrived under", async () => {
    // 403 is SEPARATION_OF_DUTIES and 409 is GATE_NOT_PENDING, and the caller
    // reacts differently to each. Reading the status alone loses that.
    const { f } = capture(409, { error: { code: "GATE_NOT_PENDING" } });
    const r = await resolveGateAtKaambaan(input, {
      baseUrl: "https://k.dev", mint: async () => "t", fetch: f,
    });
    expect(r).toEqual({ ok: false, code: "GATE_NOT_PENDING" });
  });

  test("falls back to the status when the body says nothing useful", async () => {
    const { f } = capture(502, "<html>bad gateway</html>");
    const r = await resolveGateAtKaambaan(input, {
      baseUrl: "https://k.dev", mint: async () => "t", fetch: f,
    });
    expect(r).toEqual({ ok: false, code: "HTTP_502" });
  });

  test("distinguishes not reaching the board from being refused by it", async () => {
    // A refusal is final; a network failure is not, and the reader should be
    // able to press the button again.
    const f = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await resolveGateAtKaambaan(input, {
      baseUrl: "https://k.dev", mint: async () => "t", fetch: f,
    });
    expect(r).toEqual({ ok: false, code: "UNREACHABLE" });
  });

  test("does not mint a second token for a retry it never makes", async () => {
    let mints = 0;
    const { f } = capture(409, { error: { code: "GATE_NOT_PENDING" } });
    await resolveGateAtKaambaan(input, {
      baseUrl: "https://k.dev", mint: async () => { mints++; return "t"; }, fetch: f,
    });
    expect(mints).toBe(1);
  });
});
