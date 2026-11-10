import { describe, expect, test } from "bun:test";
import { OrgPlaneError } from "../../auth/org-plane/client";

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
 * Pinned against treaty's `fixtures/ecosystem-identity/matrix_gate_events.json`, which
 * superpipeline and supermessage validate against too. A rename on any of the three
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

  test("carries the work the reviewer is being asked to approve", () => {
    // supermessage#37. A gate that shows a title and no work asks someone to
    // approve something they cannot see.
    const c = gateEventContent({ ...DELIVERY, handoffSummary: "Wrote the haiku." });
    expect(c.handoff_summary).toBe("Wrote the haiku.");
    expect(c.schema_version).toBe(2);
  });

  test("omits the summary entirely when the board sent none", () => {
    // A board that predates this sends nothing, and an empty row reads like a
    // card that failed to load.
    expect(gateEventContent(DELIVERY).handoff_summary).toBeUndefined();
    expect(gateEventContent({ ...DELIVERY, handoffSummary: null }).handoff_summary).toBeUndefined();
  });

  test("carries none of the four fields superpipeline#34 proposed that do not exist", () => {
    // run_id and task_id name no column; gates do not expire; tenant_id is
    // superpipeline's internal boundary and a room can be wider than a board.
    const c = gateEventContent(DELIVERY);
    for (const absent of ["run_id", "task_id", "expires_at", "tenant_id"]) {
      expect(c[absent], `${absent} was dropped deliberately`).toBeUndefined();
    }
  });

  test("drops an option superpipeline could not resolve", () => {
    const c = gateEventContent({
      ...DELIVERY,
      options: [{ id: "approve", label: "Approve" }, { id: "ship_it", label: "Ship it" }],
    });
    expect(c.options).toEqual([{ id: "approve", label: "Approve" }]);
  });

  test("names the type superpipeline owns, not the plane that carries it", () => {
    // AgentPod sends this; superpipeline owns what a gate means. The ownership map
    // in charter's layer reference gives Gate to the work plane.
    expect(GATE_EVENT_TYPE).toBe("dev.superpipeline.gate.v1");
  });

  test("the option ids are exactly superpipeline's GateDecision union", () => {
    expect([...GATE_OPTION_IDS]).toEqual(["approve", "request_changes", "reject"]);
    expect(isGateOptionId("approve")).toBe(true);
    expect(isGateOptionId("ship_it")).toBe(false);
    expect(isGateOptionId(1)).toBe(false);
  });

  test("omits the deep link rather than sending a broken one", () => {
    expect(gateEventContent(DELIVERY).deep_link).toBeUndefined();
    expect(
      gateEventContent(DELIVERY, "https://superpipeline.dev/b/brd_7c1f/c/crd_9a22").deep_link
    ).toBe("https://superpipeline.dev/b/brd_7c1f/c/crd_9a22");
  });

  test("the prose and the card agree on where the link goes", () => {
    // They are two events describing one gate. A reader who taps the prose
    // link and a reader who taps the card's must land in the same place.
    const link = "https://superpipeline.dev/b/brd_7c1f/c/crd_9a22";
    expect(gateProseBody(DELIVERY, link)).toContain(link);
    expect(gateEventContent(DELIVERY, link).deep_link).toBe(link);
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

  test("writes the link as markdown, because a bare URL is not tappable", () => {
    // supermessage markdown-parses a plain body when there is no
    // formatted_body, and pulldown-cmark does not autolink bare URLs. A raw
    // https:// in prose renders as characters to retype — it looks like a link
    // and is not, which is worse than omitting it.
    expect(
      gateProseBody(DELIVERY, "https://superpipeline.dev/b/brd_7c1f/c/crd_9a22")
    ).toEndWith(" [Open the card](https://superpipeline.dev/b/brd_7c1f/c/crd_9a22)");
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
  GATE_OUTCOME_TYPE,
  handleGateDecision,
  parseGateDecision,
  settleGateOutcome,
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
    principalForMatrixId: async () => ({
      id: "68jYD9VOCmXlPhIYGFOgoZVE6vDUVHPA",
      kind: "human" as const,
    }),
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

  test("refuses an option superpipeline could not resolve", () => {
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

  test("a plane outage while resolving the sender is refused as identity-unavailable, not unlinked", async () => {
    // Design §5.7: the one plane call on an authorization path. Down is not "unlinked".
    const { deps, resolved, replies } = decisionDeps({
      principalForMatrixId: async () => {
        throw new OrgPlaneError(0, "unreachable");
      },
    });
    const r = await handleGateDecision({ sender: "@rakesh:id.agentpod.dev", content: decision() }, "!room", deps);
    expect(r).toEqual({ status: "refused", reason: "identity-unavailable" });
    expect(resolved).toHaveLength(0);
    // Refused AND told: a silent drop reads as a broken button.
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("cannot check who you are");
  });

  test("the sender's mxid reaches resolveGate, so the plane can resolve the human itself", async () => {
    const { deps, resolved } = decisionDeps();
    await handleGateDecision({ sender: "@rakesh:id.agentpod.dev", content: decision() }, "!room", deps);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      principalId: "68jYD9VOCmXlPhIYGFOgoZVE6vDUVHPA",
      senderMxid: "@rakesh:id.agentpod.dev",
    });
  });

  test("an assertion the plane could not give is a failed receipt in the room, refused as identity-unavailable", async () => {
    const { deps, replies } = decisionDeps({
      resolveGate: async () => ({ ok: false, code: "IDENTITY_UNAVAILABLE" }),
    });
    const r = await handleGateDecision({ sender: "@rakesh:id.agentpod.dev", content: decision() }, "!room", deps);
    expect(r).toEqual({ status: "refused", reason: "identity-unavailable" });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("cannot check who you are");
  });

  test.each(["ASSERTION_REFUSED", "ASSERTION_MISMATCH"])(
    "an assertion the plane refused (%s) is a failed receipt in the room, and nothing is resolved",
    async (code) => {
      const { deps, replies } = decisionDeps({ resolveGate: async () => ({ ok: false, code }) });
      const r = await handleGateDecision({ sender: "@rakesh:id.agentpod.dev", content: decision() }, "!room", deps);
      expect(r).toEqual({ status: "refused", reason: "assertion-refused" });
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("Nothing has changed");
      expect(replies[0]).toContain(code);
    },
  );

  test("checks attribution before it resolves anything", async () => {
    // Order matters: an unlinked sender must not reach superpipeline even once.
    const calls: string[] = [];
    const { deps } = decisionDeps({
      principalForMatrixId: async () => { calls.push("principal"); return null; },
      resolveGate: async () => { calls.push("resolve"); return { ok: true }; },
    });
    await handleGateDecision({ sender: "@x:y", content: decision() }, "!room", deps);
    expect(calls).toEqual(["principal"]);
  });
});

import { resolveGateAtSuperpipeline } from "./gates";
import { AssertionMismatch } from "../../auth/org-plane/assertion";

/**
 * Calling superpipeline as the person, not as this service.
 *
 * The alternative — using the bridge's own `spa_` agent token — would work on
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
    senderMxid: "@rakesh:id.agentpod.dev",
  };

  test("carries a freshly minted assertion for that principal", async () => {
    const minted: unknown[] = [];
    const { calls, f } = capture();
    await resolveGateAtSuperpipeline(input, {
      baseUrl: "https://superpipeline.dev/",
      mint: async (p) => { minted.push(p); return "the.jwt.here"; },
      fetch: f,
    });
    expect(minted, "one token, for the person who tapped").toEqual([
      { principalId: input.principalId, senderMxid: input.senderMxid },
    ]);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization)
      .toBe("Bearer the.jwt.here");
  });

  test("addresses the gate on its own board, with a trimmed base url", async () => {
    const { calls, f } = capture();
    await resolveGateAtSuperpipeline(input, {
      baseUrl: "https://superpipeline.dev/", mint: async () => "t", fetch: f,
    });
    expect(calls[0]!.url).toBe("https://superpipeline.dev/v1/boards/brd_7c1f/gates/gate_4e8b/resolve");
  });

  test("omits a comment rather than sending null", async () => {
    const { calls, f } = capture();
    await resolveGateAtSuperpipeline(input, { baseUrl: "https://k.dev", mint: async () => "t", fetch: f });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ decision: "approve" });
  });

  test("sends the feedback that becomes the rework's context", async () => {
    const { calls, f } = capture();
    await resolveGateAtSuperpipeline(
      { ...input, decision: "request_changes", comment: "Add a test." },
      { baseUrl: "https://k.dev", mint: async () => "t", fetch: f }
    );
    expect(JSON.parse(String(calls[0]!.init.body)))
      .toEqual({ decision: "request_changes", comment: "Add a test." });
  });

  test("reports superpipeline's own code, not the status it arrived under", async () => {
    // 403 is SEPARATION_OF_DUTIES and 409 is GATE_NOT_PENDING, and the caller
    // reacts differently to each. Reading the status alone loses that.
    const { f } = capture(409, { error: { code: "GATE_NOT_PENDING" } });
    const r = await resolveGateAtSuperpipeline(input, {
      baseUrl: "https://k.dev", mint: async () => "t", fetch: f,
    });
    expect(r).toEqual({ ok: false, code: "GATE_NOT_PENDING" });
  });

  test("falls back to the status when the body says nothing useful", async () => {
    const { f } = capture(502, "<html>bad gateway</html>");
    const r = await resolveGateAtSuperpipeline(input, {
      baseUrl: "https://k.dev", mint: async () => "t", fetch: f,
    });
    expect(r).toEqual({ ok: false, code: "HTTP_502" });
  });

  test("distinguishes not reaching the board from being refused by it", async () => {
    // A refusal is final; a network failure is not, and the reader should be
    // able to press the button again.
    const f = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await resolveGateAtSuperpipeline(input, {
      baseUrl: "https://k.dev", mint: async () => "t", fetch: f,
    });
    expect(r).toEqual({ ok: false, code: "UNREACHABLE" });
  });

  // Contract §3.4b, under the org plane: the assertion is the plane's, and it can be refused or
  // unreachable. Either is a failed receipt the room is told about, never an exception that drops
  // the answer on the floor — and the board is never called without the person's token.
  test.each([
    ["plane unreachable", new OrgPlaneError(0, "unreachable"), "IDENTITY_UNAVAILABLE"],
    ["plane 503", new OrgPlaneError(503, "error"), "IDENTITY_UNAVAILABLE"],
    ["plane 404 unknown_identity", new OrgPlaneError(404, "unknown_identity"), "ASSERTION_REFUSED"],
    ["plane 423 suspended", new OrgPlaneError(423, "suspended"), "ASSERTION_REFUSED"],
    ["a different sub", new AssertionMismatch("prn_0000000000000000000a", "prn_0000000000000000000f"), "ASSERTION_MISMATCH"],
  ])("a mint that fails with %s is %s, and the board is not called", async (_label, error, code) => {
    const { calls, f } = capture();
    const r = await resolveGateAtSuperpipeline(input, {
      baseUrl: "https://k.dev",
      mint: async () => { throw error; },
      fetch: f,
    });
    expect(r).toEqual({ ok: false, code });
    expect(calls).toHaveLength(0);
  });

  test("any other mint failure still throws, as it always has (legacy unchanged)", async () => {
    const { f } = capture();
    await expect(
      resolveGateAtSuperpipeline(input, {
        baseUrl: "https://k.dev",
        mint: async () => { throw new Error("no tenant resolves"); },
        fetch: f,
      }),
    ).rejects.toThrow("no tenant resolves");
  });

  test("does not mint a second token for a retry it never makes", async () => {
    let mints = 0;
    const { f } = capture(409, { error: { code: "GATE_NOT_PENDING" } });
    await resolveGateAtSuperpipeline(input, {
      baseUrl: "https://k.dev", mint: async () => { mints++; return "t"; }, fetch: f,
    });
    expect(mints).toBe(1);
  });
});

/**
 * agentpod#608: a gate is a human's answer, and nothing said so.
 *
 * The sender check asked whether a Matrix id is LINKED, not whether it belongs to a
 * person — and agents are linked exactly as people are. superpipeline enforces
 * separation of duties (`decidedBy !== producedBy`), so it refuses an agent
 * resolving its own gate and has no reason to refuse a different one. An agent
 * emitting a decision in a room the hub can read would approve another agent's
 * gate.
 *
 * Dormant only because the hub cannot decrypt in harness-mode rooms. The board room
 * that makes a human's answer readable makes an agent's readable too, so this lands
 * with it.
 */
describe("who may answer a gate", () => {
  const decision = {
    sender: "@agent_cleaner-cody:id.agentpod.dev",
    content: {
      suite_event_type: GATE_DECISION_SUITE_TYPE,
      gate_id: "gate_7c1f",
      option_id: "approve",
      "m.relates_to": { rel_type: "m.reference", event_id: GATE_EVENT_ID },
    },
  };

  test("an agent is refused, and the gate is not resolved", async () => {
    const { deps, resolved } = decisionDeps({
      principalForMatrixId: async () => ({ id: "prn_cody", kind: "agent" as const }),
    });
    const out = await handleGateDecision(decision, "!room:id.agentpod.dev", deps);
    expect(out).toEqual({ status: "refused", reason: "not-human" });
    // The point of the test: superpipeline is never asked. Its own guard would have
    // accepted this, because a different agent is not the producer.
    expect(resolved).toHaveLength(0);
  });

  test("a service principal is refused too", async () => {
    const { deps, resolved } = decisionDeps({
      principalForMatrixId: async () => ({ id: "prn_svc", kind: "service" as const }),
    });
    const out = await handleGateDecision(decision, "!room:id.agentpod.dev", deps);
    expect(out).toEqual({ status: "refused", reason: "not-human" });
    expect(resolved).toHaveLength(0);
  });

  test("a human is resolved, as themselves", async () => {
    const { deps, resolved } = decisionDeps();
    const out = await handleGateDecision(decision, "!room:id.agentpod.dev", deps);
    expect(out).toEqual({ status: "resolved" });
    expect(resolved).toHaveLength(1);
    // Resolved AS the answering principal, never as this service — the point
    // charter 2026-08-14 rests on.
    expect((resolved[0] as { principalId: string }).principalId).toBe(
      "68jYD9VOCmXlPhIYGFOgoZVE6vDUVHPA",
    );
  });

  test("an unlinked sender is still refused separately from a non-human one", async () => {
    // Different reasons because they are different situations: somebody in the room
    // who never linked an account, versus a machine trying to approve work.
    const { deps } = decisionDeps({ principalForMatrixId: async () => null });
    const out = await handleGateDecision(decision, "!room:id.agentpod.dev", deps);
    expect(out).toEqual({ status: "refused", reason: "unlinked-sender" });
  });
});

/**
 * agentpod#614: a gate that was answered still read as pending when its card was
 * redrawn, because nothing in the room said the board had accepted it.
 *
 * This service spoke on a DUPLICATE tap ("That was already decided") and said
 * nothing at all on a successful one — so the room heard about a redundant answer
 * and never about an accepted one.
 */
describe("saying in the room that the board accepted an answer", () => {
  function receiptDeps(over: Partial<GateDecisionDeps> = {}) {
    const replies: string[] = [];
    const outcomes: Record<string, unknown>[] = [];
    const base = decisionDeps().deps;
    const deps: GateDecisionDeps = {
      ...base,
      reply: async (_r, b) => {
        replies.push(b);
        return null;
      },
      sendOutcome: async (_r, content) => {
        outcomes.push(content);
        return null;
      },
      displayNameFor: async () => "rakesh",
      markOutcomePosted: async () => true,
      ...over,
    };
    return { deps, replies, outcomes };
  }

  const decision = {
    sender: "@rakesh:id.agentpod.dev",
    content: {
      suite_event_type: GATE_DECISION_SUITE_TYPE,
      gate_id: "gate_4e8b",
      option_id: "approve",
      "m.relates_to": { rel_type: "m.reference", event_id: GATE_EVENT_ID },
    },
  };

  test("a resolved gate leaves a readable line and a structured receipt", async () => {
    const { deps, replies, outcomes } = receiptDeps();
    const out = await handleGateDecision(decision, "!room", deps);

    expect(out).toEqual({ status: "resolved" });
    // Prose, because a stock client renders an unknown event TYPE as nothing at all.
    expect(replies[0]).toContain("Approved");
    expect(replies[0]).toContain("rakesh");
    // …and the marker beside it, pointing at the gate's own event so a client knows
    // which card to close.
    expect(outcomes[0]).toMatchObject({
      suite_event_type: GATE_OUTCOME_TYPE,
      gate_id: "gate_4e8b",
      decision: "approve",
      decided_by: "rakesh",
      "m.relates_to": { rel_type: "m.reference", event_id: GATE_EVENT_ID },
    });
  });

  test("it names WHO answered, which in a shared room is a different fact from 'answered'", async () => {
    const { deps, replies } = receiptDeps({ displayNameFor: async () => "someone-else" });
    await handleGateDecision(decision, "!room", deps);
    expect(replies[0]).toContain("someone-else");
  });

  test("an automatic or manual approval reads as words, not as its option key", async () => {
    // A gate bound to a publishing subject offers approve_automatic / approve_manual. The
    // receipt printed the raw key — "approve_automatic by …" — in the operator's room.
    for (const [optionId, words] of [
      ["approve_automatic", "Approved for automatic delivery"],
      ["approve_manual", "Approved for manual delivery"],
    ] as const) {
      const { deps, replies } = receiptDeps();
      // The path a decision made on the web takes (the gate sweep), and the Matrix path's last step.
      await settleGateOutcome(
        { gateId: "gate_4e8b", decision: optionId, decidedBy: "prn_fixture" },
        "!room",
        { boardId: "brd_fixture", eventId: GATE_EVENT_ID },
        deps,
      );
      expect(replies[0]).toContain(words);
      expect(replies[0]).not.toContain(optionId);
    }
  });

  test("a second delivery of the same decision leaves one receipt, not two", async () => {
    // A double tap or a re-sent transaction must not read as though the gate were
    // answered twice.
    let claims = 0;
    const { deps, replies } = receiptDeps({
      markOutcomePosted: async () => ++claims === 1,
    });
    await handleGateDecision(decision, "!room", deps);
    await handleGateDecision(decision, "!room", deps);
    expect(replies).toHaveLength(1);
  });

  test("a receipt that cannot be posted does not unresolve the gate", async () => {
    // superpipeline already has the answer by this point. Reporting failure here
    // would tell the reader their approval did not land when it did.
    const { deps } = receiptDeps({
      reply: async () => {
        throw new Error("homeserver said no");
      },
    });
    expect(await handleGateDecision(decision, "!room", deps)).toEqual({ status: "resolved" });
  });

  test("a rejection reads as a rejection", async () => {
    const { deps, replies } = receiptDeps();
    await handleGateDecision(
      { ...decision, content: { ...decision.content, option_id: "reject" } },
      "!room",
      deps,
    );
    expect(replies[0]).toContain("Rejected");
  });
});

import {
  GATE_DECISION_V2_SUITE_TYPE,
  GATE_V2_SUITE_TYPE,
  gateOptionsV2,
  gateSubjectV2,
  gateV2Content,
} from "./gates";

/**
 * gate.v2 (charter: decisions/2026-11-07-gate-v2-is-the-decision-envelope.md).
 *
 * A gate bound to a publishing subject reached a room with only Request changes and Reject:
 * this hub filtered the options on the three v1 ids and dropped approve_automatic and
 * approve_manual, showed no post text, and sent no subject binding back. v2 carries the
 * options the gate offers, what each one means, and the subject's preview.
 */
const POST_TEXT = "Shipping the new release today.\n\nNotes: *fast* paths & `code`.";
const SUBJECT = {
  id: "aps_fixture01",
  digest: "sha256:3f1c0d9a",
  schema: "social-publish/v1",
  revision: 1,
  expiresAt: "2030-01-02T03:04:05Z",
  previewComplete: true,
  preview: [
    { type: "text", label: "Post", text: POST_TEXT },
    { type: "field", label: "Account", value: "@fixture_account on X" },
    { type: "field", label: "Approval expires", value: "2030-01-02T03:04:05Z" },
  ],
};
const PUBLISHING: GatePendingDelivery = {
  ...DELIVERY,
  cardId: "crd_5e10",
  gateId: "gate_7d21",
  stageKey: "approve",
  returnStageKey: "draft",
  cardTitle: "Announce the release",
  handoffSummary: POST_TEXT,
  options: [
    { id: "approve_manual", label: "Approve — I'll post it myself", meaning: "approve", needsComment: false, delivery: "manual" },
    { id: "approve_automatic", label: "Approve — post automatically", meaning: "approve", needsComment: false, delivery: "automatic" },
    { id: "request_changes", label: "Request changes", meaning: "revise", needsComment: true },
    { id: "reject", label: "Reject", meaning: "reject", needsComment: false },
  ],
  approvalSubject: SUBJECT,
  reviewUrl: "/b/brd_7c1f/c/crd_5e10",
};

describe("gate.v2 — what the gate offers, carried as offered", () => {
  test("a publishing gate carries all four options with their meaning, comment rule and delivery", () => {
    const c = gateV2Content(PUBLISHING);
    expect(c.suite_event_type).toBe(GATE_V2_SUITE_TYPE);
    expect(c.msgtype).toBe("m.text");
    expect(c.options).toEqual([
      { id: "approve_manual", label: "Approve — I'll post it myself", meaning: "approve", needs_comment: false, delivery: "manual" },
      { id: "approve_automatic", label: "Approve — post automatically", meaning: "approve", needs_comment: false, delivery: "automatic" },
      { id: "request_changes", label: "Request changes", meaning: "revise", needs_comment: true },
      { id: "reject", label: "Reject", meaning: "reject", needs_comment: false },
    ]);
  });

  test("a subject-bound gate carries its identity, digest and preview, snake_case on the wire", () => {
    expect(gateV2Content(PUBLISHING).subject).toEqual({
      id: "aps_fixture01",
      digest: "sha256:3f1c0d9a",
      schema: "social-publish/v1",
      revision: 1,
      expires_at: "2030-01-02T03:04:05Z",
      preview: SUBJECT.preview,
      preview_complete: true,
    });
  });

  test("preview_complete: the board's flag is carried; an older board's preview with no flag is complete; no preview is not", () => {
    const { previewComplete: _flag, ...olderBoard } = SUBJECT;
    const { preview: _preview, ...noPreview } = olderBoard;
    const complete = [{ ...SUBJECT, previewComplete: false }, olderBoard, noPreview].map(
      (approvalSubject) => gateSubjectV2({ ...PUBLISHING, approvalSubject })?.preview_complete
    );
    expect(complete).toEqual([false, true, false]);
  });

  test("the prose body shows the exact post, so a stock client sees what is being approved", () => {
    const body = String(gateV2Content(PUBLISHING, "https://board.example/b/brd_7c1f/c/crd_5e10").body);
    expect(body).toContain(POST_TEXT);
    expect(body).toContain("Account: @fixture_account on X");
    expect(body).toContain("[Open the card](https://board.example/b/brd_7c1f/c/crd_5e10)");
    // Fenced, so markdown cannot eat the post's own asterisks and backticks.
    expect(body).toContain("```\n" + POST_TEXT + "\n```");
  });

  test("a gate with no subject has no subject field, and its body is the v1 sentence", () => {
    const c = gateV2Content(DELIVERY);
    expect(c.subject).toBeUndefined();
    expect(c.body).toBe(gateProseBody(DELIVERY));
  });

  test("an older board's options (no meaning) still project, with meanings derived from the id", () => {
    const old: GatePendingDelivery = {
      ...DELIVERY,
      options: [
        { id: "approve", label: "Approve" },
        { id: "approve_automatic", label: "Post it" },
        { id: "approve_manual", label: "I'll post it" },
        { id: "request_changes", label: "Request changes" },
        { id: "reject", label: "Reject" },
        { id: "later", label: "Later" },
      ],
    };
    expect(gateOptionsV2(old)).toEqual([
      { id: "approve", label: "Approve", meaning: "approve", needs_comment: false },
      { id: "approve_automatic", label: "Post it", meaning: "approve", needs_comment: false },
      { id: "approve_manual", label: "I'll post it", meaning: "approve", needs_comment: false },
      { id: "request_changes", label: "Request changes", meaning: "revise", needs_comment: true },
      { id: "reject", label: "Reject", meaning: "reject", needs_comment: false },
      { id: "later", label: "Later", meaning: "defer", needs_comment: false },
    ]);
  });

  test("keeps no list of valid ids: an id superpipeline offers is carried even if this hub never heard of it", () => {
    const c = gateV2Content({
      ...DELIVERY,
      options: [{ id: "pick_b", label: "B", meaning: "choose", needsComment: false }],
    });
    expect(c.options).toEqual([{ id: "pick_b", label: "B", meaning: "choose", needs_comment: false }]);
  });

  test("the v1 payload is unchanged: it still filters to the three v1 ids", () => {
    // A v1 client keeps exactly what it had; only gate.v2 carries the subject's options.
    expect(gateEventContent(PUBLISHING).options).toEqual([
      { id: "request_changes", label: "Request changes" },
      { id: "reject", label: "Reject" },
    ]);
    expect(gateEventContent(PUBLISHING).subject).toBeUndefined();
  });
});

describe("gate.v2 — what arrives from the network is bounded", () => {
  test("a preview is re-validated: long strings are cut, malformed and excess blocks dropped, unknown keys stripped", () => {
    const blocks: unknown[] = [
      { type: "text", label: "L".repeat(500), text: "x".repeat(5000), extra: "stripped" },
      { type: "field", label: "Account", value: "v".repeat(300) },
      { type: "link", label: "Board", url: "javascript:alert(1)" },
      { type: "link", label: "Board", url: "https://board.example/b/1" },
      { type: "image", src: "https://x" },
      { type: "text" },
      "not a block",
      ...Array.from({ length: 30 }, (_, i) => ({ type: "field", label: `f${i}`, value: "v" })),
    ];
    const subject = gateV2Content({ ...PUBLISHING, approvalSubject: { ...SUBJECT, preview: blocks } }).subject;
    if (typeof subject !== "object" || subject === null || !("preview" in subject) || !Array.isArray(subject.preview)) {
      throw new Error("expected a subject with a preview");
    }
    const preview: unknown[] = subject.preview;
    expect(preview).toHaveLength(20);
    expect(preview[0]).toEqual({ type: "text", label: `${"L".repeat(199)}…`, text: `${"x".repeat(3999)}…` });
    expect(preview[1]).toEqual({ type: "field", label: "Account", value: `${"v".repeat(199)}…` });
    expect(preview[2]).toEqual({ type: "link", label: "Board", url: "https://board.example/b/1" });
    expect(preview[3]).toEqual({ type: "field", label: "f0", value: "v" });
    // This hub cut and dropped blocks, so the preview is no longer everything there was.
    expect(subject).toHaveProperty("preview_complete", false);
  });

  test("a single cut string makes the preview incomplete even when the board said it was complete", () => {
    const subject = gateSubjectV2({
      ...PUBLISHING,
      approvalSubject: { ...SUBJECT, preview: [{ type: "text", label: "Post", text: "x".repeat(4001) }] },
    });
    expect(subject?.preview_complete).toBe(false);
  });

  test("a malformed subject is not carried, and no option that would approve it is offered", () => {
    const c = gateV2Content({ ...PUBLISHING, approvalSubject: { id: "aps_x", schema: "social-publish/v1" } });
    expect(c.subject).toBeUndefined();
    expect(c.options).toEqual([
      { id: "request_changes", label: "Request changes", meaning: "revise", needs_comment: true },
      { id: "reject", label: "Reject", meaning: "reject", needs_comment: false },
    ]);
  });

  test("an option with no usable id or label is dropped, a duplicate id keeps the first, and nonsense meanings are derived", () => {
    expect(
      gateOptionsV2({
        ...DELIVERY,
        options: [
          { id: "", label: "Empty" },
          { id: "approve", label: "Approve", meaning: "obliterate", needsComment: "yes", delivery: "teleport" },
          { id: "approve", label: "Approve again" },
          { id: "x".repeat(300), label: "Too long" },
        ],
      })
    ).toEqual([{ id: "approve", label: "Approve", meaning: "approve", needs_comment: false }]);
  });
});

/** A decision.v2, answering the publishing gate above. */
function decisionV2(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msgtype: "m.text",
    body: "Approved — post automatically",
    schema_version: 1,
    suite_event_type: GATE_DECISION_V2_SUITE_TYPE,
    gate_id: "gate_7d21",
    option_id: "approve_automatic",
    subject: { id: "aps_fixture01", digest: "sha256:3f1c0d9a" },
    "m.relates_to": { rel_type: "m.reference", event_id: GATE_EVENT_ID },
    ...over,
  };
}

/** The projection this hub recorded for the publishing gate: its offered options and its subject. */
function publishingDeps(over: Partial<GateDecisionDeps> = {}) {
  return decisionDeps({
    projectionFor: async () => ({
      tenantId: "fleet_1",
      boardId: "brd_7c1f",
      eventId: GATE_EVENT_ID,
      options: gateOptionsV2(PUBLISHING),
      subjectId: "aps_fixture01",
      subjectDigest: "sha256:3f1c0d9a",
      subjectPreviewComplete: true,
    }),
    ...over,
  });
}

describe("gate.v2 — reading and acting on a decision.v2", () => {
  test("parses an option id this hub has no list for, and the subject binding", () => {
    expect(parseGateDecision(decisionV2())).toMatchObject({
      version: 2,
      gateId: "gate_7d21",
      optionId: "approve_automatic",
      subject: { id: "aps_fixture01", digest: "sha256:3f1c0d9a" },
      referencedEventId: GATE_EVENT_ID,
    });
  });

  test("a v1 decision still refuses an id outside the three", () => {
    expect(parseGateDecision(decision({ option_id: "approve_automatic" }))).toBeNull();
  });

  test("approve_automatic with its subject binding resolves, carrying the binding to superpipeline", async () => {
    const { deps, resolved } = publishingDeps();
    const r = await handleGateDecision({ sender: "@person:id.example", content: decisionV2() }, "!room", deps);
    expect(r).toEqual({ status: "resolved" });
    expect(resolved[0]).toMatchObject({
      gateId: "gate_7d21",
      decision: "approve_automatic",
      approvalSubject: { id: "aps_fixture01", digest: "sha256:3f1c0d9a" },
      principalId: "68jYD9VOCmXlPhIYGFOgoZVE6vDUVHPA",
    });
  });

  test("refused when the option was not offered for THAT gate", async () => {
    const { deps, resolved, replies } = publishingDeps();
    const r = await handleGateDecision(
      { sender: "@person:id.example", content: decisionV2({ option_id: "approve" }) },
      "!room",
      deps
    );
    expect(r).toEqual({ status: "refused", reason: "bad-option" });
    expect(resolved).toHaveLength(0);
    expect(replies[0]).toContain("Nothing has changed");
  });

  test("refused when the gate's offered options were never recorded", async () => {
    const { deps, resolved } = decisionDeps();
    const r = await handleGateDecision(
      { sender: "@person:id.example", content: decisionV2({ option_id: "approve", subject: undefined }) },
      "!room",
      deps
    );
    expect(r).toEqual({ status: "refused", reason: "bad-option" });
    expect(resolved).toHaveLength(0);
  });

  test("refused when an option that needs a comment arrives without one", async () => {
    for (const comment of [undefined, null, "", "   "]) {
      const { deps, resolved, replies } = publishingDeps();
      const r = await handleGateDecision(
        { sender: "@person:id.example", content: decisionV2({ option_id: "request_changes", comment }) },
        "!room",
        deps
      );
      expect(r).toEqual({ status: "refused", reason: "comment-required" });
      expect(resolved).toHaveLength(0);
      expect(replies[0]).toContain("comment");
    }
  });

  test("request_changes with its comment resolves and carries the comment", async () => {
    const { deps, resolved } = publishingDeps();
    const r = await handleGateDecision(
      { sender: "@person:id.example", content: decisionV2({ option_id: "request_changes", comment: "Shorter, please." }) },
      "!room",
      deps
    );
    expect(r).toEqual({ status: "resolved" });
    expect(resolved[0]).toMatchObject({ decision: "request_changes", comment: "Shorter, please." });
  });

  test("refused when an answer to a subject-bound gate carries no subject binding", async () => {
    for (const subject of [undefined, null, { id: "aps_fixture01" }, { digest: "sha256:3f1c0d9a" }, "aps_fixture01"]) {
      const { deps, resolved } = publishingDeps();
      const r = await handleGateDecision(
        { sender: "@person:id.example", content: decisionV2({ subject }) },
        "!room",
        deps
      );
      expect(r).toEqual({ status: "refused", reason: "subject-missing" });
      expect(resolved).toHaveLength(0);
    }
  });

  test("an approving answer is refused when the subject's preview was not shown in full; revise and reject still go", async () => {
    for (const subjectPreviewComplete of [false, null]) {
      const incomplete = (over: Partial<GateDecisionDeps> = {}) =>
        decisionDeps({
          projectionFor: async () => ({
            tenantId: "fleet_1",
            boardId: "brd_7c1f",
            eventId: GATE_EVENT_ID,
            options: gateOptionsV2(PUBLISHING),
            subjectId: "aps_fixture01",
            subjectDigest: "sha256:3f1c0d9a",
            subjectPreviewComplete,
          }),
          ...over,
        });
      for (const option_id of ["approve_automatic", "approve_manual"]) {
        const { deps, resolved, replies } = incomplete();
        const r = await handleGateDecision(
          { sender: "@person:id.example", content: decisionV2({ option_id }) },
          "!room",
          deps
        );
        expect(r).toEqual({ status: "refused", reason: "preview-incomplete" });
        expect(resolved).toHaveLength(0);
        expect(replies[0]).toContain("Nothing has changed");
      }
      const reject = incomplete();
      expect(
        await handleGateDecision({ sender: "@person:id.example", content: decisionV2({ option_id: "reject" }) }, "!room", reject.deps)
      ).toEqual({ status: "resolved" });
    }
  });

  test("every v1 refusal still holds for v2: unlinked sender, mismatched reference, an agent", async () => {
    const unlinked = publishingDeps({ principalForMatrixId: async () => null });
    expect(
      await handleGateDecision({ sender: "@x:elsewhere.org", content: decisionV2() }, "!room", unlinked.deps)
    ).toEqual({ status: "refused", reason: "unlinked-sender" });

    const mismatch = publishingDeps();
    expect(
      await handleGateDecision(
        { sender: "@person:id.example", content: decisionV2({ "m.relates_to": { rel_type: "m.reference", event_id: "$other" } }) },
        "!room",
        mismatch.deps
      )
    ).toEqual({ status: "refused", reason: "reference-mismatch" });

    const agent = publishingDeps({ principalForMatrixId: async () => ({ id: "prn_agent", kind: "agent" as const }) });
    expect(
      await handleGateDecision({ sender: "@agent:id.example", content: decisionV2() }, "!room", agent.deps)
    ).toEqual({ status: "refused", reason: "not-human" });

    for (const r of [unlinked, mismatch, agent]) expect(r.resolved).toHaveLength(0);
  });

  test("a v1 decision on a gate with no recorded options resolves exactly as before, with no binding", async () => {
    const { deps, resolved } = decisionDeps();
    await handleGateDecision({ sender: "@person:id.example", content: decision() }, "!room", deps);
    expect(resolved[0]).not.toHaveProperty("approvalSubject");
  });
});

describe("gate.v2 — resolving at the board with the subject binding", () => {
  test("sends approvalSubjectId and approvalSubjectDigest beside the decision and comment", async () => {
    const calls: Array<RequestInit> = [];
    const f: typeof fetch = Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response("{}", { status: 200 });
      },
      { preconnect: fetch.preconnect }
    );
    await resolveGateAtSuperpipeline(
      {
        boardId: "brd_7c1f",
        gateId: "gate_7d21",
        decision: "approve_automatic",
        comment: null,
        principalId: "prn_fixture",
        senderMxid: "@person:id.example",
        approvalSubject: { id: "aps_fixture01", digest: "sha256:3f1c0d9a" },
      },
      { baseUrl: "https://k.dev", mint: async () => "t", fetch: f }
    );
    const sent = calls[0]?.body;
    expect(JSON.parse(typeof sent === "string" ? sent : "")).toEqual({
      decision: "approve_automatic",
      approvalSubjectId: "aps_fixture01",
      approvalSubjectDigest: "sha256:3f1c0d9a",
    });
  });
});

