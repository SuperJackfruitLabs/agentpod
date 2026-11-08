/**
 * The wire of a stage's timeout (charter: "Unanswered decisions remind, then escalate" §2, §5): the
 * deadline each of the four envelopes carries, the predicate for the two pushed events, and the
 * notices posted in reply to the waiting card. Pure.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DECISION_ESCALATED_SUITE_TYPE,
  DECISION_REMINDED_SUITE_TYPE,
  deadlineV2,
  decisionNoticeContent,
  isDecisionTimeout,
  waitedFor,
} from "./decision-timeout-wire";
import { gateV2Content, gateEventContent } from "./gate-wire";
import { settleGateOutcome } from "./gate-decision";
import { questionV2Content } from "./question-wire";
import { deliveryV2Content } from "./delivery-wire";
import { attentionV2Content } from "./attention-wire";
import * as C from "./testdata/decision-timeouts-corpus";
import type { AttentionPendingDelivery, DecisionTimeoutDelivery, DeliveryPendingDelivery, ElicitationPendingDelivery, GatePendingDelivery } from "../bridge";

const REMIND = "2026-11-08T15:00:00.000Z";
const ESCALATE = "2026-11-08T18:00:00.000Z";

describe("deadline", () => {
  test("is carried in snake_case, each half only when the board set it", () => {
    expect(deadlineV2({ remindAt: REMIND, escalateAt: ESCALATE })).toEqual({ remind_at: REMIND, escalate_at: ESCALATE });
    expect(deadlineV2({ escalateAt: ESCALATE })).toEqual({ escalate_at: ESCALATE });
    expect(deadlineV2({ remindAt: REMIND })).toEqual({ remind_at: REMIND });
  });

  test("is absent when the board sent none, or nothing usable", () => {
    for (const raw of [undefined, null, {}, "soon", [], { remindAt: 5 }, { remindAt: "tomorrow" }, { remindAt: "2026-13-45T99:00:00Z" }, { remindAt: "2026-11-08" }, { remindAt: "Sun Nov 08 2026 15:00:00" }]) {
      expect(deadlineV2(raw)).toBeUndefined();
    }
  });

  test("a malformed half is dropped and the good half kept", () => {
    expect(deadlineV2({ remindAt: "not a time", escalateAt: ESCALATE })).toEqual({ escalate_at: ESCALATE });
  });

  test("a time with an offset is kept as the board wrote it; one too long to be a time is dropped", () => {
    expect(deadlineV2({ remindAt: "2026-11-08T15:00:00+05:30" })).toEqual({ remind_at: "2026-11-08T15:00:00+05:30" });
    expect(deadlineV2({ remindAt: `2026-11-08T15:00:00.${"1".repeat(80)}Z` })).toBeUndefined();
  });

  const GATE: GatePendingDelivery = {
    event: "gate.pending", boardId: "brd_7c1f", cardId: "crd_6b40", gateId: "gate_8f3a", stageKey: "review",
    returnStageKey: "draft", cardTitle: "Launch post", producedBy: "agent", options: [{ id: "approve", label: "Approve" }], ts: REMIND,
  };
  const QUESTION: ElicitationPendingDelivery = {
    event: "elicitation.pending", boardId: "brd_7c1f", cardId: "crd_6b40", cardTitle: "Launch post", elicitationId: "elc_1",
    runId: "run_1", stageKey: "draft", agentId: "agt_1", question: "Which?", options: [{ id: "a", label: "A" }], ts: REMIND,
  };
  const DELIVERY: DeliveryPendingDelivery = {
    event: "delivery.pending", boardId: "brd_7c1f", cardId: "crd_6b40", cardTitle: "Launch post", gateId: "gate_8f3a",
    stageKey: "publish", options: [{ id: "record_live_url", label: "Record the live link" }], ts: REMIND,
  };
  const ATTENTION: AttentionPendingDelivery = {
    event: "attention.pending", boardId: "brd_7c1f", cardId: "crd_6b40", cardTitle: "Launch post", stageKey: "draft",
    waitId: "wait_1", reason: "blocked", options: [], ts: REMIND,
  };
  const deadline = { remindAt: REMIND, escalateAt: ESCALATE };

  test("rides on gate.v2, question.v2, delivery.v2 and attention.v2", () => {
    for (const content of [
      gateV2Content({ ...GATE, deadline }),
      questionV2Content({ ...QUESTION, deadline }),
      deliveryV2Content({ ...DELIVERY, deadline }),
      attentionV2Content({ ...ATTENTION, deadline }),
    ]) {
      expect(content.deadline).toEqual({ remind_at: REMIND, escalate_at: ESCALATE });
    }
  });

  test("is not a key at all without one, so a v2 envelope from before is byte for byte what it was", () => {
    for (const content of [gateV2Content(GATE), questionV2Content(QUESTION), deliveryV2Content(DELIVERY), attentionV2Content(ATTENTION)]) {
      expect("deadline" in content).toBe(false);
    }
  });

  test("never reaches the v1 gate card, whose payload v1 clients read unchanged", () => {
    expect("deadline" in gateEventContent({ ...GATE, deadline })).toBe(false);
  });
});

const ESCALATED = {
  event: "decision.escalated",
  boardId: "brd_7c1f",
  boardName: "Press",
  cardId: "crd_6b40",
  cardTitle: "Launch post",
  stageKey: "review",
  stageName: "Review",
  decisionKind: "gate",
  decisionId: "gate_8f3a",
  waitingSince: "2026-11-08T12:00:00.000Z",
  escalatedAt: "2026-11-08T18:02:11.000Z",
  ts: "2026-11-08T18:02:11.000Z",
};
const REMINDED = { ...ESCALATED, event: "decision.reminded", escalatedAt: undefined, remindedAt: "2026-11-08T15:00:30.000Z" };

/** A literal above, as the predicate narrows it. */
function asTimeout(v: unknown): DecisionTimeoutDelivery {
  if (!isDecisionTimeout(v)) throw new Error("not a decision timeout");
  return v;
}

