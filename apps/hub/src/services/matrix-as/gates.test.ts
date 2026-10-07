import { describe, expect, test } from "bun:test";
import { OrgPlaneError } from "../org-plane/client";

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
