process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";

import { ELICITATION_REQUEST_CONTENT_KEY } from "@agentpod/contract";

import { db, rawSql } from "../../db/drizzle";
import { matrixElicitationEvents } from "../../db/schema/matrix";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { elicitationRequestCard, type ElicitationPendingDelivery } from "./elicitation-card";
import {
  TYPED_APPROVAL_REFUSED_TEXT,
  answerElicitationAtSuperpipeline,
  claimElicitationOutcome,
  handleElicitationAnswer,
  projectElicitation,
  recordedQuestion,
  reportAnswer,
  type ElicitationAnswerDeps,
  type ElicitationProjectionDeps,
} from "./elicitations";
import {
  QUESTION_ANSWER_V2_SUITE_TYPE,
  SUBJECT_QUESTION_NOTE,
  boundedQuestion,
  questionOptionsV2,
  questionSubjectV2,
  questionV2Content,
} from "./question-wire";
import { handleQuestionAnswer, type QuestionAnswerDeps, type RecordedQuestion } from "./question-answer";

/**
 * A question bound to a subject (charter: "Strict decisions and harness permissions bind their
 * subject" §1–4): a strict decision's operation, or a board-dispatched harness permission.
 *
 * question.v2 carries the subject in gate.v2's shape, re-bounded the same way, and options carry
 * their scope and who may take them. The subject's binding is recorded when the question is
 * posted, and every answer is judged against it: a structured answer must carry the same binding,
 * an approval is refused when the preview was incomplete, nothing is answered after the expiry,
 * and a typed reply never approves.
 */

const RUN = crypto.randomUUID().slice(0, 8);
const ROOM = `!strict-room-${RUN}:id.example`;
const SPEAKER = "@agent_superpipeline:id.example";
const HUMAN = "@person:id.example";
let n = 0;
const nextId = () => `elc_subj_${RUN}_${++n}`;
let events = 0;

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2001-01-01T00:00:00.000Z";

const SUBJECT = {
  id: "8f9a0d0e-4b2a-4c1e-9c55-1a2b3c4d5e6f",
  digest: "a4314f6971a17ca5db68d25d39220f7f2cdc94b6f2e9173d4ade28eb9e4a0e08",
  schema: "salaam-operation/v1",
  revision: 1,
  expiresAt: FUTURE,
  preview: [
    { type: "text", text: "Edit app.js in the workspace" },
    { type: "field", label: "File", value: "app.js · edit · 16 bytes" },
    { type: "text", text: "console.log(1);\n" },
  ],
  previewComplete: true,
};

function strict(over: Partial<ElicitationPendingDelivery> = {}): ElicitationPendingDelivery {
  return {
    event: "elicitation.pending",
    boardId: `brd_subj_${RUN}`,
    boardName: "Release board",
    cardId: "crd_51d0",
    cardTitle: "Upgrade the build image",
    elicitationId: nextId(),
    runId: "run_12",
    stageKey: "build",
    agentId: "agt_31d0",
    question: "Edit app.js in the workspace?",
    options: [
      { id: "approve", label: "Approve", meaning: "approve", needsComment: false, scope: "once" },
      { id: "approve-run", label: "Approve for this run", meaning: "approve", needsComment: false, scope: "run" },
      {
        id: "always",
        label: "Always allow",
        meaning: "approve",
        needsComment: false,
        scope: "always",
        requires: "workspace-admin",
      },
      { id: "deny", label: "Deny", meaning: "reject", needsComment: false, scope: "once" },
    ],
    approvalSubject: SUBJECT,
    ts: "2026-11-07T10:00:00.000Z",
    ...over,
  };
}

function rig(): { deps: ElicitationProjectionDeps; sent: Array<{ body: string; extra?: Record<string, unknown> }> } {
  const sent: Array<{ body: string; extra?: Record<string, unknown> }> = [];
  return {
    sent,
    deps: {
      boardRoom: async () => ({ roomId: ROOM, speakerMxid: SPEAKER }),
      sendText: async (_u, _r, body, extra) => {
        sent.push({ body, extra });
        return `$subj-${RUN}-${++events}`;
      },
    },
  };
}

beforeAll(async () => {
  await ensurePgMigrations();
});

