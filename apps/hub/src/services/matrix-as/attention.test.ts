import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ATTENTION_ANSWER_V2_SUITE_TYPE,
  ATTENTION_OUTCOME_TYPE,
  ATTENTION_V2_SUITE_TYPE,
  attentionOptionsV2,
  attentionOutcomeContent,
  attentionV2Content,
  isAttentionPending,
  type AttentionPendingDelivery,
} from "./attention-wire";
import {
  WAIT_CHANGED_TEXT,
  handleAttentionAnswer,
  parseAttentionAnswer,
  settleAttentionOutcome,
  type AttentionAnswerDeps,
  type AttentionAnswerRefusal,
  type RecordedAttention,
} from "./attention-answer";
import { answerAttentionAtSuperpipeline } from "./gate-resolve";
import { handleRoomMessage, type InboundDeps } from "./inbound";
import { sweepGates, type GateSweepDeps } from "./gate-sweep";
import type { WaitKey } from "./attention-projection";

/**
 * attention.v2 — a card waiting on a person (charter: "Waiting cards and broker approvals reach
 * chat" §1–2): repeated failure, blocked, not authorised. Posted into its board room once per
 * wait; an answer is judged against the options recorded for it and carried to the board's resume
 * or archive route as the person who answered, naming the wait they were shown.
 */

const CARD_EVENT_ID = "$attentionEventId";
const ROOM = "!board-room:id.example";
const LINK = "https://superpipeline.dev/b/brd_7c1f/c/crd_6b40";
const INPUT = { kind: "text", label: "What should the next attempt do?", required: true, maxLength: 2730 };

const BLOCKED: AttentionPendingDelivery = {
  event: "attention.pending",
  boardId: "brd_7c1f",
  boardName: "Release board",
  cardId: "crd_6b40",
  cardTitle: "Ship the release",
  stageKey: "build",
  stageName: "Build",
  waitId: "wait_0123456789abcdef",
  reason: "blocked",
  detail: "the staging database is down",
  summary: "Staging DB down",
  failureCount: null,
  earlierStages: [{ key: "plan", name: "Plan" }],
  options: [
    { id: "resume_here", label: "Resume here", meaning: "approve", needsComment: false, input: INPUT },
    { id: "resume_at:plan", label: "Resume at Plan", meaning: "choose", needsComment: false, input: INPUT },
    { id: "archive", label: "Archive", meaning: "reject", needsComment: false },
  ],
  ts: "2026-11-08T10:00:00.000Z",
};

const FAILING: AttentionPendingDelivery = {
  ...BLOCKED,
  cardId: "crd_6b41",
  cardTitle: "Plan the release",
  stageKey: "plan",
  stageName: "Plan",
  waitId: "wait_fedcba9876543210",
  reason: "repeated-failure",
  detail: "flaky",
  summary: null,
  failureCount: 2,
  earlierStages: [],
  options: [
    { id: "resume_here", label: "Resume here", meaning: "approve", needsComment: false, input: INPUT },
    { id: "archive", label: "Archive", meaning: "reject", needsComment: false },
  ],
};

describe("is this a waiting card this build knows how to post?", () => {
  test("accepts the board's body, and refuses one with no wait or card to address an answer to", () => {
    expect(isAttentionPending(BLOCKED)).toBe(true);
    expect(isAttentionPending({ ...BLOCKED, waitId: "" })).toBe(false);
    expect(isAttentionPending({ ...BLOCKED, cardId: "" })).toBe(false);
    expect(isAttentionPending({ ...BLOCKED, reason: "" })).toBe(false);
    expect(isAttentionPending({ ...BLOCKED, event: "gate.pending" })).toBe(false);
    expect(isAttentionPending({ ...BLOCKED, options: "none" })).toBe(false);
    expect(isAttentionPending(null)).toBe(false);
  });
});

