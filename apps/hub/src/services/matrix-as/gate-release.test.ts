import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { DecisionPulledBackDelivery, DecisionReleasedDelivery } from "../bridge";
import {
  GATE_DECISION_V2_SUITE_TYPE,
  GATE_OUTCOME_TYPE,
  GATE_V2_SUITE_TYPE,
  gateOptionsV2,
  gateV2Content,
  handleGateDecision,
  type GateDecisionDeps,
  type GatePendingDelivery,
} from "../board-chat/gates";
import {
  DECISION_PULLED_BACK_TYPE,
  DECISION_RELEASED_TYPE,
  GATE_PULL_BACK_V2_SUITE_TYPE,
  holdText,
  isDecisionPulledBack,
  isDecisionReleased,
  parsePullBack,
  pulledBackBody,
  pulledBackContent,
  releaseSentence,
  releaseTimeText,
  releaseV2,
  releasedBody,
  releasedContent,
} from "@superjackfruitlabs/treaty-matrix-events";
import { PULL_BACK_COMMENT_REQUIRED_TEXT, handleGatePullBack, type PullBackDeps, type PullBackRefusal } from "../board-chat/gate-pull-back";
import { bridgeGateSweepDeps, sweepGates } from "../board-chat/gate-sweep";
import { pullBackAtSuperpipeline } from "../board-chat/gate-resolve";
import { handleRoomMessage, type InboundDeps } from "./inbound";

/**
 * An approval may wait for its release time (charter → `decisions/2026-11-09-an-approval-may-wait-for-its-release-time.md`).
 * The hub carries the hold on gate.v2, names the release time in a held approval's receipt, replies
 * to the gate's card when the approval is released or pulled back, and carries a pull-back from chat
 * as the person. Pinned against treaty's `fixtures/ecosystem-identity/matrix_gate_events.json` (`variant: "release"`).
 */

const LINK = "https://superpipeline.dev/b/brd_7c1f/c/crd_8a40";
const GATE_EVENT = "$gateEventId";
const MONDAY = "2026-11-16T09:00:00.000Z";

const GATE: GatePendingDelivery = {
  event: "gate.pending",
  boardId: "brd_7c1f",
  cardId: "crd_8a40",
  gateId: "gate_6e19",
  stageKey: "release",
  returnStageKey: "build",
  cardTitle: "Ship the release",
  producedBy: "agt_31d0",
  options: [
    { id: "approve", label: "Approve", meaning: "approve", needsComment: false },
    { id: "request_changes", label: "Request changes", meaning: "revise", needsComment: true },
    { id: "reject", label: "Reject", meaning: "reject", needsComment: false },
  ],
  release: { holdForMinutes: 30, notBefore: MONDAY },
  ts: "2026-11-09T09:00:00.000Z",
};

const RELEASED: DecisionReleasedDelivery = {
  event: "decision.released",
  boardId: "brd_7c1f",
  cardId: "crd_8a40",
  gateId: "gate_6e19",
  decision: "approve",
  releaseAt: MONDAY,
  releasedAt: "2026-11-16T09:03:00.000Z",
  outcome: "released",
};

const PULLED: DecisionPulledBackDelivery = {
  event: "decision.pulled_back",
  boardId: "brd_7c1f",
  cardId: "crd_8a40",
  gateId: "gate_6e19",
  pulledBackBy: "prn_rakesh",
  at: "2026-11-16T08:40:00.000Z",
  comment: "wrong image",
};