afterEach(async () => {
  await rawSql`DELETE FROM matrix_elicitation_events WHERE elicitation_id LIKE ${"elc_subj_" + RUN + "%"}`;
});

describe("question.v2 with a subject — the wire", () => {
  test("carries the subject in gate.v2's snake_case shape, and each option's scope and who may take it", () => {
    const d = strict();
    const content = questionV2Content(boundedQuestion(d));
    expect(content.subject).toEqual({
      id: SUBJECT.id,
      digest: SUBJECT.digest,
      schema: "salaam-operation/v1",
      revision: 1,
      expires_at: FUTURE,
      preview: SUBJECT.preview,
      preview_complete: true,
    });
    expect(content.options).toEqual([
      { id: "approve", label: "Approve", meaning: "approve", needs_comment: false, scope: "once" },
      { id: "approve-run", label: "Approve for this run", meaning: "approve", needs_comment: false, scope: "run" },
      {
        id: "always",
        label: "Always allow",
        meaning: "approve",
        needs_comment: false,
        scope: "always",
        requires: "workspace-admin",
      },
      { id: "deny", label: "Deny", meaning: "reject", needs_comment: false, scope: "once" },
    ]);
  });

  test("an unknown scope or requirement is not carried", () => {
    const d = strict({ options: [{ id: "x", label: "X", meaning: "reject", scope: "forever", requires: "root" }] });
    expect(questionOptionsV2(d)).toEqual([{ id: "x", label: "X", meaning: "reject", needs_comment: false }]);
  });

  test("the prose tells a stock client a reply can only decline it", () => {
    const body = String(questionV2Content(strict()).body);
    expect(body).toContain("1. Approve");
    expect(body).toContain(SUBJECT_QUESTION_NOTE);
    // An ordinary question's prose is unchanged.
    const { approvalSubject: _none, ...plain } = strict();
    expect(String(questionV2Content(plain).body)).not.toContain(SUBJECT_QUESTION_NOTE);
  });

  test("a preview this hub had to cut is carried as incomplete", () => {
    const d = strict({
      approvalSubject: { ...SUBJECT, preview: [{ type: "text", text: "x".repeat(5000) }], previewComplete: true },
    });
    expect(questionSubjectV2(d)?.preview_complete).toBe(false);
  });

  test("a subject this hub cannot carry withholds every approving option, and the question carries no subject", () => {
    const d = strict({ approvalSubject: { id: SUBJECT.id } });
    expect(questionSubjectV2(d)).toBeNull();
    expect(questionOptionsV2(d).map((o) => o.id)).toEqual(["deny"]);
    expect(questionV2Content(d)).not.toHaveProperty("subject");
  });

  test("a question with a subject still fits one event at its worst", () => {
    const long = "語".repeat(50_000);
    const d = boundedQuestion(
      strict({
        cardTitle: long,
        question: long,
        options: Array.from({ length: 60 }, (_, i) => ({ id: `o_${i}`, label: long, meaning: "reject" })),
        approvalSubject: { ...SUBJECT, preview: Array.from({ length: 40 }, () => ({ type: "text", label: long, text: long })) },
      }),
    );
    const { body, ...v2 } = questionV2Content(d, "https://board.example/b/x/c/y");
    const content = { ...v2, body, [ELICITATION_REQUEST_CONTENT_KEY]: elicitationRequestCard(d) };
    expect(new TextEncoder().encode(JSON.stringify(content)).length).toBeLessThan(56_000);
  });
});

describe("question.v2 with a subject — recorded when posted", () => {
  test("the binding, its preview completeness and its expiry are recorded with the question", async () => {
    const d = strict();
    const { deps, sent } = rig();
    expect((await projectElicitation(BOOTSTRAP_TENANT_ID, d, deps)).status).toBe("posted");
    expect(sent[0]?.extra?.subject).toMatchObject({ id: SUBJECT.id, digest: SUBJECT.digest });
    const [row] = await db
      .select()
      .from(matrixElicitationEvents)
      .where(eq(matrixElicitationEvents.elicitationId, d.elicitationId));
    expect(row?.approvalSubjectId).toBe(SUBJECT.id);
    expect(row?.approvalSubjectDigest).toBe(SUBJECT.digest);
    expect(row?.approvalSubjectPreviewComplete).toBe(true);
    expect(row?.approvalSubjectExpiresAt?.toISOString()).toBe(FUTURE);
    expect((await recordedQuestion(d.elicitationId))?.subject).toEqual({
      id: SUBJECT.id,
      digest: SUBJECT.digest,
      previewComplete: true,
      expiresAt: new Date(FUTURE),
    });
  });

  test("a question with no subject records none", async () => {
    const { approvalSubject: _none, ...plain } = strict();
    await projectElicitation(BOOTSTRAP_TENANT_ID, plain, rig().deps);
    expect((await recordedQuestion(plain.elicitationId))?.subject).toBeNull();
  });
});