import { readFileSync } from "node:fs";
import { GATE_REQUEST_CONTENT_KEY } from "@agentpod/contract";
import { gateRequestCard } from "./gates";

/** The rules every gate.v2 the hub sends keeps: a body, options with meaning and needs_comment, unique ids, a subject digest. */
function wellFormed(c: Record<string, unknown>): boolean {
  if (typeof c.body !== "string" || !Array.isArray(c.options)) return false;
  const options: unknown[] = c.options;
  const ids = new Set<unknown>();
  for (const o of options) {
    if (typeof o !== "object" || o === null || !("id" in o) || !("meaning" in o) || !("needs_comment" in o)) return false;
    ids.add(o.id);
  }
  if (ids.size !== options.length) return false;
  const s = c.subject;
  return s === undefined || (typeof s === "object" && s !== null && "id" in s && "digest" in s);
}

/**
 * The shared corpus's gate.v2 and decision.v2 examples — what supermessage and superpipeline
 * validate too. The hub's own output must BE the accepted gates, and the hub must refuse every
 * rejected answer.
 */
describe("gate.v2 against the shared corpus", () => {
  const corpusText = readFileSync(
    Bun.resolveSync("@superjackfruitlabs/treaty-ecosystem-identity/matrix_gate_events.json", import.meta.dir),
    "utf8"
  );
  const corpus: unknown = JSON.parse(corpusText);
  const events: Array<{ suiteEventType: string; accept: Array<{ content: Record<string, unknown> }>; reject: Array<{ why: string; content: Record<string, unknown> }> }> =
    typeof corpus === "object" && corpus !== null && "events" in corpus && Array.isArray(corpus.events) ? corpus.events : [];
  const gateV2 = events.find((e) => e.suiteEventType === GATE_V2_SUITE_TYPE);
  const decisionV2Corpus = events.find((e) => e.suiteEventType === GATE_DECISION_V2_SUITE_TYPE);

  const corpusPost = "Our next release ships today.\n\nThanks to everyone who tested it.";
  const corpusPublishing: GatePendingDelivery = {
    ...DELIVERY,
    cardId: "crd_6b40",
    gateId: "gate_8f3a",
    stageKey: "approve",
    returnStageKey: "draft",
    cardTitle: "Announce the release",
    handoffSummary: corpusPost,
    options: PUBLISHING.options,
    approvalSubject: {
      id: "aps_2c9e71",
      digest: "sha256:9b2f4e0c1a7d",
      schema: "social-publish/v1",
      revision: 1,
      expiresAt: "2030-01-02T03:04:05Z",
      previewComplete: true,
      preview: [
        { type: "text", label: "Post", text: corpusPost },
        { type: "field", label: "Account", value: "@fixture_account on X" },
        { type: "field", label: "Approval expires", value: "2030-01-02T03:04:05Z" },
      ],
    },
  };

  test("the hub's gate.v2 for a publishing gate and for an ordinary gate is exactly what the corpus accepts", () => {
    expect(gateV2?.accept).toHaveLength(2);
    expect(gateV2Content(corpusPublishing, "https://superpipeline.dev/b/brd_7c1f/c/crd_6b40")).toEqual(
      gateV2?.accept[0]?.content ?? {}
    );
    expect(
      gateV2Content(
        { ...DELIVERY, handoffSummary: "Added the OAuth routes and a test for the refresh-token path." },
        "https://superpipeline.dev/b/brd_7c1f/c/crd_9a22"
      )
    ).toEqual(gateV2?.accept[1]?.content ?? {});
  });

  test("every gate.v2 the corpus rejects breaks a rule the hub's own output keeps", () => {
    for (const { content } of gateV2?.accept ?? []) expect(wellFormed(content)).toBe(true);
    expect(gateV2?.reject.length).toBeGreaterThanOrEqual(4);
    for (const { why, content } of gateV2?.reject ?? []) expect(wellFormed(content), why).toBe(false);
  });

  const corpusDeps = () =>
    decisionDeps({
      projectionFor: async () => ({
        tenantId: "fleet_1",
        boardId: "brd_7c1f",
        eventId: "$gateEventId",
        options: gateOptionsV2(corpusPublishing),
        subjectId: "aps_2c9e71",
        subjectDigest: "sha256:9b2f4e0c1a7d",
        subjectPreviewComplete: true,
      }),
    });

  test("every decision.v2 the corpus accepts resolves, carrying its binding", async () => {
    expect(decisionV2Corpus?.accept.length).toBeGreaterThanOrEqual(2);
    for (const { content } of decisionV2Corpus?.accept ?? []) {
      const { deps, resolved } = corpusDeps();
      expect(await handleGateDecision({ sender: "@person:id.example", content }, "!room", deps)).toEqual({ status: "resolved" });
      expect(resolved[0]).toMatchObject({ approvalSubject: { id: "aps_2c9e71", digest: "sha256:9b2f4e0c1a7d" } });
    }
  });

  test("every decision.v2 the corpus rejects is refused, and nothing resolves", async () => {
    expect(decisionV2Corpus?.reject.length).toBeGreaterThanOrEqual(4);
    for (const { why, content } of decisionV2Corpus?.reject ?? []) {
      const { deps, resolved } = corpusDeps();
      const r = await handleGateDecision({ sender: "@person:id.example", content }, "!room", deps);
      expect(r.status, why).toBe("refused");
      expect(resolved, why).toHaveLength(0);
    }
  });
});