/** What a reminder of each kind says. */
const say = (decisionKind: string) => String(decisionNoticeContent(asTimeout({ ...REMINDED, decisionKind }), "$c").body);

describe("the two pushed events", () => {
  test("a reminder and an escalation are recognised", () => {
    expect(isDecisionTimeout(ESCALATED)).toBe(true);
    expect(isDecisionTimeout(REMINDED)).toBe(true);
  });

  test("anything else is not: another event, an unknown kind, no decision, no time it happened", () => {
    expect(isDecisionTimeout({ ...ESCALATED, event: "gate.pending" })).toBe(false);
    expect(isDecisionTimeout({ ...ESCALATED, decisionKind: "vote" })).toBe(false);
    expect(isDecisionTimeout({ ...ESCALATED, decisionId: "" })).toBe(false);
    expect(isDecisionTimeout({ ...ESCALATED, boardId: 7 })).toBe(false);
    expect(isDecisionTimeout({ ...ESCALATED, cardTitle: undefined })).toBe(false);
    expect(isDecisionTimeout({ ...ESCALATED, waitingSince: "a while ago" })).toBe(false);
    expect(isDecisionTimeout({ ...ESCALATED, escalatedAt: undefined })).toBe(false);
    expect(isDecisionTimeout({ ...REMINDED, remindedAt: undefined })).toBe(false);
    expect(isDecisionTimeout(null)).toBe(false);
  });
});

describe("how long it waited", () => {
  test("in minutes under an hour, hours under two days, days after", () => {
    const since = "2026-11-08T12:00:00.000Z";
    expect(waitedFor(since, "2026-11-08T12:00:20.000Z")).toBe("1 min");
    expect(waitedFor(since, "2026-11-08T12:45:59.000Z")).toBe("45 min");
    expect(waitedFor(since, "2026-11-08T15:00:30.000Z")).toBe("3 h");
    expect(waitedFor(since, "2026-11-10T11:59:00.000Z")).toBe("47 h");
    expect(waitedFor(since, "2026-11-11T13:00:00.000Z")).toBe("3 d");
  });
});

