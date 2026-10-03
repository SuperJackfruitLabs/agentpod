import { describe, expect, test } from "bun:test";

import { createSuperpipelinePushRoutes, type SuperpipelinePushDeps } from "./superpipeline-push";

/**
 * The signed door a board pushes a gate through.
 *
 * Everything here is about refusing. The projection itself needs a database and
 * is covered where it lives; what this file protects is that nothing reaches it
 * without superpipeline's signature over the exact bytes it sent.
 */

const SECRET = "s3cret";

const DELIVERY = {
  event: "gate.pending",
  boardId: "brd_7c1f",
  cardId: "crd_9a22",
  gateId: "gate_4e8b",
  stageKey: "review",
  returnStageKey: "code",
  cardTitle: "Add OAuth login",
  producedBy: "agt_31d0",
  options: [{ id: "approve", label: "Approve" }],
  ts: "2026-08-30T00:00:00.000Z",
};

async function sign(secret: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function deps(over: Partial<SuperpipelinePushDeps> = {}): SuperpipelinePushDeps & { projected: unknown[] } {
  const projected: unknown[] = [];
  return {
    secret: SECRET,
    domain: "id.agentpod.dev",
    tenantIdFor: async () => "fleet_00000000000000000001",
    sendText: async () => "$prose",
    sendCustomEvent: async (_u, _r, _t, content) => {
      projected.push(content);
      return "$gate";
    },
    projected,
    ...over,
  } as SuperpipelinePushDeps & { projected: unknown[] };
}

async function post(d: SuperpipelinePushDeps, raw: string, signature?: string) {
  const app = createSuperpipelinePushRoutes(d);
  return app.request("/bridge/superpipeline/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(signature ? { "X-Superpipeline-Signature": signature } : {}),
    },
    body: raw,
  });
}

describe("the signed push receiver", () => {
  test("refuses an unsigned request", async () => {
    const raw = JSON.stringify(DELIVERY);
    expect((await post(deps(), raw)).status).toBe(401);
  });

  test("refuses a signature over different bytes", async () => {
    const raw = JSON.stringify(DELIVERY);
    // Signed the right shape, sent a different card: the classic replay-with-edit.
    const other = JSON.stringify({ ...DELIVERY, cardTitle: "Delete production" });
    expect((await post(deps(), other, await sign(SECRET, raw))).status).toBe(401);
  });

  test("refuses a signature made with the wrong secret", async () => {
    const raw = JSON.stringify(DELIVERY);
    expect((await post(deps(), raw, await sign("not-the-secret", raw))).status).toBe(401);
  });

  test("refuses everything when no secret is configured", async () => {
    // An unset secret must never mean "accept anything" — that is the mistake
    // that turns a webhook into a public write endpoint.
    const raw = JSON.stringify(DELIVERY);
    const res = await post(deps({ secret: undefined }), raw, await sign(SECRET, raw));
    expect(res.status).toBe(503);
  });

  test("refuses a truncated signature without leaking how far it matched", async () => {
    const raw = JSON.stringify(DELIVERY);
    const good = await sign(SECRET, raw);
    expect((await post(deps(), raw, good.slice(0, -2))).status).toBe(401);
  });

  test("treats malformed JSON as terminal rather than retryable", async () => {
    const raw = "{not json";
    expect((await post(deps(), raw, await sign(SECRET, raw))).status).toBe(400);
  });

  test("acknowledges an event it does not handle instead of making the board retry", async () => {
    // work.available and gate.resolved arrive here too. A non-2xx would make
    // superpipeline retry something this build will never like.
    const raw = JSON.stringify({ event: "work.available", boardId: "brd_7c1f" });
    const res = await post(deps(), raw, await sign(SECRET, raw));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: true });
  });

  test("refuses a gate.pending with no gate id", async () => {
    const raw = JSON.stringify({ ...DELIVERY, gateId: "" });
    const res = await post(deps(), raw, await sign(SECRET, raw));
    expect(await res.json()).toMatchObject({ ignored: true });
  });

  test("refuses a board mapped to no fleet", async () => {
    // The correct refusal. A default would project one tenant's approval into
    // another's room.
    const raw = JSON.stringify(DELIVERY);
    const res = await post(deps({ tenantIdFor: async () => null }), raw, await sign(SECRET, raw));
    expect(res.status).toBe(404);
  });
});

/**
 * A board telling the hub an agent is blocked on a person.
 *
 * The same door as a gate, the same signature, and the same refusal to guess: a body
 * this build does not recognise is answered 200-and-ignored, because a non-2xx makes
 * the board retry something it will never like.
 */
const ELICITATION = {
  event: "elicitation.pending",
  boardId: "brd_7c1f",
  boardName: "Client Quality",
  cardId: "crd_9a22",
  cardTitle: "Add OAuth login",
  elicitationId: "elc_4e8b",
  runId: "run_12",
  stageKey: "research",
  agentId: "agt_31d0",
  question: "May I run the test suite?",
  options: [
    { id: "run_them", label: "Run the tests" },
    { id: "skip", label: "Skip them" },
  ],
  ts: "2026-10-02T12:00:00.000Z",
};

test("a signed elicitation.pending is routed to the elicitation projection", async () => {
  // This file tests the DOOR, not what happens through it: the projection's own
  // behaviour — the card, the claim, the release on a failed send — is covered
  // against a database in `elicitations.test.ts`. Here the board room is refused, so
  // the projection answers `no-room` before it writes anything, and the outcome in
  // the response is what proves the body reached the elicitation path rather than
  // being ignored as an unknown shape.
  // A list, not a `let`: TypeScript cannot see a callback run, so a nullable
  // variable narrows to `null` and the assertion below stops compiling.
  const askedFor: string[] = [];
  const d = deps({
    boardRoom: async (boardId: string) => {
      askedFor.push(boardId);
      return null;
    },
  });
  const raw = JSON.stringify(ELICITATION);

  const res = await post(d, raw, await sign(SECRET, raw));

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, status: "no-room" });
  expect(askedFor).toEqual([ELICITATION.boardId]);
});

test("an unsigned elicitation is refused, exactly as a gate is", async () => {
  const d = deps();
  const raw = JSON.stringify(ELICITATION);
  const res = await post(d, raw, "sha256=deadbeef");
  expect(res.status).toBe(401);
});

test("an elicitation for a board this hub does not know is 404, not a crash", async () => {
  const d = deps({ tenantIdFor: async () => null });
  const raw = JSON.stringify(ELICITATION);
  const res = await post(d, raw, await sign(SECRET, raw));
  expect(res.status).toBe(404);
});

test("an elicitation missing the id an answer is addressed to is ignored, not projected", async () => {
  // The predicate's whole job: a board a version ahead or behind must not have this
  // hub posting a question nobody can answer, which reads like a button that does
  // nothing.
  const said: unknown[] = [];
  const d = deps({ sendText: async () => { said.push(1); return "$x"; } });
  const { elicitationId: _gone, ...without } = ELICITATION;
  const raw = JSON.stringify(without);

  const res = await post(d, raw, await sign(SECRET, raw));

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ignored: true });
  expect(said).toHaveLength(0);
});
