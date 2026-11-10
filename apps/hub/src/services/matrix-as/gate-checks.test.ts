import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { CheckFailedDelivery, CheckOverriddenDelivery, DecisionTimeoutDelivery } from "../bridge";
import { GATE_V2_SUITE_TYPE, gateV2Content, type GatePendingDelivery } from "../board-chat/gates";
import {
  CHECKS_WAITING_TYPE,
  CHECK_FAILED_TYPE,
  CHECK_OVERRIDDEN_TYPE,
  CHECK_OVERRIDE_V2_SUITE_TYPE,
  checkFailedBody,
  checkFailedContent,
  checkOverriddenBody,
  checkOverriddenContent,
  checksV2,
  checksWaitingContent,
  isCheckFailed,
  isCheckOverridden,
  parseCheckOverride,
} from "../board-chat/checks-wire";
import {
  CHECK_OVERRIDE_COMMENT_REQUIRED_TEXT,
  checkOverrideRefusalText,
  handleCheckOverride,
  type CheckOverrideDeps,
  type CheckOverrideRefusal,
} from "../board-chat/check-override";
import { DECISION_ESCALATED_SUITE_TYPE, DECISION_REMINDED_SUITE_TYPE, decisionNoticeContent, isDecisionTimeout } from "../board-chat/decision-timeout-wire";
import { overrideCheckAtSuperpipeline } from "../board-chat/gate-resolve";
import { handleRoomMessage, type InboundDeps } from "./inbound";

/**
 * A gate may be decided by checks (charter → `decisions/2026-11-09-a-gate-may-be-decided-by-checks.md`).
 * The hub carries a gate's checks on gate.v2, says a failed or overridden check in the board's room,
 * posts a checks.waiting card when overdue checks escalate, and carries an override from chat as the
 * person. Pinned against treaty's `fixtures/ecosystem-identity/matrix_gate_events.json` (`variant: "checks"`).
 */

const LINK = "https://superpipeline.dev/b/brd_7c1f/c/crd_8a40";
const WAITING_EVENT = "$checksWaitingEventId";

const GATE: GatePendingDelivery = {
  event: "gate.pending",
  boardId: "brd_7c1f",
  cardId: "crd_8a40",
  gateId: "gate_6e19",
  stageKey: "review",
  returnStageKey: "build",
  cardTitle: "Ship the release",
  producedBy: "agt_31d0",
  options: [
    { id: "approve", label: "Approve", meaning: "approve", needsComment: false },
    { id: "request_changes", label: "Request changes", meaning: "revise", needsComment: true },
    { id: "reject", label: "Reject", meaning: "reject", needsComment: false },
  ],
  ts: "2026-11-09T09:00:00.000Z",
};

const CHECKS = [
  { name: "build", provider: "ci", status: "passed", url: "https://forge.example/acme/app/actions/runs/412" },
  { name: "quality", provider: "verdict", status: "passed" },
  { name: "claims", provider: "verdict", status: "overridden" },
];

const FAILED: CheckFailedDelivery = {
  event: "check.failed",
  boardId: "brd_7c1f",
  cardId: "crd_8a40",
  cardTitle: "Ship the release",
  arrivalId: "arr_5d02",
  stageKey: "review",
  check: { name: "build", provider: "ci", status: "failed", detail: "lint: failure", url: "https://forge.example/acme/app/actions/runs/413" },
  returnedTo: "build",
};

const OVERRIDDEN: CheckOverriddenDelivery = {
  event: "check.overridden",
  boardId: "brd_7c1f",
  cardId: "crd_8a40",
  cardTitle: "Ship the release",
  arrivalId: "arr_5d02",
  stageKey: "review",
  check: { name: "quality", provider: "verdict", status: "overridden" },
  by: "prn_rakesh",
  comment: "the grader is down; read it myself",
  at: "2026-11-09T12:10:00.000Z",
};