describe("gate.v2 carries what would hold an approval", () => {
  test("snake_case beside the options, and one sentence in the prose", () => {
    const c = gateV2Content(GATE, LINK);
    expect(c.release).toEqual({ hold_for_minutes: 30, not_before: MONDAY });
    expect(String(c.body).endsWith("\n\nIf approved, it goes ahead after Mon 16 Nov, 09:00 UTC, and no sooner than 30 minutes after the approval.")).toBe(true);
  });

  test("a gate nothing holds is byte-identical to before: no release key, no sentence", () => {
    const { release: _r, ...plain } = GATE;
    const c = gateV2Content(plain, LINK);
    expect(c).not.toHaveProperty("release");
    expect(String(c.body)).not.toContain("If approved");
    expect(gateV2Content({ ...GATE, release: undefined }, LINK)).toEqual(c);
  });

  test("a malformed release is not carried at all, not even its good half", () => {
    const bad: unknown[] = [
      null,
      "30",
      [],
      {},
      { holdForMinutes: 4 },
      { holdForMinutes: 10_081 },
      { holdForMinutes: 30.5 },
      { holdForMinutes: "30" },
      { notBefore: "next Monday" },
      { notBefore: "2026-13-40T09:00:00Z" },
      { holdForMinutes: 0, notBefore: MONDAY },
      { holdForMinutes: 30, notBefore: 1_700_000_000 },
    ];
    for (const release of bad) {
      expect(releaseV2(release), JSON.stringify(release)).toBeNull();
      const c = gateV2Content({ ...GATE, release }, LINK);
      expect(c, JSON.stringify(release)).not.toHaveProperty("release");
      expect(String(c.body), JSON.stringify(release)).not.toContain("If approved");
    }
    // The edges hold.
    expect(releaseV2({ holdForMinutes: 5 })).toEqual({ hold_for_minutes: 5 });
    expect(releaseV2({ holdForMinutes: 10_080 })).toEqual({ hold_for_minutes: 10_080 });
  });

  test("times and holds read as a person says them", () => {
    expect(releaseTimeText(MONDAY)).toBe("Mon 16 Nov, 09:00 UTC");
    expect(releaseTimeText("2026-11-13T23:30:00+05:30")).toBe("Fri 13 Nov, 18:00 UTC");
    expect(holdText(30)).toBe("30 minutes");
    expect(holdText(90)).toBe("90 minutes");
    expect(holdText(120)).toBe("2 hours");
    expect(holdText(60)).toBe("1 hour");
    expect(holdText(10_080)).toBe("7 days");
    expect(releaseSentence({ hold_for_minutes: 30 })).toBe("If approved, it waits 30 minutes before it goes ahead.");
    expect(releaseSentence({ not_before: MONDAY })).toBe("If approved, it goes ahead after Mon 16 Nov, 09:00 UTC.");
  });
});

// ── A held approval's outcome receipt ───────────────────────────────────────

type Read = Awaited<ReturnType<NonNullable<GateDecisionDeps["readGate"]>>>;

function decisionDeps(read: Read | (() => Promise<Read>), over: Partial<GateDecisionDeps> = {}) {
  const replies: string[] = [];
  const outcomes: Array<Record<string, unknown>> = [];
  const resolved: unknown[] = [];
  const value: GateDecisionDeps = {
    principalForMatrixId: async () => ({ id: "prn_rakesh", kind: "human" as const }),
    projectionFor: async () => ({
      tenantId: "fleet_1",
      boardId: GATE.boardId,
      eventId: GATE_EVENT,
      options: gateOptionsV2(GATE),
      subjectId: null,
      subjectPreviewComplete: null,
      variants: null,
      quorum: null,
    }),
    resolveGate: async (i) => {
      resolved.push(i);
      return { ok: true };
    },
    readGate: typeof read === "function" ? read : async () => read,
    reply: async (_r, b) => {
      replies.push(b);
      return null;
    },
    sendOutcome: async (_r, c) => {
      outcomes.push(c);
      return null;
    },
    displayNameFor: async () => "rakesh",
    markOutcomePosted: async () => true,
    ...over,
  };
  return { deps: value, replies, outcomes, resolved };
}

const approval = (over: Record<string, unknown> = {}) => ({
  msgtype: "m.text",
  body: "Approved",
  schema_version: 1,
  suite_event_type: GATE_DECISION_V2_SUITE_TYPE,
  gate_id: "gate_6e19",
  option_id: "approve",
  "m.relates_to": { rel_type: "m.reference", event_id: GATE_EVENT },
  ...over,
});

const decide = (content: Record<string, unknown>, d: ReturnType<typeof decisionDeps>) =>
  handleGateDecision({ sender: "@rakesh:id.example", content }, "!room", d.deps);

const HELD: Read = { status: "resolved", decision: "approve", decidedBy: "prn_rakesh", chosen: null, heldUntil: MONDAY };

