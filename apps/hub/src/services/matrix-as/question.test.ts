import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ELICITATION_REQUEST_CONTENT_KEY } from "@agentpod/contract";

import { elicitationRequestCard, type ElicitationPendingDelivery } from "./elicitation-card";
import { answerElicitationAtSuperpipeline } from "./elicitations";
import {
  QUESTION_ANSWER_V2_SUITE_TYPE,
  QUESTION_V2_SUITE_TYPE,
  boundedQuestion,
  questionFreeTextV2,
  questionOptionsV2,
  questionV2Content,
} from "./question-wire";
import {
  handleQuestionAnswer,
  parseQuestionAnswer,
  type QuestionAnswerDeps,
  type RecordedQuestion,
} from "./question-answer";

/**
 * question.v2 — an agent's question in the decision envelope (charter: "The decision envelope
 * covers questions and follow-ups" §2).
 *
 * The question's prose message keeps its v1 card exactly as before and also carries
 * `dev.superpipeline.question.v2`: options that say what they mean, an option's input, and
 * `free_text` on a question with no options. A `question.answer.v2` is judged against the
 * options RECORDED for that question when it was posted, never against a list.
 */

const QUESTION_EVENT_ID = "$questionEventId";
const ROOM = "!board-room:id.example";

const ASKED: ElicitationPendingDelivery = {
  event: "elicitation.pending",
  boardId: "brd_7c1f",
  boardName: "Release board",
  cardId: "crd_51d0",
  cardTitle: "Upgrade the build image",
  elicitationId: "elc_7f3c",
  runId: "run_12",
  stageKey: "build",
  agentId: "agt_31d0",
  question: "The tests need network access. May I run them?",
  options: [
    { id: "run_them", label: "Run the tests", meaning: "choose", needsComment: false },
    { id: "skip", label: "Skip them", meaning: "choose", needsComment: false },
  ],
  ts: "2026-11-07T10:00:00.000Z",
};

const OPEN: ElicitationPendingDelivery = {
  ...ASKED,
  elicitationId: "elc_8a21",
  question: "Which branch should I base the fix on?",
  options: [],
  freeText: { maxLength: 2000 },
};

describe("question.v2 — the options a question offers", () => {
  test("carries each option with what it means; an older board's bare option means choose", () => {
    expect(questionOptionsV2(ASKED)).toEqual([
      { id: "run_them", label: "Run the tests", meaning: "choose", needs_comment: false },
      { id: "skip", label: "Skip them", meaning: "choose", needs_comment: false },
    ]);
    const older: ElicitationPendingDelivery = { ...ASKED, options: [{ id: "run_them", label: "Run the tests" }] };
    expect(questionOptionsV2(older)).toEqual([
      { id: "run_them", label: "Run the tests", meaning: "choose", needs_comment: false },
    ]);
  });

  test("keeps a strict decision's approve and reject meanings", () => {
    const strict: ElicitationPendingDelivery = {
      ...ASKED,
      options: [
        { id: "allow_once", label: "Allow once", meaning: "approve", needsComment: false },
        { id: "deny", label: "Deny", meaning: "reject", needsComment: false },
      ],
    };
    expect(questionOptionsV2(strict).map((o) => o.meaning)).toEqual(["approve", "reject"]);
  });

  test("an option's input goes on the Matrix wire in snake_case, bounded", () => {
    const withInput: ElicitationPendingDelivery = {
      ...ASKED,
      options: [
        {
          id: "other",
          label: "Something else",
          meaning: "choose",
          needsComment: false,
          input: { kind: "text", label: "What then?", required: true, maxLength: 9_999_999 },
        },
      ],
    };
    expect(questionOptionsV2(withInput)).toEqual([
      {
        id: "other",
        label: "Something else",
        meaning: "choose",
        needs_comment: false,
        input: { kind: "text", label: "What then?", required: true, max_length: 4000 },
      },
    ]);
  });

  test("drops an option with no usable id and a repeated id, and an unknown meaning falls back to choose", () => {
    const messy: ElicitationPendingDelivery = {
      ...ASKED,
      options: [
        { id: "", label: "Nothing" },
        { id: "run_them", label: "Run the tests", meaning: "ship-it" },
        { id: "run_them", label: "Run them again" },
      ],
    };
    expect(questionOptionsV2(messy)).toEqual([
      { id: "run_them", label: "Run the tests", meaning: "choose", needs_comment: false },
    ]);
  });

  test("a question with no options is answered by typing, at most the board's limit and never past 2000", () => {
    expect(questionFreeTextV2(OPEN)).toEqual({ max_length: 2000 });
    expect(questionFreeTextV2({ ...OPEN, freeText: { maxLength: 500 } })).toEqual({ max_length: 500 });
    expect(questionFreeTextV2({ ...OPEN, freeText: { maxLength: 50_000 } })).toEqual({ max_length: 2000 });
    // An older board says nothing; its answer route still takes text.
    const { freeText: _older, ...older } = OPEN;
    expect(questionFreeTextV2(older)).toEqual({ max_length: 2000 });
    expect(questionFreeTextV2(ASKED)).toBeNull();
  });
});

