import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GATE_REQUEST_CONTENT_KEY } from "@agentpod/contract";

import type { MatrixGateVariant } from "../../db/schema/matrix";
import { gateDecisionRecord } from "./fleet-gates";
import { bridgeGateSweepDeps, sweepGates } from "./gate-sweep";
import {
  GATE_DECISION_SUITE_TYPE,
  GATE_DECISION_V2_SUITE_TYPE,
  GATE_OUTCOME_TYPE,
  GATE_V2_SUITE_TYPE,
  gateEventContent,
  gateOptionsV2,
  gateRequestCard,
  gateSubjectV2,
  gateV2Content,
  gateVariantsV2,
  handleGateDecision,
  settleGateOutcome,
  type DecisionRefusal,
  type GateDecisionDeps,
  type GatePendingDelivery,
} from "./gates";

/**
 * A gate may offer a choice of variants (charter → `decisions/2026-11-09-a-gate-may-offer-a-choice-of-variants.md`).
 * The hub carries every variant, bounds each on its own, and judges an approval as the choice: a
 * binding naming exactly one variant whose preview was shown in full and whose subject has not
 * expired. Pinned against `fixtures/ecosystem-identity/matrix_gate_events.json` (`variant: "choice"`).
 */

const POST = "Our next release ships today.";
const THREAD = "Our next release ships today.\n\nThanks to everyone who tested it.";
const LONG = "Our next release ships today. Here is everything in it, from the first";
const LINK = "https://superpipeline.dev/b/brd_7c1f/c/crd_7e31";

function variant(id: string, label: string, n: number, preview: unknown[], previewComplete = true, expiresAt: string | null = "2030-01-02T03:04:05Z") {
  return {
    id,
    label,
    subject: { id: `aps_v${n}`, digest: `sha256:v${n}d1`, schema: "social-publish/v1", revision: n, expiresAt, preview, previewComplete },
  };
}

const VARIANTS = [
  variant("short", "Short", 1, [{ type: "text", label: "Post", text: POST }]),
  variant("thread", "With the thread", 2, [{ type: "text", label: "Post", text: THREAD }]),
  // The board had to cut this one to its share: it says so, on its own.
  variant("long", "Long form", 3, [{ type: "text", label: "Post", text: `${LONG}…` }], false),
];

const VARIANT_GATE: GatePendingDelivery = {
  event: "gate.pending",
  boardId: "brd_7c1f",
  cardId: "crd_7e31",
  gateId: "gate_5d72",
  stageKey: "approve",
  returnStageKey: "draft",
  cardTitle: "Announce the release",
  producedBy: "agt_31d0",
  handoffSummary: 'Choose one of 3 variants: "Short", "With the thread", "Long form". Open the card to see them before approving.',
  options: [
    { id: "approve_manual", label: "Approve — I'll post it myself", meaning: "approve", needsComment: false, delivery: "manual" },
    { id: "approve_automatic", label: "Approve — post automatically", meaning: "approve", needsComment: false, delivery: "automatic" },
    { id: "request_changes", label: "Request changes", meaning: "revise", needsComment: true },
    { id: "reject", label: "Reject", meaning: "reject", needsComment: false },
  ],
  approvalSubject: { variants: VARIANTS },
  ts: "2026-11-09T00:00:00.000Z",
};

/** The ids of a content's options, read without trusting its shape. */
function optionIds(options: unknown): unknown[] {
  return Array.isArray(options) ? options.map((o: unknown) => (typeof o === "object" && o !== null && "id" in o ? o.id : null)) : [];
}

/** A record's field as a record, or an empty one. */
function field(v: unknown, key: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || !(key in v)) return {};
  const f: unknown = Reflect.get(v, key);
  return typeof f === "object" && f !== null ? { ...f } : {};
}

const withVariants = (variants: unknown, extra: Record<string, unknown> = {}): GatePendingDelivery => ({
  ...VARIANT_GATE,
  approvalSubject: { variants, ...extra },
});