describe("a held approval's receipt", () => {
  test("names the release time, and the structured outcome carries held_until", async () => {
    const d = decisionDeps(HELD);
    expect(await decide(approval(), d)).toEqual({ status: "resolved" });
    expect(d.replies).toEqual(["Approved by rakesh — goes ahead after Mon 16 Nov, 09:00 UTC unless pulled back."]);
    expect(d.outcomes[0]).toMatchObject({ suite_event_type: GATE_OUTCOME_TYPE, decision: "approve", held_until: MONDAY });
  });

  test("is unchanged when nothing holds it, when the read fails, and when the time is not one", async () => {
    for (const read of [
      { ...HELD, heldUntil: null },
      { ...HELD, heldUntil: undefined },
      { ...HELD, heldUntil: "Monday" },
      null,
    ] satisfies Read[]) {
      const d = decisionDeps(read);
      expect(await decide(approval(), d), JSON.stringify(read)).toEqual({ status: "resolved" });
      expect(d.replies, JSON.stringify(read)).toEqual(["Approved by rakesh — the board has it."]);
      expect(d.outcomes[0], JSON.stringify(read)).not.toHaveProperty("held_until");
    }
    const throwing = decisionDeps(async () => {
      throw new Error("board down");
    });
    expect(await decide(approval(), throwing)).toEqual({ status: "resolved" });
    expect(throwing.replies).toEqual(["Approved by rakesh — the board has it."]);
  });

  test("a gate still pending after the approval is recorded, as before", async () => {
    const d = decisionDeps({ status: "pending", decision: null, decidedBy: null, chosen: null });
    expect(await decide(approval(), d)).toEqual({ status: "recorded" });
    expect(d.replies).toHaveLength(0);
  });

  test("an approval whose release would fall after its subject expires is refused in words", async () => {
    const d = decisionDeps(HELD, { resolveGate: async () => ({ ok: false, code: "APPROVAL_RELEASE_AFTER_EXPIRY" }) });
    expect(await decide(approval(), d)).toEqual({ status: "refused", reason: "release-after-expiry" });
    expect(d.replies).toEqual(["That can't be approved: it would go ahead only after what it approves has expired. Nothing has changed."]);
    expect(d.outcomes).toHaveLength(0);
  });
});

// ── The sweep, for an approval decided elsewhere ────────────────────────────

const SWEEP_CONFIG: Parameters<typeof bridgeGateSweepDeps>[0] = { baseUrl: "https://board.test", source: "superpipeline" };

function reading(gate: Record<string, unknown>) {
  return bridgeGateSweepDeps(
    SWEEP_CONFIG,
    { tenantIdFor: async () => "fleet_1", project: async () => ({ status: "already" }) },
    async () => ({ status: 200, ok: true, json: async () => ({ gate }) }),
    async () => [{ boardId: "brd_7c1f", token: `spa_${"a".repeat(48)}` }],
  );
}

describe("decided on the board: the sweep reads the hold", () => {
  test("a held approval's release time reaches the receipt", async () => {
    const decided = await reading({ status: "resolved", decision: "approve", decidedBy: "prn_rakesh", heldUntil: MONDAY }).decisionFor?.("brd_7c1f", "gate_6e19");
    expect(decided).toEqual({ decision: "approve", decidedBy: "prn_rakesh", chosen: null, heldUntil: MONDAY });
    const garbled = await reading({ status: "resolved", decision: "approve", decidedBy: "prn_rakesh", heldUntil: "soon" }).decisionFor?.("brd_7c1f", "gate_6e19");
    expect(garbled?.heldUntil).toBeNull();
  });

  test("an approval pulled back before its card was closed reads as changes requested, by who pulled it back", async () => {
    const decided = await reading({
      status: "resolved",
      decision: "approve",
      decidedBy: "prn_approver",
      heldUntil: MONDAY,
      pulledBack: { by: "prn_rakesh", at: "2026-11-16T08:40:00.000Z", comment: "wrong image" },
    }).decisionFor?.("brd_7c1f", "gate_6e19");
    expect(decided).toEqual({ decision: "request_changes", decidedBy: "prn_rakesh", chosen: null });
  });

  test("the sweep hands the release time to the receipt", async () => {
    const settled: unknown[] = [];
    await sweepGates({
      boards: async () => ["brd_7c1f"],
      tenantIdFor: async () => "fleet_1",
      pendingGates: async () => [],
      project: async () => ({ status: "already" }),
      postedGatesAwaitingOutcome: async () => [{ gateId: "gate_6e19", cardId: "crd_8a40" }],
      decisionFor: async () => ({ decision: "approve", decidedBy: "prn_rakesh", chosen: null, heldUntil: MONDAY }),
      settleOutcome: async (...args) => {
        settled.push(args);
        return true;
      },
    });
    expect(settled).toEqual([["gate_6e19", "approve", "prn_rakesh", null, MONDAY]]);
  });
});