const QUESTION_EVENT = "$strictQuestion";

function recorded(d: ElicitationPendingDelivery, over: Partial<RecordedQuestion> = {}): RecordedQuestion {
  return {
    boardId: d.boardId,
    roomId: ROOM,
    eventId: QUESTION_EVENT,
    options: questionOptionsV2(d),
    freeText: null,
    subject: { id: SUBJECT.id, digest: SUBJECT.digest, previewComplete: true, expiresAt: new Date(FUTURE) },
    ...over,
  };
}

function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msgtype: "m.text",
    body: "Approve",
    schema_version: 1,
    suite_event_type: QUESTION_ANSWER_V2_SUITE_TYPE,
    elicitation_id: "elc_strict",
    option_id: "approve",
    subject: { id: SUBJECT.id, digest: SUBJECT.digest },
    "m.relates_to": { rel_type: "m.reference", event_id: QUESTION_EVENT },
    ...over,
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

describe("question.answer.v2 on a subject-bound question", () => {
  test("an approval carrying the recorded binding reaches the board with it", async () => {
    const { deps, answered } = answerDeps(recorded(strict()));
    const out = await handleQuestionAnswer({ sender: HUMAN, content: answer() }, ROOM, deps);
    expect(out.status).toBe("answered");
    expect(answered[0]).toMatchObject({ option: "approve", subject: { id: SUBJECT.id, digest: SUBJECT.digest } });
  });

  test("a decline carrying the binding reaches the board with it", async () => {
    const { deps, answered } = answerDeps(recorded(strict()));
    const out = await handleQuestionAnswer({ sender: HUMAN, content: answer({ option_id: "deny" }) }, ROOM, deps);
    expect(out.status).toBe("answered");
    expect(answered[0]).toMatchObject({ option: "deny", subject: { id: SUBJECT.id, digest: SUBJECT.digest } });
  });

  test("an answer without the binding is refused, said in the room, and never reaches the board", async () => {
    for (const option_id of ["approve", "deny"]) {
      const { deps, answered, replies } = answerDeps(recorded(strict()));
      const out = await handleQuestionAnswer({ sender: HUMAN, content: answer({ option_id, subject: undefined }) }, ROOM, deps);
      expect(out).toEqual({ status: "refused", reason: "subject-missing" });
      expect(answered).toHaveLength(0);
      expect(replies).toHaveLength(1);
    }
  });

  test("a binding that is not the recorded one is refused — a different digest, or a different id", async () => {
    for (const subject of [
      { id: SUBJECT.id, digest: "0".repeat(64) },
      { id: "another", digest: SUBJECT.digest },
    ]) {
      for (const option_id of ["approve", "deny"]) {
        const { deps, answered } = answerDeps(recorded(strict()));
        const out = await handleQuestionAnswer({ sender: HUMAN, content: answer({ option_id, subject }) }, ROOM, deps);
        expect(out).toEqual({ status: "refused", reason: "subject-mismatch" });
        expect(answered).toHaveLength(0);
      }
    }
  });

  test("any answer after the subject expired is refused", async () => {
    const q = recorded(strict(), {
      subject: { id: SUBJECT.id, digest: SUBJECT.digest, previewComplete: true, expiresAt: new Date(PAST) },
    });
    for (const option_id of ["approve", "deny"]) {
      const { deps, answered } = answerDeps(q);
      const out = await handleQuestionAnswer({ sender: HUMAN, content: answer({ option_id }) }, ROOM, deps);
      expect(out).toEqual({ status: "refused", reason: "expired" });
      expect(answered).toHaveLength(0);
    }
  });

  test("on an incomplete preview an approval is refused and a decline still goes through", async () => {
    const q = recorded(strict(), {
      subject: { id: SUBJECT.id, digest: SUBJECT.digest, previewComplete: false, expiresAt: new Date(FUTURE) },
    });
    const refused = answerDeps(q);
    expect(await handleQuestionAnswer({ sender: HUMAN, content: answer() }, ROOM, refused.deps)).toEqual({
      status: "refused",
      reason: "preview-incomplete",
    });
    expect(refused.answered).toHaveLength(0);
    const declined = answerDeps(q);
    expect((await handleQuestionAnswer({ sender: HUMAN, content: answer({ option_id: "deny" }) }, ROOM, declined.deps)).status).toBe(
      "answered",
    );
  });

  test("a question bound to nothing ignores a binding and passes none", async () => {
    const { approvalSubject: _none, ...plain } = strict();
    const { deps, answered } = answerDeps(recorded(plain, { subject: null }));
    expect((await handleQuestionAnswer({ sender: HUMAN, content: answer() }, ROOM, deps)).status).toBe("answered");
    expect(answered[0]).not.toHaveProperty("subject");
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

describe("a typed reply to a subject-bound question", () => {
  test("never approves: a number, a label or an id that approves is refused with a pointer to the app", async () => {
    const d = strict();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    for (const body of ["1", "Approve for this run", "always"]) {
      const { deps, replies, answered } = typedRig();
      const out = await handleElicitationAnswer({ sender: HUMAN, body }, ROOM, deps);
      expect(out).toEqual({ status: "refused", code: "SUBJECT_NOT_SHOWN" });
      expect(answered).toHaveLength(0);
      expect(replies).toEqual([TYPED_APPROVAL_REFUSED_TEXT]);
    }
  });

  test("a decline goes through, bound to the version recorded when the question was posted", async () => {
    const d = strict();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    const { deps, answered } = typedRig();
    const out = await handleElicitationAnswer({ sender: HUMAN, body: "4" }, ROOM, deps);
    expect(out).toEqual({ status: "answered", elicitationId: d.elicitationId });
    expect(answered[0]).toMatchObject({ option: "deny", subject: { id: SUBJECT.id, digest: SUBJECT.digest } });
  });

  test("after the subject expired even a decline is refused, and the board is not called", async () => {
    const d = strict({ approvalSubject: { ...SUBJECT, expiresAt: PAST } });
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    const { deps, answered, replies } = typedRig();
    const out = await handleElicitationAnswer({ sender: HUMAN, body: "Deny" }, ROOM, deps);
    expect(out).toEqual({ status: "refused", code: "DECISION_EXPIRED" });
    expect(answered).toHaveLength(0);
    expect(replies[0]).toMatch(/expired/);
  });

  test("an ordinary question's typed approval is unchanged", async () => {
    const { approvalSubject: _none, ...plain } = strict();
    await projectElicitation(BOOTSTRAP_TENANT_ID, plain, rig().deps);
    const { deps, answered } = typedRig();
    expect((await handleElicitationAnswer({ sender: HUMAN, body: "1" }, ROOM, deps)).status).toBe("answered");
    expect(answered[0]).not.toHaveProperty("subject");
  });
});

describe("the binding reaches the board's answer route", () => {
  test("the subject is posted beside the option", async () => {
    const bodies: unknown[] = [];
    await answerElicitationAtSuperpipeline(
      {
        boardId: "brd_x",
        elicitationId: "elc_y",
        option: "deny",
        subject: { id: SUBJECT.id, digest: SUBJECT.digest },
        principalId: "prn_h",
        senderMxid: HUMAN,
      },
      {
        baseUrl: "https://board.test",
        mint: async () => "assertion",
        fetch: Object.assign(
          async (_url: string | URL | Request, init?: RequestInit) => {
            bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : null);
            return new Response("{}", { status: 200 });
          },
          { preconnect: fetch.preconnect },
        ),
      },
    );
    expect(bodies).toEqual([{ option: "deny", subject: { id: SUBJECT.id, digest: SUBJECT.digest } }]);
  });

  test("the board's refusals of a binding are said in words", async () => {
    for (const [code, words] of [
      ["APPROVAL_SUBJECT_MISMATCH", /different version/],
      ["DECISION_EXPIRED", /expired/],
    ] as const) {
      const replies: string[] = [];
      await reportAnswer({ ok: false, code }, "elc_x", "Deny", ROOM, {
        reply: async (_r, body) => void replies.push(body),
        claimOutcome: async () => true,
      });
      expect(replies[0]).toMatch(words);
    }
  });
});

// ── The shared corpus (fixture version 5) ────────────────────────────────────

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
const SUBJECT_KEYS = ["digest", "expires_at", "id", "preview", "preview_complete", "revision", "schema"];

/** The rules a subject-bound question.v2 keeps, as a consumer would check them. */
function wellFormedSubjectQuestion(c: Record<string, unknown>): boolean {
  const s = c.subject;
  if (!isObj(s) || Object.keys(s).toSorted().join() !== SUBJECT_KEYS.join()) return false;
  if (typeof s.id !== "string" || typeof s.digest !== "string" || typeof s.preview_complete !== "boolean") return false;
  if (!Array.isArray(c.options)) return false;
  return c.options.every(
    (o) =>
      isObj(o) &&
      (o.scope === undefined || o.scope === "once" || o.scope === "run" || o.scope === "always") &&
      (o.requires === undefined || o.requires === "workspace-admin"),
  );
}

describe("subject-bound question.v2 against the shared corpus", () => {
  const asked = corpusEvent("dev.superpipeline.question.v2", "subject-bound");
  const answered = corpusEvent("dev.superpipeline.question.answer.v2", "subject-bound");
  const fixtureQuestion = strict({
    elicitationId: "elc_9b44",
    boardId: "brd_7c1f",
    question: "Edit app.js in the workspace?",
    approvalSubject: { ...SUBJECT, digest: "0588c96c7eff47e1a83d9fc1d0ecda3cc3b72e559a5c402bb9da29d9851dbceb", expiresAt: "2026-11-07T10:30:00.000Z" },
  });

  test("the hub's question.v2 for a strict decision is exactly what the corpus accepts", () => {
    expect(asked?.accept).toHaveLength(1);
    const { boardName: _n, ...d } = fixtureQuestion;
    expect(questionV2Content(boundedQuestion(d), "https://superpipeline.dev/b/brd_7c1f/c/crd_51d0")).toEqual(asked?.accept[0]?.content ?? {});
  });

  test("every subject-bound question.v2 the corpus rejects breaks a rule the hub's output keeps", () => {
    for (const { content } of asked?.accept ?? []) expect(wellFormedSubjectQuestion(content)).toBe(true);
    expect(asked?.reject.length).toBeGreaterThanOrEqual(3);
    for (const { why, content } of asked?.reject ?? []) expect(wellFormedSubjectQuestion(content), why).toBe(false);
  });

  const corpusRecorded = (): RecordedQuestion => ({
    boardId: "brd_7c1f",
    roomId: ROOM,
    eventId: "$questionEventId",
    options: questionOptionsV2(fixtureQuestion),
    freeText: null,
    subject: { id: SUBJECT.id, digest: "0588c96c7eff47e1a83d9fc1d0ecda3cc3b72e559a5c402bb9da29d9851dbceb", previewComplete: true, expiresAt: new Date(FUTURE) },
  });

  test("every subject-bound answer the corpus accepts is carried with its binding; every one it rejects is refused", async () => {
    expect(answered?.accept.length).toBeGreaterThanOrEqual(2);
    for (const { why, content } of answered?.accept ?? []) {
      const { deps, answered: sent } = answerDeps(corpusRecorded());
      expect((await handleQuestionAnswer({ sender: HUMAN, content }, ROOM, deps)).status, why).toBe("answered");
      expect(sent[0]?.subject, why).toEqual({ id: SUBJECT.id, digest: "0588c96c7eff47e1a83d9fc1d0ecda3cc3b72e559a5c402bb9da29d9851dbceb" });
    }
    expect(answered?.reject.length).toBeGreaterThanOrEqual(3);
    for (const { why, content } of answered?.reject ?? []) {
      const { deps, answered: sent } = answerDeps(corpusRecorded());
      expect((await handleQuestionAnswer({ sender: HUMAN, content }, ROOM, deps)).status, why).toBe("refused");
      expect(sent, why).toHaveLength(0);
    }
  });
});