/** The projection this hub would record for a delivery, as `claimGate` records it. */
function recordedFor(d: GatePendingDelivery): Partial<GateDecisionDeps> {
  const subject = gateSubjectV2(d);
  return {
    projectionFor: async () => ({
      tenantId: "fleet_1",
      boardId: "brd_7c1f",
      eventId: GATE_EVENT_ID,
      options: gateOptionsV2(d),
      subjectId: subject?.id ?? null,
      subjectDigest: subject?.digest ?? null,
      subjectPreviewComplete: subject?.preview_complete ?? null,
    }),
  };
}

describe("gate.v2 — review fixes: a preview flag is not proof, a subject that cannot be carried offers no approval, an event fits", () => {
  test("a board's previewComplete: true with no usable preview is not complete, and an approval of it is refused", async () => {
    const { preview: _preview, ...noPreview } = SUBJECT;
    for (const approvalSubject of [
      noPreview,
      { ...SUBJECT, preview: "not an array" },
      { ...SUBJECT, preview: [] },
      { ...SUBJECT, preview: [{ type: "text" }, { type: "image", src: "https://x" }] },
    ]) {
      const d: GatePendingDelivery = { ...PUBLISHING, approvalSubject: { ...approvalSubject, previewComplete: true } };
      expect(gateSubjectV2(d)?.preview_complete).toBe(false);
      const { deps, resolved } = decisionDeps(recordedFor(d));
      const r = await handleGateDecision({ sender: "@person:id.example", content: decisionV2() }, "!room", deps);
      expect(r).toEqual({ status: "refused", reason: "preview-incomplete" });
      expect(resolved).toHaveLength(0);
    }
  });

  test("a subject the hub could not carry leaves no approve-meaning option at all; revise and reject stay", async () => {
    const d: GatePendingDelivery = {
      ...DELIVERY,
      options: [
        { id: "approve", label: "Approve" },
        { id: "request_changes", label: "Request changes" },
        { id: "reject", label: "Reject" },
      ],
      approvalSubject: { id: "aps_x", schema: "social-publish/v1" },
    };
    expect(gateOptionsV2(d).map((o) => o.id)).toEqual(["request_changes", "reject"]);
    const { deps, resolved } = decisionDeps(recordedFor(d));
    const r = await handleGateDecision(
      { sender: "@person:id.example", content: decisionV2({ option_id: "approve", subject: undefined }) },
      "!room",
      deps
    );
    expect(r).toEqual({ status: "refused", reason: "bad-option" });
    expect(resolved).toHaveLength(0);
  });

  test("a gate whose preview would overflow an event still fits one, with the preview marked incomplete", () => {
    // Every block at its per-block limit, in a script that costs three bytes a character, and
    // the board's handoff summary being all of that text joined — what the board sends.
    const long = "語".repeat(4000);
    const preview = Array.from({ length: 20 }, (_, i) => ({ type: "text", label: `Post ${i + 1}`, text: long }));
    const d: GatePendingDelivery = {
      ...PUBLISHING,
      handoffSummary: preview.map((b) => b.text).join("\n\n"),
      approvalSubject: { ...SUBJECT, previewComplete: true, preview },
    };
    const { body, ...v2 } = gateV2Content(d, "https://board.example/b/brd_7c1f/c/crd_5e10");
    // The prose message as it is sent: the v2 fields, the v1 card beside them, and the body.
    const content = { ...v2, [GATE_REQUEST_CONTENT_KEY]: gateRequestCard(d), msgtype: "m.text", body };
    const bytes = new TextEncoder().encode(JSON.stringify(content)).length;
    // Under 64 KiB with room for Megolm's base64 (×4/3) in an encrypted board room.
    expect(bytes).toBeLessThan(48_000);
    expect(gateSubjectV2(d)?.preview_complete).toBe(false);
    // The body shows the bounded preview, not the full one.
    expect(String(body)).toContain("Post 1:");
    expect(String(body)).not.toContain("Post 20:");
  });
});
