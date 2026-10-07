/**
 * An agent's question arrives after the human has joined its board room — never before.
 *
 * The same rule as a gate (`gate-awaits-join.test.ts`, 2026-10-07): a question posted
 * into a board room the human had only been invited to is encrypted to the speaker
 * alone and can never be read. Held, it takes no claim — no `matrix_elicitation_events`
 * row — so the sweep and the join trigger re-offer it from the board's pending list,
 * and a hub restart loses nothing. With no row, nothing in the room is "the open
 * question" either, so no reply can be taken as an answer to a question nobody saw.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";

import { ensurePgMigrations } from "../helpers/pg-migrations";
import { db } from "../../src/db/drizzle";
import { matrixElicitationEvents } from "../../src/db/schema/matrix";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import type { ElicitationPendingDelivery } from "../../src/services/matrix-as/elicitation-card";
import {
  openQuestionInRoom,
  projectElicitation,
  type ElicitationProjectionDeps,
} from "../../src/services/matrix-as/elicitations";

const ROOM = "!board-elicit-join:id.agentpod.dev";
const SPEAKER = "@agent_superpipeline:id.agentpod.dev";

const delivery = (elicitationId: string): ElicitationPendingDelivery => ({
  event: "elicitation.pending",
  boardId: "brd_0123456789abcdef",
  cardId: "card_elicit_join",
  cardTitle: "Ship the widget",
  elicitationId,
  runId: "run_1",
  stageKey: "build",
  agentId: "agt_lyra",
  question: "Which database?",
  options: [
    { id: "pg", label: "Postgres" },
    { id: "sqlite", label: "SQLite" },
  ],
  ts: "2026-10-07T10:00:00Z",
});

function rig(joined: { value: boolean }) {
  const sent: string[] = [];
  const deps: ElicitationProjectionDeps = {
    boardRoom: async () => ({ roomId: ROOM, speakerMxid: SPEAKER }),
    humanJoined: async (roomId, speaker) => {
      expect(roomId).toBe(ROOM);
      expect(speaker).toBe(SPEAKER);
      return joined.value;
    },
    sendText: async (_u, _r, body) => {
      sent.push(body);
      return "$question";
    },
  };
  return { deps, sent };
}

async function wipe() {
  await db
    .delete(matrixElicitationEvents)
    .where(like(matrixElicitationEvents.elicitationId, "eli_awaitjoin_%"));
}

beforeAll(async () => {
  await ensurePgMigrations();
  await wipe();
});
afterAll(wipe);

describe("a question whose board room nobody has joined yet", () => {
  test("is held: nothing is sent, so nothing is encrypted to the speaker alone", async () => {
    const { deps, sent } = rig({ value: false });
    const outcome = await projectElicitation(BOOTSTRAP_TENANT_ID, delivery("eli_awaitjoin_1"), deps);
    expect(outcome).toEqual({ status: "awaiting-join", roomId: ROOM });
    expect(sent).toEqual([]);
  });

  test("takes no claim, and the room has no open question a reply could answer", async () => {
    const rows = await db
      .select()
      .from(matrixElicitationEvents)
      .where(eq(matrixElicitationEvents.elicitationId, "eli_awaitjoin_1"));
    expect(rows).toEqual([]);
    expect(await openQuestionInRoom(ROOM)).toBeNull();
  });

  test("is posted once the human has joined, and is then the room's open question", async () => {
    const { deps, sent } = rig({ value: true });
    const outcome = await projectElicitation(BOOTSTRAP_TENANT_ID, delivery("eli_awaitjoin_1"), deps);
    expect(outcome).toEqual({ status: "posted", roomId: ROOM, eventId: "$question" });
    expect(sent).toHaveLength(1);
    expect((await openQuestionInRoom(ROOM))?.elicitationId).toBe("eli_awaitjoin_1");
  });

  test("a question already in its room stays `already` even if the room has emptied since", async () => {
    const { deps, sent } = rig({ value: false });
    const outcome = await projectElicitation(BOOTSTRAP_TENANT_ID, delivery("eli_awaitjoin_1"), deps);
    expect(outcome).toEqual({ status: "already" });
    expect(sent).toEqual([]);
  });
});