describe("gate.v2 carries the checks that ran before it opened", () => {
  test("beside the options, and one line in the prose", () => {
    const c = gateV2Content({ ...GATE, checks: CHECKS }, LINK);
    expect(c.checks).toEqual(CHECKS);
    expect(String(c.body).endsWith("\n\nChecks: build (CI) ✓, quality (verdict) ✓, claims (verdict) overridden.")).toBe(true);
  });

  test("a gate whose stage has no checks is byte-identical to before", () => {
    const c = gateV2Content(GATE, LINK);
    expect(c).not.toHaveProperty("checks");
    expect(String(c.body)).not.toContain("Checks:");
    expect(gateV2Content({ ...GATE, checks: undefined }, LINK)).toEqual(c);
  });

  test("a malformed list is not carried at all, not even its good entries", () => {
    const good = { name: "build", provider: "ci", status: "passed" };
    const bad: unknown[] = [
      null,
      "build",
      {},
      [],
      Array.from({ length: 6 }, (_, i) => ({ ...good, name: `c${i}` })),
      [good, { ...good, name: "ci/lint" }],
      [{ ...good, name: "x".repeat(41) }],
      [{ ...good, name: "" }],
      [{ ...good, name: " build" }],
      [{ ...good, name: 7 }],
      [{ ...good, provider: "cost" }],
      [{ ...good, status: "skipped" }],
      [good, { ...good, provider: "verdict" }],
    ];
    for (const checks of bad) {
      expect(checksV2(checks), JSON.stringify(checks)).toBeNull();
      const c = gateV2Content({ ...GATE, checks }, LINK);
      expect(c, JSON.stringify(checks)).not.toHaveProperty("checks");
      expect(String(c.body), JSON.stringify(checks)).not.toContain("Checks:");
    }
    // The edges hold: 5 checks, a 40-character name.
    expect(checksV2(Array.from({ length: 5 }, (_, i) => ({ ...good, name: `c${i}` })))).toHaveLength(5);
    expect(checksV2([{ ...good, name: "x".repeat(40) }])).toHaveLength(1);
  });

  test("a link that is not https is dropped and its check kept", () => {
    for (const url of ["http://forge.example/run", "javascript:alert(1)", "https://", 42, "https://a b"]) {
      expect(checksV2([{ name: "build", provider: "ci", status: "passed", url }]), String(url)).toEqual([
        { name: "build", provider: "ci", status: "passed" },
      ]);
    }
  });
});

describe("check.failed and check.overridden are checked before they are believed", () => {
  test("well-formed pushes are", () => {
    expect(isCheckFailed(FAILED)).toBe(true);
    expect(isCheckFailed({ ...FAILED, returnedTo: null })).toBe(true);
    expect(isCheckFailed({ ...FAILED, cardTitle: "" })).toBe(true);
    expect(isCheckFailed({ ...FAILED, check: { name: "build", provider: "ci", status: "failed" } })).toBe(true);
    expect(isCheckOverridden(OVERRIDDEN)).toBe(true);
  });

  test("anything missing or malformed is not", () => {
    const badFailed: unknown[] = [
      null,
      { ...FAILED, event: "check.overridden" },
      { ...FAILED, boardId: "" },
      { ...FAILED, cardId: 4 },
      { ...FAILED, stageKey: undefined },
      { ...FAILED, arrivalId: "" },
      { ...FAILED, arrivalId: undefined },
      { ...FAILED, cardTitle: undefined },
      { ...FAILED, cardTitle: 7 },
      { ...FAILED, check: null },
      { ...FAILED, check: { ...FAILED.check, status: "passed" } },
      { ...FAILED, check: { ...FAILED.check, name: "a/b" } },
      { ...FAILED, check: { ...FAILED.check, provider: "cost" } },
      { ...FAILED, check: { ...FAILED.check, detail: 3 } },
      { ...FAILED, check: { ...FAILED.check, url: {} } },
      { ...FAILED, returnedTo: undefined },
      { ...FAILED, returnedTo: "" },
    ];
    for (const v of badFailed) expect(isCheckFailed(v), JSON.stringify(v)).toBe(false);
    const badOverridden: unknown[] = [
      null,
      { ...OVERRIDDEN, event: "check.failed" },
      { ...OVERRIDDEN, check: { ...OVERRIDDEN.check, status: "passed" } },
      { ...OVERRIDDEN, by: "" },
      { ...OVERRIDDEN, arrivalId: 3 },
      { ...OVERRIDDEN, cardTitle: null },
      { ...OVERRIDDEN, at: "yesterday" },
      { ...OVERRIDDEN, comment: "  " },
      { ...OVERRIDDEN, comment: undefined },
    ];
    for (const v of badOverridden) expect(isCheckOverridden(v), JSON.stringify(v)).toBe(false);
  });

  test("the notices read as a person says them", () => {
    expect(checkFailedBody({ ...FAILED, check: { name: "build", provider: "ci", status: "failed" } }, "Ship the release")).toBe(
      "CI check “build” failed on “Ship the release” — returned for changes.",
    );
    expect(checkFailedBody({ ...FAILED, returnedTo: null, check: { ...FAILED.check, url: "http://x.example" } }, null)).toBe(
      "CI check “build” failed — it could not go back and waits for a person.",
    );
    expect(checkOverriddenBody(OVERRIDDEN, null, null)).toBe("Verdict check “quality” overridden: the grader is down; read it myself");
  });

  test("an override's notice never carries who by id, and a failure never a link that is not https", () => {
    const c = checkOverriddenContent(OVERRIDDEN, null, null);
    expect(c.overridden_by).toBeNull();
    expect(JSON.stringify(c)).not.toContain("prn_rakesh");
    expect(c).not.toHaveProperty("m.relates_to");
    const f = checkFailedContent({ ...FAILED, check: { ...FAILED.check, url: "http://x.example", detail: "x".repeat(1_000) } }, null);
    expect(JSON.stringify(f)).not.toContain("http://x.example");
    const check: unknown = f.check;
    expect(typeof check === "object" && check !== null ? String(Reflect.get(check, "detail")).length : 0).toBeLessThanOrEqual(300);
    expect(f).not.toHaveProperty("card_title");
  });
});