describe("attention.v2 — what the card offers", () => {
  test("resume here, resume at an earlier stage and archive, in the board's order, snake_case", () => {
    expect(attentionOptionsV2(BLOCKED)).toEqual([
      { id: "resume_here", label: "Resume here", meaning: "approve", needs_comment: false, input: { kind: "text", label: "What should the next attempt do?", required: true, max_length: 2730 } },
      { id: "resume_at:plan", label: "Resume at Plan", meaning: "choose", needs_comment: false, input: { kind: "text", label: "What should the next attempt do?", required: true, max_length: 2730 } },
      { id: "archive", label: "Archive", meaning: "reject", needs_comment: false },
    ]);
  });

  test("a resume always takes a required instruction within the board's limit, whatever the board said", () => {
    const loose = { ...BLOCKED, options: [{ id: "resume_here", label: "Resume here", input: { kind: "url", label: "x", required: false, maxLength: 9000 } }] };
    expect(attentionOptionsV2(loose)[0]?.input).toEqual({ kind: "text", label: "x", required: true, max_length: 2730 });
    const bare = { ...BLOCKED, options: [{ id: "resume_at:plan", label: "Back to Plan" }] };
    expect(attentionOptionsV2(bare)[0]).toEqual({
      id: "resume_at:plan",
      label: "Back to Plan",
      meaning: "choose",
      needs_comment: false,
      input: { kind: "text", label: "What should the next attempt do?", required: true, max_length: 2730 },
    });
  });

  test("an option this hub cannot act on — a forward move, a bare resume_at:, a repeat — is not offered", () => {
    const d = {
      ...BLOCKED,
      options: [
        { id: "move_to:ship", label: "Move to Ship" },
        { id: "resume_at:", label: "Resume somewhere" },
        { id: "archive", label: "Archive" },
        { id: "archive", label: "Archive again" },
        { id: "resume_here" },
      ],
    };
    expect(attentionOptionsV2(d).map((o) => o.id)).toEqual(["archive"]);
  });
});

describe("attention.v2 — the message in the board room", () => {
  test("carries the card, the wait, the reason and the options; the prose stands alone", () => {
    const c = attentionV2Content(BLOCKED, LINK);
    expect(c).toMatchObject({
      msgtype: "m.text",
      suite_event_type: ATTENTION_V2_SUITE_TYPE,
      schema_version: 1,
      board_id: "brd_7c1f",
      card_id: "crd_6b40",
      card_title: "Ship the release",
      stage_key: "build",
      stage_name: "Build",
      wait_id: "wait_0123456789abcdef",
      reason: "blocked",
      detail: "the staging database is down",
      summary: "Staging DB down",
      failure_count: null,
      deep_link: LINK,
    });
    expect(c.body).toBe(
      [
        'A card is waiting on you — "Ship the release" at Build is blocked.',
        "Staging DB down",
        "```\nthe staging database is down\n```",
        "- Resume here\n- Resume at Plan\n- Archive",
        `Choose in an updated app, or [open the card](${LINK}) on the board.`,
      ].join("\n\n"),
    );
  });

  test("a repeated failure says how many times; absent fields are null, never missing", () => {
    const c = attentionV2Content(FAILING);
    expect(String(c.body).split("\n\n")[0]).toBe('A card is waiting on you — "Plan the release" at Plan has failed 2 times.');
    expect(c).toMatchObject({ summary: null, failure_count: 2, reason: "repeated-failure" });
    expect("deep_link" in c).toBe(false);
    const bare = attentionV2Content({ ...BLOCKED, detail: undefined, summary: undefined, failureCount: "3" });
    expect(bare).toMatchObject({ detail: null, summary: null, failure_count: null });
  });

  test("an agent's detail is fenced so markdown keeps it, and a huge one still fits one event", () => {
    const c = attentionV2Content({ ...BLOCKED, summary: null, detail: "```rm -rf```\n**bold**" });
    expect(String(c.body)).toContain("````\n```rm -rf```\n**bold**\n````");
    const huge = attentionV2Content({ ...BLOCKED, cardTitle: "t".repeat(50_000), detail: "d".repeat(200_000), summary: "s".repeat(50_000) });
    expect(new TextEncoder().encode(JSON.stringify(huge)).length).toBeLessThan(32_000);
  });
});

