import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CHECK_OVERRIDE_V2_SUITE_TYPE,
  GATE_PULL_BACK_V2_SUITE_TYPE,
  isPermissionAnswerMarked,
} from "@superjackfruitlabs/treaty-matrix-events";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { handleRoomMessage, type InboundDeps } from "../../src/services/matrix-as/inbound";
import { handleAttentionAnswer } from "../../src/services/board-chat/attention-answer";
import { handleCheckOverride } from "../../src/services/board-chat/check-override";
import { handleDeliveryAnswer } from "../../src/services/board-chat/delivery-answer";
import { handleGateDecision } from "../../src/services/board-chat/gate-decision";
import { handleGatePullBack } from "../../src/services/board-chat/gate-pull-back";
import { handleQuestionAnswer } from "../../src/services/board-chat/question-answer";

/**
 * Treaty's board-room corpus, run through the hub's own handling of a person's answer.
 *
 * The parsers are treaty's now (`@superjackfruitlabs/treaty-matrix-events`) and treaty tests them
 * against this corpus. What stays the hub's is where an answer goes: `handleRoomMessage` sends each
 * kind to its own board handler before anything could read it as a prompt, and the pull-back and
 * check-override handlers refuse a malformed one themselves. This holds that routing to the corpus:
 * every valid answer reaches its handler and no other; an answer the schema refuses reaches none
 * (or, for the two matched by marker, is refused by the handler before it reads any record); an
 * answer only the carrier can refuse (`recorded`) reaches its handler, which judges it.
 */

type Case = { why: string; refusedBy: "schema" | "unique" | "recorded"; body: Record<string, unknown> };
// Read, not imported: a typed import of the whole corpus is a literal type the compiler chokes on.
const corpus: unknown = JSON.parse(
  readFileSync(Bun.resolveSync("@superjackfruitlabs/treaty-matrix-events/examples.json", import.meta.dir), "utf8"),
);
const schemas = (corpus as { schemas: Record<string, { valid: Record<string, Record<string, unknown>>; invalid: Case[] }> }).schemas;

const ROOM = "!corpus:id.agentpod.dev";
const SENDER = "@someone:id.agentpod.dev";

/** The answer types the hub routes to a board handler, by the handler that takes them. */
const ROUTED: Record<string, Handler> = {
  "dev.superpipeline.gate.decision.v1": "gates",
  "dev.superpipeline.gate.decision.v2": "gates",
  "dev.superpipeline.question.answer.v2": "questions",
  "dev.superpipeline.delivery.answer.v2": "deliveries",
  "dev.superpipeline.attention.answer.v2": "attention",
  [GATE_PULL_BACK_V2_SUITE_TYPE]: "pullBacks",
  [CHECK_OVERRIDE_V2_SUITE_TYPE]: "checkOverrides",
};
type Handler = "gates" | "questions" | "deliveries" | "attention" | "pullBacks" | "checkOverrides";
const HANDLERS: Handler[] = ["gates", "questions", "deliveries", "attention", "pullBacks", "checkOverrides"];

/** Where one message went: the board handlers that took it, in order. */
async function route(content: Record<string, unknown>): Promise<Handler[]> {
  const took: Handler[] = [];
  const spy = (h: Handler) => ({
    handle: async () => {
      took.push(h);
    },
  });
  const deps = { domain: "id.agentpod.dev", ...Object.fromEntries(HANDLERS.map((h) => [h, spy(h)])) } as unknown as InboundDeps;
  // A message no board handler takes goes on to be read as chat; this room is nobody's, so it stops there.
  await handleRoomMessage({ type: "m.room.message", room_id: ROOM, sender: SENDER, event_id: "$corpus", content }, deps);
  return took;
}

/** The reference an answer carries, or null. */
function referenceIn(content: Record<string, unknown>): string | null {
  const rel = content["m.relates_to"] as { rel_type?: unknown; event_id?: unknown } | undefined;
  return rel?.rel_type === "m.reference" && typeof rel.event_id === "string" ? rel.event_id : null;
}
const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);

/**
 * What the hub would have recorded when it posted the message an answer names: the same ids, this
 * room, the event the answer should reference (the one it references when it references one), and
 * what the board offers for that kind. Built from the answer so that a refusal can only be the
 * answer's own fault; the `recorded` cases need a particular record and are judged in each handler's
 * own tests instead.
 */
