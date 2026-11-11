import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { MatrixGateQuorum } from "../../db/schema/matrix";
import {
  GATE_DECISION_V2_SUITE_TYPE,
  GATE_OUTCOME_TYPE,
  GATE_V2_SUITE_TYPE,
  gateOptionsV2,
  gateV2Content,
  handleGateDecision,
  type DecisionRefusal,
  type GateDecisionDeps,
  type GatePendingDelivery,
} from "./gates";
import {
  GATE_PROGRESS_TYPE,
  QUORUM_APPROVALS_MAX,
  approvalsCounted,
  gateProgressBody,
  gateProgressContent,
  isGateApprovalRecorded,
  quorumV2,
} from "@superjackfruitlabs/treaty-matrix-events";

/**
 * A gate may need more than one approver (charter → `decisions/2026-11-09-a-gate-may-need-more-than-one-approver.md`).
 * The hub carries the quorum on gate.v2, says each approval short of it in the room, and does not
 * say "Approved — the board has it" for an approval the board recorded without passing the gate.
 * Pinned against treaty's `fixtures/ecosystem-identity/matrix_gate_events.json` (`variant: "quorum"`).
 */

const LINK = "https://superpipeline.dev/b/brd_7c1f/c/crd_8a40";
const GATE_EVENT = "$gateEventId";
const FIRST_AT = "2026-11-09T10:00:00.000Z";

const QUORUM_GATE: GatePendingDelivery = {
  event: "gate.pending",
  boardId: "brd_7c1f",
  cardId: "crd_8a40",
  gateId: "gate_6e19",
  stageKey: "release",
  returnStageKey: "build",
  cardTitle: "Ship the release",
  producedBy: "agt_31d0",
  options: [
    { id: "approve", label: "Approve", meaning: "approve", needsComment: false },
    { id: "request_changes", label: "Request changes", meaning: "revise", needsComment: true },
    { id: "reject", label: "Reject", meaning: "reject", needsComment: false },
  ],
  quorum: { required: 2, from: "admins", approvals: [{ principalId: "prn_first", at: FIRST_AT }] },
  ts: "2026-11-09T09:00:00.000Z",
};

const STORED: MatrixGateQuorum = { required: 2, from: "admins", approvals: [{ principal_id: "prn_first", at: FIRST_AT }] };

describe("gate.v2 carries a quorum gate's progress", () => {
  test("snake_case beside the options, with the approvals recorded so far", () => {
    expect(gateV2Content(QUORUM_GATE, LINK).quorum).toEqual({
      required: 2,
      from: "admins",
      approvals: [{ principal_id: "prn_first", at: FIRST_AT }],
    });
  });

  test("a variant approval names its variant", () => {
    const q = quorumV2({ required: 3, from: "deciders", approvals: [{ principalId: "prn_a", at: FIRST_AT, variantId: "short" }] });
    expect(q?.approvals).toEqual([{ principal_id: "prn_a", at: FIRST_AT, variant_id: "short" }]);
  });

  test("a gate without a quorum is byte-identical to before: no quorum key at all", () => {
    const { quorum: _q, ...plain } = QUORUM_GATE;
    expect(gateV2Content(plain, LINK)).not.toHaveProperty("quorum");
  });

  test("a malformed quorum is not carried: the field is omitted rather than carried as junk", () => {
    const approval = { principalId: "prn_a", at: FIRST_AT };
    const bad: unknown[] = [
      null,
      "two",
      [],
      { required: 1, from: "admins", approvals: [] },
      { required: 6, from: "admins", approvals: [] },
      { required: 2.5, from: "admins", approvals: [] },
      { required: "2", from: "admins", approvals: [] },
      { required: 2, from: "everyone", approvals: [] },
      { required: 2, approvals: [] },
      { required: 2, from: "admins" },
      { required: 2, from: "admins", approvals: "prn_a" },
      { required: 2, from: "admins", approvals: [{ principalId: "", at: FIRST_AT }] },
      { required: 2, from: "admins", approvals: [{ principalId: "p".repeat(129), at: FIRST_AT }] },
      { required: 2, from: "admins", approvals: [{ principalId: "prn_a", at: "yesterday" }] },
      { required: 2, from: "admins", approvals: [{ principalId: "prn_a", at: FIRST_AT, variantId: 7 }] },
      { required: 2, from: "admins", approvals: [{ principalId: "prn_a", at: FIRST_AT, variantId: "" }] },
      { required: 2, from: "admins", approvals: [approval, approval] },
      {
        required: 5,
        from: "deciders",
        approvals: Array.from({ length: QUORUM_APPROVALS_MAX + 1 }, (_, i) => ({ principalId: `prn_${i}`, at: FIRST_AT })),
      },
    ];
    for (const quorum of bad) {
      expect(quorumV2(quorum), JSON.stringify(quorum)).toBeNull();
      expect(gateV2Content({ ...QUORUM_GATE, quorum }, LINK), JSON.stringify(quorum)).not.toHaveProperty("quorum");
    }
    // The edges hold: 2 and 5, and the most approvals carried.
    expect(quorumV2({ required: 5, from: "deciders", approvals: [] })).not.toBeNull();
    expect(
      quorumV2({ required: 5, from: "deciders", approvals: Array.from({ length: QUORUM_APPROVALS_MAX }, (_, i) => ({ principalId: `prn_${i}`, at: FIRST_AT })) }),
    ).not.toBeNull();
  });
});

