import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  DELIVERY_ANSWER_V2_SUITE_TYPE,
  DELIVERY_V2_SUITE_TYPE,
  deliveryOptionsV2,
  deliverySubjectV2,
  deliveryV2Content,
  isDeliveryPending,
  type DeliveryPendingDelivery,
  GATE_OUTCOME_TYPE,
  deliveryOutcomeContent,
  QUESTION_ANSWER_V2_SUITE_TYPE,
} from "@superjackfruitlabs/treaty-matrix-events";
import {
  handleDeliveryAnswer,
  parseDeliveryAnswer,
  type DeliveryAnswerDeps,
  type DeliveryAnswerRefusal,
  type RecordedDelivery,
} from "../board-chat/delivery-answer";
import { updateDeliveryAtSuperpipeline } from "../board-chat/gate-resolve";
import { settleGateOutcome } from "../board-chat/gate-decision";
import { settleDeliveryOutcome } from "../board-chat/delivery-answer";
import { handleRoomMessage, type InboundDeps } from "./inbound";

/**
 * delivery.v2 — the follow-up a post approved for manual delivery owes (charter: "The decision
 * envelope covers questions and follow-ups" §3): record its live link, or switch it to automatic
 * delivery. Projected into the gate's board room once; an answer is judged against the options
 * recorded for it and carried to the board's delivery route as the person who answered.
 */

const FOLLOW_UP_EVENT_ID = "$followUpEventId";
const ROOM = "!board-room:id.example";
const POST = "Our next release ships today.\n\nThanks to everyone who tested it.";

const OWED: DeliveryPendingDelivery = {
  event: "delivery.pending",
  boardId: "brd_7c1f",
  boardName: "Release board",
  cardId: "crd_6b40",
  cardTitle: "Announce the release",
  gateId: "gate_8f3a",
  stageKey: "approve",
  approvalSubject: {
    id: "aps_2c9e71",
    digest: "sha256:9b2f4e0c1a7d",
    schema: "social-publish/v1",
    revision: 1,
    expiresAt: "2030-01-02T03:04:05Z",
    preview: [
      { type: "text", label: "Post", text: POST },
      { type: "field", label: "Account", value: "@fixture_account on X" },
    ],
    previewComplete: true,
  },
  options: [
    {
      id: "record_live_url",
      label: "Record the live link",
      meaning: "defer",
      needsComment: false,
      input: { kind: "url", label: "Live link", required: true, maxLength: 2000 },
    },
    { id: "switch_to_automatic", label: "Post it automatically", meaning: "approve", needsComment: false, delivery: "automatic" },
  ],
  ts: "2026-11-07T10:00:00.000Z",
};

/** What a client closes a follow-up card by: the gate outcome type, the gate, the decision and the reference. */
function closable(c: Record<string, unknown>): boolean {
  return (
    c.suite_event_type === GATE_OUTCOME_TYPE &&
    typeof c.gate_id === "string" &&
    typeof c.decision === "string" &&
    isRecord(c["m.relates_to"]) &&
    c["m.relates_to"].rel_type === "m.reference" &&
    typeof c["m.relates_to"].event_id === "string"
  );
}

describe("is this a follow-up this build knows how to post?", () => {
  test("accepts the board's body, and refuses one with no gate to address an answer to", () => {
    expect(isDeliveryPending(OWED)).toBe(true);
    expect(isDeliveryPending({ ...OWED, gateId: "" })).toBe(false);
    expect(isDeliveryPending({ ...OWED, event: "gate.pending" })).toBe(false);
    expect(isDeliveryPending({ ...OWED, options: "none" })).toBe(false);
    expect(isDeliveryPending(null)).toBe(false);
  });
});

