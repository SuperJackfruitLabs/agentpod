process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { ELICITATION_REQUEST_CONTENT_KEY } from "@agentpod/contract";

import { db, rawSql } from "../../db/drizzle";
import { matrixElicitationEvents } from "../../db/schema/matrix";
import { eq } from "drizzle-orm";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import type { ElicitationPendingDelivery } from "./elicitation-card";
import {
  TYPED_APPROVAL_REFUSED_TEXT,
  claimElicitationOutcome,
  handleElicitationAnswer,
  projectElicitation,
  recordedQuestion,
  type ElicitationAnswerDeps,
  type ElicitationProjectionDeps,
} from "./elicitations";
import {
  APPROVAL_REQUEST_NOTE,
  QUESTION_ANSWER_V2_SUITE_TYPE,
  QUESTION_V2_SUITE_TYPE,
  boundedQuestion,
  isApprovalRequest,
  questionOptionsV2,
  questionV2Content,
} from "./question-wire";
import { APPROVAL_UNBOUND_TEXT, handleQuestionAnswer, type QuestionAnswerDeps, type RecordedQuestion } from "./question-answer";

/**
 * A SuperToolkit approval request hosted on the board (charter: "Waiting cards and broker approvals
 * reach chat" §3–4). It arrives on `elicitation.pending` as a subject-bound question that belongs
 * to no card, run or stage (`cardId: ""`, `approvalRequestId: "apr_…"`, an `stk-capability/v1`
 * subject). The room must not describe or link it as a card; it still posts in the board's room,
 * carries the subject and options as any subject-bound question does, and its answers go through
 * the same bound path. Only workspace owners and admins may allow one — the board judges that.
 */

const RUN = crypto.randomUUID().slice(0, 8);
const ROOM = `!apr-room-${RUN}:id.example`;
const SPEAKER = "@agent_superpipeline:id.example";
const HUMAN = "@person:id.example";
const FUTURE = "2099-01-01T00:00:00.000Z";
let n = 0;
let events = 0;

const ARGS = '{\n  "title": "Flaky login test",\n  "labels": ["ci"]\n}';
const DIGEST = "sha256:4be1c0de9a7f30b2";

const SUBJECT = {
  id: "stkreq_8f2c",
  digest: DIGEST,
  schema: "stk-capability/v1",
  revision: 1,
  expiresAt: "2026-11-08T10:30:00.000Z",
  preview: [
    { type: "field", label: "Service", value: "github" },
    { type: "field", label: "Capability", value: "issues.create" },
    { type: "field", label: "Target", value: "acme/site" },
    { type: "text", label: "Arguments", text: ARGS },
    { type: "field", label: "Station", value: "station-7" },
    { type: "field", label: "Requested by", value: "prn_agent_31d0" },
  ],
  previewComplete: true,
};

/** Shared with the corpus entry (`variant: "approval-request"`). */
const APPROVAL_REQUEST: ElicitationPendingDelivery = {
  event: "elicitation.pending",
  boardId: "brd_7c1f",
  boardName: "Release board",
  cardId: "",
  cardTitle: "Approval request",
  elicitationId: "apr_5d2e9c41",
  runId: "",
  stageKey: "",
  agentId: "prn_agent_31d0",
  question: "Allow github issues.create on acme/site?",
  options: [
    { id: "allow_once", label: "Allow once", meaning: "approve", needsComment: false, scope: "once", requires: "workspace-admin" },
    { id: "deny", label: "Deny", meaning: "reject", needsComment: false, scope: "once" },
  ],
  approvalSubject: SUBJECT,
  approvalRequestId: "apr_5d2e9c41",
  ts: "2026-11-08T10:00:00.000Z",
};

function request(over: Partial<ElicitationPendingDelivery> = {}): ElicitationPendingDelivery {
  return {
    ...APPROVAL_REQUEST,
    boardId: `brd_apr_${RUN}`,
    elicitationId: `apr_${RUN}_${++n}`,
    approvalSubject: { ...SUBJECT, expiresAt: FUTURE },
    ...over,
  };
}

function rig(): { deps: ElicitationProjectionDeps; sent: Array<{ body: string; extra?: Record<string, unknown> }> } {
  const sent: Array<{ body: string; extra?: Record<string, unknown> }> = [];
  return {
    sent,
    deps: {
      boardRoom: async () => ({ roomId: ROOM, speakerMxid: SPEAKER }),
      boardBaseUrl: "https://superpipeline.dev",
      sendText: async (_u, _r, body, extra) => {
        sent.push({ body, extra });
        return `$apr-${RUN}-${++events}`;
      },
    },
  };
}