// ── The pushes ──────────────────────────────────────────────────────────────

describe("decision.released and decision.pulled_back are checked before they are believed", () => {
  test("well-formed pushes are", () => {
    expect(isDecisionReleased(RELEASED)).toBe(true);
    expect(isDecisionReleased({ ...RELEASED, outcome: "blocked", reason: "the subject expired" })).toBe(true);
    expect(isDecisionPulledBack(PULLED)).toBe(true);
  });

  test("anything missing or malformed is not", () => {
    const badReleased: unknown[] = [
      null,
      { ...RELEASED, event: "decision.pulled_back" },
      { ...RELEASED, boardId: null },
      { ...RELEASED, cardId: "" },
      { ...RELEASED, gateId: 4 },
      { ...RELEASED, decision: "" },
      { ...RELEASED, releaseAt: "soon" },
      { ...RELEASED, releasedAt: undefined },
      { ...RELEASED, outcome: "done" },
      { ...RELEASED, reason: 7 },
    ];
    for (const v of badReleased) expect(isDecisionReleased(v), JSON.stringify(v)).toBe(false);
    const badPulled: unknown[] = [
      null,
      { ...PULLED, event: "decision.released" },
      { ...PULLED, boardId: "" },
      { ...PULLED, pulledBackBy: "" },
      { ...PULLED, at: "yesterday" },
      { ...PULLED, comment: "  " },
      { ...PULLED, comment: undefined },
    ];
    for (const v of badPulled) expect(isDecisionPulledBack(v), JSON.stringify(v)).toBe(false);
  });

  test("the replies read as a person says them", () => {
    expect(releasedBody(RELEASED)).toBe("Released — it went ahead.");
    expect(releasedBody({ ...RELEASED, outcome: "blocked", reason: "the subject expired." })).toBe("Did not go ahead: the subject expired.");
    expect(releasedBody({ ...RELEASED, outcome: "blocked" })).toBe("Did not go ahead: it was blocked at its release time.");
    expect(pulledBackBody({ who: "rakesh", comment: " wrong image " })).toBe("Pulled back by rakesh — returned for changes: wrong image");
    expect(pulledBackBody({ who: null, comment: "wrong image" })).toBe("Pulled back — returned for changes: wrong image");
  });

  test("a released reply never carries a reason, and a pull-back never an id", () => {
    expect(releasedContent({ ...RELEASED, reason: "ignored" }, GATE_EVENT)).not.toHaveProperty("reason");
    const c = pulledBackContent(PULLED, null, GATE_EVENT);
    expect(c.pulled_back_by).toBeNull();
    expect(JSON.stringify(c)).not.toContain("prn_rakesh");
  });

  test("a comment past the board's bound is cut to it", () => {
    const long = pulledBackContent({ ...PULLED, comment: "é".repeat(5_000) }, "rakesh", GATE_EVENT);
    expect(new TextEncoder().encode(String(long.comment)).length).toBeLessThanOrEqual(8_192);
  });
});

// ── Pulling back from chat ──────────────────────────────────────────────────

function pullDeps(over: Partial<PullBackDeps> = {}) {
  const replies: string[] = [];
  const calls: Array<Parameters<PullBackDeps["pullBack"]>[0]> = [];
  const value: PullBackDeps = {
    principalForMatrixId: async () => ({ id: "prn_rakesh", kind: "human" as const }),
    recordedGate: async (gateId) =>
      gateId === "gate_6e19"
        ? { tenantId: "fleet_1", boardId: "brd_7c1f", roomId: "!room", eventId: GATE_EVENT, proseEventId: "$prose" }
        : null,
    pullBack: async (input) => {
      calls.push(input);
      return { ok: true };
    },
    reply: async (_r, b) => {
      replies.push(b);
      return null;
    },
    ...over,
  };
  return { deps: value, replies, calls };
}

const pullBack = (over: Record<string, unknown> = {}) => ({
  msgtype: "m.text",
  body: "Pulled back: wrong image",
  schema_version: 1,
  suite_event_type: GATE_PULL_BACK_V2_SUITE_TYPE,
  gate_id: "gate_6e19",
  comment: "wrong image",
  "m.relates_to": { rel_type: "m.reference", event_id: GATE_EVENT },
  ...over,
});

const pull = (content: Record<string, unknown>, d: ReturnType<typeof pullDeps>, roomId = "!room", sender = "@rakesh:id.example") =>
  handleGatePullBack({ sender, content }, roomId, d.deps);

