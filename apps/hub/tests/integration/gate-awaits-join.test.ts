/**
 * A gate arrives after the human has joined its board room — never before.
 *
 * 2026-10-07, room !LEug4KhmCbPF9HMHqY: a board's first gate made the board room,
 * invited the human and posted the card at once. The human had not accepted yet, so
 * the card was encrypted to the board's speaker alone (`recipients: 1, shares: 0`)
 * and could never be read on their devices. A later gate, after the join, was fine.
 *
 * Operator decision: hold the gate until somebody has joined, then post it. The hold
 * keeps no state of its own — no claim is taken — so the sweep and the join trigger
 * re-offer it, and a hub restart loses nothing: superpipeline still lists the gate
 * as pending, and that list is what both of them read.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";

import { ensurePgMigrations } from "../helpers/pg-migrations";
import { db } from "../../src/db/drizzle";
import { matrixGateEvents } from "../../src/db/schema/matrix";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { projectGate, type GatePendingDelivery, type GateProjectionDeps } from "../../src/services/matrix-as/gates";

const ROOM = "!board-join:id.agentpod.dev";
const SPEAKER = "@agent_superpipeline:id.agentpod.dev";

const delivery = (gateId: string): GatePendingDelivery => ({
  event: "gate.pending",
  boardId: "brd_0123456789abcdef",
  cardId: "card_join",
  gateId,
  stageKey: "review",
  returnStageKey: "build",
  cardTitle: "Ship the widget",
  producedBy: "lyra",
  options: [
    { id: "approve", label: "Approve" },
    { id: "reject", label: "Reject" },
  ],
  ts: "2026-10-07T10:00:00Z",
});

function rig(joined: { value: boolean }) {
  const sent: string[] = [];
  const posted: string[] = [];
  const deps: GateProjectionDeps = {
    domain: "id.agentpod.dev",
    boardRoom: async () => ({ roomId: ROOM, speakerMxid: SPEAKER }),
    humanJoined: async (roomId, speaker) => {
      expect(roomId).toBe(ROOM);
      expect(speaker).toBe(SPEAKER);
      return joined.value;
    },
    sendText: async () => {
      sent.push("prose");
      return "$prose";
    },
    sendCustomEvent: async () => {
      sent.push("legacy");
      return "$legacy";
    },
    onPosted: async (d) => void posted.push(d.gateId),
  };
  return { deps, sent, posted };
}

async function wipe() {
  await db.delete(matrixGateEvents).where(like(matrixGateEvents.gateId, "gate_awaitjoin_%"));
}

beforeAll(async () => {
  await ensurePgMigrations();
  await wipe();
});
afterAll(wipe);

describe("a gate whose board room nobody has joined yet", () => {
  test("is held: nothing is sent, so nothing is encrypted to the speaker alone", async () => {
    const joined = { value: false };
    const { deps, sent, posted } = rig(joined);
    const outcome = await projectGate(BOOTSTRAP_TENANT_ID, delivery("gate_awaitjoin_1"), deps);
    expect(outcome).toEqual({ status: "awaiting-join", roomId: ROOM });
    expect(sent).toEqual([]);
    expect(posted).toEqual([]);
  });

  test("takes no claim, so a later offer — sweep, join or a restarted hub — can still post it", async () => {
    const rows = await db.select().from(matrixGateEvents).where(eq(matrixGateEvents.gateId, "gate_awaitjoin_1"));
    expect(rows).toEqual([]);
  });

  test("is posted once the human has joined, however much later that is", async () => {
    const joined = { value: true };
    const { deps, sent, posted } = rig(joined);
    const outcome = await projectGate(BOOTSTRAP_TENANT_ID, delivery("gate_awaitjoin_1"), deps);
    expect(outcome.status).toBe("sent");
    expect(sent[0]).toBe("prose");
    expect(posted).toEqual(["gate_awaitjoin_1"]);
  });

  test("a gate already in its room stays `already` even if the room has emptied since", async () => {
    const joined = { value: false };
    const { deps, sent } = rig(joined);
    const outcome = await projectGate(BOOTSTRAP_TENANT_ID, delivery("gate_awaitjoin_1"), deps);
    expect(outcome).toEqual({ status: "already" });
    expect(sent).toEqual([]);
  });
});