describe("question.v2 — the content on the question's prose message", () => {
  test("carries the question, the card fields and the options beside the unchanged v1 card", () => {
    const content = questionV2Content(ASKED, "https://board.example/b/brd_7c1f/c/crd_51d0");
    expect(content).toMatchObject({
      msgtype: "m.text",
      suite_event_type: QUESTION_V2_SUITE_TYPE,
      schema_version: 1,
      elicitation_id: "elc_7f3c",
      board_id: "brd_7c1f",
      card_id: "crd_51d0",
      run_id: "run_12",
      stage_key: "build",
      card_title: "Upgrade the build image",
      asked_by: "agt_31d0",
      question: "The tests need network access. May I run them?",
      options: questionOptionsV2(ASKED),
      deep_link: "https://board.example/b/brd_7c1f/c/crd_51d0",
    });
    expect(content).not.toHaveProperty("free_text");
    expect(String(content.body)).toContain("1. Run the tests");
  });

  test("a question with no options carries free_text and no option", () => {
    const content = questionV2Content(OPEN);
    expect(content.options).toEqual([]);
    expect(content.free_text).toEqual({ max_length: 2000 });
    expect(content).not.toHaveProperty("deep_link");
  });

  test("the v1 card stays {id, label} only, even when the board sends the envelope's fields", () => {
    const card = elicitationRequestCard(ASKED);
    expect(card.options).toEqual([
      { id: "run_them", label: "Run the tests" },
      { id: "skip", label: "Skip them" },
    ]);
  });

  test("a question that would overflow an event still fits one", () => {
    const long = "語".repeat(50_000);
    const huge: ElicitationPendingDelivery = {
      ...ASKED,
      cardTitle: long,
      question: long,
      options: Array.from({ length: 60 }, (_, i) => ({
        id: `option_${i}_${"x".repeat(150)}`,
        label: long,
        input: { kind: "text", label: long, required: false, maxLength: 2000 },
      })),
    };
    const d = boundedQuestion(huge);
    const { body, ...v2 } = questionV2Content(d, "https://board.example/b/brd_7c1f/c/crd_51d0");
    const content = { ...v2, body, [ELICITATION_REQUEST_CONTENT_KEY]: elicitationRequestCard(d) };
    const bytes = new TextEncoder().encode(JSON.stringify(content)).length;
    expect(bytes).toBeLessThan(48_000);
    expect(questionOptionsV2(d).length).toBeGreaterThan(0);
  });

  test("bounding leaves an ordinary question exactly as the board sent it", () => {
    expect(boundedQuestion(ASKED)).toEqual(ASKED);
    expect(boundedQuestion(OPEN)).toEqual(OPEN);
  });
});

function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msgtype: "m.text",
    body: "Run the tests",
    schema_version: 1,
    suite_event_type: QUESTION_ANSWER_V2_SUITE_TYPE,
    elicitation_id: "elc_7f3c",
    option_id: "run_them",
    "m.relates_to": { rel_type: "m.reference", event_id: QUESTION_EVENT_ID },
    ...over,
  };
}