describe("a pull-back from chat", () => {
  test("is carried to the board as the person, and says nothing itself", async () => {
    const d = pullDeps();
    expect(await pull(pullBack(), d)).toEqual({ status: "pulled-back" });
    expect(d.calls).toEqual([
      { tenantId: "fleet_1", boardId: "brd_7c1f", gateId: "gate_6e19", comment: "wrong image", principalId: "prn_rakesh", senderMxid: "@rakesh:id.example" },
    ]);
    expect(d.replies).toHaveLength(0);
  });

  test("may reference the gate's prose instead of its own event", async () => {
    const d = pullDeps();
    expect(await pull(pullBack({ "m.relates_to": { rel_type: "m.reference", event_id: "$prose" } }), d)).toEqual({ status: "pulled-back" });
  });

  test("without a comment is refused in words, after attribution, and never reaches the board", async () => {
    for (const content of [pullBack({ comment: undefined }), pullBack({ comment: "   " })]) {
      const d = pullDeps();
      expect(await pull(content, d)).toEqual({ status: "refused", reason: "comment-required" });
      expect(d.replies).toEqual([PULL_BACK_COMMENT_REQUIRED_TEXT]);
      expect(d.calls).toHaveLength(0);
    }
    // A stranger cannot make the hub speak, even to say a comment is missing.
    const stranger = pullDeps({ principalForMatrixId: async () => null });
    expect(await pull(pullBack({ comment: undefined }), stranger)).toEqual({ status: "refused", reason: "unlinked-sender" });
    expect(stranger.replies).toHaveLength(0);
  });

  test("a comment longer than the board takes is refused", async () => {
    const d = pullDeps();
    expect(await pull(pullBack({ comment: "x".repeat(8_193) }), d)).toEqual({ status: "refused", reason: "comment-too-long" });
    expect(d.calls).toHaveLength(0);
  });

  test("a gate this hub never posted, a reference that disagrees, or another room changes nothing and says nothing", async () => {
    const cases: Array<[Record<string, unknown>, string, PullBackRefusal]> = [
      [pullBack({ gate_id: "gate_other" }), "!room", "unknown-gate"],
      [pullBack({ "m.relates_to": { rel_type: "m.reference", event_id: "$elsewhere" } }), "!room", "reference-mismatch"],
      [pullBack({ "m.relates_to": { "m.in_reply_to": { event_id: GATE_EVENT } } }), "!room", "reference-mismatch"],
      [pullBack(), "!another-room", "reference-mismatch"],
    ];
    for (const [content, roomId, reason] of cases) {
      const d = pullDeps();
      expect(await pull(content, d, roomId), reason).toEqual({ status: "refused", reason });
      expect(d.calls).toHaveLength(0);
      expect(d.replies).toHaveLength(0);
    }
  });

  test("an agent or a service cannot pull an approval back", async () => {
    for (const kind of ["agent", "service"] as const) {
      const d = pullDeps({ principalForMatrixId: async () => ({ id: "agt_1", kind }) });
      expect(await pull(pullBack(), d)).toEqual({ status: "refused", reason: "not-human" });
      expect(d.calls).toHaveLength(0);
    }
  });

  test("an org plane that cannot be asked is said, and nothing is carried", async () => {
    const d = pullDeps({
      principalForMatrixId: async () => {
        throw new Error("plane down");
      },
    });
    expect(await pull(pullBack(), d)).toEqual({ status: "refused", reason: "identity-unavailable" });
    expect(d.replies).toHaveLength(1);
    expect(d.calls).toHaveLength(0);
  });

  test("parses only its own marker", () => {
    expect(parsePullBack({ ...pullBack(), suite_event_type: GATE_DECISION_V2_SUITE_TYPE })).toBeNull();
    expect(parsePullBack(pullBack({ gate_id: "" }))).toBeNull();
    expect(parsePullBack(pullBack())?.comment).toBe("wrong image");
  });
});

function recordingFetch(status: number, respondWith: unknown) {
  const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];
  const fetchImpl: typeof fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: url instanceof Request ? url.url : url.toString(),
        auth: new Headers(init?.headers).get("Authorization"),
        body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
      });
      return new Response(JSON.stringify(respondWith), { status });
    },
    { preconnect: fetch.preconnect },
  );
  return { calls, fetchImpl };
}

