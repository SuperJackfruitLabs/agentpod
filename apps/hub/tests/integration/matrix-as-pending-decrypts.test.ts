import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { rawSql } from "../../src/db/drizzle";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { handleRoomMessage, retryPendingDecrypts, type InboundDeps, type InboundEvent } from "../../src/services/matrix-as/inbound";
import { PENDING_MAX, PENDING_TTL_MS } from "../../src/services/matrix-as/pending-decrypts";
import { GATE_DECISION_V2_SUITE_TYPE } from "../../src/services/board-chat/gate-wire";

/**
 * An encrypted event that arrives before its key waits in the database, not in memory.
 *
 * On 2026-11-11 a gate was approved from chat while the hub restarted twice. The approval's key
 * was late, the event was parked in a map, the restart emptied the map, and the homeserver had
 * already been told the transaction was applied. The board never heard, and nothing was logged.
 * Each test here builds fresh deps for the "after" half: nothing in memory survives between them,
 * exactly as nothing does across a restart.
 */

const DOMAIN = "id.agentpod.dev";
const ROOM = "!pending-decrypts:id.agentpod.dev";
const SPEAKER = "@agent_superpipeline:id.agentpod.dev";
const SENDER = "@owner-pending:id.agentpod.dev";

function encrypted(eventId: string): InboundEvent {
  return {
    type: "m.room.encrypted",
    sender: SENDER,
    room_id: ROOM,
    event_id: eventId,
    content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "opaque", session_id: "s1" },
  };
}

function decision(gateId: string): Record<string, unknown> {
  return {
    type: "m.room.message",
    content: {
      msgtype: "m.notice",
      body: "Approve",
      suite_event_type: GATE_DECISION_V2_SUITE_TYPE,
      gate_id: gateId,
      option_id: "approve",
      "m.relates_to": { rel_type: "m.reference", event_id: "$gate-card" },
    },
  };
}

/** Nothing here reaches a station: a decision is answered before any of these are asked. */
function unreachable(): never {
  throw new Error("a board-room decision never reaches a station");
}

/** Deps whose decrypt answers from `keys` (event id → plaintext); a missing key answers null. */
function depsWith(keys: Map<string, Record<string, unknown>>) {
  const handled: Array<{ sender: string; gateId: unknown; roomId: string }> = [];
  const deps: InboundDeps = {
    domain: DOMAIN,
    client: { sendText: async () => unreachable() },
    acp: { createSession: async () => unreachable(), promptSession: async () => unreachable() },
    attach: () => unreachable(),
    decrypt: async (_roomId, asUserId, event) => {
      expect(asUserId).toBe(SPEAKER);
      return keys.get(event.event_id ?? "") ?? null;
    },
    gates: {
      handle: async (event, roomId) => {
        handled.push({ sender: event.sender, gateId: event.content.gate_id, roomId });
        return { status: "resolved" };
      },
    },
  };
  return { deps, handled };
}

async function parkedIds(): Promise<string[]> {
  const rows = await rawSql`SELECT event_id FROM matrix_pending_decrypts WHERE room_id = ${ROOM} ORDER BY event_id`;
  return rows.map((r) => String(r.event_id));
}

beforeAll(async () => {
  await ensurePgMigrations();
  await rawSql`DELETE FROM matrix_board_rooms WHERE room_id = ${ROOM}`;
  await rawSql`
    INSERT INTO matrix_board_rooms (board_id, room_id, tenant_id, speaker_mxid, alias, created_at)
    VALUES ('brd_pending_decrypts', ${ROOM}, ${BOOTSTRAP_TENANT_ID}, ${SPEAKER},
            'agentpod_board_brd_pending_decrypts', now())`;
});

beforeEach(async () => {
  await rawSql`DELETE FROM matrix_pending_decrypts`;
});

afterAll(async () => {
  await rawSql`DELETE FROM matrix_pending_decrypts`;
  await rawSql`DELETE FROM matrix_board_rooms WHERE room_id = ${ROOM}`;
});

describe("a board-room event that arrives before its key", () => {
  test("is parked in the database, and nothing acts on it yet", async () => {
    const { deps, handled } = depsWith(new Map());
    await handleRoomMessage(encrypted("$late-1"), deps);

    expect(handled).toEqual([]);
    expect(await parkedIds()).toEqual(["$late-1"]);
  });

  test("survives a restart: a fresh hub that gets the key acts on it, once", async () => {
    await handleRoomMessage(encrypted("$late-2"), depsWith(new Map()).deps);
    // Held where a restart cannot reach it. (In one test process the old in-memory map would
    // also have survived, so this line, not the retry below, is what fails on the old code.)
    expect(await parkedIds()).toEqual(["$late-2"]);

    // The restart: new deps, nothing carried over in memory. Then the key arrives.
    const after = depsWith(new Map([["$late-2", decision("gate_restart")]]));
    await retryPendingDecrypts(after.deps);

    expect(after.handled).toEqual([{ sender: SENDER, gateId: "gate_restart", roomId: ROOM }]);
    expect(await parkedIds()).toEqual([]);

    await retryPendingDecrypts(after.deps);
    expect(after.handled).toHaveLength(1);
  });

  test("two retries at once act on it once", async () => {
    await handleRoomMessage(encrypted("$late-3"), depsWith(new Map()).deps);

    const after = depsWith(new Map([["$late-3", decision("gate_race")]]));
    await Promise.all([retryPendingDecrypts(after.deps), retryPendingDecrypts(after.deps)]);

    expect(after.handled).toHaveLength(1);
  });

  test("a homeserver retry of the same event parks it once", async () => {
    const { deps } = depsWith(new Map());
    await handleRoomMessage(encrypted("$late-4"), deps);
    await handleRoomMessage(encrypted("$late-4"), deps);

    expect(await parkedIds()).toEqual(["$late-4"]);
  });

  test("still unreadable on a retry, it keeps waiting", async () => {
    await handleRoomMessage(encrypted("$late-5"), depsWith(new Map()).deps);
    await retryPendingDecrypts(depsWith(new Map()).deps);

    expect(await parkedIds()).toEqual(["$late-5"]);
  });

  test("one that waited past its time is given up on, not acted on", async () => {
    await handleRoomMessage(encrypted("$late-6"), depsWith(new Map()).deps);
    await rawSql`
      UPDATE matrix_pending_decrypts
      SET first_seen_at = now() - (${PENDING_TTL_MS + 60_000} * interval '1 millisecond')
      WHERE event_id = '$late-6'`;

    const after = depsWith(new Map([["$late-6", decision("gate_expired")]]));
    await retryPendingDecrypts(after.deps);

    expect(after.handled).toEqual([]);
    expect(await parkedIds()).toEqual([]);
  });

  test(`no more than ${PENDING_MAX} wait; the oldest go first`, async () => {
    for (let i = 0; i < PENDING_MAX; i++) {
      await rawSql`
        INSERT INTO matrix_pending_decrypts (event_id, room_id, event, first_seen_at)
        VALUES (${`$old-${String(i).padStart(3, "0")}`}, ${ROOM}, '{}'::jsonb,
                now() - (${PENDING_MAX - i} * interval '1 second'))`;
    }
    await handleRoomMessage(encrypted("$newest"), depsWith(new Map()).deps);

    const ids = await parkedIds();
    expect(ids).toHaveLength(PENDING_MAX);
    expect(ids).toContain("$newest");
    expect(ids).not.toContain("$old-000");
  });
});
