process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { OrgPlaneError } from "../org-plane/client";
import { AssertionMismatch } from "../../auth/service-signing";

import { db, rawSql } from "../../db/drizzle";
import { matrixElicitationEvents } from "../../db/schema/matrix";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { ELICITATION_REQUEST_CONTENT_KEY, type ElicitationPendingDelivery } from "./elicitation-card";
import {
  claimElicitationOutcome,
  handleElicitationAnswer,
  openQuestionInRoom,
  projectElicitation,
  answerElicitationAtSuperpipeline,
  type ElicitationAnswerDeps,
  type ElicitationProjectionDeps,
} from "./elicitations";

/**
 * Putting an agent's question in a room and taking the answer back.
 *
 * What is asserted hardest is the CLAIM — who is allowed to post, and who is allowed to
 * say the answer landed — because that is what makes the whole path safe to run twice.
 * Push redelivers, appservice transactions repeat, and people double-tap.
 *
 * `projectGate` paid for the rule these tests encode: a claim held over a failed send
 * leaves a row that every later pass reads as "already handled", so the question goes
 * invisible on both sides — somebody waiting on an answer, and nothing reporting a
 * fault.
 */
const ROOM = "!board-room:id.agentpod.dev";
const SPEAKER = "@agent_superpipeline:id.agentpod.dev";
const HUMAN = "@rakesh:id.agentpod.dev";
const RUN = crypto.randomUUID().slice(0, 8);

let n = 0;
const nextId = () => `elc_test_${RUN}_${++n}`;

function delivery(over: Partial<ElicitationPendingDelivery> = {}): ElicitationPendingDelivery {
  return {
    event: "elicitation.pending",
    boardId: `brd_test_${RUN}`,
    boardName: "Client Quality",
    cardId: "crd_a9619fe",
    cardTitle: "Add OAuth login",
    elicitationId: nextId(),
    runId: "run_12",
    stageKey: "research",
    agentId: "agt_r",
    question: "May I run the test suite?",
    options: [
      { id: "run_them", label: "Run the tests" },
      { id: "skip", label: "Skip them" },
    ],
    ts: "2026-10-02T12:00:00.000Z",
    ...over,
  };
}

// Event ids are unique across the whole file, not per rig. A homeserver never
// issues the same id twice, the schema enforces it, and a per-rig counter made two
// questions in one room collide — which is how that constraint got noticed.
let events = 0;

function rig(over: Partial<ElicitationProjectionDeps> = {}) {
  const sent: Array<{ roomId: string; body: string; extra?: Record<string, unknown> }> = [];
  const roomCalls: Array<{ boardId: string; boardName?: string }> = [];
  const deps: ElicitationProjectionDeps = {
    boardRoom: async (boardId, _tenantId, opts) => {
      roomCalls.push({ boardId, ...(opts?.boardName ? { boardName: opts.boardName } : {}) });
      return { roomId: ROOM, speakerMxid: SPEAKER };
    },
    sendText: async (_user, roomId, body, extra) => {
      sent.push({ roomId, body, extra });
      return `$event-${++events}`;
    },
    ...over,
  };
  return { deps, sent, roomCalls };
}

beforeAll(async () => {
  await ensurePgMigrations();
});

afterEach(async () => {
  await rawSql`DELETE FROM matrix_elicitation_events WHERE elicitation_id LIKE ${"elc_test_" + RUN + "%"}`;
});