describe("a pull-back reaches the board's route as the person", () => {
  test("POSTs the comment to …/pull-back with an assertion minted for the sender", async () => {
    const { calls, fetchImpl } = recordingFetch(200, { card: {} });
    const minted: unknown[] = [];
    const out = await pullBackAtSuperpipeline(
      { boardId: "brd_7c1f", gateId: "gate_6e19", comment: "wrong image", principalId: "prn_rakesh", senderMxid: "@rakesh:id.example" },
      {
        baseUrl: "https://board.example/",
        mint: async (subject) => {
          minted.push(subject);
          return "tok_person";
        },
        fetch: fetchImpl,
      },
    );
    expect(out).toEqual({ ok: true });
    expect(calls).toEqual([
      { url: "https://board.example/v1/boards/brd_7c1f/gates/gate_6e19/pull-back", auth: "Bearer tok_person", body: { comment: "wrong image" } },
    ]);
    expect(minted).toEqual([{ principalId: "prn_rakesh", senderMxid: "@rakesh:id.example" }]);
  });

  test("reads the board's refusal code", async () => {
    const { fetchImpl } = recordingFetch(409, { error: { code: "APPROVAL_RELEASED" } });
    const out = await pullBackAtSuperpipeline(
      { boardId: "b", gateId: "g", comment: "c", principalId: "p", senderMxid: "@p:id.example" },
      { baseUrl: "https://board.example", mint: async () => "t", fetch: fetchImpl },
    );
    expect(out).toEqual({ ok: false, code: "APPROVAL_RELEASED" });
  });
});

/** Hand `content` to the room as a message, and see where it went. */
const routed = async (content: Record<string, unknown>) => {
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
    pullBacks: {
      handle: async (e) => {
        handled.push(e.content.gate_id);
      },
    },
  };
  await handleRoomMessage({ type: "m.room.message", sender: "@rakesh:id.example", room_id: "!room", content }, deps);
  return { handled, prompts };
};

describe("the room routes a gate.pull_back.v2 to its handler, never to the agent", () => {
  test("a well-formed one, and a malformed one too, so it is never read as a prompt", async () => {
    for (const content of [pullBack(), pullBack({ gate_id: "" }), pullBack({ comment: undefined })]) {
      const { handled, prompts } = await routed(content);
      expect(handled).toHaveLength(1);
      expect(prompts).toHaveLength(0);
    }
  });
});

// ── The shared corpus ───────────────────────────────────────────────────────

/** The corpus writes the Matrix spelling; the board sends camelCase. */
const boardRelease = (r: unknown) =>
  typeof r === "object" && r !== null
    ? {
        ...(Reflect.get(r, "hold_for_minutes") !== undefined ? { holdForMinutes: Reflect.get(r, "hold_for_minutes") } : {}),
        ...(Reflect.get(r, "not_before") !== undefined ? { notBefore: Reflect.get(r, "not_before") } : {}),
      }
    : r;