describe("a variant gate's gate.v2 carries every variant inside subject", () => {
  test("each variant with its snake_case subject envelope, and no id or digest of the gate's own", () => {
    const subject = gateV2Content(VARIANT_GATE, LINK).subject;
    expect(subject).toEqual({
      variants: [
        { id: "short", label: "Short", subject: { id: "aps_v1", digest: "sha256:v1d1", schema: "social-publish/v1", revision: 1, expires_at: "2030-01-02T03:04:05Z", preview: [{ type: "text", label: "Post", text: POST }], preview_complete: true } },
        { id: "thread", label: "With the thread", subject: { id: "aps_v2", digest: "sha256:v2d1", schema: "social-publish/v1", revision: 2, expires_at: "2030-01-02T03:04:05Z", preview: [{ type: "text", label: "Post", text: THREAD }], preview_complete: true } },
        { id: "long", label: "Long form", subject: { id: "aps_v3", digest: "sha256:v3d1", schema: "social-publish/v1", revision: 3, expires_at: "2030-01-02T03:04:05Z", preview: [{ type: "text", label: "Post", text: `${LONG}…` }], preview_complete: false } },
      ],
    });
    expect(subject).not.toHaveProperty("id");
    expect(subject).not.toHaveProperty("digest");
    // A pre-variants reader of the gate.v2 finds no subject identity and falls back to v1.
    expect(gateSubjectV2(VARIANT_GATE)).toBeNull();
  });

  test("a variant gate keeps its approving options: the client withholds them per variant", () => {
    expect(gateOptionsV2(VARIANT_GATE).map((o) => o.id)).toEqual(["approve_manual", "approve_automatic", "request_changes", "reject"]);
  });

  test("each variant is re-bounded within an equal share of the budget: a long one is cut on its own", () => {
    // Three variants share 16,000 bytes: 5,333 each. The first is 4,000 three-byte characters
    // (about 12 KB) and must be cut; the others are short and must be untouched.
    const big = "語".repeat(4000);
    const d = withVariants([
      variant("a", "A", 1, [{ type: "text", label: "Post", text: big }]),
      variant("b", "B", 2, [{ type: "text", label: "Post", text: POST }]),
      variant("c", "C", 3, [{ type: "text", label: "Post", text: THREAD }]),
    ]);
    const vs = gateVariantsV2(d) ?? [];
    expect(vs.map((v) => v.subject.preview_complete)).toEqual([false, true, true]);
    expect(vs[0]?.subject.preview).toEqual([]);
    expect(vs[1]?.subject.preview).toEqual([{ type: "text", label: "Post", text: POST }]);
    // Alone, the same long preview fits the whole budget — the share is what cut it.
    expect(gateSubjectV2({ ...VARIANT_GATE, approvalSubject: variant("a", "A", 1, [{ type: "text", label: "Post", text: big }]).subject })?.preview_complete).toBe(true);
  });

  test("labels are one line and bounded", () => {
    const vs = gateVariantsV2(withVariants([variant("a", `Two\nlines   ${"x".repeat(200)}`, 1, [{ type: "text", text: POST }])])) ?? [];
    expect(vs[0]?.label.startsWith("Two lines xx")).toBe(true);
    expect(vs[0]?.label.length).toBe(80);
  });

  test("the prose shows each variant's label and bounded preview, and says where an incomplete one is chosen", () => {
    const body = String(gateV2Content(VARIANT_GATE, LINK).body);
    expect(body).toContain("Choose one of 3 versions.");
    expect(body).toContain("**Short**\n\nPost:\n```\nOur next release ships today.\n```");
    expect(body).toContain("**With the thread**");
    expect(body).toContain("**Long form** — shortened here; choose it on the board.");
    expect(body).toContain(`[Open the card](${LINK})`);
  });

  test("a label cannot become markdown in the prose", () => {
    const body = String(gateV2Content(withVariants([variant("a", "[click](https://evil.example)", 1, [{ type: "text", text: POST }])])).body);
    expect(body).toContain("**\\[click\\]\\(https://evil\\.example\\)**");
  });

  test("three variants each at their limit still make one event under the content budget", () => {
    const long = "語".repeat(4000);
    const blocks = Array.from({ length: 20 }, (_, i) => ({ type: "text", label: `Post ${i + 1}`, text: long }));
    const d: GatePendingDelivery = {
      ...withVariants([variant("a", "A".repeat(80), 1, blocks), variant("b", "B".repeat(80), 2, blocks), variant("c", "C".repeat(80), 3, blocks)]),
      handoffSummary: long.repeat(2),
    };
    const { body, ...v2 } = gateV2Content(d, LINK);
    const content = { ...v2, [GATE_REQUEST_CONTENT_KEY]: gateRequestCard(d, LINK), msgtype: "m.text", body };
    expect(new TextEncoder().encode(JSON.stringify(content)).length).toBeLessThan(48_000);
    expect((gateVariantsV2(d) ?? []).every((v) => !v.subject.preview_complete)).toBe(true);
  });
});