describe("a question is posted into its board's room", () => {
  test("posts one message carrying the card inside it", async () => {
    const d = delivery();
    const { deps, sent } = rig();

    const out = await projectElicitation(BOOTSTRAP_TENANT_ID, d, deps);

    expect(out.status).toBe("posted");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.roomId).toBe(ROOM);
    expect(sent[0]!.body).toContain("May I run the test suite?");
    // One question is one event and one push: the card rides inside the prose.
    expect(sent[0]!.extra?.[ELICITATION_REQUEST_CONTENT_KEY]).toBeDefined();
  });

  test("records the event id, the options, and the room", async () => {
    const d = delivery();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);

    const [row] = await db
      .select()
      .from(matrixElicitationEvents)
      .where(eq(matrixElicitationEvents.elicitationId, d.elicitationId));
    expect(row!.roomId).toBe(ROOM);
    expect(row!.eventId).toMatch(/^\$event-\d+$/);
    // Not a `pending:` placeholder — a row left at that is a question nothing will
    // ever treat as open.
    expect(row!.eventId.startsWith("pending:")).toBe(false);
    expect(JSON.parse(row!.optionsJson)).toEqual(d.options);
  });

  test("carries the board's name to the room, so the room gets named", async () => {
    const { deps, roomCalls } = rig();
    await projectElicitation(BOOTSTRAP_TENANT_ID, delivery(), deps);
    expect(roomCalls[0]!.boardName).toBe("Client Quality");
  });

  test("does not ask for a rename when the board sent no name", async () => {
    const { deps, roomCalls } = rig();
    await projectElicitation(BOOTSTRAP_TENANT_ID, delivery({ boardName: null }), deps);
    expect(roomCalls[0]).not.toHaveProperty("boardName");
  });

  test("a redelivered question is posted once", async () => {
    // Push retries. Two messages for one question would read as two questions.
    const d = delivery();
    const first = rig();
    const second = rig();

    expect((await projectElicitation(BOOTSTRAP_TENANT_ID, d, first.deps)).status).toBe("posted");
    expect((await projectElicitation(BOOTSTRAP_TENANT_ID, d, second.deps)).status).toBe("already");
    expect(second.sent).toHaveLength(0);
  });

  test("no room means nothing is recorded, so a later pass can try again", async () => {
    const d = delivery();
    const { deps } = rig({ boardRoom: async () => null });

    expect((await projectElicitation(BOOTSTRAP_TENANT_ID, d, deps)).status).toBe("no-room");

    const rows = await db
      .select()
      .from(matrixElicitationEvents)
      .where(eq(matrixElicitationEvents.elicitationId, d.elicitationId));
    expect(rows).toHaveLength(0);
  });

  test("a send that THROWS gives the claim back", async () => {
    // The failure `projectGate` paid for: a claim held over a failed send leaves a row
    // every later pass reads as handled, and the question is invisible on both sides.
    const d = delivery();
    const { deps } = rig({
      sendText: async () => {
        throw new Error("M_FORBIDDEN");
      },
    });

    await expect(projectElicitation(BOOTSTRAP_TENANT_ID, d, deps)).rejects.toThrow("M_FORBIDDEN");

    const rows = await db
      .select()
      .from(matrixElicitationEvents)
      .where(eq(matrixElicitationEvents.elicitationId, d.elicitationId));
    expect(rows).toHaveLength(0);
  });

  test("re-throws rather than reporting an outcome, so push keeps retrying", async () => {
    // Converting a failed send into a 200 would quietly retire push's own retry and
    // leave the sweep as the only path.
    const { deps } = rig({
      sendText: async () => {
        throw new Error("boom");
      },
    });
    await expect(projectElicitation(BOOTSTRAP_TENANT_ID, delivery(), deps)).rejects.toThrow("boom");
  });

  test("a refused send releases the claim and says so", async () => {
    const d = delivery();
    const { deps } = rig({ sendText: async () => null });

    expect((await projectElicitation(BOOTSTRAP_TENANT_ID, d, deps)).status).toBe("not-accepted");
    const rows = await db
      .select()
      .from(matrixElicitationEvents)
      .where(eq(matrixElicitationEvents.elicitationId, d.elicitationId));
    expect(rows).toHaveLength(0);
  });
});

describe("the question a room is waiting on", () => {
  test("is the one that was posted", async () => {
    const d = delivery();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);

    const open = await openQuestionInRoom(ROOM);
    expect(open!.elicitationId).toBe(d.elicitationId);
    expect(open!.options).toEqual(d.options);
  });

  test("is nothing in a room with no question", async () => {
    expect(await openQuestionInRoom("!quiet:id.agentpod.dev")).toBeNull();
  });

  test("is NOT a question still mid-send", async () => {
    // Its message is not in the room yet, so nothing in the room can be a reply to it.
    // Treating it as open would let an unrelated message answer a question nobody saw.
    const d = delivery();
    await db.insert(matrixElicitationEvents).values({
      elicitationId: d.elicitationId,
      tenantId: BOOTSTRAP_TENANT_ID,
      boardId: d.boardId,
      cardId: d.cardId,
      roomId: ROOM,
      eventId: `pending:${d.elicitationId}`,
      optionsJson: JSON.stringify(d.options),
    });

    expect(await openQuestionInRoom(ROOM)).toBeNull();
  });

  test("is NOT a question whose outcome was already posted", async () => {
    const d = delivery();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    expect(await claimElicitationOutcome(d.elicitationId)).toBe(true);

    expect(await openQuestionInRoom(ROOM)).toBeNull();
  });

  test("is the NEWEST when a card asked again", async () => {
    // The board retires the previous question when an agent asks again, so the room's
    // open question is the latest one. Answering the older one would answer something
    // the board has already closed.
    const older = delivery({ question: "First?" });
    await projectElicitation(BOOTSTRAP_TENANT_ID, older, rig().deps);
    await new Promise((r) => setTimeout(r, 5));
    const newer = delivery({ question: "Second?" });
    await projectElicitation(BOOTSTRAP_TENANT_ID, newer, rig().deps);

    expect((await openQuestionInRoom(ROOM))!.elicitationId).toBe(newer.elicitationId);
  });
});