describe("gate.approval_recorded is checked before it is believed", () => {
  const RECORDED = {
    event: "gate.approval_recorded",
    boardId: "brd_7c1f",
    cardId: "crd_8a40",
    gateId: "gate_6e19",
    approval: { principalId: "prn_first", at: FIRST_AT },
    quorum: { required: 2, from: "admins", approvals: [{ principalId: "prn_first", at: FIRST_AT }] },
  };

  test("a well-formed push is one", () => {
    expect(isGateApprovalRecorded(RECORDED)).toBe(true);
  });

  test("anything missing, malformed, or two halves that disagree is not", () => {
    const bad: unknown[] = [
      null,
      { ...RECORDED, event: "gate.pending" },
      { ...RECORDED, boardId: null },
      { ...RECORDED, cardId: "" },
      { ...RECORDED, gateId: 4 },
      { ...RECORDED, approval: undefined },
      { ...RECORDED, approval: { principalId: "prn_first", at: "soon" } },
      { ...RECORDED, quorum: { ...RECORDED.quorum, from: "board" } },
      { ...RECORDED, quorum: undefined },
      { ...RECORDED, approval: { principalId: "prn_second", at: FIRST_AT } },
      { ...RECORDED, approval: { principalId: "prn_first", at: FIRST_AT, variantId: "short" } },
    ];
    for (const v of bad) expect(isGateApprovalRecorded(v), JSON.stringify(v)).toBe(false);
  });
});

describe("the progress reply", () => {
  test("says who approved, how many of how many, and how many more", () => {
    expect(gateProgressBody({ who: "rakesh", variantLabel: null, count: 1, required: 2 })).toBe("Approved by rakesh — 1 of 2. Waiting for 1 more.");
    expect(gateProgressBody({ who: "asha", variantLabel: null, count: 2, required: 5 })).toBe("Approved by asha — 2 of 5. Waiting for 3 more.");
  });

  test("names the variant on a variant gate, and leaves out a person it cannot name", () => {
    expect(gateProgressBody({ who: "rakesh", variantLabel: "Short", count: 1, required: 2 })).toBe('Approved "Short" by rakesh — 1 of 2. Waiting for 1 more.');
    expect(gateProgressBody({ who: null, variantLabel: null, count: 1, required: 3 })).toBe("Approved — 1 of 3. Waiting for 2 more.");
  });

  test("counts only the approvals for the same variant", () => {
    const q = quorumV2({
      required: 2,
      from: "deciders",
      approvals: [
        { principalId: "prn_a", at: FIRST_AT, variantId: "short" },
        { principalId: "prn_b", at: FIRST_AT, variantId: "long" },
      ],
    });
    expect(q && approvalsCounted(q, { principal_id: "prn_b", at: FIRST_AT, variant_id: "long" })).toBe(1);
  });

  test("the structured half references the gate's own event", () => {
    const quorum = quorumV2(QUORUM_GATE.quorum);
    if (!quorum) throw new Error("fixture quorum must parse");
    const c = gateProgressContent({
      gateId: "gate_6e19",
      boardId: "brd_7c1f",
      cardId: "crd_8a40",
      approval: { principal_id: "prn_first", at: FIRST_AT },
      quorum,
      approvedBy: "rakesh",
      variantLabel: null,
      gateEventId: GATE_EVENT,
    });
    expect(c).toMatchObject({ suite_event_type: GATE_PROGRESS_TYPE, gate_id: "gate_6e19", "m.relates_to": { rel_type: "m.reference", event_id: GATE_EVENT } });
    expect(c).not.toHaveProperty("chosen_variant");
  });
});