describe("a variant gate this hub cannot carry offers only request changes and reject", () => {
  const malformed: Array<[string, GatePendingDelivery]> = [
    ["more than three variants", withVariants([...VARIANTS, variant("four", "Four", 4, [{ type: "text", text: POST }])])],
    ["no variants", withVariants([])],
    ["variants that are not a list", withVariants({ short: VARIANTS[0] })],
    // A whole subject identity beside the variants: read as a single subject, it would offer to approve something that is not the choice.
    ["an identity beside the variants", withVariants(VARIANTS, { id: "aps_v1", digest: "sha256:v1d1", schema: "social-publish/v1", revision: 1, preview: [{ type: "text", text: POST }] })],
    ["two variants sharing an id", withVariants([VARIANTS[0], { ...VARIANTS[1], id: "short" }])],
    ["two variants sharing a subject", withVariants([VARIANTS[0], { ...VARIANTS[1], subject: VARIANTS[0]?.subject }])],
    ["a variant with no digest", withVariants([VARIANTS[0], { ...VARIANTS[1], subject: { ...VARIANTS[1]?.subject, digest: undefined } }])],
    ["a variant with no label", withVariants([{ ...VARIANTS[0], label: "  " }])],
    ["a variant id too long", withVariants([{ ...VARIANTS[0], id: "x".repeat(65) }])],
  ];
  for (const [why, d] of malformed) {
    test(why, () => {
      expect(gateVariantsV2(d), why).toBeNull();
      const c = gateV2Content(d);
      expect(c.subject, why).toBeUndefined();
      expect(gateOptionsV2(d).map((o) => o.id), why).toEqual(["request_changes", "reject"]);
    });
  }
});

describe("the v1 card for a variant gate", () => {
  test("never offers an approval, even when the board sends a plain approve", () => {
    const d: GatePendingDelivery = {
      ...VARIANT_GATE,
      options: [
        { id: "approve", label: "Approve" },
        { id: "request_changes", label: "Request changes" },
        { id: "reject", label: "Reject" },
      ],
    };
    expect(gateRequestCard(d).options.map((o) => o.id)).toEqual(["request_changes", "reject"]);
    expect(optionIds(gateEventContent(d).options)).toEqual(["request_changes", "reject"]);
  });

  test("says to choose in an updated app or on the board, and asks which version", () => {
    const c = gateEventContent(VARIANT_GATE, LINK);
    expect(c.body).toBe(
      `Choice needed — "Announce the release" at stage \`approve\`. Choose a version in an updated app or on the board; request changes or reject can be sent from here. [Open the card](${LINK})`,
    );
    expect(c.prompt).toBe('Choose a version of "Announce the release"');
  });
});

describe("the fleet Live Activity never offers a variant", () => {
  test("a variant gate's decision record offers reject only, whatever the board's options", () => {
    const posted = { roomId: "!r", eventId: "$e", proseEventId: "$p" };
    const plain: GatePendingDelivery = { ...VARIANT_GATE, options: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }] };
    const record = gateDecisionRecord(plain, posted, 0);
    expect(record.options.map((o) => o.id)).toEqual(["reject"]);
    expect(record.question).toBe('Choose a version of "Announce the release"');
    // The same options on an ordinary gate still offer approve.
    expect(gateDecisionRecord({ ...plain, approvalSubject: undefined }, posted, 0).options.map((o) => o.id)).toEqual(["approve", "reject"]);
  });
});

/** The variants as `claimGate` records them. */
function recordedVariants(d: GatePendingDelivery): MatrixGateVariant[] | null {
  return (
    gateVariantsV2(d)?.map((v) => ({
      id: v.id,
      label: v.label,
      subject_id: v.subject.id,
      digest: v.subject.digest,
      preview_complete: v.subject.preview_complete,
      expires_at: v.subject.expires_at,
    })) ?? null
  );
}

const GATE_EVENT = "$gateEventId";

