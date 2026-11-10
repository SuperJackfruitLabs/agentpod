/**
 * A gate is one event: the prose message carries it under
 * `dev.superpipeline.gate`, and the legacy custom event follows only while
 * `AGENTPOD_LEGACY_PERMISSION_EVENTS` is on.
 *
 * Against the real test Postgres, because the part worth proving is what gets
 * RECORDED — which event a decision may reference — and that lives in
 * `matrix_gate_events`, read back by the same `projectionForGate` the live
 * decision path uses.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GATE_REQUEST_CONTENT_KEY, GateRequestCard } from "@agentpod/contract";

import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { createTestUser, deleteTestUser } from "../../../tests/helpers/database";
import { db, rawSql } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { matrixRooms } from "../../db/schema/matrix";
import { bridgeDispatches } from "../../db/schema/bridge";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { mintEnrollmentToken, enrollNode } from "../nodes/enrollment";
import { createPrincipal } from "../../../tests/helpers/principals";
import { _resetHubEventsForTest, hubEventKind } from "../push/hub-events";
import {
  GATE_DECISION_SUITE_TYPE,
  GATE_DECISION_V2_SUITE_TYPE,
  GATE_EVENT_TYPE,
  GATE_V2_SUITE_TYPE,
  handleGateDecision,
  projectGate,
  projectionForGate,
  type GatePendingDelivery,
} from "./gates";
import { forgetPrincipals } from "../../../tests/helpers/principals";

const RUN = crypto.randomUUID().slice(0, 8);
const ACTOR = `test-gates-embedded-${RUN}`;
const ROOM = `!gates-embedded-${RUN}:id.agentpod.dev`;
let stationId: string;
let cardSeq = 0;

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: ACTOR, email: `${ACTOR}@example.com`, name: "Actor", role: "admin" });
  const { token } = await mintEnrollmentToken(ACTOR, BOOTSTRAP_TENANT_ID);
  const { nodeId } = await enrollNode(token, {
    hostname: `gates-embedded-${RUN}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 1,
  });
  const principalId = await createPrincipal({ kind: "agent", handle: `gates-embedded-${RUN}` });
  stationId = `st_ge_${RUN}`;
  await db.insert(stations).values({
    id: stationId,
    tenantId: BOOTSTRAP_TENANT_ID,
    userId: ACTOR,
    nodeId,
    harness: "opencode",
    stationKey: `opencode:${RUN}`,
    kind: "workspace",
    displayName: "Gates embedded",
    principalId,
  });
  await db.insert(matrixRooms).values({
    roomId: ROOM,
    tenantId: BOOTSTRAP_TENANT_ID,
    stationId,
    principalId,
    alias: `#ge-${RUN}:id.agentpod.dev`,
  });
});

afterEach(() => {
  delete process.env.AGENTPOD_LEGACY_PERMISSION_EVENTS;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM matrix_gate_events WHERE board_id = ${"brd_" + RUN}`;
    await rawSql`DELETE FROM bridge_dispatches WHERE board_id = ${"brd_" + RUN}`;
    await rawSql`DELETE FROM stations WHERE user_id = ${ACTOR}`;
    await rawSql`DELETE FROM nodes WHERE user_id = ${ACTOR}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${ACTOR}`;
    await forgetPrincipals({ handles: ["gates-embedded-" + RUN] });
    await deleteTestUser(ACTOR);
  } catch {
    // cleanup only
  }
});

async function dispatchedGate(): Promise<GatePendingDelivery> {
  cardSeq++;
  const cardId = `crd_${RUN}_${cardSeq}`;
  await db.insert(bridgeDispatches).values({
    externalSource: "superpipeline",
    externalRunId: `run_${RUN}_${cardSeq}`,
    tenantId: BOOTSTRAP_TENANT_ID,
    boardId: `brd_${RUN}`,
    externalCardId: cardId,
    agentKey: "test",
    stationId,
    leaseEpoch: 1,
    outcome: "produced",
    startedAt: new Date(),
    updatedAt: new Date(),
  });
  return {
    event: "gate.pending",
    boardId: `brd_${RUN}`,
    cardId,
    gateId: `gate_${RUN}_${cardSeq}`,
    stageKey: "review",
    returnStageKey: "code",
    cardTitle: "Ship the fix",
    producedBy: "agt_x",
    handoffSummary: "Fixed the thing.",
    options: [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
    ],
    ts: "2026-09-28T00:00:00.000Z",
  };
}

function recordingDeps() {
  const texts: Array<{ body: string; extra?: Record<string, unknown>; id: string }> = [];
  const customs: Array<{ type: string; content: Record<string, unknown>; id: string }> = [];
  return {
    texts,
    customs,
    deps: {
      domain: "id.agentpod.dev",
        boardRoom: async () => ({ roomId: "!board:id.agentpod.dev", speakerMxid: "@agent_superpipeline:id.agentpod.dev" }),
      sendText: async (_u: string, _r: string, body: string, extra?: Record<string, unknown>) => {
        const id = `$prose-${crypto.randomUUID()}`;
        texts.push({ body, extra, id });
        return id;
      },
      sendCustomEvent: async (_u: string, _r: string, type: string, content: Record<string, unknown>) => {
        const id = `$gate-${crypto.randomUUID()}`;
        customs.push({ type, content, id });
        return id;
      },
    },
  };
}

function decide(gateId: string, referenced: string) {
  const resolved: unknown[] = [];
  return {
    resolved,
    run: () =>
      handleGateDecision(
        {
          sender: "@rakesh:id.agentpod.dev",
          content: {
            msgtype: "m.text",
            body: "Approved",
            suite_event_type: GATE_DECISION_SUITE_TYPE,
            gate_id: gateId,
            option_id: "approve",
            "m.relates_to": { rel_type: "m.reference", event_id: referenced },
          },
        },
        ROOM,
        {
          // A human: a gate is a person's answer, and the kind is now part of the
          // contract so a caller cannot resolve one without it (agentpod#608).
          principalForMatrixId: async () => ({ id: "principal_1", kind: "human" as const }),
          projectionFor: projectionForGate,
          resolveGate: async (i) => {
            resolved.push(i);
            return { ok: true };
          },
          reply: async () => null,
        }
      ),
  };
}

describe("a gate rides inside its prose message", () => {
  test("the prose carries the card under dev.superpipeline.gate, the same payload as the legacy event", async () => {
    _resetHubEventsForTest();
    const d = await dispatchedGate();
    const { deps, texts, customs } = recordingDeps();

    const outcome = await projectGate(BOOTSTRAP_TENANT_ID, d, deps);
    expect(outcome.status).toBe("sent");

    expect(texts).toHaveLength(1);
    const card = GateRequestCard.parse(texts[0]!.extra?.[GATE_REQUEST_CONTENT_KEY]);
    expect(card.gate_id).toBe(d.gateId);
    expect(card.handoff_summary).toBe("Fixed the thing.");

    // Legacy on by default: the custom event still follows, with the same card.
    expect(customs).toHaveLength(1);
    expect(customs[0]!.type).toBe(GATE_EVENT_TYPE);
    const { body: _body, ...legacyCard } = customs[0]!.content;
    expect(legacyCard).toEqual(texts[0]!.extra![GATE_REQUEST_CONTENT_KEY] as Record<string, unknown>);

    // The prose is the question's push; the legacy event must not buzz again.
    expect(hubEventKind(texts[0]!.id)).toBe("gate");
    expect(hubEventKind(customs[0]!.id)).toBe("companion");
  });

  test("with legacy on, a decision may reference either event", async () => {
    const d = await dispatchedGate();
    const { deps, texts, customs } = recordingDeps();
    await projectGate(BOOTSTRAP_TENANT_ID, d, deps);

    const projection = await projectionForGate(d.gateId);
    expect(projection).toMatchObject({ eventId: customs[0]!.id, proseEventId: texts[0]!.id });

    const viaLegacy = decide(d.gateId, customs[0]!.id);
    expect((await viaLegacy.run()).status).toBe("resolved");
    const viaProse = decide(d.gateId, texts[0]!.id);
    expect((await viaProse.run()).status).toBe("resolved");
    const viaOther = decide(d.gateId, "$something-else");
    expect(await viaOther.run()).toEqual({ status: "refused", reason: "reference-mismatch" });
    expect(viaOther.resolved).toHaveLength(0);
  });

  test("with legacy off, the prose is the only event and the one a decision references", async () => {
    process.env.AGENTPOD_LEGACY_PERMISSION_EVENTS = "false";
    const d = await dispatchedGate();
    const { deps, texts, customs } = recordingDeps();

    const outcome = await projectGate(BOOTSTRAP_TENANT_ID, d, deps);
    expect(outcome).toMatchObject({ status: "sent", eventId: texts[0]!.id });
    expect(customs).toHaveLength(0);

    const projection = await projectionForGate(d.gateId);
    expect(projection).toMatchObject({ eventId: texts[0]!.id, proseEventId: texts[0]!.id });
    expect((await decide(d.gateId, texts[0]!.id).run()).status).toBe("resolved");
  });
});

/** A decision.v2 on a projected gate, resolved against what `projectionForGate` recorded. */
function decideV2(gateId: string, referenced: string, over: Record<string, unknown> = {}) {
  const resolved: Array<Record<string, unknown>> = [];
  return {
    resolved,
    run: () =>
      handleGateDecision(
        {
          sender: "@person:id.example",
          content: {
            msgtype: "m.text",
            body: "Approved — post automatically",
            suite_event_type: GATE_DECISION_V2_SUITE_TYPE,
            gate_id: gateId,
            option_id: "approve_automatic",
            subject: { id: `aps_${RUN}`, digest: "sha256:3f1c0d9a" },
            "m.relates_to": { rel_type: "m.reference", event_id: referenced },
            ...over,
          },
        },
        ROOM,
        {
          principalForMatrixId: async () => ({ id: "principal_1", kind: "human" as const }),
          projectionFor: projectionForGate,
          resolveGate: async (i) => {
            resolved.push(i);
            return { ok: true };
          },
          reply: async () => null,
        }
      ),
  };
}