describe("delivery.v2 — what the follow-up offers", () => {
  test("both choices on a complete preview: a required https link, and automatic delivery", () => {
    expect(deliveryOptionsV2(OWED)).toEqual([
      {
        id: "record_live_url",
        label: "Record the live link",
        meaning: "defer",
        needs_comment: false,
        input: { kind: "url", label: "Live link", required: true, max_length: 2000 },
      },
      { id: "switch_to_automatic", label: "Post it automatically", meaning: "approve", needs_comment: false, delivery: "automatic" },
    ]);
  });

  test("no switch to automatic when the hub's own bounding finds the preview incomplete, whatever the board said", () => {
    const tooLong: DeliveryPendingDelivery = {
      ...OWED,
      approvalSubject: {
        id: "aps_2c9e71",
        digest: "sha256:9b2f4e0c1a7d",
        schema: "social-publish/v1",
        revision: 1,
        previewComplete: true,
        preview: [{ type: "text", label: "Post", text: "x".repeat(5000) }],
      },
    };
    expect(deliverySubjectV2(tooLong)?.preview_complete).toBe(false);
    expect(deliveryOptionsV2(tooLong).map((o) => o.id)).toEqual(["record_live_url"]);
  });

  test("no switch to automatic on a subject the hub cannot carry; recording the link stays", () => {
    const noSubject: DeliveryPendingDelivery = { ...OWED, approvalSubject: { id: "aps_x" } };
    expect(deliverySubjectV2(noSubject)).toBeNull();
    expect(deliveryOptionsV2(noSubject).map((o) => o.id)).toEqual(["record_live_url"]);
    expect(deliveryV2Content(noSubject)).not.toHaveProperty("subject");
  });

  test("a live link is always a required https address, whatever an older board said about its input", () => {
    const older: DeliveryPendingDelivery = { ...OWED, options: [{ id: "record_live_url", label: "Record the live link" }] };
    expect(deliveryOptionsV2(older)).toEqual([
      {
        id: "record_live_url",
        label: "Record the live link",
        meaning: "defer",
        needs_comment: false,
        input: { kind: "url", label: "Live link", required: true, max_length: 2000 },
      },
    ]);
  });

  test("an option this hub could not act on is not offered", () => {
    const extra: DeliveryPendingDelivery = { ...OWED, options: [...OWED.options, { id: "remind_me", label: "Remind me" }] };
    expect(deliveryOptionsV2(extra).map((o) => o.id)).toEqual(["record_live_url", "switch_to_automatic"]);
  });
});

describe("delivery.v2 — the message in the board room", () => {
  test("carries the gate, the re-bounded subject and the options, with the preview and choices in the body", () => {
    const content = deliveryV2Content(OWED, "https://board.example/b/brd_7c1f/c/crd_6b40");
    expect(content).toMatchObject({
      msgtype: "m.text",
      suite_event_type: DELIVERY_V2_SUITE_TYPE,
      schema_version: 1,
      board_id: "brd_7c1f",
      card_id: "crd_6b40",
      gate_id: "gate_8f3a",
      stage_key: "approve",
      card_title: "Announce the release",
      subject: {
        id: "aps_2c9e71",
        digest: "sha256:9b2f4e0c1a7d",
        schema: "social-publish/v1",
        revision: 1,
        expires_at: "2030-01-02T03:04:05Z",
        preview_complete: true,
      },
      options: deliveryOptionsV2(OWED),
      deep_link: "https://board.example/b/brd_7c1f/c/crd_6b40",
    });
    const body = String(content.body);
    expect(body).toContain(POST);
    expect(body).toContain("Record the live link");
    expect(body).toContain("Post it automatically");
  });

  test("a follow-up whose preview would overflow an event still fits one", () => {
    const long = "語".repeat(4000);
    const preview = Array.from({ length: 20 }, (_, i) => ({ type: "text", label: `Post ${i + 1}`, text: long }));
    const d: DeliveryPendingDelivery = {
      ...OWED,
      cardTitle: long,
      approvalSubject: { id: "aps_2c9e71", digest: "sha256:9b2f4e0c1a7d", schema: "social-publish/v1", revision: 1, previewComplete: true, preview },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(deliveryV2Content(d, "https://board.example/b/brd_7c1f/c/crd_6b40"))).length;
    expect(bytes).toBeLessThan(48_000);
    expect(deliveryOptionsV2(d).map((o) => o.id)).toEqual(["record_live_url"]);
  });
});

function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msgtype: "m.text",
    body: "Live at https://social.example/posts/1",
    schema_version: 1,
    suite_event_type: DELIVERY_ANSWER_V2_SUITE_TYPE,
    gate_id: "gate_8f3a",
    option_id: "record_live_url",
    text: "https://social.example/posts/1",
    "m.relates_to": { rel_type: "m.reference", event_id: FOLLOW_UP_EVENT_ID },
    ...over,
  };
}