function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msgtype: "m.text",
    body: "Resume here",
    suite_event_type: ATTENTION_ANSWER_V2_SUITE_TYPE,
    board_id: "brd_7c1f",
    card_id: "crd_6b40",
    wait_id: "wait_0123456789abcdef",
    option_id: "resume_here",
    text: "The database is back; run the migrations again.",
    "m.relates_to": { rel_type: "m.reference", event_id: CARD_EVENT_ID },
    ...over,
  };
}

function recorded(d: AttentionPendingDelivery): RecordedAttention {
  return { boardId: d.boardId, cardId: d.cardId, waitId: d.waitId, roomId: ROOM, eventId: CARD_EVENT_ID, options: attentionOptionsV2(d) };
}

function answerDeps(over: Partial<AttentionAnswerDeps> = {}) {
  const calls: Array<Parameters<AttentionAnswerDeps["answer"]>[0]> = [];
  const outcomes: Array<Record<string, unknown>> = [];
  const replies: string[] = [];
  const closed: WaitKey[] = [];
  let claims = 0;
  const deps: AttentionAnswerDeps = {
    principalForMatrixId: async () => ({ id: "prn_person", kind: "human" }),
    recordedAttention: async (k) => (k.waitId === BLOCKED.waitId && k.cardId === BLOCKED.cardId && k.boardId === BLOCKED.boardId ? recorded(BLOCKED) : null),
    answer: async (input) => {
      calls.push(input);
      return { ok: true };
    },
    reply: async (_room, body) => {
      replies.push(body);
      return null;
    },
    claimOutcome: async () => ++claims === 1,
    displayNameFor: async () => "fixture-person",
    sendOutcome: async (_room, content) => {
      outcomes.push(content);
      return null;
    },
    onClosed: (k) => closed.push(k),
    ...over,
  };
  return { deps, calls, replies, outcomes, closed };
}

const SENDER = "@person:id.example";

describe("attention.answer.v2 — reading an answer", () => {
  test("reads the board, card, wait, option, text and reference", () => {
    expect(parseAttentionAnswer(answer())).toEqual({
      boardId: "brd_7c1f",
      cardId: "crd_6b40",
      waitId: "wait_0123456789abcdef",
      optionId: "resume_here",
      text: "The database is back; run the migrations again.",
      referencedEventId: CARD_EVENT_ID,
    });
    expect(parseAttentionAnswer(answer({ wait_id: "" }))).toBeNull();
    expect(parseAttentionAnswer(answer({ card_id: 7 }))).toBeNull();
    expect(parseAttentionAnswer(answer({ option_id: undefined }))).toBeNull();
    expect(parseAttentionAnswer(answer({ suite_event_type: "dev.superpipeline.delivery.answer.v2" }))).toBeNull();
    expect(parseAttentionAnswer(answer({ "m.relates_to": { rel_type: "m.in_reply_to", event_id: CARD_EVENT_ID } }))?.referencedEventId).toBeNull();
  });
});

