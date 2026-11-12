import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { ensurePgMigrations } from "../helpers/pg-migrations";
import { rawSql } from "../../src/db/drizzle";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { collectConfigErrors } from "../../src/validate-config";
import { config } from "../../src/config";
import {
  MOVED_NOTICE,
  MovedBoardsConfigError,
  announceMovedBoards,
  movedBoardOfRoom,
  parseMovedBoards,
} from "../../src/services/board-chat/moved-boards";

/**
 * Boards whose chat has moved out of this hub (BOARD_CHAT_MOVED_BOARDS): the setting itself, and
 * the one notice each moved board's old room gets. The paths that skip a moved board are tested
 * where they live (the push and event routes, the sweeps, the join wake, inbound answers).
 */

const RUN = crypto.randomUUID().slice(0, 8);
const MOVED = `brd_moved_${RUN}`;
const STAYING = `brd_staying_${RUN}`;
const SPEAKER = "@agent_superpipeline:id.agentpod.dev";
const roomOf = (boardId: string) => `!${boardId}:id.agentpod.dev`;

/** The configuration errors a value of the setting raises, the setting's own only. */
function movedBoardsErrors(moved: string | undefined): string[] {
  return collectConfigErrors(config, () => {}, undefined, [], undefined, undefined, { ok: true, credential: null }, moved)
    .map((e) => e.field)
    .filter((f) => f === "BOARD_CHAT_MOVED_BOARDS");
}

/** The board a room belongs to, as the hub records it. */
async function lookup(roomId: string): Promise<{ boardId: string } | null> {
  const [row] = await rawSql`SELECT board_id FROM matrix_board_rooms WHERE room_id = ${roomId}`;
  return typeof row?.board_id === "string" ? { boardId: row.board_id } : null;
}

const before = process.env.BOARD_CHAT_MOVED_BOARDS;
afterEach(() => {
  if (before === undefined) delete process.env.BOARD_CHAT_MOVED_BOARDS;
  else process.env.BOARD_CHAT_MOVED_BOARDS = before;
});

beforeAll(async () => {
  await ensurePgMigrations();
  for (const boardId of [MOVED, STAYING]) {
    await rawSql`
      INSERT INTO matrix_board_rooms (board_id, room_id, tenant_id, speaker_mxid, alias)
      VALUES (${boardId}, ${roomOf(boardId)}, ${BOOTSTRAP_TENANT_ID}, ${SPEAKER}, ${`agentpod_board_${boardId}`})`;
  }
});

afterAll(async () => {
  await rawSql`DELETE FROM matrix_board_rooms WHERE board_id IN (${MOVED}, ${STAYING})`;
});

describe("the setting", () => {
  test("is a comma-separated list of board ids; unset or empty moves nothing", () => {
    expect(parseMovedBoards(undefined)).toEqual(new Set());
    expect(parseMovedBoards("  ")).toEqual(new Set());
    expect(parseMovedBoards(" brd_a , brd_b-2 ")).toEqual(new Set(["brd_a", "brd_b-2"]));
    expect(() => parseMovedBoards("brd_a,,brd_b")).toThrow(MovedBoardsConfigError);
    expect(() => parseMovedBoards("brd a")).toThrow(MovedBoardsConfigError);
  });

  test("a malformed one refuses the boot", () => {
    expect(movedBoardsErrors("brd_a,brd b")).toEqual(["BOARD_CHAT_MOVED_BOARDS"]);
    expect(movedBoardsErrors("brd_a,brd_b")).toEqual([]);
    expect(movedBoardsErrors(undefined)).toEqual([]);
  });
});

describe("the old room of a moved board", () => {
  test("is recognised as moved; another board's room is not", async () => {
    process.env.BOARD_CHAT_MOVED_BOARDS = MOVED;
    expect(await movedBoardOfRoom(roomOf(MOVED), lookup)).toBe(MOVED);
    expect(await movedBoardOfRoom(roomOf(STAYING), lookup)).toBeNull();
  });

  test("is not even looked up while no board has moved", async () => {
    delete process.env.BOARD_CHAT_MOVED_BOARDS;
    let asked = 0;
    expect(await movedBoardOfRoom(roomOf(MOVED), async () => (asked++, { boardId: MOVED }))).toBeNull();
    expect(asked).toBe(0);
  });
});

describe("the moved notice", () => {
  test("is posted once in the moved board's old room, by its speaker, and nowhere else", async () => {
    process.env.BOARD_CHAT_MOVED_BOARDS = MOVED;
    const sent: Array<[string, string, string]> = [];
    const send = async (userId: string, roomId: string, body: string) => {
      sent.push([userId, roomId, body]);
      return "$notice";
    };
    expect(await announceMovedBoards(send)).toEqual([MOVED]);
    // A second pass, a restart, another hub replica: the notice is recorded, not posted again.
    expect(await announceMovedBoards(send)).toEqual([]);
    expect(sent).toEqual([[SPEAKER, roomOf(MOVED), MOVED_NOTICE]]);
    const [staying] = await rawSql`SELECT moved_notice_at FROM matrix_board_rooms WHERE board_id = ${STAYING}`;
    expect(staying?.moved_notice_at).toBeNull();
  });

  test("one that could not be sent is tried again on the next pass", async () => {
    await rawSql`UPDATE matrix_board_rooms SET moved_notice_at = NULL WHERE board_id = ${MOVED}`;
    process.env.BOARD_CHAT_MOVED_BOARDS = MOVED;
    expect(await announceMovedBoards(async () => null)).toEqual([]);
    expect(
      await announceMovedBoards(async () => {
        throw new Error("homeserver down");
      }),
    ).toEqual([]);
    expect(await announceMovedBoards(async () => "$notice")).toEqual([MOVED]);
  });
});