describe("the notices", () => {
  test("an escalation replies to the card, says so in prose, and carries what a client renders it from", () => {
    const content = decisionNoticeContent(asTimeout(ESCALATED), "$card", "https://board.test/b/brd_7c1f/c/crd_6b40");
    expect(content).toEqual({
      msgtype: "m.text",
      body: 'Escalated to workspace admins after 6 h: "Launch post" is still waiting for an approval at Review. [Open the card](https://board.test/b/brd_7c1f/c/crd_6b40)',
      suite_event_type: DECISION_ESCALATED_SUITE_TYPE,
      schema_version: 1,
      board_id: "brd_7c1f",
      card_id: "crd_6b40",
      decision_kind: "gate",
      decision_id: "gate_8f3a",
      waiting_since: "2026-11-08T12:00:00.000Z",
      escalated_at: "2026-11-08T18:02:11.000Z",
      deep_link: "https://board.test/b/brd_7c1f/c/crd_6b40",
      "m.relates_to": { "m.in_reply_to": { event_id: "$card" } },
    });
  });

  test("a reminder is the short line, as a reply, with its own marker", () => {
    const content = decisionNoticeContent(asTimeout(REMINDED), "$card");
    expect(content.body).toBe('Still waiting: "Launch post" has waited 3 h for an approval.');
    expect(content.suite_event_type).toBe(DECISION_REMINDED_SUITE_TYPE);
    expect(content.reminded_at).toBe("2026-11-08T15:00:30.000Z");
    expect("escalated_at" in content).toBe(false);
    expect("deep_link" in content).toBe(false);
    expect(content["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$card" } });
  });

  test("each kind says what it waits for", () => {
    expect(say("question")).toContain("for an answer");
    expect(say("delivery")).toContain("for its live link");
    expect(say("attention")).toContain("for a person");
  });

  test("a title cannot break out of its quotes into markdown", () => {
    const content = decisionNoticeContent(asTimeout({ ...REMINDED, cardTitle: "x".repeat(500) }), "$c");
    expect(String(content.body).length).toBeLessThan(300);
  });
});

describe("a gate closed because its subject expired (charter decision 7)", () => {
  test("its card closes as expired, not as an answer the board has", async () => {
    const said: string[] = [];
    const outcomes: Array<Record<string, unknown>> = [];
    await settleGateOutcome({ gateId: "gate_8f3a", decision: "expired", decidedBy: null }, "!room", { boardId: "brd_7c1f", eventId: "$gate" }, {
      reply: async (_room, body) => {
        said.push(body);
      },
      sendOutcome: async (_room, content) => {
        outcomes.push(content);
        return null;
      },
    });
    expect(said).toEqual(["Expired — what this gate approves passed its expiry before anyone approved it, so it can no longer be approved here."]);
    expect(outcomes[0]).toMatchObject({ decision: "expired", decided_by: null, gate_id: "gate_8f3a" });
  });
});

// ── The shared corpus (fixture version 7) ────────────────────────────────────

interface CorpusEvent {
  suiteEventType: string;
  variant?: string;
  accept: Array<{ why: string; content: Record<string, unknown> }>;
  reject: Array<{ why: string; content: Record<string, unknown> }>;
}
function readCorpus(): { version: number; events: CorpusEvent[] } {
  return JSON.parse(readFileSync(join(import.meta.dir, "../../../../../fixtures/ecosystem-identity/matrix_gate_events.json"), "utf8"));
}
const corpus = readCorpus();
const entry = (t: string, variant?: string) => corpus.events.find((e) => e.suiteEventType === t && e.variant === variant);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** A deadline as a consumer checks it: snake_case halves only, each a time, at least one. */
function wellFormedDeadline(d: unknown): boolean {
  if (!isRecord(d)) return false;
  const keys = Object.keys(d);
  if (keys.length === 0 || keys.some((k) => k !== "remind_at" && k !== "escalate_at")) return false;
  return keys.every((k) => {
    const v = d[k];
    return typeof v === "string" && ISO.test(v);
  });
}