function recordFor(handler: Handler, content: Record<string, unknown>, posted: string) {
  const eventId = referenceIn(content) ?? posted;
  const subject = content.subject as { id?: string; digest?: string } | undefined;
  const option = typeof content.option_id === "string" ? content.option_id : null;
  switch (handler) {
    case "gates": {
      const meaning = option?.startsWith("approve") ? "approve" : option === "request_changes" ? "revise" : "reject";
      return {
        tenantId: "tnt_corpus",
        boardId: "brd_corpus",
        eventId,
        proseEventId: null,
        // A gate.v1 recorded no options; a gate.v2 offered the one answered.
        options:
          content.suite_event_type === "dev.superpipeline.gate.decision.v2" && option
            ? [{ id: option, meaning, needs_comment: option === "request_changes" }]
            : null,
        subjectId: subject?.id ?? null,
        subjectPreviewComplete: true,
        variants: null,
        quorum: null,
      };
    }
    case "questions":
      return {
        boardId: "brd_corpus",
        approvalRequest: str(content.elicitation_id, "").startsWith("apr_"),
        roomId: ROOM,
        eventId,
        options: option
          ? [
              {
                id: option,
                label: option,
                meaning: option === "deny" ? "reject" : "approve",
                ...(option === "other" ? { input: { kind: "text" as const, required: true, max_length: 2000 } } : {}),
              },
            ]
          : null,
        freeText: option ? null : { max_length: 2000 },
        subject: subject?.id && subject.digest ? { id: subject.id, digest: subject.digest, previewComplete: true, expiresAt: null } : null,
      };
    case "deliveries":
      return {
        boardId: "brd_corpus",
        roomId: ROOM,
        eventId,
        options: [{ id: "record_live_url", input: { kind: "url" as const, required: true, max_length: 2048 } }, { id: "switch_to_automatic" }],
        subjectPreviewComplete: true,
      };
    case "attention": {
      const instruction = { kind: "text" as const, required: true, max_length: 2730 };
      return {
        boardId: str(content.board_id, "brd_corpus"),
        cardId: str(content.card_id, "crd_corpus"),
        waitId: str(content.wait_id, "wait_corpus"),
        roomId: ROOM,
        eventId,
        options: [
          { id: "resume_here", label: "Resume here", input: instruction },
          { id: "resume_at:plan", label: "Resume at plan", input: instruction },
          { id: "archive", label: "Archive" },
        ],
      };
    }
    case "pullBacks":
      return { tenantId: "tnt_corpus", boardId: "brd_corpus", roomId: ROOM, eventId, proseEventId: null };
    case "checkOverrides":
      return { tenantId: "tnt_corpus", boardId: str(content.board_id, "brd_corpus"), cardId: str(content.card_id, "crd_corpus"), roomId: ROOM, eventId };
  }
}

/** The event each kind of answer is posted under, in the corpus. */
const POSTED: Record<Handler, string> = {
  gates: "$gateEventId",
  questions: "$questionEventId",
  deliveries: "$deliveryEventId",
  attention: "$attentionEventId",
  pullBacks: "$gateEventId",
  checkOverrides: "$checksWaitingEventId",
};

/** The one call that acts: the board's route, as the person. */
const ACTS = new Set(["resolveGate", "answer", "updateDelivery", "pullBack", "override"]);
const READS = new Set(["projectionFor", "recordedQuestion", "recordedDelivery", "recordedAttention", "recordedGate", "recordedChecksCard"]);

/** Run one answer through its hub handler, against a matching record; how many times did it act? */
async function acts(handler: Handler, content: Record<string, unknown>): Promise<number> {
  let acted = 0;
  const record = recordFor(handler, content, POSTED[handler]);
  const deps = new Proxy(
    {},
    {
      get: (_t, name) => {
        const n = String(name);
        if (n === "then") return undefined;
        if (READS.has(n)) return async () => record;
        if (ACTS.has(n)) return async () => ((acted += 1), { ok: true });
        if (n === "principalForMatrixId") return async () => ({ id: "prn_corpus", kind: "human" });
        if (n === "claimOutcome" || n === "markOutcomePosted") return async () => true;
        if (n === "now") return () => new Date("2026-01-01T00:00:00Z");
        return async () => null;
      },
    },
  ) as never;
  const event = { sender: SENDER, content };
  await HANDLE[handler](event, ROOM, deps);
  return acted;
}

const HANDLE: Record<Handler, (e: { sender: string; content: Record<string, unknown> }, room: string, deps: never) => Promise<unknown>> = {
  gates: handleGateDecision,
  questions: handleQuestionAnswer,
  deliveries: handleDeliveryAnswer,
  attention: handleAttentionAnswer,
  pullBacks: handleGatePullBack,
  checkOverrides: handleCheckOverride,
};

beforeAll(async () => {
  await ensurePgMigrations();
});

test("the corpus covers every answer type the hub routes", () => {
  for (const type of Object.keys(ROUTED)) {
    expect(Object.keys(schemas[type]?.valid ?? {}).length).toBeGreaterThan(0);
    expect(schemas[type]?.invalid.length ?? 0).toBeGreaterThan(0);
  }
});

/** One type's cases; the coverage test above fails first if a type is missing. */
const casesOf = (type: string) => schemas[type] ?? { valid: {}, invalid: [] };

for (const [type, handler] of Object.entries(ROUTED)) {
  describe(type, () => {
    for (const [label, content] of Object.entries(casesOf(type).valid)) {
      test(`reaches ${handler} alone, which carries it to the board once: ${label}`, async () => {
        expect(await route(content)).toEqual([handler]);
        expect(await acts(handler, content)).toBe(1);
      });
    }

    for (const c of casesOf(type).invalid.filter((k) => k.refusedBy !== "recorded")) {
      test(`is never carried to the board (${c.refusedBy}): ${c.why}`, async () => {
        const took = await route(c.body);
        // Refused by the routing parse, or routed to its own handler and refused there.
        expect(took.length === 0 || (took.length === 1 && took[0] === handler)).toBe(true);
        if (took.length === 1) expect(await acts(handler, c.body)).toBe(0);
      });
    }
  });
}

describe("dev.agentpod.permission.answer.v2", () => {
  for (const [label, content] of Object.entries(casesOf("dev.agentpod.permission.answer.v2").valid)) {
    test(`is an agent's answer, never a board's: ${label}`, async () => {
      expect(isPermissionAnswerMarked(content)).toBe(true);
      expect(await route(content)).toEqual([]);
    });
  }
});
