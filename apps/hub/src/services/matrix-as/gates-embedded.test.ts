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
import { createTestUser } from "../../../tests/helpers/database";
import { db, rawSql } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { matrixRooms } from "../../db/schema/matrix";
import { bridgeDispatches } from "../../db/schema/bridge";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { mintEnrollmentToken, enrollNode } from "../enrollment";
import { createPrincipal } from "../principals";
import { _resetHubEventsForTest, hubEventKind } from "../push/hub-events";
import {
  GATE_DECISION_SUITE_TYPE,
  GATE_EVENT_TYPE,
  handleGateDecision,
  projectGate,
  projectionForGate,
  type GatePendingDelivery,
} from "./gates";

const RUN = crypto.randomUUID().slice(0, 8);
const ACTOR = `test-gates-embedded-${RUN}`;
const ROOM = `!gates-embedded-${RUN}:id.agentpod.dev`;
let stationId: string;
let cardSeq = 0;

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: ACTOR, email: `${ACTOR}@example.com`, name: "Actor", role: "admin" });
  const { token } = await mintEnrollmentToken(ACTOR);
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
    await rawSql`DELETE FROM principals WHERE handle = ${"gates-embedded-" + RUN}`;
    await rawSql`DELETE FROM "user" WHERE id = ${ACTOR}`;
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
          principalForMatrixId: async () => "principal_1",
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