beforeAll(async () => {
  await ensurePgMigrations();
});

afterEach(async () => {
  await rawSql`DELETE FROM matrix_elicitation_events WHERE board_id = ${"brd_apr_" + RUN}`;
});

describe("a board-less approval request — the wire", () => {
  test("is recognised by its empty card or its approval request id", () => {
    expect(isApprovalRequest(APPROVAL_REQUEST)).toBe(true);
    expect(isApprovalRequest({ cardId: "", approvalRequestId: undefined })).toBe(true);
    expect(isApprovalRequest({ cardId: "crd_1", approvalRequestId: undefined })).toBe(false);
  });

  test("the prose says it is a SuperToolkit approval request and shows the request — no card, no stage, no link", () => {
    const body = String(questionV2Content(boundedQuestion(APPROVAL_REQUEST)).body);
    expect(body).toBe(
      [
        "A SuperToolkit approval request is waiting on a workspace owner or admin.",
        "Allow github issues.create on acme/site?",
        `Service: github\n\nCapability: issues.create\n\nTarget: acme/site\n\nArguments:\n\`\`\`\n${ARGS}\n\`\`\`\n\nStation: station-7\n\nRequested by: prn_agent_31d0`,
        "1. Allow once\n2. Deny",
        APPROVAL_REQUEST_NOTE,
      ].join("\n\n"),
    );
    expect(body).not.toContain("stage");
    expect(body).not.toContain("Open the card");
  });

  test("an incomplete preview says so in the prose, and allow_once is still listed for the board to refuse", () => {
    const cut = { ...APPROVAL_REQUEST, approvalSubject: { ...SUBJECT, previewComplete: false } };
    expect(String(questionV2Content(boundedQuestion(cut)).body)).toContain("could not be shown in full here");
  });

  test("question.v2 carries the subject, the options with who may take them, and the approval request id", () => {
    const c = questionV2Content(boundedQuestion(APPROVAL_REQUEST));
    expect(c).toMatchObject({
      suite_event_type: QUESTION_V2_SUITE_TYPE,
      elicitation_id: "apr_5d2e9c41",
      card_id: "",
      run_id: "",
      stage_key: "",
      approval_request_id: "apr_5d2e9c41",
      subject: { id: "stkreq_8f2c", digest: DIGEST, schema: "stk-capability/v1", preview_complete: true },
      options: [
        { id: "allow_once", meaning: "approve", scope: "once", requires: "workspace-admin" },
        { id: "deny", meaning: "reject", scope: "once" },
      ],
    });
    expect("deep_link" in c).toBe(false);
  });
});

describe("a board-less approval request — posted in the board's room", () => {
  test("posted once, with no deep link on the message or its v1 card", async () => {
    const d = request();
    const { deps, sent } = rig();
    expect((await projectElicitation(BOOTSTRAP_TENANT_ID, d, deps)).status).toBe("posted");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.extra).not.toHaveProperty("deep_link");
    expect(sent[0]?.extra?.[ELICITATION_REQUEST_CONTENT_KEY]).not.toHaveProperty("deep_link");
    expect(sent[0]?.body).not.toContain("/c/");
    expect(await recordedQuestion(d.elicitationId)).toMatchObject({ approvalRequest: true, subject: { id: "stkreq_8f2c", digest: DIGEST } });
  });
});

function typedRig(over: Partial<ElicitationAnswerDeps> = {}) {
  const replies: string[] = [];
  const answered: Array<Parameters<ElicitationAnswerDeps["answer"]>[0]> = [];
  const deps: ElicitationAnswerDeps = {
    principalForMatrixId: async () => ({ id: "prn_person", kind: "human" }),
    answer: async (input) => (answered.push(input), { ok: true }),
    reply: async (_r, body) => void replies.push(body),
    claimOutcome: claimElicitationOutcome,
    ...over,
  };
  return { deps, replies, answered };
}

describe("a typed reply to an approval request", () => {
  test("never allows it; a denial goes through bound, and the receipt says SuperToolkit has it", async () => {
    const d = request();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    const allow = typedRig();
    expect(await handleElicitationAnswer({ sender: HUMAN, body: "1" }, ROOM, allow.deps)).toEqual({ status: "refused", code: "SUBJECT_NOT_SHOWN" });
    expect(allow.answered).toHaveLength(0);
    expect(allow.replies).toEqual([TYPED_APPROVAL_REFUSED_TEXT]);

    const deny = typedRig();
    expect((await handleElicitationAnswer({ sender: HUMAN, body: "Deny" }, ROOM, deny.deps)).status).toBe("answered");
    expect(deny.answered[0]).toMatchObject({ option: "deny", subject: { id: "stkreq_8f2c", digest: DIGEST } });
    expect(deny.replies).toEqual(["Answered: Deny. SuperToolkit has the decision."]);
  });
});