// ── Answers on a quorum gate ────────────────────────────────────────────────

type Read = Awaited<ReturnType<NonNullable<GateDecisionDeps["readGate"]>>>;

function deps(over: Partial<GateDecisionDeps> = {}, quorum: MatrixGateQuorum | null = STORED) {
  const resolved: unknown[] = [];
  const replies: string[] = [];
  const outcomes: Array<Record<string, unknown>> = [];
  const marked: string[] = [];
  const reads: string[] = [];
  const value: GateDecisionDeps = {
    principalForMatrixId: async () => ({ id: "prn_second", kind: "human" as const }),
    projectionFor: async () => ({
      tenantId: "fleet_1",
      boardId: QUORUM_GATE.boardId,
      eventId: GATE_EVENT,
      options: gateOptionsV2(QUORUM_GATE),
      subjectId: null,
      subjectPreviewComplete: null,
      variants: null,
      quorum,
    }),
    resolveGate: async (i) => {
      resolved.push(i);
      return { ok: true };
    },
    readGate: async (_b, gateId): Promise<Read> => {
      reads.push(gateId);
      return { status: "pending", decision: null, decidedBy: null, chosen: null };
    },
    reply: async (_r, b) => {
      replies.push(b);
      return null;
    },
    sendOutcome: async (_r, c) => {
      outcomes.push(c);
      return null;
    },
    displayNameFor: async () => "rakesh",
    markOutcomePosted: async (gateId) => {
      marked.push(gateId);
      return true;
    },
    ...over,
  };
  return { deps: value, resolved, replies, outcomes, marked, reads };
}

function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msgtype: "m.text",
    body: "Approved",
    schema_version: 1,
    suite_event_type: GATE_DECISION_V2_SUITE_TYPE,
    gate_id: "gate_6e19",
    option_id: "approve",
    "m.relates_to": { rel_type: "m.reference", event_id: GATE_EVENT },
    ...over,
  };
}

const run = (content: Record<string, unknown>, d: ReturnType<typeof deps>) =>
  handleGateDecision({ sender: "@second:id.example", content }, "!room", d.deps);