function recorded(d: ElicitationPendingDelivery): RecordedQuestion {
  return {
    boardId: d.boardId,
    roomId: ROOM,
    eventId: QUESTION_EVENT_ID,
    options: questionOptionsV2(d),
    freeText: questionFreeTextV2(d),
  };
}

function answerDeps(over: Partial<QuestionAnswerDeps> = {}) {
  const answered: Array<Parameters<QuestionAnswerDeps["answer"]>[0]> = [];
  const replies: string[] = [];
  const deps: QuestionAnswerDeps = {
    principalForMatrixId: async () => ({ id: "prn_person", kind: "human" }),
    recordedQuestion: async (id) => (id === ASKED.elicitationId ? recorded(ASKED) : id === OPEN.elicitationId ? recorded(OPEN) : null),
    answer: async (input) => {
      answered.push(input);
      return { ok: true };
    },
    reply: async (_room, body) => {
      replies.push(body);
      return null;
    },
    claimOutcome: async () => true,
    ...over,
  };
  return { deps, answered, replies };
}

describe("question.answer.v2 — reading an answer", () => {
  test("reads the question, the option, the text and the reference", () => {
    expect(parseQuestionAnswer(answer({ text: "  with network  " }))).toEqual({
      elicitationId: "elc_7f3c",
      optionId: "run_them",
      text: "with network",
      referencedEventId: QUESTION_EVENT_ID,
    });
  });

  test("is not an answer without the suite type or the question's id", () => {
    expect(parseQuestionAnswer(answer({ suite_event_type: "dev.superpipeline.gate.decision.v2" }))).toBeNull();
    expect(parseQuestionAnswer(answer({ elicitation_id: "" }))).toBeNull();
    expect(parseQuestionAnswer("nope")).toBeNull();
  });

  test("a quoted reply is not a reference", () => {
    const p = parseQuestionAnswer(answer({ "m.relates_to": { "m.in_reply_to": { event_id: QUESTION_EVENT_ID } } }));
    expect(p?.referencedEventId).toBeNull();
  });
});