describe("attention.answer.v2 — acting on an answer", () => {
  test("resume here goes to the board as the person, with the instruction and the wait", async () => {
    const { deps, calls, replies, closed } = answerDeps();
    expect(await handleAttentionAnswer({ sender: SENDER, content: answer() }, ROOM, deps)).toEqual({ status: "done", decision: "resume_here" });
    expect(calls).toEqual([
      {
        boardId: "brd_7c1f",
        cardId: "crd_6b40",
        waitId: "wait_0123456789abcdef",
        action: { kind: "resume", toStageKey: null, comment: "The database is back; run the migrations again." },
        principalId: "prn_person",
        senderMxid: SENDER,
      },
    ]);
    expect(replies).toEqual(["Resumed by fixture-person — the board has it."]);
    expect(closed).toEqual([{ boardId: "brd_7c1f", cardId: "crd_6b40", waitId: "wait_0123456789abcdef" }]);
  });

  test("resume at an earlier stage names the stage; archive carries a remark when given", async () => {
    const at = answerDeps();
    await handleAttentionAnswer({ sender: SENDER, content: answer({ option_id: "resume_at:plan", text: "Re-plan it." }) }, ROOM, at.deps);
    expect(at.calls[0]?.action).toEqual({ kind: "resume", toStageKey: "plan", comment: "Re-plan it." });
    expect(at.replies).toEqual(["Resumed (Resume at Plan) by fixture-person — the board has it."]);

    const archive = answerDeps();
    await handleAttentionAnswer({ sender: SENDER, content: answer({ option_id: "archive", text: undefined }) }, ROOM, archive.deps);
    expect(archive.calls[0]?.action).toEqual({ kind: "archive", comment: null });
    expect(archive.replies).toEqual(["Archived by fixture-person — the board has it."]);

    const remark = answerDeps();
    await handleAttentionAnswer({ sender: SENDER, content: answer({ option_id: "archive", text: " not needed any more " }) }, ROOM, remark.deps);
    expect(remark.calls[0]?.action).toEqual({ kind: "archive", comment: "not needed any more" });
  });

  test("a repeated answer leaves one receipt", async () => {
    const { deps, replies, outcomes } = answerDeps();
    await handleAttentionAnswer({ sender: SENDER, content: answer() }, ROOM, deps);
    await handleAttentionAnswer({ sender: SENDER, content: answer() }, ROOM, deps);
    expect(replies).toHaveLength(1);
    expect(outcomes).toHaveLength(1);
  });

  test("a resume with no instruction, or a blank one, is refused, said, and never sent", async () => {
    for (const text of [undefined, "   "]) {
      const { deps, calls, replies } = answerDeps();
      const out = await handleAttentionAnswer({ sender: SENDER, content: answer({ text }) }, ROOM, deps);
      expect(out).toEqual({ status: "refused", reason: "input-required" });
      expect(calls).toHaveLength(0);
      expect(replies).toEqual(["Resuming needs an instruction for the next attempt. Nothing has changed."]);
    }
  });

  test("an instruction or remark past the board's limit is refused, and never sent", async () => {
    for (const option_id of ["resume_here", "archive"]) {
      const { deps, calls, replies } = answerDeps();
      const out = await handleAttentionAnswer({ sender: SENDER, content: answer({ option_id, text: "x".repeat(2731) }) }, ROOM, deps);
      expect(out).toEqual({ status: "refused", reason: "text-too-long" });
      expect(calls).toHaveLength(0);
      expect(replies).toEqual(["That is longer than the board takes (at most 2730 characters). Nothing has changed."]);
    }
    const { deps, calls } = answerDeps();
    await handleAttentionAnswer({ sender: SENDER, content: answer({ text: "x".repeat(2730) }) }, ROOM, deps);
    expect(calls).toHaveLength(1);
  });

  test("an option the card did not offer is refused — a forward move above all", async () => {
    for (const option_id of ["move_to:ship", "resume_at:ship", "approve"]) {
      const { deps, calls, replies } = answerDeps();
      const out = await handleAttentionAnswer({ sender: SENDER, content: answer({ option_id }) }, ROOM, deps);
      expect(out).toEqual({ status: "refused", reason: "bad-option" });
      expect(calls).toHaveLength(0);
      expect(replies).toEqual(["That is not one of this card's choices. Nothing has changed."]);
    }
  });

  test("attribution refusals are silent: a mismatched reference, another room, an unlinked sender, an agent", async () => {
    const cases: Array<[Record<string, unknown>, string, Partial<AttentionAnswerDeps>, AttentionAnswerRefusal]> = [
      [answer({ "m.relates_to": { rel_type: "m.reference", event_id: "$other" } }), ROOM, {}, "reference-mismatch"],
      [answer(), "!elsewhere:id.example", {}, "reference-mismatch"],
      [answer(), ROOM, { principalForMatrixId: async () => null }, "unlinked-sender"],
      [answer(), ROOM, { principalForMatrixId: async () => ({ id: "prn_agent", kind: "agent" }) }, "not-human"],
      [answer({ wait_id: "wait_ffffffffffffffff" }), ROOM, {}, "unknown-card"],
      [answer({ card_id: "crd_other" }), ROOM, {}, "unknown-card"],
    ];
    for (const [content, room, over, reason] of cases) {
      const { deps, calls, replies } = answerDeps(over);
      expect(await handleAttentionAnswer({ sender: SENDER, content }, room, deps)).toEqual({ status: "refused", reason });
      expect(calls).toHaveLength(0);
      expect(replies).toHaveLength(0);
    }
  });

  test("an unreachable identity service is said, and nothing is sent", async () => {
    const { deps, calls, replies } = answerDeps({
      principalForMatrixId: async () => {
        throw new Error("plane down");
      },
    });
    expect(await handleAttentionAnswer({ sender: SENDER, content: answer() }, ROOM, deps)).toEqual({ status: "refused", reason: "identity-unavailable" });
    expect(calls).toHaveLength(0);
    expect(replies).toHaveLength(1);
  });

  test("WAIT_CHANGED is said in plain words, and the card is closed as settled elsewhere", async () => {
    const { deps, replies, outcomes, closed } = answerDeps({ answer: async () => ({ ok: false, code: "WAIT_CHANGED" }) });
    expect(await handleAttentionAnswer({ sender: SENDER, content: answer() }, ROOM, deps)).toEqual({ status: "refused", reason: "board-refused", code: "WAIT_CHANGED" });
    expect(replies).toEqual([WAIT_CHANGED_TEXT]);
    expect(outcomes).toEqual([attentionOutcomeContent({ ...recorded(BLOCKED) }, "settled_elsewhere", null)]);
    expect(closed).toHaveLength(1);
  });

  test("other board refusals are said, and the card stays open", async () => {
    const said: Record<string, string> = {
      HTTP_403: "The board says you can't do that: it needs someone who may work this board. Nothing has changed.",
      GATE_PENDING: "The card has a review waiting. Decide that first. Nothing has changed.",
      UNREACHABLE: "That did not reach the board. Try again in a moment. Nothing has changed.",
      SOMETHING_NEW: "That did not go through (SOMETHING_NEW). Nothing has changed.",
    };
    for (const [code, text] of Object.entries(said)) {
      const { deps, replies, outcomes, closed } = answerDeps({ answer: async () => ({ ok: false, code }) });
      await handleAttentionAnswer({ sender: SENDER, content: answer() }, ROOM, deps);
      expect(replies).toEqual([text]);
      expect(outcomes).toHaveLength(0);
      expect(closed).toHaveLength(0);
    }
  });
});