function recorded(d: ElicitationPendingDelivery, eventId = "$aprEventId"): RecordedQuestion {
  return {
    boardId: d.boardId,
    approvalRequest: true,
    roomId: ROOM,
    eventId,
    options: questionOptionsV2(d),
    freeText: null,
    subject: { id: "stkreq_8f2c", digest: DIGEST, previewComplete: true, expiresAt: new Date(FUTURE) },
  };
}

function answerDeps(q: RecordedQuestion, over: Partial<QuestionAnswerDeps> = {}) {
  const answered: Array<Parameters<QuestionAnswerDeps["answer"]>[0]> = [];
  const replies: string[] = [];
  const deps: QuestionAnswerDeps = {
    principalForMatrixId: async () => ({ id: "prn_person", kind: "human" }),
    recordedQuestion: async () => q,
    answer: async (input) => (answered.push(input), { ok: true }),
    reply: async (_r, body) => (replies.push(body), null),
    claimOutcome: async () => true,
    ...over,
  };
  return { deps, answered, replies };
}

const answer = (over: Record<string, unknown> = {}) => ({
  msgtype: "m.text",
  body: "Allow once",
  suite_event_type: QUESTION_ANSWER_V2_SUITE_TYPE,
  elicitation_id: "apr_5d2e9c41",
  option_id: "allow_once",
  subject: { id: "stkreq_8f2c", digest: DIGEST },
  "m.relates_to": { rel_type: "m.reference", event_id: "$aprEventId" },
  ...over,
});

describe("question.answer.v2 on an approval request", () => {
  test("allow once reaches the board with its binding, and the receipt names SuperToolkit, not an agent", async () => {
    const { deps, answered, replies } = answerDeps(recorded(APPROVAL_REQUEST));
    expect((await handleQuestionAnswer({ sender: HUMAN, content: answer() }, ROOM, deps)).status).toBe("answered");
    expect(answered[0]).toMatchObject({ boardId: "brd_7c1f", elicitationId: "apr_5d2e9c41", option: "allow_once", subject: { id: "stkreq_8f2c", digest: DIGEST } });
    expect(replies).toEqual(["Answered: Allow once. SuperToolkit has the decision."]);
  });

  test("the board's refusals are said in plain words", async () => {
    const said: Record<string, string> = {
      WORKSPACE_ADMIN_REQUIRED: "Only workspace owners and admins can allow this. Nothing has changed.",
      SEPARATION_OF_DUTIES: "Whoever made a request can't also decide it. Someone else has to answer. Nothing has changed.",
      APPROVAL_SUBJECT_MISMATCH:
        "The board says that answer was for a different version of this decision. Open the latest one and answer again. Nothing has changed.",
      DECISION_EXPIRED: "The board says this decision has expired, so it can no longer be answered. Nothing has changed.",
    };
    for (const [code, text] of Object.entries(said)) {
      const { deps, replies } = answerDeps(recorded(APPROVAL_REQUEST), { answer: async () => ({ ok: false, code }) });
      const out = await handleQuestionAnswer({ sender: HUMAN, content: answer() }, ROOM, deps);
      expect(out).toEqual({ status: "refused", reason: "board-refused", code });
      expect(replies).toEqual([text]);
    }
  });

  test("ELICITATION_NOT_PENDING: already decided — said once", async () => {
    const { deps, replies } = answerDeps(recorded(APPROVAL_REQUEST), { answer: async () => ({ ok: false, code: "ELICITATION_NOT_PENDING" }) });
    await handleQuestionAnswer({ sender: HUMAN, content: answer() }, ROOM, deps);
    expect(replies).toEqual(["That one is already settled — the board has it."]);
  });
});