describe("question.answer.v2 — acting on an answer", () => {
  test("an offered option is passed to the board as the person who chose it", async () => {
    const { deps, answered, replies } = answerDeps();
    const out = await handleQuestionAnswer({ sender: "@person:id.example", content: answer() }, ROOM, deps);
    expect(out).toEqual({ status: "answered", elicitationId: "elc_7f3c" });
    expect(answered).toEqual([
      { boardId: "brd_7c1f", elicitationId: "elc_7f3c", option: "run_them", principalId: "prn_person", senderMxid: "@person:id.example" },
    ]);
    expect(replies).toEqual(["Answered: Run the tests. The agent is unblocked."]);
  });

  test("a free-text answer is passed as text, with no option", async () => {
    const { deps, answered } = answerDeps();
    const content = answer({ elicitation_id: "elc_8a21", option_id: undefined, text: "main" });
    const out = await handleQuestionAnswer({ sender: "@person:id.example", content }, ROOM, deps);
    expect(out).toEqual({ status: "answered", elicitationId: "elc_8a21" });
    expect(answered[0]).toMatchObject({ elicitationId: "elc_8a21", text: "main" });
    expect(answered[0]).not.toHaveProperty("option");
  });

  test("an option with an input passes both the option and the text", async () => {
    const withInput: ElicitationPendingDelivery = {
      ...ASKED,
      options: [{ id: "other", label: "Something else", input: { kind: "text", label: "What then?", required: true, maxLength: 100 } }],
    };
    const { deps, answered } = answerDeps({ recordedQuestion: async () => recorded(withInput) });
    const out = await handleQuestionAnswer(
      { sender: "@person:id.example", content: answer({ option_id: "other", text: "Run only the unit tests" }) },
      ROOM,
      deps,
    );
    expect(out.status).toBe("answered");
    expect(answered[0]).toMatchObject({ option: "other", text: "Run only the unit tests" });
  });

  test("an option the question did not offer is refused, said in the room, and never reaches the board", async () => {
    const { deps, answered, replies } = answerDeps();
    const out = await handleQuestionAnswer({ sender: "@person:id.example", content: answer({ option_id: "ship_it" }) }, ROOM, deps);
    expect(out).toEqual({ status: "refused", reason: "bad-option" });
    expect(answered).toHaveLength(0);
    expect(replies).toHaveLength(1);
  });

  test("a question posted before options were recorded refuses a v2 answer", async () => {
    const { deps, answered } = answerDeps({ recordedQuestion: async () => ({ ...recorded(ASKED), options: null }) });
    const out = await handleQuestionAnswer({ sender: "@person:id.example", content: answer() }, ROOM, deps);
    expect(out).toEqual({ status: "refused", reason: "bad-option" });
    expect(answered).toHaveLength(0);
  });

  test("an empty required input is refused", async () => {
    const withInput: ElicitationPendingDelivery = {
      ...ASKED,
      options: [{ id: "other", label: "Something else", input: { kind: "text", label: "What then?", required: true, maxLength: 100 } }],
    };
    const { deps, answered } = answerDeps({ recordedQuestion: async () => recorded(withInput) });
    for (const text of [undefined, "", "   "]) {
      const out = await handleQuestionAnswer({ sender: "@person:id.example", content: answer({ option_id: "other", text }) }, ROOM, deps);
      expect(out).toEqual({ status: "refused", reason: "input-required" });
    }
    expect(answered).toHaveLength(0);
  });

  test("empty free text and free text over the limit are refused", async () => {
    const { deps, answered } = answerDeps({
      recordedQuestion: async () => ({ ...recorded(OPEN), freeText: { max_length: 10 } }),
    });
    const base = { elicitation_id: "elc_8a21", option_id: undefined };
    expect(await handleQuestionAnswer({ sender: "@p:id.example", content: answer({ ...base, text: " " }) }, ROOM, deps)).toEqual({
      status: "refused",
      reason: "input-required",
    });
    expect(
      await handleQuestionAnswer({ sender: "@p:id.example", content: answer({ ...base, text: "x".repeat(11) }) }, ROOM, deps),
    ).toEqual({ status: "refused", reason: "text-too-long" });
    expect(answered).toHaveLength(0);
  });

  test("text alone on a question with options is refused: it is answered by choosing", async () => {
    const { deps, answered } = answerDeps();
    const out = await handleQuestionAnswer(
      { sender: "@p:id.example", content: answer({ option_id: undefined, text: "yes" }) },
      ROOM,
      deps,
    );
    expect(out).toEqual({ status: "refused", reason: "bad-option" });
    expect(answered).toHaveLength(0);
  });

  test("an answer whose reference is not the question's message, or from another room, is refused silently", async () => {
    const { deps, answered, replies } = answerDeps();
    const elsewhere = answer({ "m.relates_to": { rel_type: "m.reference", event_id: "$somethingElse" } });
    expect(await handleQuestionAnswer({ sender: "@p:id.example", content: elsewhere }, ROOM, deps)).toEqual({
      status: "refused",
      reason: "reference-mismatch",
    });
    expect(await handleQuestionAnswer({ sender: "@p:id.example", content: answer() }, "!other:id.example", deps)).toEqual({
      status: "refused",
      reason: "reference-mismatch",
    });
    const { "m.relates_to": _none, ...unreferenced } = answer();
    expect(await handleQuestionAnswer({ sender: "@p:id.example", content: unreferenced }, ROOM, deps)).toEqual({
      status: "refused",
      reason: "reference-mismatch",
    });
    expect(answered).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  test("an unlinked sender is refused silently, and a question this hub never posted is unknown", async () => {
    const unlinked = answerDeps({ principalForMatrixId: async () => null });
    expect(await handleQuestionAnswer({ sender: "@stranger:id.example", content: answer() }, ROOM, unlinked.deps)).toEqual({
      status: "refused",
      reason: "unlinked-sender",
    });
    expect(unlinked.answered).toHaveLength(0);
    expect(unlinked.replies).toHaveLength(0);

    const { deps, answered } = answerDeps();
    expect(
      await handleQuestionAnswer({ sender: "@p:id.example", content: answer({ elicitation_id: "elc_unknown" }) }, ROOM, deps),
    ).toEqual({ status: "refused", reason: "unknown-question" });
    expect(answered).toHaveLength(0);
  });

  test("the org plane down is said in the room, and nothing reaches the board", async () => {
    const { deps, answered, replies } = answerDeps({
      principalForMatrixId: async () => {
        throw new Error("plane down");
      },
    });
    const out = await handleQuestionAnswer({ sender: "@p:id.example", content: answer() }, ROOM, deps);
    expect(out).toEqual({ status: "refused", reason: "identity-unavailable" });
    expect(answered).toHaveLength(0);
    expect(replies).toHaveLength(1);
  });

  test("a board that says the question is over is told once, and the answer is refused", async () => {
    const { deps, replies } = answerDeps({ answer: async () => ({ ok: false, code: "ELICITATION_NOT_PENDING" }) });
    const out = await handleQuestionAnswer({ sender: "@p:id.example", content: answer() }, ROOM, deps);
    expect(out).toEqual({ status: "refused", reason: "board-refused", code: "ELICITATION_NOT_PENDING" });
    expect(replies).toEqual(["That one is already settled — the board has it."]);
  });
});

/** A fetch that records each call's url, Authorization and JSON body, and answers `status`. */
function recordingFetch(status = 200, respondWith: unknown = {}) {
  const sent: Array<{ url: string; auth: string; body: unknown }> = [];
  const fetchImpl: typeof fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sent.push({
        url: url instanceof Request ? url.url : url.toString(),
        auth: headers.get("Authorization") ?? "",
        body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
      });
      return new Response(JSON.stringify(respondWith), { status });
    },
    { preconnect: fetch.preconnect },
  );
  return { sent, fetchImpl };
}