describe("a waiting card's receipt", () => {
  test("carries attention.outcome.v1 pointing at the card, naming who decided", async () => {
    const { deps, outcomes } = answerDeps();
    await handleAttentionAnswer({ sender: SENDER, content: answer({ option_id: "resume_at:plan" }) }, ROOM, deps);
    expect(outcomes).toEqual([
      {
        suite_event_type: ATTENTION_OUTCOME_TYPE,
        board_id: "brd_7c1f",
        card_id: "crd_6b40",
        wait_id: "wait_0123456789abcdef",
        decision: "resume_at:plan",
        decided_by: "fixture-person",
        "m.relates_to": { rel_type: "m.reference", event_id: CARD_EVENT_ID },
      },
    ]);
  });

  test("settled elsewhere: a line and an outcome naming nobody, claimed once", async () => {
    const { deps, replies, outcomes } = answerDeps();
    expect(await settleAttentionOutcome(recorded(BLOCKED), "settled_elsewhere", null, ROOM, deps)).toBe(true);
    expect(await settleAttentionOutcome(recorded(BLOCKED), "settled_elsewhere", null, ROOM, deps)).toBe(false);
    expect(replies).toEqual(["This card is no longer waiting — it was settled on the board."]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ decision: "settled_elsewhere", decided_by: null });
  });
});

/** A recording fetch, as the delivery tests use. */
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