function recorded(d: DeliveryPendingDelivery): RecordedDelivery {
  return {
    boardId: d.boardId,
    roomId: ROOM,
    eventId: FOLLOW_UP_EVENT_ID,
    options: deliveryOptionsV2(d),
    subjectPreviewComplete: deliverySubjectV2(d)?.preview_complete ?? null,
  };
}

function answerDeps(over: Partial<DeliveryAnswerDeps> = {}) {
  const changes: Array<Parameters<DeliveryAnswerDeps["updateDelivery"]>[0]> = [];
  const outcomes: Array<Record<string, unknown>> = [];
  const replies: string[] = [];
  let claims = 0;
  const deps: DeliveryAnswerDeps = {
    principalForMatrixId: async () => ({ id: "prn_person", kind: "human" }),
    recordedDelivery: async (gateId) => (gateId === OWED.gateId ? recorded(OWED) : null),
    updateDelivery: async (input) => {
      changes.push(input);
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
    ...over,
  };
  return { deps, changes, replies, outcomes };
}

describe("delivery.answer.v2 — reading an answer", () => {
  test("reads the gate, the option, the link and the reference", () => {
    expect(parseDeliveryAnswer(answer())).toEqual({
      gateId: "gate_8f3a",
      optionId: "record_live_url",
      text: "https://social.example/posts/1",
      referencedEventId: FOLLOW_UP_EVENT_ID,
    });
    expect(parseDeliveryAnswer(answer({ option_id: "" }))).toBeNull();
    expect(parseDeliveryAnswer(answer({ suite_event_type: QUESTION_ANSWER_V2_SUITE_TYPE }))).toBeNull();
  });
});

describe("delivery.answer.v2 — acting on an answer", () => {
  test("a live link is recorded at the board as the person, and the room is told who did it", async () => {
    const { deps, changes, replies } = answerDeps();
    const out = await handleDeliveryAnswer({ sender: "@person:id.example", content: answer() }, ROOM, deps);
    expect(out).toEqual({ status: "recorded", change: "live-url" });
    expect(changes).toEqual([
      {
        boardId: "brd_7c1f",
        gateId: "gate_8f3a",
        change: { liveUrl: "https://social.example/posts/1" },
        principalId: "prn_person",
        senderMxid: "@person:id.example",
      },
    ]);
    expect(replies).toEqual(["Live link recorded by fixture-person — the board has it."]);
  });

  test("switching to automatic delivery sends mode automatic, and says so", async () => {
    const { deps, changes, replies } = answerDeps();
    const out = await handleDeliveryAnswer(
      { sender: "@person:id.example", content: answer({ option_id: "switch_to_automatic", text: undefined }) },
      ROOM,
      deps,
    );
    expect(out).toEqual({ status: "recorded", change: "automatic" });
    expect(changes[0]?.change).toEqual({ mode: "automatic" });
    expect(replies).toEqual(["Switched to automatic delivery by fixture-person — the board has it."]);
  });

  test("a repeated answer leaves one receipt", async () => {
    const { deps, replies } = answerDeps();
    await handleDeliveryAnswer({ sender: "@person:id.example", content: answer() }, ROOM, deps);
    await handleDeliveryAnswer({ sender: "@person:id.example", content: answer() }, ROOM, deps);
    expect(replies).toHaveLength(1);
  });

  test("a missing link, a non-https link and a link that is not an address are refused, said, and never sent", async () => {
    const { deps, changes, replies } = answerDeps();
    const cases: Array<[unknown, DeliveryAnswerRefusal]> = [
      [undefined, "input-required"],
      ["   ", "input-required"],
      ["http://social.example/posts/1", "url-invalid"],
      ["javascript:alert(1)", "url-invalid"],
      ["https://", "url-invalid"],
      [`https://social.example/${"p".repeat(2100)}`, "text-too-long"],
    ];
    for (const [text, reason] of cases) {
      const out = await handleDeliveryAnswer({ sender: "@person:id.example", content: answer({ text }) }, ROOM, deps);
      expect(out).toEqual({ status: "refused", reason });
    }
    expect(changes).toHaveLength(0);
    expect(replies).toHaveLength(cases.length);
  });

  test("an option the follow-up did not offer is refused", async () => {
    const { deps, changes } = answerDeps();
    const out = await handleDeliveryAnswer({ sender: "@person:id.example", content: answer({ option_id: "remind_me" }) }, ROOM, deps);
    expect(out).toEqual({ status: "refused", reason: "bad-option" });
    expect(changes).toHaveLength(0);
  });

  test("switch_to_automatic is refused when the recorded preview was incomplete — even if it was recorded as offered", async () => {
    const { deps, changes } = answerDeps({
      recordedDelivery: async () => ({ ...recorded(OWED), subjectPreviewComplete: false }),
    });
    const out = await handleDeliveryAnswer(
      { sender: "@person:id.example", content: answer({ option_id: "switch_to_automatic" }) },
      ROOM,
      deps,
    );
    expect(out).toEqual({ status: "refused", reason: "preview-incomplete" });
    expect(changes).toHaveLength(0);
  });

  test("switch_to_automatic not offered on an incomplete preview is refused as not offered", async () => {
    const incomplete: DeliveryPendingDelivery = {
      ...OWED,
      approvalSubject: { id: "aps_2c9e71", digest: "sha256:9b2f4e0c1a7d", schema: "social-publish/v1", revision: 1, previewComplete: false, preview: [{ type: "text", text: POST }] },
    };
    const { deps, changes } = answerDeps({ recordedDelivery: async () => recorded(incomplete) });
    const out = await handleDeliveryAnswer(
      { sender: "@person:id.example", content: answer({ option_id: "switch_to_automatic" }) },
      ROOM,
      deps,
    );
    expect(out.status).toBe("refused");
    expect(changes).toHaveLength(0);
  });

  test("attribution refusals are silent: a mismatched reference, another room, an unlinked sender, an agent", async () => {
    const mismatch = answerDeps();
    expect(
      await handleDeliveryAnswer(
        { sender: "@p:id.example", content: answer({ "m.relates_to": { rel_type: "m.reference", event_id: "$other" } }) },
        ROOM,
        mismatch.deps,
      ),
    ).toEqual({ status: "refused", reason: "reference-mismatch" });
    expect(await handleDeliveryAnswer({ sender: "@p:id.example", content: answer() }, "!elsewhere:id.example", mismatch.deps)).toEqual({
      status: "refused",
      reason: "reference-mismatch",
    });
    expect(mismatch.replies).toHaveLength(0);

    const unlinked = answerDeps({ principalForMatrixId: async () => null });
    expect(await handleDeliveryAnswer({ sender: "@stranger:id.example", content: answer() }, ROOM, unlinked.deps)).toEqual({
      status: "refused",
      reason: "unlinked-sender",
    });
    expect(unlinked.replies).toHaveLength(0);

    const agent = answerDeps({ principalForMatrixId: async () => ({ id: "prn_agent", kind: "agent" }) });
    expect(await handleDeliveryAnswer({ sender: "@agent_x:id.example", content: answer() }, ROOM, agent.deps)).toEqual({
      status: "refused",
      reason: "not-human",
    });
    for (const r of [mismatch, unlinked, agent]) expect(r.changes).toHaveLength(0);
  });

  test("a follow-up this hub never posted is unknown", async () => {
    const { deps, changes } = answerDeps();
    expect(await handleDeliveryAnswer({ sender: "@p:id.example", content: answer({ gate_id: "gate_unknown" }) }, ROOM, deps)).toEqual({
      status: "refused",
      reason: "unknown-follow-up",
    });
    expect(changes).toHaveLength(0);
  });

  test("the board's refusal is said in the room, and no receipt is posted", async () => {
    const { deps, replies } = answerDeps({ updateDelivery: async () => ({ ok: false, code: "APPROVAL_EXPIRED" }) });
    const out = await handleDeliveryAnswer({ sender: "@p:id.example", content: answer() }, ROOM, deps);
    expect(out).toEqual({ status: "refused", reason: "board-refused", code: "APPROVAL_EXPIRED" });
    expect(replies).toEqual(["That did not go through (APPROVAL_EXPIRED). Nothing has changed."]);
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

describe("the board's delivery route, called as the person", () => {
  test("POSTs { liveUrl } or { mode: automatic } to the gate's delivery route with a minted assertion", async () => {
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
    const who = { boardId: "brd_7c1f", gateId: "gate_8f3a", principalId: "prn_person", senderMxid: "@person:id.example" };
    expect(await updateDeliveryAtSuperpipeline({ ...who, change: { liveUrl: "https://social.example/posts/1" } }, deps)).toEqual({ ok: true });
    expect(await updateDeliveryAtSuperpipeline({ ...who, change: { mode: "automatic" } }, deps)).toEqual({ ok: true });
    expect(sent).toEqual([
      { url: "https://board.example/v1/boards/brd_7c1f/gates/gate_8f3a/delivery", auth: "Bearer tok_person", body: { liveUrl: "https://social.example/posts/1" } },
      { url: "https://board.example/v1/boards/brd_7c1f/gates/gate_8f3a/delivery", auth: "Bearer tok_person", body: { mode: "automatic" } },
    ]);
    expect(minted).toEqual([
      { principalId: "prn_person", senderMxid: "@person:id.example" },
      { principalId: "prn_person", senderMxid: "@person:id.example" },
    ]);
  });

  test("reads the board's error code", async () => {
    const { fetchImpl } = recordingFetch(409, { error: { code: "INVALID_LIVE_URL" } });
    const out = await updateDeliveryAtSuperpipeline(
      { boardId: "brd_7c1f", gateId: "gate_8f3a", change: { liveUrl: "https://x.example" }, principalId: "p", senderMxid: "@p:id.example" },
      { baseUrl: "https://board.example", mint: async () => "t", fetch: fetchImpl },
    );
    expect(out).toEqual({ ok: false, code: "INVALID_LIVE_URL" });
  });
});

/** Inbound deps that record which envelope handler each message reached, and any prompt. */
function inbound() {
  const questions: unknown[] = [];
  const deliveries: unknown[] = [];
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
    questions: {
      handle: async (e) => {
        questions.push(e.content.suite_event_type);
      },
    },
    deliveries: {
      handle: async (e) => {
        deliveries.push(e.content.suite_event_type);
      },
    },
  };
  return { deps, questions, deliveries, prompts };
}

describe("the room routes the envelope's answers to their handlers, before anything else", () => {
  test("a question.answer.v2 reaches the question handler, a delivery.answer.v2 the delivery handler", async () => {
    const r = inbound();
    await handleRoomMessage(
      {
        type: "m.room.message",
        sender: "@person:id.example",
        room_id: ROOM,
        content: {
          msgtype: "m.text",
          body: "Run the tests",
          suite_event_type: QUESTION_ANSWER_V2_SUITE_TYPE,
          elicitation_id: "elc_7f3c",
          option_id: "run_them",
          "m.relates_to": { rel_type: "m.reference", event_id: "$q" },
        },
      },
      r.deps,
    );
    await handleRoomMessage({ type: "m.room.message", sender: "@person:id.example", room_id: ROOM, content: answer() }, r.deps);
    expect(r.questions).toEqual([QUESTION_ANSWER_V2_SUITE_TYPE]);
    expect(r.deliveries).toEqual([DELIVERY_ANSWER_V2_SUITE_TYPE]);
    expect(r.prompts).toHaveLength(0);
  });
});

interface CorpusEvent {
  suiteEventType: string;
  accept: Array<{ why: string; content: Record<string, unknown> }>;
  reject: Array<{ why: string; content: Record<string, unknown> }>;
}

function corpusEvent(suiteEventType: string): CorpusEvent | undefined {
  const corpus: unknown = JSON.parse(
    readFileSync(Bun.resolveSync("@superjackfruitlabs/treaty-ecosystem-identity/matrix_gate_events.json", import.meta.dir), "utf8"),
  );
  const events: CorpusEvent[] =
    typeof corpus === "object" && corpus !== null && "events" in corpus && Array.isArray(corpus.events) ? corpus.events : [];
  return events.find((e) => e.suiteEventType === suiteEventType);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The rules a delivery.v2 keeps, as a consumer would check them. */
function wellFormedDelivery(c: Record<string, unknown>): boolean {
  if (c.msgtype !== "m.text" || typeof c.body !== "string" || c.body === "") return false;
  if (c.suite_event_type !== DELIVERY_V2_SUITE_TYPE || typeof c.gate_id !== "string") return false;
  const complete = isRecord(c.subject) && c.subject.preview_complete === true;
  const options = c.options;
  if (!Array.isArray(options)) return false;
  for (const o of options) {
    if (!isRecord(o) || typeof o.label !== "string" || typeof o.needs_comment !== "boolean") return false;
    if (o.id === "record_live_url") {
      const i = o.input;
      if (!isRecord(i) || i.kind !== "url" || i.required !== true || typeof i.max_length !== "number" || "maxLength" in i) return false;
    } else if (o.id === "switch_to_automatic") {
      if (!complete || o.delivery !== "automatic") return false;
    } else {
      return false;
    }
  }
  return true;
}

describe("delivery.v2 against the shared corpus", () => {
  const deliveryV2 = corpusEvent(DELIVERY_V2_SUITE_TYPE);
  const answerV2 = corpusEvent(DELIVERY_ANSWER_V2_SUITE_TYPE);
  const link = "https://superpipeline.dev/b/brd_7c1f/c/crd_6b40";
  const incomplete: DeliveryPendingDelivery = {
    ...OWED,
    gateId: "gate_8f3b",
    approvalSubject: {
      id: "aps_2c9e71",
      digest: "sha256:9b2f4e0c1a7d",
      schema: "social-publish/v1",
      revision: 1,
      expiresAt: "2030-01-02T03:04:05Z",
      preview: [
        { type: "text", label: "Post", text: POST },
        { type: "field", label: "Account", value: "@fixture_account on X" },
      ],
      previewComplete: false,
    },
    options: OWED.options.slice(0, 1),
  };

  test("the hub's delivery.v2 on a complete and on an incomplete preview is exactly what the corpus accepts", () => {
    expect(deliveryV2?.accept).toHaveLength(2);
    expect(deliveryV2Content(OWED, link)).toEqual(deliveryV2?.accept[0]?.content ?? {});
    expect(deliveryV2Content(incomplete, link)).toEqual(deliveryV2?.accept[1]?.content ?? {});
  });

  test("every delivery.v2 the corpus rejects breaks a rule the hub's own output keeps", () => {
    for (const { content } of deliveryV2?.accept ?? []) expect(wellFormedDelivery(content)).toBe(true);
    expect(deliveryV2?.reject.length).toBeGreaterThanOrEqual(4);
    for (const { why, content } of deliveryV2?.reject ?? []) expect(wellFormedDelivery(content), why).toBe(false);
  });

  const corpusDeps = () =>
    answerDeps({
      recordedDelivery: async (gateId) =>
        gateId === OWED.gateId
          ? { ...recorded(OWED), eventId: "$deliveryEventId" }
          : gateId === incomplete.gateId
            ? { ...recorded(incomplete), eventId: "$deliveryEventId" }
            : null,
    });

  test("every delivery.answer.v2 the corpus accepts reaches the board", async () => {
    expect(answerV2?.accept.length).toBeGreaterThanOrEqual(2);
    for (const { why, content } of answerV2?.accept ?? []) {
      const { deps, changes } = corpusDeps();
      const out = await handleDeliveryAnswer({ sender: "@person:id.example", content }, ROOM, deps);
      expect(out.status, why).toBe("recorded");
      expect(changes, why).toHaveLength(1);
    }
  });

  test("every delivery.answer.v2 the corpus rejects is refused, and nothing reaches the board", async () => {
    expect(answerV2?.reject.length).toBeGreaterThanOrEqual(4);
    for (const { why, content } of answerV2?.reject ?? []) {
      const { deps, changes } = corpusDeps();
      const out = await handleDeliveryAnswer({ sender: "@person:id.example", content }, ROOM, deps);
      expect(out.status, why).toBe("refused");
      expect(changes, why).toHaveLength(0);
    }
  });
});

/**
 * A follow-up "is settled by a receipt, like a gate" (charter: the decision envelope covers
 * questions and follow-ups §3): the prose line and the same structured
 * `dev.superpipeline.gate.outcome.v1` a gate's receipt carries, pointing at the follow-up's own
 * message so a client knows which card to close. No new wire type.
 */
describe("a follow-up's receipt carries the gate outcome", () => {
  test("recording the link posts the structured outcome beside the prose, pointing at the follow-up", async () => {
    const { deps, outcomes } = answerDeps();
    await handleDeliveryAnswer({ sender: "@person:id.example", content: answer() }, ROOM, deps);
    expect(outcomes).toEqual([
      {
        suite_event_type: GATE_OUTCOME_TYPE,
        gate_id: "gate_8f3a",
        board_id: "brd_7c1f",
        decision: "record_live_url",
        decided_by: "fixture-person",
        "m.relates_to": { rel_type: "m.reference", event_id: FOLLOW_UP_EVENT_ID },
      },
    ]);
  });

  test("switching to automatic says so in the outcome, and a repeated answer posts no second outcome", async () => {
    const { deps, outcomes } = answerDeps();
    const content = answer({ option_id: "switch_to_automatic", text: undefined });
    await handleDeliveryAnswer({ sender: "@person:id.example", content }, ROOM, deps);
    await handleDeliveryAnswer({ sender: "@person:id.example", content }, ROOM, deps);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ decision: "switch_to_automatic" });
  });

  test("settled on the board: a line and an outcome naming nobody, claimed once", async () => {
    const { deps, replies, outcomes } = answerDeps();
    const where = { boardId: "brd_7c1f", eventId: FOLLOW_UP_EVENT_ID };
    expect(await settleDeliveryOutcome("gate_8f3a", "settled_elsewhere", null, ROOM, where, deps)).toBe(true);
    expect(await settleDeliveryOutcome("gate_8f3a", "settled_elsewhere", null, ROOM, where, deps)).toBe(false);
    expect(replies).toEqual(["Settled on the board — the board has it."]);
    expect(outcomes).toEqual([deliveryOutcomeContent("gate_8f3a", where, "settled_elsewhere", null)]);
  });

  test("the outcome's shape is the gate receipt's, field for field", async () => {
    const gateOutcomes: Array<Record<string, unknown>> = [];
    await settleGateOutcome({ gateId: "gate_8f3a", decision: "approve_manual", decidedBy: "prn_person" }, ROOM, { boardId: "brd_7c1f", eventId: "$gateEventId" }, {
      reply: async () => null,
      sendOutcome: async (_r, content) => {
        gateOutcomes.push(content);
        return null;
      },
      displayNameFor: async () => "fixture-person",
    });
    const delivery = deliveryOutcomeContent("gate_8f3a", { boardId: "brd_7c1f", eventId: FOLLOW_UP_EVENT_ID }, "record_live_url", "fixture-person");
    expect(Object.keys(delivery).toSorted()).toEqual(Object.keys(gateOutcomes[0] ?? {}).toSorted());
  });
});

describe("gate.outcome.v1 against the shared corpus", () => {
  const outcome = corpusEvent(GATE_OUTCOME_TYPE);

  test("the hub's gate receipt and its three follow-up receipts are exactly what the corpus accepts", async () => {
    const gateOutcomes: Array<Record<string, unknown>> = [];
    await settleGateOutcome({ gateId: "gate_8f3a", decision: "approve_manual", decidedBy: "prn_person" }, ROOM, { boardId: "brd_7c1f", eventId: "$gateEventId" }, {
      reply: async () => null,
      sendOutcome: async (_r, content) => {
        gateOutcomes.push(content);
        return null;
      },
      displayNameFor: async () => "fixture-person",
    });
    const where = { boardId: "brd_7c1f", eventId: "$deliveryEventId" };
    expect([
      gateOutcomes[0],
      deliveryOutcomeContent("gate_8f3a", where, "record_live_url", "fixture-person"),
      deliveryOutcomeContent("gate_8f3a", where, "switch_to_automatic", "fixture-person"),
      deliveryOutcomeContent("gate_8f3a", where, "settled_elsewhere", null),
    ]).toEqual((outcome?.accept ?? []).map((a) => a.content));
  });

  test("every outcome the corpus rejects lacks what a client closes a card by", () => {
    for (const { content } of outcome?.accept ?? []) expect(closable(content)).toBe(true);
    expect(outcome?.reject.length).toBeGreaterThanOrEqual(3);
    for (const { why, content } of outcome?.reject ?? []) expect(closable(content), why).toBe(false);
  });
});