function deps(d: GatePendingDelivery = VARIANT_GATE, over: Partial<GateDecisionDeps> = {}) {
  const resolved: Array<Record<string, unknown>> = [];
  const replies: string[] = [];
  const outcomes: Array<Record<string, unknown>> = [];
  const value: GateDecisionDeps = {
    principalForMatrixId: async () => ({ id: "prn_person", kind: "human" as const }),
    projectionFor: async () => ({
      tenantId: "fleet_1",
      boardId: d.boardId,
      eventId: GATE_EVENT,
      options: gateOptionsV2(d),
      subjectId: null,
      subjectPreviewComplete: null,
      variants: recordedVariants(d),
    }),
    resolveGate: async (i) => {
      resolved.push(i);
      return { ok: true };
    },
    reply: async (_r, b) => {
      replies.push(b);
      return null;
    },
    sendOutcome: async (_r, c) => {
      outcomes.push(c);
      return null;
    },
    displayNameFor: async () => "rakesh",
    ...over,
  };
  return { deps: value, resolved, replies, outcomes };
}

function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msgtype: "m.text",
    body: "Approved — post automatically",
    schema_version: 1,
    suite_event_type: GATE_DECISION_V2_SUITE_TYPE,
    gate_id: "gate_5d72",
    option_id: "approve_automatic",
    subject: { id: "aps_v2", digest: "sha256:v2d1" },
    "m.relates_to": { rel_type: "m.reference", event_id: GATE_EVENT },
    ...over,
  };
}

const run = (content: Record<string, unknown>, d: ReturnType<typeof deps>) =>
  handleGateDecision({ sender: "@person:id.example", content }, "!room", d.deps);

describe("judging a decision.v2 on a variant gate", () => {
  test("an approval binding a complete variant resolves, forwarding that variant's binding as the person", async () => {
    const d = deps();
    expect(await run(answer(), d)).toEqual({ status: "resolved" });
    expect(d.resolved[0]).toMatchObject({
      decision: "approve_automatic",
      principalId: "prn_person",
      approvalSubject: { id: "aps_v2", digest: "sha256:v2d1" },
    });
  });

  test("an approval with no binding is refused in plain words", async () => {
    const d = deps();
    expect(await run(answer({ subject: undefined }), d)).toEqual({ status: "refused", reason: "subject-missing" });
    expect(d.resolved).toHaveLength(0);
    expect(d.replies[0]).toBe("That answer did not say which version it chooses. Nothing has changed.");
  });

  test("a binding naming no variant is refused — a known id with another digest names none", async () => {
    for (const subject of [{ id: "aps_other", digest: "sha256:v2d1" }, { id: "aps_v2", digest: "sha256:v1d1" }]) {
      const d = deps();
      expect(await run(answer({ subject }), d)).toEqual({ status: "refused", reason: "variant-unknown" });
      expect(d.resolved).toHaveLength(0);
      expect(d.replies[0]).toBe("That is not one of the versions this gate offers. Nothing has changed.");
    }
  });

  test("choosing a variant whose preview was incomplete is refused; its siblings still go", async () => {
    const d = deps();
    expect(await run(answer({ subject: { id: "aps_v3", digest: "sha256:v3d1" } }), d)).toEqual({ status: "refused", reason: "variant-incomplete" });
    expect(d.resolved).toHaveLength(0);
    expect(d.replies[0]).toBe("That version couldn't be shown in full here — choose it on the board. Nothing has changed.");
    expect(await run(answer({ subject: { id: "aps_v1", digest: "sha256:v1d1" } }), deps())).toEqual({ status: "resolved" });
  });

  test("choosing a variant whose subject has expired is refused", async () => {
    const gate = withVariants([VARIANTS[0], variant("old", "Old", 9, [{ type: "text", text: POST }], true, "2020-01-01T00:00:00Z")]);
    const d = deps(gate);
    expect(await run(answer({ subject: { id: "aps_v9", digest: "sha256:v9d1" } }), d)).toEqual({ status: "refused", reason: "variant-expired" });
    expect(d.resolved).toHaveLength(0);
    expect(d.replies[0]).toContain("expired");
  });

  test("request changes and reject act on the set: no binding needed, and a stale one is not forwarded", async () => {
    for (const subject of [undefined, { id: "aps_v3", digest: "sha256:v3d1" }, { id: "aps_gone", digest: "sha256:x" }]) {
      const reject = deps();
      expect(await run(answer({ option_id: "reject", subject }), reject)).toEqual({ status: "resolved" });
      expect(reject.resolved[0]).not.toHaveProperty("approvalSubject");
      const revise = deps();
      expect(await run(answer({ option_id: "request_changes", comment: "Shorter.", subject }), revise)).toEqual({ status: "resolved" });
      expect(revise.resolved[0]).not.toHaveProperty("approvalSubject");
    }
  });

  test("a v1 approve on a variant gate is refused: it can carry no choice", async () => {
    const d = deps();
    const v1 = { ...answer({ suite_event_type: GATE_DECISION_SUITE_TYPE, option_id: "approve" }) };
    expect(await run(v1, d)).toEqual({ status: "refused", reason: "subject-missing" });
    expect(d.resolved).toHaveLength(0);
    expect(d.replies[0]).toContain("updated app or on the board");
  });

  test("the board's refusals of a choice are said in plain words", async () => {
    const cases: Array<[string, DecisionRefusal, string]> = [
      ["APPROVAL_SUBJECT_MISMATCH", "subject-mismatch", "not one of this gate's versions"],
      ["DECISION_EXPIRED", "subject-expired", "expired"],
    ];
    for (const [code, reason, words] of cases) {
      const d = deps(VARIANT_GATE, { resolveGate: async () => ({ ok: false, code }) });
      expect(await run(answer(), d)).toEqual({ status: "refused", reason });
      expect(d.replies[0]).toContain(words);
      expect(d.replies[0]).toContain("Nothing has changed");
    }
  });
});