describe("the board's resume and archive routes, called as the person", () => {
  test("POSTs resume (here and at a stage) and archive with expectedWaitId and a minted assertion", async () => {
    const { sent, fetchImpl } = recordingFetch();
    const minted: unknown[] = [];
    const deps = {
      baseUrl: "https://board.example/",
      mint: async (subject: unknown) => {
        minted.push(subject);
        return "tok_person";
      },
      fetch: fetchImpl,
    };
    const who = { boardId: "brd_7c1f", cardId: "crd_6b40", waitId: "wait_0123456789abcdef", principalId: "prn_person", senderMxid: SENDER };
    await answerAttentionAtSuperpipeline({ ...who, action: { kind: "resume", toStageKey: null, comment: "go" } }, deps);
    await answerAttentionAtSuperpipeline({ ...who, action: { kind: "resume", toStageKey: "plan", comment: "re-plan" } }, deps);
    await answerAttentionAtSuperpipeline({ ...who, action: { kind: "archive", comment: null } }, deps);
    await answerAttentionAtSuperpipeline({ ...who, action: { kind: "archive", comment: "done" } }, deps);
    const card = "https://board.example/v1/boards/brd_7c1f/cards/crd_6b40";
    expect(sent).toEqual([
      { url: `${card}/resume`, auth: "Bearer tok_person", body: { comment: "go", expectedWaitId: "wait_0123456789abcdef" } },
      { url: `${card}/resume`, auth: "Bearer tok_person", body: { comment: "re-plan", toStageKey: "plan", expectedWaitId: "wait_0123456789abcdef" } },
      { url: `${card}/archive`, auth: "Bearer tok_person", body: { expectedWaitId: "wait_0123456789abcdef" } },
      { url: `${card}/archive`, auth: "Bearer tok_person", body: { expectedWaitId: "wait_0123456789abcdef", comment: "done" } },
    ]);
    expect(minted).toHaveLength(4);
    expect(minted[0]).toEqual({ principalId: "prn_person", senderMxid: SENDER });
  });

  test("reads WAIT_CHANGED off a 409", async () => {
    const { fetchImpl } = recordingFetch(409, { error: { code: "WAIT_CHANGED" } });
    const out = await answerAttentionAtSuperpipeline(
      { boardId: "b", cardId: "c", waitId: "w", action: { kind: "archive", comment: null }, principalId: "p", senderMxid: "@p:id.example" },
      { baseUrl: "https://board.example", mint: async () => "t", fetch: fetchImpl },
    );
    expect(out).toEqual({ ok: false, code: "WAIT_CHANGED" });
  });
});

describe("the room routes an attention.answer.v2 to its handler, never to the agent", () => {
  test("reaches the attention handler before anything else", async () => {
    const handled: unknown[] = [];
    const prompts: unknown[] = [];
    const deps: InboundDeps = {
      domain: "id.example",
      client: { sendText: async () => null },
      acp: {
        createSession: async () => ({ id: "s" }),
        promptSession: async (...args) => {
          prompts.push(args);
        },
      },
      attach: () => {},
      attention: {
        handle: async (e) => {
          handled.push(e.content.wait_id);
        },
      },
    };
    await handleRoomMessage({ type: "m.room.message", sender: SENDER, room_id: ROOM, content: answer() }, deps);
    expect(handled).toEqual(["wait_0123456789abcdef"]);
    expect(prompts).toHaveLength(0);
  });
});

function sweepDeps(over: Partial<GateSweepDeps>): GateSweepDeps {
  return {
    boards: async () => ["brd_7c1f"],
    tenantIdFor: async () => "tnt_1",
    pendingGates: async () => [],
    project: async () => ({ status: "already" }),
    projectAttention: async () => ({ status: "already" }),
    ...over,
  };
}

