/**
 * Boards whose chat has moved out of this hub.
 *
 * Board chat (gates, questions, waiting cards, follow-ups and checks in a board's Matrix room) is
 * moving to a separate communication service one board at a time, and while it moves exactly one
 * path may serve a board. `BOARD_CHAT_MOVED_BOARDS` lists the SuperPipeline board ids that are no
 * longer this hub's: nothing is projected for them, they are not swept or subscribed to push, and
 * an answer typed into their old room here is logged and ignored, so a stale card cannot resolve a
 * decision twice. The hub asks the other service nothing; the list is the whole decision.
 *
 * This file is the one place that decides "moved". Unset or empty, no board has moved and every
 * path behaves exactly as before.
 */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { matrixBoardRooms } from "../../db/schema/board-rooms";
import { createLogger } from "../../utils/logger";

const log = createLogger("board-chat-moved");

export const MOVED_BOARDS_ENV = "BOARD_CHAT_MOVED_BOARDS";

/** A SuperPipeline board id: letters, digits, `_` and `-` (`brd_…`). */
const BOARD_ID = /^[A-Za-z0-9_-]+$/;

export class MovedBoardsConfigError extends Error {
  constructor(readonly invalid: string[]) {
    super(
      `${MOVED_BOARDS_ENV} must be a comma-separated list of SuperPipeline board ids; ` +
        `not valid: ${invalid.map((v) => JSON.stringify(v)).join(", ")}`,
    );
    this.name = "MovedBoardsConfigError";
  }
}

/** The board ids in the setting. Throws `MovedBoardsConfigError` on an entry that is not a board id. */
export function parseMovedBoards(raw: string | undefined): Set<string> {
  const entries = (raw ?? "").split(",").map((s) => s.trim());
  if (entries.length === 1 && entries[0] === "") return new Set();
  const invalid = entries.filter((e) => !BOARD_ID.test(e));
  if (invalid.length > 0) throw new MovedBoardsConfigError(invalid);
  return new Set(entries);
}

/**
 * The boards that have moved. Read from the environment on every call (a short string), so the
 * answer is always the running setting; boot validation has already refused a malformed one.
 */
export function movedBoards(): Set<string> {
  return parseMovedBoards(process.env[MOVED_BOARDS_ENV]);
}

export function isBoardMoved(boardId: string): boolean {
  return movedBoards().has(boardId);
}

/**
 * Whether a room is the old board room of a moved board, and which board. No database read while
 * no board has moved, because this is asked for every message the hub receives.
 */
export async function movedBoardOfRoom(
  roomId: string,
  lookup: (roomId: string) => Promise<{ boardId: string } | null>,
): Promise<string | null> {
  const moved = movedBoards();
  if (moved.size === 0) return null;
  const board = await lookup(roomId);
  return board && moved.has(board.boardId) ? board.boardId : null;
}

export const MOVED_NOTICE =
  "This board's chat has moved to a new room. New approvals, questions and cards for this board " +
  "are posted there, and answers given in this room no longer reach the board.";

/**
 * Say once, in each moved board's old room, that its chat has moved.
 *
 * Claimed before it is sent (`moved_notice_at`) so two passes leave one line, and given back when
 * the send fails so the next pass tries again. A moved board this hub never made a room for has no
 * one to tell. Returns the boards told on this pass.
 */
export async function announceMovedBoards(
  sendText: (userId: string, roomId: string, body: string) => Promise<string | null>,
): Promise<string[]> {
  const told: string[] = [];
  for (const boardId of movedBoards()) {
    const [claimed] = await db
      .update(matrixBoardRooms)
      .set({ movedNoticeAt: new Date() })
      .where(and(eq(matrixBoardRooms.boardId, boardId), isNull(matrixBoardRooms.movedNoticeAt)))
      .returning({ roomId: matrixBoardRooms.roomId, speakerMxid: matrixBoardRooms.speakerMxid });
    if (!claimed) continue;
    let eventId: string | null = null;
    try {
      eventId = await sendText(claimed.speakerMxid, claimed.roomId, MOVED_NOTICE);
    } catch (err) {
      log.warn("could not post the moved notice", { boardId, error: err instanceof Error ? err.message : String(err) });
    }
    if (!eventId) {
      await db.update(matrixBoardRooms).set({ movedNoticeAt: null }).where(eq(matrixBoardRooms.boardId, boardId));
      continue;
    }
    log.info("board chat moved; notice posted in its old room", { boardId, roomId: claimed.roomId });
    told.push(boardId);
  }
  return told;
}

/** How often a notice that could not be posted is tried again. */
const MOVED_NOTICE_INTERVAL_MS = 5 * 60_000;

/**
 * Post the moved notices now and again on an interval, for a send that failed (the homeserver not
 * up yet at boot). Nothing runs while no board has moved. Unref'd: it never holds the process open.
 */
export function startMovedBoardNotices(
  sendText: (userId: string, roomId: string, body: string) => Promise<string | null>,
): (() => void) | null {
  if (movedBoards().size === 0) return null;
  const pass = () =>
    void announceMovedBoards(sendText).catch((err) =>
      log.warn("moved notice pass failed", { error: err instanceof Error ? err.message : String(err) }),
    );
  pass();
  const timer = setInterval(pass, MOVED_NOTICE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
