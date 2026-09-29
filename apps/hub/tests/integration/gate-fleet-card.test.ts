/**
 * A projected gate is handed to the fleet Live Activity once it is in its
 * room — with the ids a decision is answered by — and a gate that could not
 * be posted is not.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { like } from "drizzle-orm";

import { ensurePgMigrations } from "../helpers/pg-migrations";
import { db } from "../../src/db/drizzle";
import { matrixGateEvents } from "../../src/db/schema/matrix";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { projectGate, projectionForGate, type GatePendingDelivery } from "../../src/services/matrix-as/gates";

const delivery = (gateId: string): GatePendingDelivery => ({
  event: "gate.pending",
  boardId: "brd_0123456789abcdef",
  cardId: "card_fleet",
  gateId,
  stageKey: "review",
  returnStageKey: "build",
  cardTitle: "Ship the widget",
  producedBy: "lyra",
  options: [
    { id: "approve", label: "Approve" },
    { id: "reject", label: "Reject" },
  ],
  ts: "2026-09-29T10:00:00Z",
});

async function wipe() {
  await db.delete(matrixGateEvents).where(like(matrixGateEvents.gateId, "gate_fleetcard_%"));
}

beforeAll(async () => {
  await ensurePgMigrations();
  await wipe();
});
afterAll(wipe);

describe("a projected gate and the fleet card", () => {
  test("is handed over once posted, with its room and both event ids — and the projection knows its room", async () => {
    const posted: unknown[] = [];
    const outcome = await projectGate(BOOTSTRAP_TENANT_ID, delivery("gate_fleetcard_1"), {
      domain: "id.agentpod.dev",
      boardRoom: async () => ({ roomId: "!board-fleet:id.agentpod.dev", speakerMxid: "@agent_superpipeline:id.agentpod.dev" }),
      sendText: async () => "$prose-fleet",
      sendCustomEvent: async () => "$legacy-fleet",
      onPosted: async (d, p) => {
        posted.push({ gateId: d.gateId, ...p });
      },
    });
    expect(outcome.status).toBe("sent");
    expect(posted).toHaveLength(1);
    expect((posted[0] as { gateId: string }).gateId).toBe("gate_fleetcard_1");
    expect((posted[0] as { roomId: string }).roomId).toBe("!board-fleet:id.agentpod.dev");
    expect((posted[0] as { proseEventId: string }).proseEventId).toBe("$prose-fleet");
    expect((await projectionForGate("gate_fleetcard_1"))?.roomId).toBe("!board-fleet:id.agentpod.dev");
  });

  test("a gate that was refused a room is not handed over, and a failing hand-over costs nothing", async () => {
    let calls = 0;
    const refused = await projectGate(BOOTSTRAP_TENANT_ID, delivery("gate_fleetcard_2"), {
      domain: "id.agentpod.dev",
      boardRoom: async () => ({ roomId: "!board-fleet:id.agentpod.dev", speakerMxid: "@agent_superpipeline:id.agentpod.dev" }),
      sendText: async () => null,
      sendCustomEvent: async () => null,
      onPosted: async () => {
        calls++;
      },
    });
    expect(refused.status).toBe("no-room");
    expect(calls).toBe(0);

    const ok = await projectGate(BOOTSTRAP_TENANT_ID, delivery("gate_fleetcard_3"), {
      domain: "id.agentpod.dev",
      boardRoom: async () => ({ roomId: "!board-fleet:id.agentpod.dev", speakerMxid: "@agent_superpipeline:id.agentpod.dev" }),
      sendText: async () => "$p3",
      sendCustomEvent: async () => "$l3",
      onPosted: async () => {
        throw new Error("fleet down");
      },
    });
    expect(ok.status).toBe("sent");
  });
});