describe("the sweep: the floor beneath attention.pending", () => {

  test("posts every waiting card the board lists, and skips one in an unknown shape", async () => {
    const posted: string[] = [];
    const result = await sweepGates(
      sweepDeps({
        pendingAttention: async () => [BLOCKED, { event: "attention.pending" }, { ...FAILING, boardId: "brd_other" }],
        projectAttention: async (_t, d) => {
          posted.push(d.waitId);
          return { status: "posted", roomId: ROOM, eventId: "$e" };
        },
      }),
    );
    expect(posted).toEqual([BLOCKED.waitId]);
    expect(result.attention).toMatchObject({ checked: 1, projected: 1, stuck: 0 });
  });

  test("settles the cards whose wait ended — including a card now waiting under a new wait", async () => {
    const settled: WaitKey[] = [];
    const seen: string[][] = [];
    const result = await sweepGates(
      sweepDeps({
        pendingAttention: async () => [{ ...BLOCKED, waitId: "wait_1111111111111111" }],
        postedAttentionAwaitingOutcome: async () => [
          { boardId: "brd_7c1f", cardId: BLOCKED.cardId, waitId: BLOCKED.waitId },
          { boardId: "brd_7c1f", cardId: BLOCKED.cardId, waitId: "wait_1111111111111111" },
          { boardId: "brd_7c1f", cardId: "crd_done", waitId: "wait_2222222222222222" },
        ],
        settleAttention: async (k) => {
          settled.push(k);
          return true;
        },
        onBoardAttention: async (_b, waiting) => {
          seen.push(waiting.map((w) => w.waitId));
        },
      }),
    );
    expect(settled.map((k) => k.waitId)).toEqual([BLOCKED.waitId, "wait_2222222222222222"]);
    expect(result.attention.settled).toBe(2);
    expect(seen).toEqual([["wait_1111111111111111"]]);
  });

  test("a board whose list cannot be read settles nothing, and is named", async () => {
    const settled: WaitKey[] = [];
    let told = false;
    const result = await sweepGates(
      sweepDeps({
        pendingAttention: async () => {
          throw new Error("503");
        },
        postedAttentionAwaitingOutcome: async () => [{ boardId: "brd_7c1f", cardId: "c", waitId: "w" }],
        settleAttention: async (k) => {
          settled.push(k);
          return true;
        },
        onBoardAttention: async () => {
          told = true;
        },
      }),
    );
    expect(settled).toHaveLength(0);
    expect(told).toBe(false);
    expect(result.attention.failedBoards).toEqual(["brd_7c1f"]);
  });

  test("a card that cannot be placed is counted stuck, and one projection throwing does not stop the rest", async () => {
    const result = await sweepGates(
      sweepDeps({
        pendingAttention: async () => [BLOCKED, FAILING],
        projectAttention: async (_t, d) => {
          if (d.waitId === BLOCKED.waitId) throw new Error("M_FORBIDDEN");
          return { status: "no-room" };
        },
      }),
    );
    expect(result.attention).toMatchObject({ checked: 2, projected: 0, stuck: 2 });
  });
});

interface CorpusEvent {
  suiteEventType: string;
  variant?: string;
  accept: Array<{ why: string; content: Record<string, unknown> }>;
  reject: Array<{ why: string; content: Record<string, unknown> }>;
}

function corpus(): { version: number; events: CorpusEvent[] } {
  return JSON.parse(readFileSync(join(import.meta.dir, "../../../../../fixtures/ecosystem-identity/matrix_gate_events.json"), "utf8"));
}

const corpusEvent = (t: string) => corpus().events.find((e) => e.suiteEventType === t);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The rules an attention.v2 keeps, as a consumer would check them. */
function wellFormedAttention(c: Record<string, unknown>): boolean {
  if (c.msgtype !== "m.text" || typeof c.body !== "string" || c.body === "") return false;
  if (c.suite_event_type !== ATTENTION_V2_SUITE_TYPE) return false;
  for (const k of ["board_id", "card_id", "wait_id", "stage_key", "reason"]) if (typeof c[k] !== "string" || c[k] === "") return false;
  if ("subject" in c) return false;
  if (!Array.isArray(c.options)) return false;
  for (const o of c.options) {
    if (!isRecord(o) || typeof o.id !== "string" || typeof o.label !== "string" || typeof o.meaning !== "string") return false;
    if (o.id === "archive") {
      if ("input" in o) return false;
    } else if (o.id === "resume_here" || (o.id.startsWith("resume_at:") && o.id.length > "resume_at:".length)) {
      const i = o.input;
      if (!isRecord(i) || i.kind !== "text" || i.required !== true || typeof i.max_length !== "number" || i.max_length > 2730 || "maxLength" in i) return false;
    } else {
      return false;
    }
  }
  return true;
}