describe("two questions cannot share one message", () => {
  test("a second question projected onto the same event id is refused", async () => {
    // Enforced by `matrix_elicitation_events_event_idx`, and not theoretical: a test
    // rig that reused an id hit it immediately. A reply arrives holding a room and
    // needing the question, so two questions on one message would make the first
    // unanswerable — and silently, because the newer row would simply win.
    const first = delivery();
    await projectElicitation(BOOTSTRAP_TENANT_ID, first, rig().deps);

    const second = delivery();
    const fixed = rig({ sendText: async () => "$event-collide" });
    await projectElicitation(BOOTSTRAP_TENANT_ID, second, fixed.deps);
    const third = delivery();
    const same = rig({ sendText: async () => "$event-collide" });

    await expect(projectElicitation(BOOTSTRAP_TENANT_ID, third, same.deps)).rejects.toThrow();
  });
});

describe("saying the answer landed, exactly once", () => {
  test("the claim is true once and false afterwards", async () => {
    const d = delivery();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);

    expect(await claimElicitationOutcome(d.elicitationId)).toBe(true);
    expect(await claimElicitationOutcome(d.elicitationId)).toBe(false);
  });

  test("a question nobody projected cannot be claimed", async () => {
    expect(await claimElicitationOutcome(`elc_test_${RUN}_absent`)).toBe(false);
  });
});

function answerRig(over: Partial<ElicitationAnswerDeps> = {}) {
  const replies: string[] = [];
  const answered: Array<{ elicitationId: string; option: string; principalId: string; senderMxid: string }> = [];
  const deps: ElicitationAnswerDeps = {
    principalForMatrixId: async () => ({ id: "prn_human", kind: "user" }),
    answer: async (input) => {
      answered.push({
        elicitationId: input.elicitationId,
        option: input.option,
        principalId: input.principalId,
        senderMxid: input.senderMxid,
      });
      return { ok: true };
    },
    reply: async (_roomId, body) => void replies.push(body),
    claimOutcome: claimElicitationOutcome,
    ...over,
  };
  return { deps, replies, answered };
}