/**
 * gate.v2 against the real table (charter: decisions/2026-11-07-gate-v2-is-the-decision-envelope.md).
 *
 * What is worth proving here is what gets RECORDED: the options the gate offered and its
 * subject, read back by the same `projectionForGate` the live decision path uses, because a
 * decision.v2 is checked against them and not against a list.
 */
describe("gate.v2 rides on the prose message", () => {
  const POST = "Shipping the new release today.\n\nNotes: *fast* paths.";

  async function publishingGate(): Promise<GatePendingDelivery> {
    const d = await dispatchedGate();
    return {
      ...d,
      handoffSummary: POST,
      options: [
        { id: "approve_manual", label: "Approve — I'll post it myself", meaning: "approve", needsComment: false, delivery: "manual" },
        { id: "approve_automatic", label: "Approve — post automatically", meaning: "approve", needsComment: false, delivery: "automatic" },
        { id: "request_changes", label: "Request changes", meaning: "revise", needsComment: true },
        { id: "reject", label: "Reject", meaning: "reject", needsComment: false },
      ],
      approvalSubject: {
        id: `aps_${RUN}`,
        digest: "sha256:3f1c0d9a",
        schema: "social-publish/v1",
        revision: 1,
        expiresAt: null,
        previewComplete: true,
        preview: [{ type: "text", label: "Post", text: POST }],
      },
    };
  }

  test("the prose carries the v2 marker, all four options and the exact post; the v1 card beside it is unchanged", async () => {
    const d = await publishingGate();
    const { deps, texts, customs } = recordingDeps();
    expect((await projectGate(BOOTSTRAP_TENANT_ID, d, deps)).status).toBe("sent");

    const [prose] = texts;
    const extra = prose?.extra ?? {};
    expect(extra.suite_event_type).toBe(GATE_V2_SUITE_TYPE);
    expect(extra.options).toEqual([
      { id: "approve_manual", label: "Approve — I'll post it myself", meaning: "approve", needs_comment: false, delivery: "manual" },
      { id: "approve_automatic", label: "Approve — post automatically", meaning: "approve", needs_comment: false, delivery: "automatic" },
      { id: "request_changes", label: "Request changes", meaning: "revise", needs_comment: true },
      { id: "reject", label: "Reject", meaning: "reject", needs_comment: false },
    ]);
    expect(extra.subject).toMatchObject({ id: `aps_${RUN}`, digest: "sha256:3f1c0d9a" });
    expect(prose?.body).toContain(POST);

    // v1 clients: the embedded card and the legacy event still offer only the v1 ids.
    const card = GateRequestCard.parse(extra[GATE_REQUEST_CONTENT_KEY]);
    expect(card.options.map((o) => o.id)).toEqual(["request_changes", "reject"]);
    expect(customs[0]?.type).toBe(GATE_EVENT_TYPE);
    expect(customs[0]?.content).not.toHaveProperty("suite_event_type");
  });

  test("the offered options and the subject are recorded, and a decision.v2 is judged against them", async () => {
    const d = await publishingGate();
    const { deps, texts } = recordingDeps();
    await projectGate(BOOTSTRAP_TENANT_ID, d, deps);

    const projection = await projectionForGate(d.gateId);
    expect(projection?.options?.map((o) => o.id)).toEqual(["approve_manual", "approve_automatic", "request_changes", "reject"]);
    expect(projection).toMatchObject({
      subjectId: `aps_${RUN}`,
      subjectDigest: "sha256:3f1c0d9a",
      subjectPreviewComplete: true,
    });
    const proseId = texts[0]?.id ?? "";

    const ok = decideV2(d.gateId, proseId);
    expect((await ok.run()).status).toBe("resolved");
    expect(ok.resolved[0]).toMatchObject({
      decision: "approve_automatic",
      approvalSubject: { id: `aps_${RUN}`, digest: "sha256:3f1c0d9a" },
    });

    const notOffered = decideV2(d.gateId, proseId, { option_id: "approve" });
    expect(await notOffered.run()).toEqual({ status: "refused", reason: "bad-option" });
    const noBinding = decideV2(d.gateId, proseId, { subject: undefined });
    expect(await noBinding.run()).toEqual({ status: "refused", reason: "subject-missing" });
    const noComment = decideV2(d.gateId, proseId, { option_id: "request_changes" });
    expect(await noComment.run()).toEqual({ status: "refused", reason: "comment-required" });
    for (const r of [notOffered, noBinding, noComment]) expect(r.resolved).toHaveLength(0);
  });

  test("a gate bound to no subject records its options and no subject", async () => {
    const d = await dispatchedGate();
    const { deps, texts } = recordingDeps();
    await projectGate(BOOTSTRAP_TENANT_ID, d, deps);
    const proseId = texts[0]?.id ?? "";
    expect(await projectionForGate(d.gateId)).toMatchObject({
      options: [
        { id: "approve", label: "Approve", meaning: "approve", needs_comment: false },
        { id: "reject", label: "Reject", meaning: "reject", needs_comment: false },
      ],
      subjectId: null,
      subjectDigest: null,
      subjectPreviewComplete: null,
    });
    const v2 = decideV2(d.gateId, proseId, { option_id: "approve", subject: undefined });
    expect((await v2.run()).status).toBe("resolved");
    expect(v2.resolved[0]).not.toHaveProperty("approvalSubject");
  });

  test("a preview the board could not send in full is recorded so, and an approval of it is refused", async () => {
    const full = await publishingGate();
    const d: GatePendingDelivery = {
      ...full,
      approvalSubject: {
        id: `aps_${RUN}`,
        digest: "sha256:3f1c0d9a",
        schema: "social-publish/v1",
        revision: 1,
        expiresAt: null,
        previewComplete: false,
        preview: [{ type: "text", label: "Post", text: POST }],
      },
    };
    const { deps, texts } = recordingDeps();
    await projectGate(BOOTSTRAP_TENANT_ID, d, deps);
    const proseId = texts[0]?.id ?? "";
    expect(texts[0]?.extra?.subject).toMatchObject({ preview_complete: false });
    expect(await projectionForGate(d.gateId)).toMatchObject({ subjectPreviewComplete: false });

    const approve = decideV2(d.gateId, proseId);
    expect(await approve.run()).toEqual({ status: "refused", reason: "preview-incomplete" });
    expect(approve.resolved).toHaveLength(0);
    expect((await decideV2(d.gateId, proseId, { option_id: "reject" }).run()).status).toBe("resolved");
  });
});