describe("an approval that waits, against the shared corpus", () => {
  interface Entry {
    suiteEventType: string;
    variant?: string;
    accept: Array<{ why: string; said?: string; content: Record<string, unknown> }>;
    reject: Array<{ why: string; said?: string; content: Record<string, unknown> }>;
    boardRefusals?: Array<{ code: string; httpStatus: number; said: string }>;
  }
  const parsed: unknown = JSON.parse(
    readFileSync(Bun.resolveSync("@superjackfruitlabs/treaty-ecosystem-identity/matrix_gate_events.json", import.meta.dir), "utf8"),
  );
  const corpus: { version: number; events: Entry[] } =
    typeof parsed === "object" && parsed !== null && "events" in parsed && "version" in parsed && Array.isArray(parsed.events) && typeof parsed.version === "number"
      ? { version: parsed.version, events: parsed.events }
      : { version: 0, events: [] };
  const entry = (t: string) => corpus.events.find((e) => e.suiteEventType === t && e.variant === "release");
  const gateV2 = entry(GATE_V2_SUITE_TYPE);
  const outcome = entry(GATE_OUTCOME_TYPE);
  const released = entry(DECISION_RELEASED_TYPE);
  const pulledBack = entry(DECISION_PULLED_BACK_TYPE);
  const pullBackEntry = entry(GATE_PULL_BACK_V2_SUITE_TYPE);
  const decision = entry(GATE_DECISION_V2_SUITE_TYPE);

  test("version 11", () => {
    expect(corpus.version).toBe(11);
  });

  test("the hub's gate.v2 for each held gate is exactly what the corpus accepts", () => {
    expect(gateV2?.accept).toHaveLength(3);
    for (const { why, content } of gateV2?.accept ?? []) {
      expect(gateV2Content({ ...GATE, release: boardRelease(content.release) }, LINK), why).toEqual(content);
    }
  });

  test("every release the corpus rejects is one this hub would not carry", () => {
    expect(gateV2?.reject.length).toBeGreaterThanOrEqual(4);
    for (const { why, content } of gateV2?.reject ?? []) {
      expect(releaseV2(boardRelease(content.release)), why).toBeNull();
      // Not carried: the gate.v2 is the corpus entry without its release, prose unchanged.
      const { release: _dropped, ...carried } = content;
      expect(gateV2Content({ ...GATE, release: boardRelease(content.release) }, LINK), why).toEqual(carried);
    }
  });

  test("a held approval's receipt is exactly what the corpus accepts", async () => {
    const d = decisionDeps(HELD);
    await decide(approval(), d);
    expect(d.outcomes[0]).toEqual(outcome?.accept[0]?.content ?? {});
    expect(d.replies).toEqual([outcome?.accept[0]?.said ?? ""]);
  });

  test("the release replies are exactly what the corpus accepts, released and blocked", () => {
    expect(released?.accept).toHaveLength(2);
    for (const { why, said, content } of released?.accept ?? []) {
      const push: DecisionReleasedDelivery = {
        ...RELEASED,
        outcome: content.outcome === "blocked" ? "blocked" : "released",
        releasedAt: String(content.released_at),
        ...(typeof content.reason === "string" ? { reason: content.reason } : {}),
      };
      expect(releasedContent(push, GATE_EVENT), why).toEqual(content);
      expect(releasedBody(push), why).toBe(said ?? "");
    }
  });

  test("the pull-back reply is exactly what the corpus accepts", () => {
    const accepted = pulledBack?.accept[0];
    expect(pulledBackContent(PULLED, "rakesh", GATE_EVENT)).toEqual(accepted?.content ?? {});
    expect(pulledBackBody({ who: "rakesh", comment: PULLED.comment })).toBe(accepted?.said ?? "");
  });

  test("every pull-back the corpus accepts reaches the board as the person; every one it rejects is refused as it says", async () => {
    expect(pullBackEntry?.accept.length).toBeGreaterThanOrEqual(1);
    for (const { why, content } of pullBackEntry?.accept ?? []) {
      const d = pullDeps();
      expect(await pull(content, d), why).toEqual({ status: "pulled-back" });
      expect(d.calls, why).toHaveLength(1);
    }
    expect(pullBackEntry?.reject.length).toBeGreaterThanOrEqual(1);
    for (const { why, said, content } of pullBackEntry?.reject ?? []) {
      const d = pullDeps();
      expect((await pull(content, d)).status, why).toBe("refused");
      expect(d.calls, why).toHaveLength(0);
      expect(d.replies, why).toEqual([said ?? ""]);
    }
  });

  test("each board refusal of a pull-back is said as the corpus says it", async () => {
    const codes = (pullBackEntry?.boardRefusals ?? []).map((r) => r.code);
    for (const code of ["APPROVAL_RELEASED", "GATE_NOT_HELD", "APPROVAL_DECIDER_NOT_ALLOWED", "SEPARATION_OF_DUTIES", "INVALID_COMMENT"]) {
      expect(codes).toContain(code);
    }
    for (const r of pullBackEntry?.boardRefusals ?? []) {
      const d = pullDeps({ pullBack: async () => ({ ok: false, code: r.code }) });
      expect(await pull(pullBack(), d), r.code).toEqual({ status: "refused", reason: "board-refused", code: r.code });
      expect(d.replies, r.code).toEqual([r.said]);
    }
  });

  test("an approval refused for releasing after expiry is said as the corpus says it", async () => {
    expect(decision?.boardRefusals?.map((r) => r.code)).toEqual(["APPROVAL_RELEASE_AFTER_EXPIRY"]);
    for (const r of decision?.boardRefusals ?? []) {
      const d = decisionDeps(HELD, { resolveGate: async () => ({ ok: false, code: r.code }) });
      expect((await decide(decision?.accept[0]?.content ?? approval(), d)).status).toBe("refused");
      expect(d.replies).toEqual([r.said]);
    }
  });
});
