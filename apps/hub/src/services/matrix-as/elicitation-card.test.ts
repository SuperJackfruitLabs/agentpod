import { describe, expect, test } from "bun:test";

import { ElicitationRequestCard } from "@agentpod/contract";

import {
  elicitationProseBody,
  elicitationRequestCard,
  isElicitationPending,
  type ElicitationPendingDelivery,
} from "./elicitation-card";

/**
 * An agent's question, turned into something a person can answer from a room.
 *
 * The pure half of the projection: what the message says, what the card carries, and
 * whether a body off the wire is a question this build knows how to post. No homeserver
 * and no database, so each rule can be read on its own.
 *
 * The thing to keep in view while reading: the PROSE is the answerable surface and the
 * CARD is the convenience. A client that has never heard of
 * `dev.superpipeline.elicitation` still shows the prose, and a reply of "2" still
 * resolves — which is why the prose lists every option and the card does not have to.
 */

const BASE: ElicitationPendingDelivery = {
  event: "elicitation.pending",
  boardId: "brd_6a899b0f0d054046",
  boardName: "Client Quality",
  cardId: "crd_a9619fe",
  cardTitle: "Add OAuth login",
  elicitationId: "elc_7f3c",
  runId: "run_12",
  stageKey: "research",
  agentId: "agt_r",
  question: "May I run the test suite?",
  options: [
    { id: "run_them", label: "Run the tests" },
    { id: "skip", label: "Skip them" },
  ],
  ts: "2026-10-02T12:00:00.000Z",
};

const five = Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));

describe("is this a question this build knows how to post?", () => {
  test("accepts a question with everything it needs", () => {
    expect(isElicitationPending(BASE)).toBe(true);
  });

  test("accepts a question with no options", () => {
    expect(isElicitationPending({ ...BASE, options: [] })).toBe(true);
  });

  test("refuses anything without the id an answer is addressed to", () => {
    // The predicate exists because "authenticated" is not "checked". A board a version
    // ahead or behind would otherwise have this hub posting a question nobody can
    // answer, which looks to a reader exactly like a button that does nothing.
    expect(isElicitationPending({ ...BASE, elicitationId: "" })).toBe(false);
    const { elicitationId: _gone, ...without } = BASE;
    expect(isElicitationPending(without)).toBe(false);
  });

  test("refuses another event that travels the same route", () => {
    expect(isElicitationPending({ ...BASE, event: "gate.pending" })).toBe(false);
    expect(isElicitationPending({ event: "work.available", boardId: "brd_x" })).toBe(false);
  });

  test("refuses the shapes a bad payload actually takes", () => {
    expect(isElicitationPending(null)).toBe(false);
    expect(isElicitationPending("elicitation.pending")).toBe(false);
    expect(isElicitationPending({ ...BASE, options: "run_them" })).toBe(false);
  });
});

describe("what the room is told", () => {
  test("names the card and the agent that is waiting", () => {
    const body = elicitationProseBody(BASE);
    expect(body).toContain("Add OAuth login");
    expect(body).toContain("May I run the test suite?");
  });

  test("numbers every option, and says how to reply", () => {
    // The numbers are not decoration: a reply of "1" is matched against them, and this
    // is the only place a reader learns that is possible.
    const body = elicitationProseBody(BASE);
    expect(body).toContain("1. Run the tests");
    expect(body).toContain("2. Skip them");
    expect(body.toLowerCase()).toContain("reply");
  });

  test("lists all five options even though only four get a button", () => {
    const body = elicitationProseBody({ ...BASE, options: five });
    expect(body).toContain("5. Option 4");
  });

  test("says so when an option will have no button", () => {
    // The cap is applied where it can still be reported. A reader who sees four buttons
    // and a fifth option in the text needs to be told the fifth is answerable by number
    // rather than left to assume it was dropped.
    const body = elicitationProseBody({ ...BASE, options: five });
    expect(body.toLowerCase()).toContain("button");
    expect(elicitationProseBody(BASE).toLowerCase()).not.toContain("button");
  });

  test("a question with no options says where it can be answered instead", () => {
    // Buttons-only was the decision, so this hub cannot take a typed answer. Pretending
    // the question is tappable would be worse than sending the reader to the board.
    const body = elicitationProseBody({ ...BASE, options: [], question: "What should the headline say?" });
    expect(body).toContain("What should the headline say?");
    expect(body.toLowerCase()).toContain("board");
    expect(body).not.toContain("1.");
  });

  test("a question with no text still reads as a question", () => {
    // An agent can stop on options alone. An empty prompt must not produce a message
    // that looks like a failed render.
    const body = elicitationProseBody({ ...BASE, question: "" });
    expect(body.trim()).not.toBe("");
    expect(body).toContain("Add OAuth login");
  });

  test("carries the card's link when there is one", () => {
    const body = elicitationProseBody(BASE, "https://board.test/b/brd_6a899b0f0d054046/c/crd_a9619fe");
    expect(body).toContain("https://board.test/b/brd_6a899b0f0d054046/c/crd_a9619fe");
  });
});

describe("the card a client draws buttons from", () => {
  test("is exactly what the contract accepts", () => {
    expect(ElicitationRequestCard.safeParse(elicitationRequestCard(BASE)).success).toBe(true);
  });

  test("carries the id an answer is addressed to", () => {
    expect(elicitationRequestCard(BASE).elicitation_id).toBe("elc_7f3c");
  });

  test("caps the buttons at four, keeping the first four in order", () => {
    const card = elicitationRequestCard({ ...BASE, options: five });
    expect(ElicitationRequestCard.safeParse(card).success).toBe(true);
    expect(card.options.map((o) => o.id)).toEqual(["o0", "o1", "o2", "o3"]);
  });

  test("is valid with no options at all", () => {
    const card = elicitationRequestCard({ ...BASE, options: [] });
    expect(ElicitationRequestCard.safeParse(card).success).toBe(true);
    expect(card.options).toEqual([]);
  });

  test("does not carry the prose body — the message already has it", () => {
    // The gate card made the same choice for the same reason: one fact, one place.
    expect(elicitationRequestCard(BASE)).not.toHaveProperty("body");
  });

  test("omits the link rather than carrying an empty one", () => {
    expect(elicitationRequestCard(BASE)).not.toHaveProperty("deep_link");
    expect(elicitationRequestCard(BASE, "https://board.test/x").deep_link).toBe("https://board.test/x");
  });
});