describe("an approval the board recorded short of the quorum", () => {
  test("posts no outcome and claims none: the gate is still pending", async () => {
    const d = deps();
    expect(await run(answer(), d)).toEqual({ status: "recorded" });
    expect(d.resolved).toHaveLength(1);
    expect(d.reads).toEqual(["gate_6e19"]);
    expect(d.replies).toHaveLength(0);
    expect(d.outcomes).toHaveLength(0);
    expect(d.marked).toHaveLength(0);
  });

  test("a gate read that fails leaves the receipt to the sweep", async () => {
    for (const readGate of [async () => null, async () => Promise.reject(new Error("board down"))]) {
      const d = deps({ readGate });
      expect(await run(answer(), d)).toEqual({ status: "recorded" });
      expect(d.outcomes).toHaveLength(0);
      expect(d.marked).toHaveLength(0);
    }
    // No read wired at all is the same: nothing is said that the board has not said.
    const none = deps({ readGate: undefined });
    expect(await run(answer(), none)).toEqual({ status: "recorded" });
    expect(none.outcomes).toHaveLength(0);
  });

  test("only a read that says resolved settles the card, whatever else it carries", async () => {
    for (const status of ["pending", "open", ""]) {
      const d = deps({ readGate: async () => ({ status, decision: "approve", decidedBy: "prn_second", chosen: null }) });
      expect(await run(answer(), d), status).toEqual({ status: "recorded" });
      expect(d.marked, status).toHaveLength(0);
      expect(d.outcomes, status).toHaveLength(0);
    }
  });

  test("the approval that reaches the quorum posts the outcome the board resolved with", async () => {
    // The person chose automatic; another approver chose manual, so the board resolved manual.
    const d = deps({
      readGate: async () => ({ status: "resolved", decision: "approve", decidedBy: "prn_second", chosen: null }),
    });
    expect(await run(answer(), d)).toEqual({ status: "resolved" });
    expect(d.marked).toEqual(["gate_6e19"]);
    expect(d.replies).toEqual(["Approved by rakesh — the board has it."]);
    expect(d.outcomes[0]).toMatchObject({ suite_event_type: GATE_OUTCOME_TYPE, decision: "approve" });
  });

  test("the outcome names the board's decision, not the answer's", async () => {
    const options = [
      { id: "approve_manual", label: "Approve — I'll post it", meaning: "approve", needsComment: false, delivery: "manual" },
      { id: "approve_automatic", label: "Approve — post it", meaning: "approve", needsComment: false, delivery: "automatic" },
      { id: "reject", label: "Reject", meaning: "reject", needsComment: false },
    ];
    const d = deps({
      projectionFor: async () => ({
        tenantId: "fleet_1",
        boardId: QUORUM_GATE.boardId,
        eventId: GATE_EVENT,
        options: gateOptionsV2({ ...QUORUM_GATE, options }),
        quorum: STORED,
      }),
      readGate: async () => ({ status: "resolved", decision: "approve_manual", decidedBy: "prn_second", chosen: null }),
    });
    expect(await run(answer({ option_id: "approve_automatic" }), d)).toEqual({ status: "resolved" });
    expect(d.replies).toEqual(["Approved for manual delivery by rakesh — the board has it."]);
    expect(d.outcomes[0]).toMatchObject({ decision: "approve_manual" });
  });

  test("a reject on a quorum gate ends it at once, as before: no read", async () => {
    const d = deps();
    expect(await run(answer({ option_id: "reject" }), d)).toEqual({ status: "resolved" });
    expect(d.reads).toHaveLength(0);
    expect(d.replies).toEqual(["Rejected by rakesh — the board has it."]);
  });

  test("a gate with no stored quorum the board says resolved: the outcome at once", async () => {
    const d = deps({ readGate: async () => ({ status: "resolved", decision: "approve", decidedBy: "prn_second", chosen: null }) }, null);
    expect(await run(answer(), d)).toEqual({ status: "resolved" });
    expect(d.replies).toEqual(["Approved by rakesh — the board has it."]);
    expect(d.marked).toEqual(["gate_6e19"]);
  });

  test("a gate projected before quorums, still pending at the board: recorded, nothing said or claimed", async () => {
    // A quorum gate this hub posted before it carried quorums has none stored; the board's read is
    // what tells an approval recorded from one that passed the gate.
    const d = deps({}, null);
    expect(await run(answer(), d)).toEqual({ status: "recorded" });
    expect(d.replies).toHaveLength(0);
    expect(d.outcomes).toHaveLength(0);
    expect(d.marked).toHaveLength(0);
  });

  test("a gate with no stored quorum the board cannot read keeps the single-approval behaviour", async () => {
    for (const readGate of [undefined, async () => null, async () => Promise.reject(new Error("board down"))]) {
      const d = deps({ readGate }, null);
      expect(await run(answer(), d)).toEqual({ status: "resolved" });
      expect(d.replies).toEqual(["Approved by rakesh — the board has it."]);
    }
  });
});

describe("the board's refusals of a quorum approval are said in plain words", () => {
  test("approving twice", async () => {
    const d = deps({ resolveGate: async () => ({ ok: false, code: "QUORUM_ALREADY_APPROVED" }) });
    const result = await run(answer(), d);
    expect(result).toEqual({ status: "refused", reason: "quorum-already-approved" satisfies DecisionRefusal });
    expect(d.replies).toEqual(["You have already approved this; it is waiting for other approvers. Nothing has changed."]);
  });

  test("an approval that does not count: owners and admins only", async () => {
    const d = deps({ resolveGate: async () => ({ ok: false, code: "APPROVAL_DECIDER_NOT_ALLOWED" }) });
    expect(await run(answer(), d)).toEqual({ status: "refused", reason: "decider-not-allowed" satisfies DecisionRefusal });
    expect(d.replies).toEqual([
      "This gate needs approvals from the workspace's owners and admins, so your approval does not count here. Nothing has changed.",
    ]);
  });

  test("an approval that does not count: the stage's deciders", async () => {
    const d = deps({ resolveGate: async () => ({ ok: false, code: "APPROVAL_DECIDER_NOT_ALLOWED" }) }, { ...STORED, from: "deciders" });
    expect(await run(answer(), d)).toEqual({ status: "refused", reason: "decider-not-allowed" });
    expect(d.replies).toEqual(["Your approval does not count for this gate: it needs approvals from its named deciders. Nothing has changed."]);
  });

  test("on a gate with no quorum, APPROVAL_DECIDER_NOT_ALLOWED is handled as before", async () => {
    const d = deps({ resolveGate: async () => ({ ok: false, code: "APPROVAL_DECIDER_NOT_ALLOWED" }) }, null);
    expect(await run(answer(), d)).toEqual({ status: "refused", reason: "unknown-gate" });
    expect(d.replies).toHaveLength(0);
  });
});