describe("only a person answers an approval request (review of #845)", () => {
  const AGENT = { id: "prn_agent_other", kind: "agent" as const };

  test("question.answer.v2 from another agent — even a bound deny — is refused quietly and never sent", async () => {
    for (const content of [answer({ option_id: "deny", body: "Deny" }), answer()]) {
      const { deps, answered, replies } = answerDeps(recorded(APPROVAL_REQUEST), { principalForMatrixId: async () => AGENT });
      expect(await handleQuestionAnswer({ sender: "@agent_other:id.example", content }, ROOM, deps)).toEqual({ status: "refused", reason: "not-human" });
      expect(answered).toHaveLength(0);
      expect(replies).toHaveLength(0);
    }
  });

  test("an agent's answer to an ordinary question is still the board's to judge", async () => {
    const { approvalRequest: _a, ...plain } = recorded(APPROVAL_REQUEST);
    const { deps, answered } = answerDeps(plain, { principalForMatrixId: async () => AGENT });
    expect((await handleQuestionAnswer({ sender: "@agent_other:id.example", content: answer({ option_id: "deny" }) }, ROOM, deps)).status).toBe("answered");
    expect(answered).toHaveLength(1);
  });

  test("a typed reply from another agent is refused quietly and never sent", async () => {
    await projectElicitation(BOOTSTRAP_TENANT_ID, request(), rig().deps);
    const { deps, answered, replies } = typedRig({ principalForMatrixId: async () => AGENT });
    expect(await handleElicitationAnswer({ sender: "@agent_other:id.example", body: "Deny" }, ROOM, deps)).toEqual({ status: "refused", code: "NOT_HUMAN" });
    expect(answered).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });
});

describe("an approval request with no subject the hub could carry is never allowed (review of #845)", () => {
  const { approvalSubject: _s, ...bare } = APPROVAL_REQUEST;

  test("allow_once is not offered: not in question.v2, the prose, the v1 card, or what a reply is matched against", async () => {
    for (const d of [bare, { ...APPROVAL_REQUEST, approvalSubject: { id: "x" } }]) {
      const c = questionV2Content(boundedQuestion(d));
      expect(questionOptionsV2(boundedQuestion(d)).map((o) => o.id)).toEqual(["deny"]);
      expect(c.options).toEqual(questionOptionsV2(boundedQuestion(d)));
      expect(String(c.body)).toContain("1. Deny");
      expect(String(c.body)).not.toContain("Allow once");
      expect(String(c.body)).toContain("could not be shown here, so it cannot be allowed");
    }
    const d = request({ approvalSubject: undefined });
    const { deps, sent } = rig();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, deps);
    expect(JSON.stringify(sent[0]?.extra?.[ELICITATION_REQUEST_CONTENT_KEY])).not.toContain("allow_once");
    const typed = typedRig();
    expect((await handleElicitationAnswer({ sender: HUMAN, body: "Allow once" }, ROOM, typed.deps)).status).toBe("unmatched");
    expect(typed.answered).toHaveLength(0);
  });

  test("an approve on a recorded approval request with no subject is refused in the hub, with the right words", async () => {
    const q: RecordedQuestion = { ...recorded(APPROVAL_REQUEST), subject: null };
    const allow = answerDeps(q);
    expect(await handleQuestionAnswer({ sender: HUMAN, content: answer({ subject: undefined }) }, ROOM, allow.deps)).toEqual({ status: "refused", reason: "approval-unbound" });
    expect(allow.answered).toHaveLength(0);
    expect(allow.replies).toEqual([APPROVAL_UNBOUND_TEXT]);
    const deny = answerDeps(q);
    expect((await handleQuestionAnswer({ sender: HUMAN, content: answer({ option_id: "deny", subject: undefined }) }, ROOM, deny.deps)).status).toBe("answered");
  });

  test("a typed approve, or a v1 button, on such a row is refused locally — not sent unbound", async () => {
    const d = request({ approvalSubject: undefined });
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    // A row recorded with allow_once regardless (as a client's v1 card could still send it).
    await db
      .update(matrixElicitationEvents)
      .set({ optionsJson: JSON.stringify([{ id: "allow_once", label: "Allow once" }, { id: "deny", label: "Deny" }]) })
      .where(eq(matrixElicitationEvents.elicitationId, d.elicitationId));
    const { deps, answered, replies } = typedRig();
    expect(await handleElicitationAnswer({ sender: HUMAN, body: "allow_once" }, ROOM, deps)).toEqual({ status: "refused", code: "APPROVAL_UNBOUND" });
    expect(answered).toHaveLength(0);
    expect(replies).toEqual([APPROVAL_UNBOUND_TEXT]);
  });
});

describe("one test of what an approval request is (review of #845)", () => {
  test("an apr_ id with a card still records as an approval request, and its receipt says so", async () => {
    const d = request({ cardId: "crd_odd" });
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    expect(await recordedQuestion(d.elicitationId)).toMatchObject({ approvalRequest: true });
  });
});