describe("a reminder of overdue checks", () => {
  const REMINDED: DecisionTimeoutDelivery = {
    event: "decision.reminded",
    boardId: "brd_7c1f",
    cardId: "crd_8a40",
    cardTitle: "Ship the release",
    stageKey: "review",
    decisionKind: "checks",
    decisionId: "arr_5d02",
    waitingSince: "2026-11-09T09:00:00.000Z",
    remindedAt: "2026-11-09T10:00:00.000Z",
    ts: "2026-11-09T10:00:00.000Z",
  };

  test("is a decision kind the push may carry", () => {
    expect(isDecisionTimeout(REMINDED)).toBe(true);
  });

  test("stands alone: there is no card to reply to", () => {
    const c = decisionNoticeContent(REMINDED, null);
    expect(c).not.toHaveProperty("m.relates_to");
    expect(c.body).toBe('Still waiting: "Ship the release" has waited 1 h for its checks.');
  });
});

// ── Overriding from chat ────────────────────────────────────────────────────

function overrideDeps(over: Partial<CheckOverrideDeps> = {}) {
  const replies: string[] = [];
  const calls: Array<Parameters<CheckOverrideDeps["override"]>[0]> = [];
  const value: CheckOverrideDeps = {
    principalForMatrixId: async () => ({ id: "prn_rakesh", kind: "human" as const }),
    recordedChecksCard: async (eventId) =>
      eventId === WAITING_EVENT ? { tenantId: "fleet_1", boardId: "brd_7c1f", cardId: "crd_8a40", roomId: "!room", eventId } : null,
    override: async (input) => {
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

const overrideMessage = (over: Record<string, unknown> = {}) => ({
  msgtype: "m.text",
  body: "Override quality: the grader is down; read it myself",
  schema_version: 1,
  suite_event_type: CHECK_OVERRIDE_V2_SUITE_TYPE,
  board_id: "brd_7c1f",
  card_id: "crd_8a40",
  check_name: "quality",
  comment: "the grader is down; read it myself",
  "m.relates_to": { rel_type: "m.reference", event_id: WAITING_EVENT },
  ...over,
});

const send = (content: Record<string, unknown>, d: ReturnType<typeof overrideDeps>, roomId = "!room", sender = "@rakesh:id.example") =>
  handleCheckOverride({ sender, content }, roomId, d.deps);

describe("an override from chat", () => {
  test("is carried to the board as the person, and says nothing itself", async () => {
    const d = overrideDeps();
    expect(await send(overrideMessage(), d)).toEqual({ status: "overridden" });
    expect(d.calls).toEqual([
      {
        tenantId: "fleet_1",
        boardId: "brd_7c1f",
        cardId: "crd_8a40",
        checkName: "quality",
        comment: "the grader is down; read it myself",
        principalId: "prn_rakesh",
        senderMxid: "@rakesh:id.example",
      },
    ]);
    expect(d.replies).toHaveLength(0);
  });

  test("without a comment is refused in words, after attribution, and never reaches the board", async () => {
    for (const content of [overrideMessage({ comment: undefined }), overrideMessage({ comment: "   " })]) {
      const d = overrideDeps();
      expect(await send(content, d)).toEqual({ status: "refused", reason: "comment-required" });
      expect(d.replies).toEqual([CHECK_OVERRIDE_COMMENT_REQUIRED_TEXT]);
      expect(d.calls).toHaveLength(0);
    }
    // A stranger cannot make the hub speak, even to say a comment is missing.
    const stranger = overrideDeps({ principalForMatrixId: async () => null });
    expect(await send(overrideMessage({ comment: undefined }), stranger)).toEqual({ status: "refused", reason: "unlinked-sender" });
    expect(stranger.replies).toHaveLength(0);
  });

  test("a comment longer than the board takes is refused", async () => {
    const d = overrideDeps();
    expect(await send(overrideMessage({ comment: "x".repeat(8_193) }), d)).toEqual({ status: "refused", reason: "comment-too-long" });
    expect(d.calls).toHaveLength(0);
  });

  test("a card this hub never posted, a reference that disagrees, or another room changes nothing and says nothing", async () => {
    const cases: Array<[Record<string, unknown>, string, CheckOverrideRefusal]> = [
      [overrideMessage({ "m.relates_to": { rel_type: "m.reference", event_id: "$elsewhere" } }), "!room", "unknown-card"],
      [overrideMessage({ "m.relates_to": { "m.in_reply_to": { event_id: WAITING_EVENT } } }), "!room", "unknown-card"],
      [overrideMessage({ "m.relates_to": undefined }), "!room", "unknown-card"],
      [overrideMessage({ board_id: "brd_other" }), "!room", "reference-mismatch"],
      [overrideMessage({ card_id: "crd_other" }), "!room", "reference-mismatch"],
      [overrideMessage(), "!another-room", "reference-mismatch"],
    ];
    for (const [content, roomId, reason] of cases) {
      const d = overrideDeps();
      expect(await send(content, d, roomId), reason).toEqual({ status: "refused", reason });
      expect(d.calls).toHaveLength(0);
      expect(d.replies).toHaveLength(0);
    }
  });

  test("an agent or a service never overrides a check, and is not answered", async () => {
    for (const kind of ["agent", "service"] as const) {
      const d = overrideDeps({ principalForMatrixId: async () => ({ id: "agt_1", kind }) });
      expect(await send(overrideMessage(), d)).toEqual({ status: "refused", reason: "not-human" });
      expect(d.calls).toHaveLength(0);
      expect(d.replies).toHaveLength(0);
    }
  });

  test("an org plane that cannot be asked is said, and nothing is carried", async () => {
    const d = overrideDeps({
      principalForMatrixId: async () => {
        throw new Error("plane down");
      },
    });
    expect(await send(overrideMessage(), d)).toEqual({ status: "refused", reason: "identity-unavailable" });
    expect(d.replies).toHaveLength(1);
    expect(d.calls).toHaveLength(0);
  });

  test("each board refusal is said in one sentence", async () => {
    for (const code of ["CHECK_OVERRIDE_NOT_ALLOWED", "SEPARATION_OF_DUTIES", "CHECK_NOT_OPEN", "CHECK_NOT_FOUND", "CARD_NOT_FOUND", "UNREACHABLE", "WEIRD"]) {
      const d = overrideDeps({ override: async () => ({ ok: false, code }) });
      expect(await send(overrideMessage(), d), code).toEqual({ status: "refused", reason: "board-refused", code });
      expect(d.replies, code).toEqual([checkOverrideRefusalText(code)]);
    }
    expect(new Set(["CHECK_OVERRIDE_NOT_ALLOWED", "SEPARATION_OF_DUTIES", "CHECK_NOT_OPEN", "CHECK_NOT_FOUND"].map(checkOverrideRefusalText)).size).toBe(4);
    expect(checkOverrideRefusalText("WEIRD")).toBe("That did not go through (WEIRD). Nothing has changed.");
  });

  test("parses only its own marker, with a check name the board would accept", () => {
    expect(parseCheckOverride({ ...overrideMessage(), suite_event_type: "dev.superpipeline.gate.pull_back.v2" })).toBeNull();
    expect(parseCheckOverride(overrideMessage({ check_name: "ci/build" }))).toBeNull();
    expect(parseCheckOverride(overrideMessage({ board_id: "" }))).toBeNull();
    expect(parseCheckOverride(overrideMessage())?.comment).toBe("the grader is down; read it myself");
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

describe("an override reaches the board's route as the person", () => {
  test("POSTs the comment to …/checks/:name/override with an assertion minted for the sender", async () => {
    const { calls, fetchImpl } = recordingFetch(200, { card: {}, checks: {} });
    const minted: unknown[] = [];
    const out = await overrideCheckAtSuperpipeline(
      { boardId: "brd_7c1f", cardId: "crd_8a40", checkName: "lint check", comment: "flaky", principalId: "prn_rakesh", senderMxid: "@rakesh:id.example" },
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
      { url: "https://board.example/v1/boards/brd_7c1f/cards/crd_8a40/checks/lint%20check/override", auth: "Bearer tok_person", body: { comment: "flaky" } },
    ]);
    expect(minted).toEqual([{ principalId: "prn_rakesh", senderMxid: "@rakesh:id.example" }]);
  });

  test("reads the board's refusal code", async () => {
    const { fetchImpl } = recordingFetch(403, { error: { code: "CHECK_OVERRIDE_NOT_ALLOWED" } });
    const out = await overrideCheckAtSuperpipeline(
      { boardId: "b", cardId: "c", checkName: "n", comment: "x", principalId: "p", senderMxid: "@p:id.example" },
      { baseUrl: "https://board.example", mint: async () => "t", fetch: fetchImpl },
    );
    expect(out).toEqual({ ok: false, code: "CHECK_OVERRIDE_NOT_ALLOWED" });
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
    checkOverrides: {
      handle: async (e) => {
        handled.push(e.content.check_name);
      },
    },
  };
  await handleRoomMessage({ type: "m.room.message", sender: "@rakesh:id.example", room_id: "!room", content }, deps);
  return { handled, prompts };
};

describe("the room routes a check.override.v2 to its handler, never to the agent", () => {
  test("a well-formed one, and a malformed one too, so it is never read as a prompt", async () => {
    for (const content of [overrideMessage(), overrideMessage({ check_name: "" }), overrideMessage({ comment: undefined })]) {
      const { handled, prompts } = await routed(content);
      expect(handled).toHaveLength(1);
      expect(prompts).toHaveLength(0);
    }
  });
});

// ── The shared corpus ───────────────────────────────────────────────────────

describe("a gate decided by checks, against the shared corpus", () => {
  interface Entry {
    suiteEventType: string;
    variant?: string;
    accept: Array<{
      why: string;
      said?: string;
      content: Record<string, unknown>;
      push?: unknown;
      who?: string | null;
      replyTo?: string;
    }>;
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
  const entry = (t: string) => corpus.events.find((e) => e.suiteEventType === t && e.variant === "checks");
  const gateV2 = entry(GATE_V2_SUITE_TYPE);
  const failed = entry(CHECK_FAILED_TYPE);
  const overridden = entry(CHECK_OVERRIDDEN_TYPE);
  const waiting = entry(CHECKS_WAITING_TYPE);
  const escalated = entry(DECISION_ESCALATED_SUITE_TYPE);
  const reminded = entry(DECISION_REMINDED_SUITE_TYPE);
  const overrideEntry = entry(CHECK_OVERRIDE_V2_SUITE_TYPE);

  test("version 11", () => {
    expect(corpus.version).toBe(11);
  });

  test("the hub's gate.v2 with checks is exactly what the corpus accepts", () => {
    expect(gateV2?.accept).toHaveLength(1);
    for (const { why, content } of gateV2?.accept ?? []) {
      expect(gateV2Content({ ...GATE, checks: content.checks }, LINK), why).toEqual(content);
    }
  });

  test("every list of checks the corpus rejects is one this hub would not carry", () => {
    expect(gateV2?.reject.length).toBeGreaterThanOrEqual(6);
    for (const { why, content } of gateV2?.reject ?? []) {
      expect(checksV2(content.checks), why).toBeNull();
      const { checks: _dropped, ...carried } = content;
      expect(gateV2Content({ ...GATE, checks: content.checks }, LINK), why).toEqual(carried);
    }
  });

  test("a failed check's notice is exactly what the corpus accepts, returned and not", () => {
    expect(failed?.accept).toHaveLength(2);
    for (const { why, push, replyTo, said, content } of failed?.accept ?? []) {
      expect(isCheckFailed(push), why).toBe(true);
      if (!isCheckFailed(push)) continue;
      const title = push.cardTitle === "" ? null : push.cardTitle;
      expect(checkFailedContent(push, title, replyTo), why).toEqual(content);
      expect(checkFailedBody(push, title), why).toBe(said ?? "");
    }
  });

  test("an override's notice is exactly what the corpus accepts", () => {
    for (const { why, push, who, replyTo, said, content } of overridden?.accept ?? []) {
      expect(isCheckOverridden(push), why).toBe(true);
      if (!isCheckOverridden(push)) continue;
      expect(checkOverriddenContent(push, who ?? null, push.cardTitle, replyTo), why).toEqual(content);
      expect(checkOverriddenBody(push, who ?? null, push.cardTitle), why).toBe(said ?? "");
    }
    expect(overridden?.accept).toHaveLength(1);
  });

  test("the checks.waiting card is exactly what the corpus accepts", () => {
    const c = waiting?.accept[0]?.content ?? {};
    const checks = checksV2(c.checks);
    expect(checks).not.toBeNull();
    expect(
      checksWaitingContent(
        { boardId: "brd_7c1f", cardId: "crd_8a40", cardTitle: "Ship the release", stageKey: "review", stageName: "Review", checks: checks ?? [] },
        LINK,
      ),
    ).toEqual(c);
  });

  test("the reminder and escalation of overdue checks are exactly what the corpus accepts", () => {
    const esc: DecisionTimeoutDelivery = {
      event: "decision.escalated",
      boardId: "brd_7c1f",
      cardId: "crd_8a40",
      cardTitle: "Ship the release",
      stageKey: "review",
      stageName: "Review",
      decisionKind: "checks",
      decisionId: "arr_5d02",
      waitingSince: "2026-11-09T09:00:00.000Z",
      escalatedAt: "2026-11-09T12:00:00.000Z",
      ts: "2026-11-09T12:00:00.000Z",
    };
    expect(decisionNoticeContent(esc, WAITING_EVENT, LINK)).toEqual(escalated?.accept[0]?.content ?? {});
    const { escalatedAt: _e, ...rest } = esc;
    const rem: DecisionTimeoutDelivery = { ...rest, event: "decision.reminded", remindedAt: "2026-11-09T10:00:00.000Z", ts: "2026-11-09T10:00:00.000Z" };
    expect(decisionNoticeContent(rem, null, LINK)).toEqual(reminded?.accept[0]?.content ?? {});
  });

  test("every override the corpus accepts reaches the board as the person; every one it rejects is refused as it says", async () => {
    expect(overrideEntry?.accept.length).toBeGreaterThanOrEqual(1);
    for (const { why, content } of overrideEntry?.accept ?? []) {
      const d = overrideDeps();
      expect(await send(content, d), why).toEqual({ status: "overridden" });
      expect(d.calls, why).toHaveLength(1);
    }
    expect(overrideEntry?.reject.length).toBeGreaterThanOrEqual(1);
    for (const { why, said, content } of overrideEntry?.reject ?? []) {
      const d = overrideDeps();
      expect((await send(content, d)).status, why).toBe("refused");
      expect(d.calls, why).toHaveLength(0);
      expect(d.replies, why).toEqual([said ?? ""]);
    }
  });

  test("each board refusal of an override is said as the corpus says it", async () => {
    const codes = (overrideEntry?.boardRefusals ?? []).map((r) => r.code);
    for (const code of ["CHECK_OVERRIDE_NOT_ALLOWED", "SEPARATION_OF_DUTIES", "CHECK_NOT_OPEN", "CHECK_NOT_FOUND", "INVALID_COMMENT"]) {
      expect(codes).toContain(code);
    }
    for (const r of overrideEntry?.boardRefusals ?? []) {
      const d = overrideDeps({ override: async () => ({ ok: false, code: r.code }) });
      expect(await send(overrideMessage(), d), r.code).toEqual({ status: "refused", reason: "board-refused", code: r.code });
      expect(d.replies, r.code).toEqual([r.said]);
    }
  });
});