/** What a client closes a waiting card by. */
function closable(c: Record<string, unknown>): boolean {
  return (
    c.suite_event_type === ATTENTION_OUTCOME_TYPE &&
    typeof c.board_id === "string" &&
    typeof c.card_id === "string" &&
    typeof c.wait_id === "string" &&
    typeof c.decision === "string" &&
    isRecord(c["m.relates_to"]) &&
    c["m.relates_to"].rel_type === "m.reference" &&
    typeof c["m.relates_to"].event_id === "string"
  );
}

describe("attention against the shared corpus (version 6, carried in 9)", () => {
  test("the corpus is version 9", () => {
    expect(corpus().version).toBe(9);
  });

  test("the hub's attention.v2 for a blocked card and a repeated failure is exactly what the corpus accepts", () => {
    const v2 = corpusEvent(ATTENTION_V2_SUITE_TYPE);
    expect(v2?.accept).toHaveLength(2);
    expect(attentionV2Content(BLOCKED, LINK)).toEqual(v2?.accept[0]?.content ?? {});
    expect(attentionV2Content(FAILING)).toEqual(v2?.accept[1]?.content ?? {});
  });

  test("every attention.v2 the corpus rejects breaks a rule the hub's own output keeps", () => {
    const v2 = corpusEvent(ATTENTION_V2_SUITE_TYPE);
    for (const { content } of v2?.accept ?? []) expect(wellFormedAttention(content)).toBe(true);
    expect(v2?.reject.length).toBeGreaterThanOrEqual(4);
    for (const { why, content } of v2?.reject ?? []) expect(wellFormedAttention(content), why).toBe(false);
  });

  test("every attention.answer.v2 the corpus accepts reaches the board, and every one it rejects does not", async () => {
    const a = corpusEvent(ATTENTION_ANSWER_V2_SUITE_TYPE);
    expect(a?.accept.length).toBeGreaterThanOrEqual(3);
    for (const { why, content } of a?.accept ?? []) {
      const { deps, calls } = answerDeps();
      expect((await handleAttentionAnswer({ sender: SENDER, content }, ROOM, deps)).status, why).toBe("done");
      expect(calls, why).toHaveLength(1);
    }
    expect(a?.reject.length).toBeGreaterThanOrEqual(5);
    for (const { why, content } of a?.reject ?? []) {
      const { deps, calls } = answerDeps();
      expect((await handleAttentionAnswer({ sender: SENDER, content }, ROOM, deps)).status, why).toBe("refused");
      expect(calls, why).toHaveLength(0);
    }
  });

  test("the hub's receipts are exactly what the corpus accepts, and every reject lacks what a client closes by", () => {
    const o = corpusEvent(ATTENTION_OUTCOME_TYPE);
    const card = { boardId: "brd_7c1f", cardId: "crd_6b40", waitId: "wait_0123456789abcdef", eventId: CARD_EVENT_ID };
    expect([
      attentionOutcomeContent(card, "resume_here", "fixture-person"),
      attentionOutcomeContent(card, "resume_at:plan", "fixture-person"),
      attentionOutcomeContent(card, "archive", "fixture-person"),
      attentionOutcomeContent(card, "settled_elsewhere", null),
    ]).toEqual((o?.accept ?? []).map((x) => x.content));
    for (const { content } of o?.accept ?? []) expect(closable(content)).toBe(true);
    expect(o?.reject.length).toBeGreaterThanOrEqual(3);
    for (const { why, content } of o?.reject ?? []) expect(closable(content), why).toBe(false);
  });
});
