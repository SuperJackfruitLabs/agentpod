/**
 * The room a board's gates close in.
 *
 * `charter → decisions/2026-09-28-a-gate-belongs-to-its-board-not-to-an-agents-room.md`.
 *
 * A gate used to be projected into the station's own room, speaking as the agent
 * that produced it. That could be delivered and never answered: the hub encrypts as
 * the agent outbound — which `bridge-agents.ts` says it must never do — and
 * correctly refuses to decrypt for it inbound. Observed on 2026-09-28, when an
 * operator approved from their phone and the decision was discarded unread.
 *
 * A board room is the other arrangement: an identity whose keys the hub owns
 * outright, so it can both encrypt for and decrypt for it. That is the whole
 * requirement, and it is what selects every choice below.
 */
import { eq } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { matrixBoardRooms } from "../../db/schema/board-rooms";
import { createLogger } from "../../utils/logger";

const log = createLogger("matrix-board-room");

/**
 * The localpart the board speaks as.
 *
 * Inside the appservice's existing exclusive `@agent_.*` namespace, so this needs no
 * registration change and no homeserver restart. It reads as an agent and is not
 * one; the display name is what anybody sees. A bare `@superpipeline` would read
 * better and costs a namespace edit plus a reload — that trade can be made later
 * without touching anything here, because the speaker is stored per room rather
 * than derived.
 */
export const BOARD_SPEAKER_LOCALPART = "agent_superpipeline";
export const BOARD_SPEAKER_DISPLAY_NAME = "superpipeline";

/** The room alias for a board, inside the appservice's `#agentpod_.*` namespace. */
export function boardRoomAlias(boardId: string): string {
  return `agentpod_board_${boardId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function boardSpeakerMxid(domain: string): string {
  return `@${BOARD_SPEAKER_LOCALPART}:${domain}`;
}

export interface BoardRoomDeps {
  domain: string;
  /** Create the speaker if it does not exist yet, and name it. */
  ensureUser(localpart: string, displayName: string): Promise<unknown>;
  /** Create or find the room, returning its id. */
  ensureRoom(
    alias: string,
    opts: { creator: string; name: string; topic: string; invite?: string },
  ): Promise<string | null>;
  /** Invite somebody who is not already in the room. */
  invite(asUserId: string, roomId: string, invitee: string): Promise<void>;
  /** Turn on encryption. A board room is always encrypted; the hub owns the keys. */
  enableEncryption(asUserId: string, roomId: string): Promise<boolean>;
  /**
   * The Matrix ids of the humans who may answer this board's gates.
   *
   * **A list from the first day, though today it holds one.** superpipeline owns
   * board membership and is the eventual source of truth, but its `/v1/members`
   * route resolves a user SESSION — the same restriction that stops the hub minting
   * agent tokens — so the hub cannot ask it with the credentials it holds. Until
   * superpipeline exposes membership to a service credential, this resolves the one
   * human the bridge roster already names.
   *
   * Injected rather than read inline so that swap is a change of one function, and
   * so the single-person assumption never reaches room creation.
   */
  humansFor(boardId: string): Promise<string[]>;
}

export interface BoardRoom {
  boardId: string;
  roomId: string;
  speakerMxid: string;
  created: boolean;
}

/**
 * The board's room, made if it is not there yet.
 *
 * Idempotent, and recorded before anybody is invited: a room created but unrecorded
 * is a room the next call creates again under a new alias, and two rooms for one
 * board is the failure that cannot be repaired by retrying.
 */
export async function ensureBoardRoom(
  boardId: string,
  tenantId: string,
  deps: BoardRoomDeps,
): Promise<BoardRoom | null> {
  const [existing] = await db
    .select()
    .from(matrixBoardRooms)
    .where(eq(matrixBoardRooms.boardId, boardId));
  if (existing) {
    // Membership is re-checked even for a room we already have: a person added to
    // the board after the room was made would otherwise never be invited.
    await inviteHumans(boardId, existing.roomId, existing.speakerMxid, deps);
    return {
      boardId,
      roomId: existing.roomId,
      speakerMxid: existing.speakerMxid,
      created: false,
    };
  }

  const speaker = boardSpeakerMxid(deps.domain);
  await deps.ensureUser(BOARD_SPEAKER_LOCALPART, BOARD_SPEAKER_DISPLAY_NAME);

  const alias = boardRoomAlias(boardId);
  const humans = await deps.humansFor(boardId);
  const roomId = await deps.ensureRoom(alias, {
    creator: speaker,
    name: "superpipeline",
    topic: `Approvals for board ${boardId}. Answer here and the board hears it.`,
    // The first invitee rides on creation; the rest follow. `is_direct` and the
    // room's People filing depend on the invite being part of the create.
    ...(humans[0] ? { invite: humans[0] } : {}),
  });
  if (!roomId) {
    log.warn("could not create a board room", { boardId, alias });
    return null;
  }

  // Encryption before the record: a room that is written down as the board's room
  // while still plaintext is a room gates would be posted into in the clear.
  const encrypted = await deps.enableEncryption(speaker, roomId);
  if (!encrypted) {
    log.warn("board room created but could not be encrypted; not recording it", {
      boardId,
      roomId,
    });
    return null;
  }

  await db
    .insert(matrixBoardRooms)
    .values({ boardId, roomId, tenantId, speakerMxid: speaker, alias })
    .onConflictDoNothing();

  await inviteHumans(boardId, roomId, speaker, deps, humans);

  log.info("board room ready", { boardId, roomId, speaker, humans: humans.length });
  return { boardId, roomId, speakerMxid: speaker, created: true };
}

/**
 * Invite everyone who should be able to answer, and never fail the room over it.
 *
 * An invite for somebody already in the room is an error from the homeserver and
 * not a problem here, so each is attempted on its own: one person who cannot be
 * invited must not cost everybody else their room.
 */
async function inviteHumans(
  boardId: string,
  roomId: string,
  speaker: string,
  deps: BoardRoomDeps,
  known?: string[],
): Promise<void> {
  const humans = known ?? (await deps.humansFor(boardId));
  for (const mxid of humans) {
    try {
      await deps.invite(speaker, roomId, mxid);
    } catch (err) {
      log.debug("invite not needed or not possible", {
        boardId,
        roomId,
        mxid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** The board room a Matrix room belongs to, or null. The inbound path's question. */
export async function boardRoomFor(roomId: string) {
  const [row] = await db
    .select()
    .from(matrixBoardRooms)
    .where(eq(matrixBoardRooms.roomId, roomId));
  return row ?? null;
}