describe("the receipt after a choice names the variant", () => {
  test("from the room: the label of the variant the approval bound", async () => {
    const d = deps();
    await run(answer(), d);
    expect(d.replies[0]).toBe('Approved "With the thread" for automatic delivery by rakesh — the board has it.');
    expect(d.outcomes[0]).toMatchObject({ suite_event_type: GATE_OUTCOME_TYPE, decision: "approve_automatic", chosen_variant: { id: "thread", label: "With the thread" } });
  });

  test("a rejection names no variant", async () => {
    const d = deps();
    await run(answer({ option_id: "reject", subject: undefined }), d);
    expect(d.replies[0]).toBe("Rejected by rakesh — the board has it.");
    expect(d.outcomes[0]).not.toHaveProperty("chosen_variant");
  });

  test("decided on the board: the chosen variant the board's read gives", async () => {
    const replies: string[] = [];
    const outcomes: Array<Record<string, unknown>> = [];
    await settleGateOutcome(
      { gateId: "gate_5d72", decision: "approve_manual", decidedBy: "prn_person", chosen: { id: "short", label: "Short" } },
      "!room",
      { boardId: "brd_7c1f", eventId: GATE_EVENT },
      {
        displayNameFor: async () => "rakesh",
        reply: async (_r, b) => replies.push(b),
        sendOutcome: async (_r, c) => outcomes.push(c),
      },
    );
    expect(replies[0]).toBe('Approved "Short" for manual delivery by rakesh — the board has it.');
    expect(outcomes[0]).toMatchObject({ chosen_variant: { id: "short", label: "Short" } });
  });
});