describe("a reply in a board room, read as an answer", () => {
  test("a number answers the question", async () => {
    // The only reason this works from any Matrix client on day one.
    const d = delivery();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    const { deps, answered, replies } = answerRig();

    const out = await handleElicitationAnswer({ sender: HUMAN, body: "2" }, ROOM, deps);

    expect(out).toEqual({ status: "answered", elicitationId: d.elicitationId });
    expect(answered[0]!.option).toBe("skip");
    expect(answered[0]!.principalId).toBe("prn_human");
    // The sender's mxid travels with the answer: under the plane it, not the prn_, is asserted.
    expect(answered[0]!.senderMxid).toBe(HUMAN);
    expect(replies[0]).toContain("Skip them");
  });

  test("an option's label answers it too", async () => {
    const d = delivery();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    const { deps, answered } = answerRig();

    await handleElicitationAnswer({ sender: HUMAN, body: "Run the tests" }, ROOM, deps);
    expect(answered[0]!.option).toBe("run_them");
  });

  test("says nothing at all in a room with no open question", async () => {
    // Most messages in a board room are not answers. Replying "there is no question"
    // to ordinary conversation would make the room unusable.
    const { deps, replies } = answerRig();
    const out = await handleElicitationAnswer({ sender: HUMAN, body: "morning" }, "!quiet:x", deps);

    expect(out.status).toBe("no-question");
    expect(replies).toHaveLength(0);
  });

  test("an unmatched reply gets the options back, not a scolding", async () => {
    const d = delivery();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    const { deps, replies, answered } = answerRig();

    const out = await handleElicitationAnswer({ sender: HUMAN, body: "yes please" }, ROOM, deps);

    expect(out.status).toBe("unmatched");
    expect(answered).toHaveLength(0);
    expect(replies[0]).toContain("Run the tests");
    expect(replies[0]).toContain("Skip them");
  });

  test("a question with no options is not answerable here", async () => {
    // Buttons-only by decision; the prose already said to answer it on the board.
    const d = delivery({ options: [] });
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    const { deps, replies, answered } = answerRig();

    const out = await handleElicitationAnswer({ sender: HUMAN, body: "the long one" }, ROOM, deps);

    expect(out.status).toBe("not-an-answer");
    expect(answered).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  test("a sender this hub cannot resolve is refused, and the board is not called", async () => {
    // An answer's whole value is the record of who gave it, so guessing is worse than
    // refusing.
    const d = delivery();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    const { deps, answered } = answerRig({ principalForMatrixId: async () => null });

    const out = await handleElicitationAnswer({ sender: "@stranger:elsewhere", body: "1" }, ROOM, deps);

    expect(out).toEqual({ status: "refused", code: "UNRESOLVED_SENDER" });
    expect(answered).toHaveLength(0);
  });

  test("a plane outage while resolving the sender is refused as IDENTITY_UNAVAILABLE and said in the room", async () => {
    // Design §5.7: the one plane call on an authorization path. Down is not "unresolved".
    const d = delivery();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    const { deps, answered, replies } = answerRig({
      principalForMatrixId: async () => {
        throw new OrgPlaneError(0, "unreachable");
      },
    });

    const out = await handleElicitationAnswer({ sender: HUMAN, body: "1" }, ROOM, deps);

    expect(out).toEqual({ status: "refused", code: "IDENTITY_UNAVAILABLE" });
    expect(answered).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("cannot check who you are");
    expect(await openQuestionInRoom(ROOM)).not.toBeNull();
  });

  test("a question already settled on the board says so once", async () => {
    const d = delivery();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    const { deps, replies } = answerRig({
      answer: async () => ({ ok: false, code: "ELICITATION_NOT_PENDING" }),
    });

    const first = await handleElicitationAnswer({ sender: HUMAN, body: "1" }, ROOM, deps);
    expect(first).toEqual({ status: "refused", code: "ELICITATION_NOT_PENDING" });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("already settled");

    // A double tap must not leave a second line. The question is no longer open after
    // the claim, so the second attempt finds nothing to answer.
    const second = await handleElicitationAnswer({ sender: HUMAN, body: "1" }, ROOM, deps);
    expect(second.status).toBe("no-question");
    expect(replies).toHaveLength(1);
  });

  test("a double tap on a question that WORKED leaves one receipt", async () => {
    const d = delivery();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    const { deps, replies, answered } = answerRig();

    await handleElicitationAnswer({ sender: HUMAN, body: "1" }, ROOM, deps);
    await handleElicitationAnswer({ sender: HUMAN, body: "1" }, ROOM, deps);

    expect(answered).toHaveLength(1);
    expect(replies).toHaveLength(1);
  });

  test("any other refusal is reported without claiming the outcome", async () => {
    // A refusal that might not be final must leave the question answerable, so the
    // reader can try again.
    const d = delivery();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    const { deps, replies } = answerRig({
      answer: async () => ({ ok: false, code: "UNREACHABLE" }),
    });

    const out = await handleElicitationAnswer({ sender: HUMAN, body: "1" }, ROOM, deps);

    expect(out).toEqual({ status: "refused", code: "UNREACHABLE" });
    expect(replies[0]).toContain("UNREACHABLE");
    expect(await openQuestionInRoom(ROOM)).not.toBeNull();
  });
});

describe("handing the answer to the board", () => {
  test.each([
    ["plane unreachable", new OrgPlaneError(0, "unreachable"), "IDENTITY_UNAVAILABLE"],
    ["plane 409 not_human", new OrgPlaneError(409, "not_human"), "ASSERTION_REFUSED"],
    ["a different sub", new AssertionMismatch("prn_0000000000000000000a", "prn_0000000000000000000f"), "ASSERTION_MISMATCH"],
  ])("a mint that fails with %s is %s, and the board is not called", async (_label, error, code) => {
    let called = 0;
    const result = await answerElicitationAtSuperpipeline(
      { boardId: "brd_x", elicitationId: "elc_y", option: "skip", principalId: "prn_h", senderMxid: "@h:id.test" },
      {
        baseUrl: "https://board.test",
        mint: async () => {
          throw error;
        },
        fetch: (async () => (called++, new Response("{}", { status: 200 }))) as unknown as typeof fetch,
      },
    );
    expect(result).toEqual({ ok: false, code });
    expect(called).toBe(0);
  });

  test("an assertion the plane could not give is a failed receipt, and the question stays open", async () => {
    const d = delivery();
    await projectElicitation(BOOTSTRAP_TENANT_ID, d, rig().deps);
    const { deps, replies } = answerRig({ answer: async () => ({ ok: false, code: "IDENTITY_UNAVAILABLE" }) });

    const out = await handleElicitationAnswer({ sender: HUMAN, body: "1" }, ROOM, deps);

    expect(out).toEqual({ status: "refused", code: "IDENTITY_UNAVAILABLE" });
    expect(replies[0]).toContain("cannot check who you are");
    expect(await openQuestionInRoom(ROOM)).not.toBeNull();
  });

  test("posts the option to the board's answer route, as the person", async () => {
    const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const minted: unknown[] = [];
    const result = await answerElicitationAtSuperpipeline(
      { boardId: "brd_x", elicitationId: "elc_y", option: "skip", principalId: "prn_h", senderMxid: "@h:id.test" },
      {
        baseUrl: "https://board.test/",
        mint: async (s) => (minted.push(s), `assertion-for-${s.principalId}`),
        fetch: (async (url: string, init: RequestInit) => {
          calls.push({
            url,
            auth: new Headers(init.headers).get("Authorization"),
            body: JSON.parse(init.body as string),
          });
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      },
    );

    expect(result).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("https://board.test/v1/boards/brd_x/elicitations/elc_y/answer");
    // As the person who answered, never as the hub or the agent.
    expect(calls[0]!.auth).toBe("Bearer assertion-for-prn_h");
    // mint is handed both the principal and the sender (contract §3.4b).
    expect(minted).toEqual([{ principalId: "prn_h", senderMxid: "@h:id.test" }]);
    expect(calls[0]!.body).toEqual({ option: "skip" });
  });

  test("reports the board's own refusal code, not the status", async () => {
    // A question that is gone, one already answered, and an option never offered are
    // three different situations with the same shape.
    const result = await answerElicitationAtSuperpipeline(
      { boardId: "brd_x", elicitationId: "elc_y", option: "skip", principalId: "prn_h", senderMxid: "@h:id.test" },
      {
        baseUrl: "https://board.test",
        mint: async () => "t",
        fetch: (async () =>
          new Response(JSON.stringify({ error: { code: "ELICITATION_NOT_PENDING" } }), {
            status: 409,
          })) as unknown as typeof fetch,
      },
    );
    expect(result).toEqual({ ok: false, code: "ELICITATION_NOT_PENDING" });
  });

  test("distinguishes the network from a refusal", async () => {
    // A refusal is final; this is not, so the reader should be able to answer again.
    const result = await answerElicitationAtSuperpipeline(
      { boardId: "brd_x", elicitationId: "elc_y", option: "skip", principalId: "prn_h", senderMxid: "@h:id.test" },
      {
        baseUrl: "https://board.test",
        mint: async () => "t",
        fetch: (async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
      },
    );
    expect(result).toEqual({ ok: false, code: "UNREACHABLE" });
  });

  test("falls back to the status when the board sends no code", async () => {
    const result = await answerElicitationAtSuperpipeline(
      { boardId: "brd_x", elicitationId: "elc_y", option: "skip", principalId: "prn_h", senderMxid: "@h:id.test" },
      {
        baseUrl: "https://board.test",
        mint: async () => "t",
        fetch: (async () => new Response("gateway down", { status: 502 })) as unknown as typeof fetch,
      },
    );
    expect(result).toEqual({ ok: false, code: "HTTP_502" });
  });
});
