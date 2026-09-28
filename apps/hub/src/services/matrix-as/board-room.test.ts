process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { db, rawSql } from "../../db/drizzle";
import { matrixBoardRooms } from "../../db/schema/board-rooms";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import {
  boardRoomAlias,
  boardSpeakerMxid,
  ensureBoardRoom,
  type BoardRoomDeps,
} from "./board-room";

/**
 * The room a board's gates close in.
 *
 * What is asserted hardest is the ORDER, because order is what makes this safe to
 * run twice: a room recorded before it is encrypted is a room gates go into in the
 * clear, and a room created but not recorded is a second room on the next call —
 * two rooms for one board being the failure that retrying cannot repair.
 */
const DOMAIN = "id.agentpod.dev";
const HUMAN = `@rakesh:${DOMAIN}`;
const RUN = crypto.randomUUID().slice(0, 8);

function rig(over: Partial<BoardRoomDeps> = {}) {
  const calls: string[] = [];
  const invited: string[] = [];
  const deps: BoardRoomDeps = {
    domain: DOMAIN,
    nameFor: async (id) => `Board ${id}`,
    ensureUser: async (lp) => void calls.push(`ensureUser:${lp}`),
    ensureRoom: async (alias, opts) => {
      calls.push(`ensureRoom:${alias}:${opts.name}`);
      return `!room-${alias}:${DOMAIN}`;
    },
    invite: async (_as, _room, who) => {
      calls.push("invite");
      invited.push(who);
    },
    enableEncryption: async () => {
      calls.push("encrypt");
      return true;
    },
    humansFor: async () => [HUMAN],
    ...over,
  };
  return { deps, calls, invited };
}

beforeAll(async () => {
  await ensurePgMigrations();
});

afterEach(async () => {
  await rawSql`DELETE FROM matrix_board_rooms WHERE board_id LIKE ${"brd_test_" + RUN + "%"}`;
});

describe("a board's room", () => {
  test("is created, encrypted, recorded, and its humans invited", async () => {
    const boardId = `brd_test_${RUN}_a`;
    const { deps, calls, invited } = rig();

    const room = await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps);

    expect(room).not.toBeNull();
    expect(room!.created).toBe(true);
    expect(room!.speakerMxid).toBe(boardSpeakerMxid(DOMAIN));
    expect(invited).toContain(HUMAN);

    const [row] = await db
      .select()
      .from(matrixBoardRooms)
      .where(eq(matrixBoardRooms.boardId, boardId));
    expect(row!.roomId).toBe(room!.roomId);
    expect(row!.speakerMxid).toBe(boardSpeakerMxid(DOMAIN));
    expect(row!.alias).toBe(boardRoomAlias(boardId));
  });

  test("encryption is turned on BEFORE the room is recorded", async () => {
    // A room written down as the board's while still plaintext is a room gates
    // would be posted into in the clear.
    const boardId = `brd_test_${RUN}_b`;
    const { deps, calls } = rig();
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps);
    expect(calls.indexOf("encrypt")).toBeGreaterThan(calls.findIndex((c) => c.startsWith("ensureRoom:")));
  });

  test("a room that cannot be encrypted is NOT recorded", async () => {
    // Better to make it again next time than to remember a room gates cannot
    // safely use.
    const boardId = `brd_test_${RUN}_c`;
    const { deps } = rig({ enableEncryption: async () => false });

    const room = await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps);

    expect(room).toBeNull();
    const rows = await db
      .select()
      .from(matrixBoardRooms)
      .where(eq(matrixBoardRooms.boardId, boardId));
    expect(rows).toHaveLength(0);
  });

  test("asking twice returns the same room rather than making a second", async () => {
    // Two rooms for one board is the failure retrying cannot repair.
    const boardId = `brd_test_${RUN}_d`;
    const first = await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, rig().deps);
    const second = await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, rig().deps);

    expect(second!.roomId).toBe(first!.roomId);
    expect(second!.created).toBe(false);
  });

  test("a human added later is invited to the room that already exists", async () => {
    const boardId = `brd_test_${RUN}_e`;
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, rig().deps);

    const late = `@second:${DOMAIN}`;
    const { deps, invited } = rig({ humansFor: async () => [HUMAN, late] });
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps);

    expect(invited).toContain(late);
  });

  test("one person who cannot be invited does not cost everybody else the room", async () => {
    const boardId = `brd_test_${RUN}_f`;
    const good = `@good:${DOMAIN}`;
    const { deps, invited } = rig({
      humansFor: async () => [`@bad:${DOMAIN}`, good],
      invite: async (_as, _room, who) => {
        if (who.startsWith("@bad")) throw new Error("M_FORBIDDEN");
        invitedLocal.push(who);
      },
    });
    const invitedLocal: string[] = [];

    const room = await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps);

    expect(room).not.toBeNull();
    expect(invitedLocal).toContain(good);
  });

  test("each board's room is named for its board, never all the same", async () => {
    // Every room was called "superpipeline", so a second board produced a second
    // room with the same name and nothing to tell them apart — the speaker is the
    // same identity in all of them.
    const one = `brd_test_${RUN}_n1`;
    const two = `brd_test_${RUN}_n2`;
    const a = rig({ nameFor: async () => "Press" });
    const b = rig({ nameFor: async () => "Delivery" });

    await ensureBoardRoom(one, BOOTSTRAP_TENANT_ID, a.deps);
    await ensureBoardRoom(two, BOOTSTRAP_TENANT_ID, b.deps);

    expect(a.calls.some((c) => c.endsWith(":Press"))).toBe(true);
    expect(b.calls.some((c) => c.endsWith(":Delivery"))).toBe(true);
  });

  test("a board whose name cannot be read is named by its id, not by a constant", async () => {
    // A room a person cannot identify is worse than an ugly one.
    const boardId = `brd_test_${RUN}_n3`;
    const { deps, calls } = rig({ nameFor: async (id) => id });
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps);
    expect(calls.some((c) => c.endsWith(`:${boardId}`))).toBe(true);
  });

  test("the alias is safe for a board id with awkward characters", async () => {
    // It becomes a Matrix alias localpart, and the appservice owns `#agentpod_.*`.
    expect(boardRoomAlias("brd_7c1f")).toBe("agentpod_board_brd_7c1f");
    expect(boardRoomAlias("brd/../etc")).toBe("agentpod_board_brd____etc");
  });
});