describe("answering at the board", () => {
  test("sends the option alone for a v1 reply, exactly as before", async () => {
    const { sent, fetchImpl } = recordingFetch();
    await answerElicitationAtSuperpipeline(
      { boardId: "brd_7c1f", elicitationId: "elc_7f3c", option: "run_them", principalId: "prn_p", senderMxid: "@p:id.example" },
      { baseUrl: "https://board.example/", mint: async () => "tok", fetch: fetchImpl },
    );
    expect(sent).toEqual([
      { url: "https://board.example/v1/boards/brd_7c1f/elicitations/elc_7f3c/answer", auth: "Bearer tok", body: { option: "run_them" } },
    ]);
  });

  test("sends text, with or without an option", async () => {
    const { sent, fetchImpl } = recordingFetch();
    const deps = { baseUrl: "https://board.example", mint: async () => "tok", fetch: fetchImpl };
    await answerElicitationAtSuperpipeline(
      { boardId: "brd_7c1f", elicitationId: "elc_8a21", text: "main", principalId: "prn_p", senderMxid: "@p:id.example" },
      deps,
    );
    await answerElicitationAtSuperpipeline(
      { boardId: "brd_7c1f", elicitationId: "elc_7f3c", option: "other", text: "unit only", principalId: "prn_p", senderMxid: "@p:id.example" },
      deps,
    );
    expect(sent.map((s) => s.body)).toEqual([{ text: "main" }, { option: "other", text: "unit only" }]);
  });
});

/** One event's examples in the shared corpus, read without trusting its shape. */
interface CorpusEvent {
  suiteEventType: string;
  accept: Array<{ why: string; content: Record<string, unknown> }>;
  reject: Array<{ why: string; content: Record<string, unknown> }>;
}

