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
   * Rename the room, answering whether the homeserver took it.
   *
   * Separate from `ensureRoom`'s `name`, which only applies at creation: Matrix sets a
   * room's name with a state event, and every room that predates this was created with
   * the product's name rather than its board's.
   */
  setName(asUserId: string, roomId: string, name: string): Promise<boolean>;
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
  opts: { boardName?: string } = {},
): Promise<BoardRoom | null> {
  const [existing] = await db
    .select()
    .from(matrixBoardRooms)
    .where(eq(matrixBoardRooms.boardId, boardId));
  if (existing) {
    // Membership is re-checked even for a room we already have: a person added to
    // the board after the room was made would otherwise never be invited.
    await inviteHumans(boardId, existing.roomId, existing.speakerMxid, deps);
    // And so is the name, for the same reason and in the same place: a board renamed
    // after its room was made would otherwise keep the old name forever. This is also
    // the whole backfill — every room older than the `name` column is named after the
    // product, and gets its board's name on its next gate.
    await renameIfNeeded(boardId, existing.roomId, existing.speakerMxid, existing.name, deps, opts);
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
  // The id is the fallback, not a default: a hub newer than its board receives no
  // name, and `brd_6a899b0f…` is at least unambiguous where "superpipeline" was the
  // same for every board on the fleet.
  const name = opts.boardName?.trim() || boardId;
  const roomId = await deps.ensureRoom(alias, {
    creator: speaker,
    name,
    topic: `Approvals for ${name}. Answer here and the board hears it.`,
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
    .values({ boardId, roomId, tenantId, speakerMxid: speaker, alias, name })
    .onConflictDoNothing();

  await inviteHumans(boardId, roomId, speaker, deps, humans);

  log.info("board room ready", { boardId, roomId, speaker, humans: humans.length });
  return { boardId, roomId, speakerMxid: speaker, created: true };
}

/**
 * Rename the room when — and only when — the board's name has actually changed.
 *
 * Three cases, and the middle one is the one that can do damage:
 *
 *  - **No name sent.** Do nothing. A hub newer than its board receives no name, and
 *    falling back to the id here would rename a perfectly readable room to `brd_…`,
 *    which is the unreadable state this whole change exists to remove. The fallback
 *    belongs at creation, where there is no existing name to destroy.
 *  - **Name unchanged.** Do nothing. Otherwise every gate on every board writes a state
 *    event that says nothing — noise in the timeline, and a request per gate.
 *  - **Name changed, or never recorded.** Rename, and record it only if the homeserver
 *    took it. A failed rename that was recorded anyway would leave the room misnamed
 *    forever, because the next pass would compare equal and find nothing to do.
 *
 * Never throws. A room that cannot be renamed is still a room gates close in — unlike
 * encryption, where refusing to record is the safe answer, a wrong name leaks nothing.
 */
async function renameIfNeeded(
  boardId: string,
  roomId: string,
  speaker: string,
  recorded: string | null,
  deps: BoardRoomDeps,
  opts: { boardName?: string },
): Promise<void> {
  const wanted = opts.boardName?.trim();
  if (!wanted || wanted === recorded) return;

  try {
    const ok = await deps.setName(speaker, roomId, wanted);
    if (!ok) {
      log.warn("board room could not be renamed; leaving the recorded name alone", {
        boardId,
        roomId,
      });
      return;
    }
    await db
      .update(matrixBoardRooms)
      .set({ name: wanted })
      .where(eq(matrixBoardRooms.boardId, boardId));
    log.info("board room renamed", { boardId, roomId, name: wanted });
  } catch (err) {
    log.warn("board room rename did not reach the homeserver", {
      boardId,
      roomId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

/**
 * Whether anybody but the speaker — and not another of this hub's own users — has
 * JOINED the board room.
 *
 * The question a gate is held on (`gates.ts`, `humanJoined`). An invited human holds
 * no room key for what is sent before they accept: on 2026-10-07 a board's first gate
 * was posted the moment the room was made and encrypted to the speaker alone. Joined,
 * not invited, is the operator's rule. Asked as the speaker, who is always in the room.
 *
 * Throws when the homeserver does not answer: "could not ask" is neither yes (which
 * would post a card nobody can read) nor no (which would hold one silently); a throw
 * is a counted sweep failure and a 5xx to push, and both retry.
 */
export async function boardRoomHasJoinedHuman(
  roomId: string,
  speakerMxid: string,
  deps: { homeserverUrl: string; asToken: string; fetch?: typeof fetch },
): Promise<boolean> {
  const url = new URL(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
    deps.homeserverUrl,
  );
  url.searchParams.set("user_id", speakerMxid);
  const res = await (deps.fetch ?? fetch)(url, {
    headers: { Authorization: `Bearer ${deps.asToken}` },
  });
  if (!res.ok) {
    throw new Error(`joined members of ${roomId} unreadable (${res.status})`);
  }
  const body = (await res.json()) as { joined?: Record<string, unknown> };
  return Object.keys(body.joined ?? {}).some(
    (m) => m !== speakerMxid && !m.startsWith("@agent_"),
  );
}

/**
 * The board whose held gates a membership event should wake, or null.
 *
 * Only a JOIN, only into a board room, and only by somebody other than its speaker.
 * The sweep would post a held gate within five minutes anyway; this is what makes a
 * person who just accepted the invite see the question now.
 */
export async function boardForHumanJoin(
  event: {
    type: string;
    sender: string;
    room_id?: string;
    state_key?: string;
    content?: Record<string, unknown>;
  },
  lookup: (roomId: string) => Promise<{ boardId: string; speakerMxid: string } | null> = boardRoomFor,
): Promise<string | null> {
  if (event.type !== "m.room.member" || !event.room_id) return null;
  if (event.content?.membership !== "join") return null;
  const who = event.state_key ?? event.sender;
  const board = await lookup(event.room_id);
  if (!board || who === board.speakerMxid || who.startsWith("@agent_")) return null;
  return board.boardId;
}

/**
 * The Matrix ids of the humans who may answer a board's gates.
 *
 * **One entry today, and a list by construction.** superpipeline owns board
 * membership and is the eventual source of truth, but its `/v1/members` route
 * resolves a user SESSION — the same restriction that stops the hub minting agent
 * tokens — so the hub cannot ask it with the credentials it holds. Until
 * superpipeline exposes membership to a service credential, the bridge roster is
 * the only place that names a board's human at all.
 *
 * Resolved the long way round on purpose: roster `hubUserId` (a `prn_`) → the
 * plane's `GET /api/principals/:id/identities?system=matrix`. A Matrix id is never guessed from a localpart or a
 * matching email (charter `2026-08-13-ecosystem-identity` Decision 2), so a board
 * whose human has never linked an account yields nobody rather than somebody wrong.
 */
export async function matrixIdsForBoardHumans(boardId: string): Promise<string[]> {
  const { isBridgeEnabled } = await import("../bridge/config");
  if (!isBridgeEnabled()) return [];

  let hubUserIds: string[];
  try {
    // Read from `bridge_agents` rather than a parsed environment variable, and — the part that
    // matters here — the user comes off the STATION. The roster used to carry its own `hubUserId`,
    // which could disagree with the station it named; this cannot, because there is only one of
    // them now. See `services/bridge/roster.ts`.
    const { listBridgeAgents } = await import("../bridge/roster");
    const { BOOTSTRAP_TENANT_ID } = await import("../../db/schema/tenants");
    const roster = await listBridgeAgents(BOOTSTRAP_TENANT_ID);
    hubUserIds = [...new Set(roster.filter((a) => a.boardId === boardId).map((a) => a.hubUserId))];
  } catch {
    // A roster that cannot be read is an operator's problem and is reported where it is read; a
    // board room should still be made, just with nobody invited yet.
    return [];
  }

  const { principalForUser } = await import("../principals");
  const { matrixIdForPrincipal } = await import("../principal-matrix-id");
  const mxids: string[] = [];
  for (const userId of hubUserIds) {
    const principal = await principalForUser(userId);
    if (!principal) continue;
    const mxid = await matrixIdForPrincipal(principal.id);
    if (mxid) mxids.push(mxid);
  }
  return mxids;
}