/** The shared corpus's `variant: "quorum"` entries: the hub's output must BE them. */
describe("quorum gates against the shared corpus", () => {
  interface Entry {
    suiteEventType: string;
    variant?: string;
    accept: Array<{ why: string; content: Record<string, unknown> }>;
    reject: Array<{ why: string; content: Record<string, unknown> }>;
    /** What the board refuses an answer with, and what the hub then says in the room. */
    boardRefusals?: Array<{ code: string; httpStatus: number; from?: string; said: string }>;
  }
  const parsed: unknown = JSON.parse(
    readFileSync(Bun.resolveSync("@superjackfruitlabs/treaty-ecosystem-identity/matrix_gate_events.json", import.meta.dir), "utf8"),
  );
  const corpus: { version: number; events: Entry[] } =
    typeof parsed === "object" && parsed !== null && "events" in parsed && "version" in parsed && Array.isArray(parsed.events) && typeof parsed.version === "number"
      ? { version: parsed.version, events: parsed.events }
      : { version: 0, events: [] };
  const entry = (t: string) => corpus.events.find((e) => e.suiteEventType === t && e.variant === "quorum");
  const gateV2 = entry(GATE_V2_SUITE_TYPE);
  const progress = entry(GATE_PROGRESS_TYPE);
  const decision = entry(GATE_DECISION_V2_SUITE_TYPE);

  test("version 11 (quorum entries since 9)", () => {
    expect(corpus.version).toBe(11);
  });

  test("the hub's gate.v2 for a quorum gate is exactly what the corpus accepts", () => {
    expect(gateV2?.accept).toHaveLength(1);
    expect(gateV2Content(QUORUM_GATE, LINK)).toEqual(gateV2?.accept[0]?.content ?? {});
  });

  test("every quorum the corpus rejects is one this hub would not carry", () => {
    expect(gateV2?.reject.length).toBeGreaterThanOrEqual(3);
    for (const { why, content } of gateV2?.reject ?? []) {
      const q: unknown = content.quorum;
      // The corpus writes the Matrix spelling; the board sends camelCase. Translate the approvals back.
      const board =
        typeof q === "object" && q !== null && "approvals" in q && Array.isArray(q.approvals)
          ? {
              ...q,
              approvals: q.approvals.map((a: unknown) =>
                typeof a === "object" && a !== null
                  ? { principalId: Reflect.get(a, "principal_id"), at: Reflect.get(a, "at"), variantId: Reflect.get(a, "variant_id") }
                  : a,
              ),
            }
          : q;
      expect(quorumV2(board), why).toBeNull();
    }
  });

  test("the progress event is exactly what the corpus accepts", () => {
    const quorum = quorumV2(QUORUM_GATE.quorum);
    if (!quorum) throw new Error("fixture quorum must parse");
    expect(progress?.accept).toHaveLength(1);
    expect(
      gateProgressContent({
        gateId: "gate_6e19",
        boardId: "brd_7c1f",
        cardId: "crd_8a40",
        approval: { principal_id: "prn_first", at: FIRST_AT },
        quorum,
        approvedBy: "rakesh",
        variantLabel: null,
        gateEventId: GATE_EVENT,
      }),
    ).toEqual(progress?.accept[0]?.content ?? {});
  });

  test("every quorum answer the corpus accepts reaches the board as the person", async () => {
    expect(decision?.accept.length).toBeGreaterThanOrEqual(1);
    for (const { why, content } of decision?.accept ?? []) {
      const d = deps();
      expect(await run(content, d), why).toEqual({ status: "recorded" });
      expect(d.resolved, why).toHaveLength(1);
    }
  });

  test("each board refusal of a quorum approval is said as the corpus says it", async () => {
    const codes = (decision?.boardRefusals ?? []).map((r) => r.code);
    expect(codes).toContain("QUORUM_ALREADY_APPROVED");
    expect(codes).toContain("APPROVAL_DECIDER_NOT_ALLOWED");
    for (const r of decision?.boardRefusals ?? []) {
      const from = r.from === "deciders" ? "deciders" : "admins";
      const d = deps({ resolveGate: async () => ({ ok: false, code: r.code }) }, { ...STORED, from });
      expect((await run(answer(), d)).status, r.code).toBe("refused");
      expect(d.replies, r.code).toEqual([r.said]);
    }
  });
});