/** A notice as a client renders it: its marker, the decision, and a reply to the card. */
function wellFormedNotice(c: Record<string, unknown>, type: string, at: string): boolean {
  const rel = c["m.relates_to"];
  return (
    c.suite_event_type === type &&
    typeof c.body === "string" &&
    ["board_id", "card_id", "decision_id", "waiting_since", at].every((k) => typeof c[k] === "string" && c[k] !== "") &&
    ["gate", "question", "delivery", "attention"].includes(String(c.decision_kind)) &&
    isRecord(rel) &&
    isRecord(rel["m.in_reply_to"]) &&
    typeof rel["m.in_reply_to"].event_id === "string"
  );
}

describe("decision timeouts against the shared corpus (version 7, carried in 8)", () => {
  test("the corpus is version 8", () => {
    expect(corpus.version).toBe(8);
  });

  test("the hub's four envelopes with a deadline are exactly what the corpus accepts", () => {
    expect(entry("dev.superpipeline.gate.v2", "deadline")?.accept.map((a) => a.content)).toEqual([gateV2Content(C.DEADLINE_GATE, C.CORPUS_LINK)]);
    expect(entry("dev.superpipeline.question.v2", "deadline")?.accept.map((a) => a.content)).toEqual([questionV2Content(C.DEADLINE_QUESTION, C.CORPUS_LINK)]);
    expect(entry("dev.superpipeline.delivery.v2", "deadline")?.accept.map((a) => a.content)).toEqual([deliveryV2Content(C.DEADLINE_DELIVERY, C.CORPUS_LINK)]);
    expect(entry("dev.superpipeline.attention.v2", "deadline")?.accept.map((a) => a.content)).toEqual([attentionV2Content(C.DEADLINE_ATTENTION, C.CORPUS_LINK)]);
  });

  test("every deadline the corpus accepts is well formed, and every one it rejects is not", () => {
    const entries = corpus.events.filter((e) => e.variant === "deadline");
    expect(entries).toHaveLength(4);
    for (const e of entries) for (const { content } of e.accept) expect(wellFormedDeadline(content.deadline)).toBe(true);
    const rejects = entries.flatMap((e) => e.reject);
    expect(rejects.length).toBeGreaterThanOrEqual(3);
    for (const { why, content } of rejects) expect(wellFormedDeadline(content.deadline), why).toBe(false);
  });

  test("the expired gate's receipt is exactly what the corpus accepts", async () => {
    const outcomes: Array<Record<string, unknown>> = [];
    await settleGateOutcome({ gateId: "gate_8f3a", decision: "expired", decidedBy: null }, "!r", { boardId: "brd_7c1f", eventId: C.CORPUS_CARD_EVENT }, {
      reply: async () => {},
      sendOutcome: async (_r, content) => {
        outcomes.push(content);
        return null;
      },
    });
    expect(entry("dev.superpipeline.gate.outcome.v1", "expired")?.accept.map((a) => a.content)).toEqual(outcomes);
  });

  for (const [type, at, d, link] of [
    [DECISION_REMINDED_SUITE_TYPE, "reminded_at", C.REMINDED, undefined],
    [DECISION_ESCALATED_SUITE_TYPE, "escalated_at", C.ESCALATED, C.CORPUS_LINK],
  ] as const) {
    test(`the hub's ${type} is exactly what the corpus accepts, and every reject lacks what a client renders it by`, () => {
      const e = entry(type);
      expect(e?.accept.map((a) => a.content)).toEqual([decisionNoticeContent(d, C.CORPUS_CARD_EVENT, link)]);
      for (const { content } of e?.accept ?? []) expect(wellFormedNotice(content, type, at)).toBe(true);
      expect(e?.reject.length).toBeGreaterThanOrEqual(5);
      for (const { why, content } of e?.reject ?? []) expect(wellFormedNotice(content, type, at), why).toBe(false);
    });
  }
});