/** One variant of a choice, as the board pushes it. */
function variant(id: string, n: number, previewComplete: boolean) {
  return {
    id,
    label: `Version ${id}`,
    subject: {
      id: `aps_${RUN}_${n}`,
      digest: `sha256:${n}`,
      schema: "social-publish/v1",
      revision: n,
      expiresAt: "2030-01-02T03:04:05Z",
      previewComplete,
      preview: [{ type: "text", label: "Post", text: `Draft ${id}` }],
    },
  };
}

/** A dispatched gate offering a choice of two variants, the second shortened by the board. */
async function variantGate(): Promise<GatePendingDelivery> {
  const d = await dispatchedGate();
  return {
    ...d,
    options: [
      { id: "approve_automatic", label: "Approve — post automatically", meaning: "approve", needsComment: false, delivery: "automatic" },
      { id: "request_changes", label: "Request changes", meaning: "revise", needsComment: true },
      { id: "reject", label: "Reject", meaning: "reject", needsComment: false },
    ],
    approvalSubject: { variants: [variant("a", 1, true), variant("b", 2, false)] },
  };
}

describe("a variant gate rides on the prose message and is judged against what was recorded", () => {
  test("each variant is recorded, and only a complete one can be chosen from the room", async () => {
    const d = await variantGate();
    const { deps, texts } = recordingDeps();
    expect((await projectGate(BOOTSTRAP_TENANT_ID, d, deps)).status).toBe("sent");
    expect(texts[0]?.extra?.subject).toMatchObject({ variants: [{ id: "a" }, { id: "b" }] });
    const card = GateRequestCard.parse(texts[0]?.extra?.[GATE_REQUEST_CONTENT_KEY]);
    expect(card.options.map((o) => o.id)).toEqual(["request_changes", "reject"]);

    expect(await projectionForGate(d.gateId)).toMatchObject({
      subjectId: null,
      variants: [
        { id: "a", label: "Version a", subject_id: `aps_${RUN}_1`, digest: "sha256:1", preview_complete: true, expires_at: "2030-01-02T03:04:05Z" },
        { id: "b", label: "Version b", subject_id: `aps_${RUN}_2`, digest: "sha256:2", preview_complete: false, expires_at: "2030-01-02T03:04:05Z" },
      ],
    });
    const proseId = texts[0]?.id ?? "";

    const incomplete = decideV2(d.gateId, proseId, { subject: { id: `aps_${RUN}_2`, digest: "sha256:2" } });
    expect(await incomplete.run()).toEqual({ status: "refused", reason: "variant-incomplete" });
    const unknown = decideV2(d.gateId, proseId, { subject: { id: `aps_${RUN}_1`, digest: "sha256:2" } });
    expect(await unknown.run()).toEqual({ status: "refused", reason: "variant-unknown" });
    for (const r of [incomplete, unknown]) expect(r.resolved).toHaveLength(0);

    const chosen = decideV2(d.gateId, proseId, { subject: { id: `aps_${RUN}_1`, digest: "sha256:1" } });
    expect(await chosen.run()).toEqual({ status: "resolved" });
    expect(chosen.resolved[0]).toMatchObject({ approvalSubject: { id: `aps_${RUN}_1`, digest: "sha256:1" } });
  });

  test("an ordinary gate records no variants", async () => {
    const d = await dispatchedGate();
    const { deps } = recordingDeps();
    await projectGate(BOOTSTRAP_TENANT_ID, d, deps);
    expect(await projectionForGate(d.gateId)).toMatchObject({ variants: null });
  });
});