describe("a typed reply goes to the agent's question, not a newer approval request (review of #845)", () => {
  test("a 2 meant for the agent reaches the agent's question; alone, the approval request takes a typed deny", async () => {
    const asked: ElicitationPendingDelivery = {
      ...request(),
      elicitationId: `elc_apr_${RUN}_${++n}`,
      cardId: "crd_51d0",
      cardTitle: "Upgrade the build image",
      runId: "run_12",
      stageKey: "build",
      question: "Which image?",
      options: [
        { id: "alpine", label: "Alpine" },
        { id: "debian", label: "Debian" },
      ],
      approvalSubject: undefined,
      approvalRequestId: undefined,
    };
    await projectElicitation(BOOTSTRAP_TENANT_ID, asked, rig().deps);
    const apr = request();
    await projectElicitation(BOOTSTRAP_TENANT_ID, apr, rig().deps);
    const typed = typedRig();
    expect(await handleElicitationAnswer({ sender: HUMAN, body: "2" }, ROOM, typed.deps)).toEqual({ status: "answered", elicitationId: asked.elicitationId });
    expect(typed.answered[0]).toMatchObject({ elicitationId: asked.elicitationId, option: "debian" });
    const deny = typedRig();
    expect(await handleElicitationAnswer({ sender: HUMAN, body: "2" }, ROOM, deny.deps)).toEqual({ status: "answered", elicitationId: apr.elicitationId });
    expect(deny.answered[0]).toMatchObject({ option: "deny" });
  });
});

interface CorpusEvent {
  suiteEventType: string;
  variant?: string;
  accept: Array<{ why: string; content: Record<string, unknown> }>;
  reject: Array<{ why: string; content: Record<string, unknown> }>;
}

function corpusEvent(suiteEventType: string, variant: string): CorpusEvent | undefined {
  const corpus: unknown = JSON.parse(
    readFileSync(Bun.resolveSync("@superjackfruitlabs/treaty-ecosystem-identity/matrix_gate_events.json", import.meta.dir), "utf8"),
  );
  const list: CorpusEvent[] =
    typeof corpus === "object" && corpus !== null && "events" in corpus && Array.isArray(corpus.events) ? corpus.events : [];
  return list.find((e) => e.suiteEventType === suiteEventType && e.variant === variant);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The rules a board-less approval request's question.v2 keeps, as a consumer would check them. */
function keepsApprovalRules(c: Record<string, unknown>): boolean {
  return (
    c.card_id === "" &&
    typeof c.approval_request_id === "string" &&
    c.approval_request_id === c.elicitation_id &&
    !("deep_link" in c) &&
    isObj(c.subject) &&
    c.subject.schema === "stk-capability/v1" &&
    Array.isArray(c.options) &&
    c.options.every((o: unknown) => isObj(o) && (o.meaning !== "approve" || o.requires === "workspace-admin"))
  );
}

describe("an approval request against the shared corpus (variant approval-request)", () => {
  const asked = corpusEvent(QUESTION_V2_SUITE_TYPE, "approval-request");
  const answered = corpusEvent(QUESTION_ANSWER_V2_SUITE_TYPE, "approval-request");

  test("the hub's question.v2 for an stk-capability/v1 request is exactly what the corpus accepts", () => {
    expect(asked?.accept).toHaveLength(1);
    const { boardName: _n, ...d } = APPROVAL_REQUEST;
    expect(questionV2Content(boundedQuestion(d))).toEqual(asked?.accept[0]?.content ?? {});
  });

  test("every corpus reject breaks a rule the hub's output keeps", () => {
    const keeps = keepsApprovalRules;
    for (const { content } of asked?.accept ?? []) expect(keeps(content)).toBe(true);
    expect(asked?.reject.length).toBeGreaterThanOrEqual(3);
    for (const { why, content } of asked?.reject ?? []) expect(keeps(content), why).toBe(false);
  });

  test("every answer the corpus accepts is carried with its binding; every one it rejects is refused", async () => {
    expect(answered?.accept.length).toBeGreaterThanOrEqual(2);
    for (const { why, content } of answered?.accept ?? []) {
      const { deps, answered: sent } = answerDeps(recorded(APPROVAL_REQUEST));
      expect((await handleQuestionAnswer({ sender: HUMAN, content }, ROOM, deps)).status, why).toBe("answered");
      expect(sent[0]?.subject, why).toEqual({ id: "stkreq_8f2c", digest: DIGEST });
    }
    expect(answered?.reject.length).toBeGreaterThanOrEqual(3);
    for (const { why, content } of answered?.reject ?? []) {
      const { deps, answered: sent } = answerDeps(recorded(APPROVAL_REQUEST));
      expect((await handleQuestionAnswer({ sender: HUMAN, content }, ROOM, deps)).status, why).toBe("refused");
      expect(sent, why).toHaveLength(0);
    }
  });
});