function corpusEvent(suiteEventType: string): CorpusEvent | undefined {
  const corpus: unknown = JSON.parse(
    readFileSync(join(import.meta.dir, "../../../../../fixtures/ecosystem-identity/matrix_gate_events.json"), "utf8"),
  );
  const events: CorpusEvent[] =
    typeof corpus === "object" && corpus !== null && "events" in corpus && Array.isArray(corpus.events) ? corpus.events : [];
  return events.find((e) => e.suiteEventType === suiteEventType);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const MEANINGS = ["approve", "reject", "revise", "choose", "defer"];

/** The rules a question.v2 keeps, as a consumer would check them. */
function wellFormedQuestion(c: Record<string, unknown>): boolean {
  if (c.msgtype !== "m.text" || typeof c.body !== "string" || c.body === "") return false;
  if (c.suite_event_type !== QUESTION_V2_SUITE_TYPE || typeof c.elicitation_id !== "string") return false;
  const options = c.options;
  if (!Array.isArray(options)) return false;
  const ids = new Set<unknown>();
  for (const o of options) {
    if (!isRecord(o) || typeof o.id !== "string" || typeof o.label !== "string") return false;
    if (typeof o.meaning !== "string" || !MEANINGS.includes(o.meaning) || typeof o.needs_comment !== "boolean") return false;
    if ("needsComment" in o) return false;
    if (o.input !== undefined) {
      const i = o.input;
      if (!isRecord(i) || (i.kind !== "text" && i.kind !== "url") || typeof i.required !== "boolean") return false;
      if (typeof i.max_length !== "number" || "maxLength" in i) return false;
    }
    ids.add(o.id);
  }
  if (ids.size !== options.length) return false;
  return c.free_text === undefined || options.length === 0;
}

/**
 * The shared corpus's question.v2 and question.answer.v2 examples — what supermessage and
 * superpipeline validate too. The hub's own output must BE the accepted questions, and the hub
 * must refuse every rejected answer.
 */
describe("question.v2 against the shared corpus", () => {
  const questionV2 = corpusEvent(QUESTION_V2_SUITE_TYPE);
  const answerV2 = corpusEvent(QUESTION_ANSWER_V2_SUITE_TYPE);

  const corpusAsked: ElicitationPendingDelivery = {
    ...ASKED,
    options: [
      ...ASKED.options,
      {
        id: "other",
        label: "Something else",
        meaning: "choose",
        needsComment: false,
        input: { kind: "text", label: "What should I do instead?", required: true, maxLength: 500 },
      },
    ],
  };
  const link = "https://superpipeline.dev/b/brd_7c1f/c/crd_51d0";

  test("the hub's question.v2 for a question with options and for one with none is exactly what the corpus accepts", () => {
    expect(questionV2?.accept).toHaveLength(2);
    expect(questionV2Content(boundedQuestion(corpusAsked), link)).toEqual(questionV2?.accept[0]?.content ?? {});
    expect(questionV2Content(boundedQuestion(OPEN), link)).toEqual(questionV2?.accept[1]?.content ?? {});
  });

  test("every question.v2 the corpus rejects breaks a rule the hub's own output keeps", () => {
    for (const { content } of questionV2?.accept ?? []) expect(wellFormedQuestion(content)).toBe(true);
    expect(questionV2?.reject.length).toBeGreaterThanOrEqual(4);
    for (const { why, content } of questionV2?.reject ?? []) expect(wellFormedQuestion(content), why).toBe(false);
  });

  const corpusDeps = () =>
    answerDeps({
      recordedQuestion: async (id) =>
        id === corpusAsked.elicitationId
          ? { ...recorded(corpusAsked), eventId: "$questionEventId" }
          : id === OPEN.elicitationId
            ? { ...recorded(OPEN), eventId: "$questionEventId" }
            : null,
    });

  test("every question.answer.v2 the corpus accepts is answered", async () => {
    expect(answerV2?.accept.length).toBeGreaterThanOrEqual(3);
    for (const { why, content } of answerV2?.accept ?? []) {
      const { deps, answered } = corpusDeps();
      const out = await handleQuestionAnswer({ sender: "@person:id.example", content }, ROOM, deps);
      expect(out.status, why).toBe("answered");
      expect(answered, why).toHaveLength(1);
    }
  });

  test("every question.answer.v2 the corpus rejects is refused, and nothing reaches the board", async () => {
    expect(answerV2?.reject.length).toBeGreaterThanOrEqual(4);
    for (const { why, content } of answerV2?.reject ?? []) {
      const { deps, answered } = corpusDeps();
      const out = await handleQuestionAnswer({ sender: "@person:id.example", content }, ROOM, deps);
      expect(out.status, why).toBe("refused");
      expect(answered, why).toHaveLength(0);
    }
  });
});