/** The shared corpus's `variant: "choice"` entries: the hub's output must BE them, and it must refuse every rejected answer. */
describe("variant gates against the shared corpus", () => {
  interface Entry {
    suiteEventType: string;
    variant?: string;
    accept: Array<{ why: string; content: Record<string, unknown> }>;
    reject: Array<{ why: string; content: Record<string, unknown> }>;
  }
  const parsed: unknown = JSON.parse(
    readFileSync(join(import.meta.dir, "../../../../../fixtures/ecosystem-identity/matrix_gate_events.json"), "utf8"),
  );
  const corpus: { version: number; events: Entry[] } =
    typeof parsed === "object" && parsed !== null && "events" in parsed && "version" in parsed && Array.isArray(parsed.events) && typeof parsed.version === "number"
      ? { version: parsed.version, events: parsed.events }
      : { version: 0, events: [] };
  const entry = (t: string) => corpus.events.find((e) => e.suiteEventType === t && e.variant === "choice");
  const gateV2 = entry(GATE_V2_SUITE_TYPE);
  const gateV1 = entry("dev.superpipeline.gate.v1");
  const decision = entry(GATE_DECISION_V2_SUITE_TYPE);
  const outcome = entry(GATE_OUTCOME_TYPE);

  test("version 8, carried in 11", () => {
    expect(corpus.version).toBe(11);
  });

  test("the hub's gate.v2 for a variant gate is exactly what the corpus accepts", () => {
    expect(gateV2?.accept).toHaveLength(1);
    expect(gateV2Content(VARIANT_GATE, LINK)).toEqual(gateV2?.accept[0]?.content ?? {});
  });

  test("every variant gate.v2 the corpus rejects is one whose variants this hub would not carry", () => {
    expect(gateV2?.reject.length).toBeGreaterThanOrEqual(4);
    for (const { why, content } of gateV2?.reject ?? []) {
      const s = field(content, "subject");
      const variants = Array.isArray(s.variants)
        ? s.variants.map((v: unknown) => {
            const sub = field(v, "subject");
            return { ...field({ v }, "v"), subject: { ...sub, expiresAt: sub.expires_at, previewComplete: sub.preview_complete } };
          })
        : s.variants;
      const { variants: _v, ...rest } = s;
      expect(gateVariantsV2({ approvalSubject: { ...rest, variants } }), why).toBeNull();
    }
  });

  test("the v1 fallback is exactly the hub's v1 card and legacy event", () => {
    expect(gateV1?.accept).toHaveLength(1);
    expect(gateEventContent(VARIANT_GATE, LINK)).toEqual(gateV1?.accept[0]?.content ?? {});
    for (const { why, content } of gateV1?.reject ?? []) {
      const ids = optionIds(content.options);
      expect(ids, why).toContain("approve");
    }
  });

  test("every decision.v2 the corpus accepts resolves, and every one it rejects is refused", async () => {
    expect(decision?.accept.length).toBeGreaterThanOrEqual(2);
    for (const { why, content } of decision?.accept ?? []) {
      const d = deps();
      expect(await run(content, d), why).toEqual({ status: "resolved" });
    }
    expect(decision?.reject.length).toBeGreaterThanOrEqual(3);
    for (const { why, content } of decision?.reject ?? []) {
      const d = deps();
      expect((await run(content, d)).status, why).toBe("refused");
      expect(d.resolved, why).toHaveLength(0);
    }
  });

  test("the receipt after a choice is what the corpus accepts", async () => {
    const d = deps();
    await run(answer(), d);
    expect(d.outcomes[0]).toEqual(outcome?.accept[0]?.content ?? {});
  });
});

const SWEEP_CONFIG: Parameters<typeof bridgeGateSweepDeps>[0] = { baseUrl: "https://board.test", source: "superpipeline" };
const roster = async () => [{ boardId: "brd_7c1f", token: `spa_${"a".repeat(48)}` }];

/** The sweep's deps over a board whose gate read answers `gate`. */
function reading(gate: Record<string, unknown>) {
  return bridgeGateSweepDeps(
    SWEEP_CONFIG,
    { tenantIdFor: async () => "fleet_1", project: async () => ({ status: "already" }) },
    async () => ({ status: 200, ok: true, json: async () => ({ gate }) }),
    roster,
  );
}

describe("decided on the board: the sweep reads which variant was chosen", () => {

  test("the variant the gate's read marks chosen is named; none when the read marks none", async () => {
    const variants = [
      { id: "short", label: "Short", status: "invalidated", chosen: false },
      { id: "thread", label: "With the thread", status: "active", chosen: true },
    ];
    const chosen = await reading({ status: "resolved", decision: "approve_automatic", decidedBy: "prn_person", variants }).decisionFor?.("brd_7c1f", "gate_5d72");
    expect(chosen).toEqual({ decision: "approve_automatic", decidedBy: "prn_person", chosen: { id: "thread", label: "With the thread" }, heldUntil: null });
    for (const v of [undefined, "nonsense", [{ id: "thread", label: "With the thread", chosen: "yes" }], [{ id: 4, label: "x", chosen: true }]]) {
      const plain = await reading({ status: "resolved", decision: "reject", decidedBy: "prn_person", variants: v }).decisionFor?.("brd_7c1f", "gate_5d72");
      expect(plain).toEqual({ decision: "reject", decidedBy: "prn_person", chosen: null, heldUntil: null });
    }
  });

  test("the sweep hands the chosen variant to the receipt", async () => {
    const settled: unknown[] = [];
    await sweepGates({
      boards: async () => ["brd_7c1f"],
      tenantIdFor: async () => "fleet_1",
      pendingGates: async () => [],
      project: async () => ({ status: "already" }),
      postedGatesAwaitingOutcome: async () => [{ gateId: "gate_5d72", cardId: "crd_7e31" }],
      decisionFor: async () => ({ decision: "approve_manual", decidedBy: "prn_person", chosen: { id: "short", label: "Short" } }),
      settleOutcome: async (...args) => {
        settled.push(args);
        return true;
      },
    });
    expect(settled).toEqual([["gate_5d72", "approve_manual", "prn_person", { id: "short", label: "Short" }, null]]);
  });
});
