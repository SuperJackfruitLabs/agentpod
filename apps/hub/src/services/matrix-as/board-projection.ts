/**
 * How a gate or an agent's question reaches its board room, as the running hub builds it.
 *
 * Moved out of `src/index.ts` so it can be tested: that file boots the hub and no test
 * may import it. The reason to test it is the rule from 2026-10-07 — nothing is posted
 * into a board room before a human has JOINED it, because a post made while they are
 * only invited is encrypted to the speaker alone and can never be read. `projectGate`
 * and `projectElicitation` enforce it only when handed `humanJoined`, so the wiring here
 * is the one place it could silently disappear. `board-projection.test.ts` holds it.
 */
import { createLogger } from "../../utils/logger";
import {
  boardForHumanJoin,
  boardRoomFor,
  boardRoomHasJoinedHuman,
  ensureBoardRoom,
  matrixIdsForBoardHumans,
} from "./board-room";
import { sweepElicitationBoardNow } from "./elicitation-sweep";
import { noteGatePosted } from "./fleet-gates";
import { sweepBoardNow } from "./gate-sweep";
import type { MatrixBridge } from "./index";

const log = createLogger("matrix-board-projection");

/**
 * The deps every projection takes — push, the gate sweep and the question sweep alike,
 * so a swept post and a pushed one cannot be made by two slightly different projections.
 */
export function boardProjectionDeps(bridge: Pick<MatrixBridge, "client" | "config">) {
  const { client, config } = bridge;
  return {
    domain: config.domain,
    boardBaseUrl: process.env.SUPERPIPELINE_BOARD_URL,
    // `extra` is the gate itself, embedded in the prose (`dev.superpipeline.gate`).
    sendText: (userId: string, roomId: string, body: string, extra?: Record<string, unknown>) =>
      client.sendText(userId, roomId, body, extra),
    sendCustomEvent: (
      userId: string,
      roomId: string,
      eventType: string,
      content: Record<string, unknown>,
    ) => client.sendCustomEvent(userId, roomId, eventType, content),
    /**
     * The board's room, made on first use.
     *
     * `charter → decisions/2026-09-28-a-gate-belongs-to-its-board-not-to-an-agents-room.md`.
     * A gate used to go to the station's room, which this hub encrypts for but must
     * never decrypt for — so it could be delivered and never answered.
     */
    // `boardOpts`, not `opts`: the `ensureRoom` lambda below already binds `opts` to
    // the ROOM's creation options, and two different `opts` in one expression is how
    // the wrong one gets passed.
    boardRoom: (boardId: string, tenantId: string, boardOpts?: { boardName?: string }) =>
      ensureBoardRoom(
        boardId,
        tenantId,
        {
          domain: config.domain,
          ensureUser: (localpart, displayName) => client.ensureUser(localpart, displayName),
          ensureRoom: (alias, opts) => client.ensureRoom(alias, opts),
          invite: (asUserId, roomId, invitee) => client.invite(asUserId, roomId, invitee),
          enableEncryption: (asUserId: string, roomId: string) =>
            client.enableRoomEncryption(asUserId, roomId),
          setName: (asUserId: string, roomId: string, name: string) =>
            client.setRoomName(asUserId, roomId, name),
          /**
           * The humans who may answer this board's gates.
           *
           * A list from the first day though it holds one today. superpipeline owns
           * board membership, but its `/v1/members` route resolves a user SESSION —
           * the same restriction that stops the hub minting agent tokens — so the hub
           * cannot ask it with the credentials it holds. Until superpipeline exposes
           * membership to a service credential, this is the one human the bridge
           * roster already names, resolved through `principal_identities` to the
           * Matrix id they actually read on.
           */
          humansFor: async () => matrixIdsForBoardHumans(boardId),
        },
        boardOpts,
      ),
    /**
     * A gate or a question waits until a human has JOINED its board room (2026-10-07):
     * posted while they were only invited, the first gate was encrypted to the speaker
     * alone and could never be read. The join wakes it (`withJoinWake`); the sweeps are
     * the floor.
     */
    humanJoined: (roomId: string, speakerMxid: string) =>
      boardRoomHasJoinedHuman(roomId, speakerMxid, {
        homeserverUrl: config.homeserverUrl,
        asToken: config.asToken,
      }),
    /** A posted gate is a pending decision on each of the board's humans' fleet card. */
    onPosted: (
      d: Parameters<typeof noteGatePosted>[0],
      posted: Parameters<typeof noteGatePosted>[1],
    ) => noteGatePosted(d, posted, { humansFor: matrixIdsForBoardHumans }),
  };
}

type MembershipEvent = Parameters<typeof boardForHumanJoin>[0];

export interface WakeDeps {
  lookup: (roomId: string) => Promise<{ boardId: string; speakerMxid: string } | null>;
  sweepGates: (boardId: string) => Promise<unknown>;
  sweepElicitations: (boardId: string) => Promise<unknown>;
}

const defaultWake: WakeDeps = {
  lookup: boardRoomFor,
  sweepGates: sweepBoardNow,
  sweepElicitations: sweepElicitationBoardNow,
};

/**
 * A human joined a board room: post what was held for them, gates and questions both.
 * Each sweep fails on its own — a board that will not list its gates must not cost the
 * person their question.
 */
export async function wakeHeldOnJoin(event: MembershipEvent, deps: WakeDeps = defaultWake): Promise<void> {
  const boardId = await boardForHumanJoin(event, deps.lookup);
  if (!boardId) return;
  const results = await Promise.allSettled([deps.sweepGates(boardId), deps.sweepElicitations(boardId)]);
  for (const r of results) {
    if (r.status === "rejected") {
      log.warn("could not wake posts held for a board room join", {
        boardId,
        roomId: event.room_id,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }
}

/**
 * The appservice event handler, with the join wake in front of it.
 *
 * The wake is not awaited: it reads superpipeline, and a homeserver transaction must not
 * wait on another service. Its failures are logged by `wakeHeldOnJoin` and are the
 * sweeps' to recover.
 */
export function withJoinWake<E extends MembershipEvent>(
  onEvent: (event: E) => Promise<void>,
  wake: (event: E) => Promise<void> = (e) => wakeHeldOnJoin(e),
): (event: E) => Promise<void> {
  return async (event) => {
    void wake(event).catch((err) =>
      log.warn("join wake threw", { error: err instanceof Error ? err.message : String(err) }),
    );
    await onEvent(event);
  };
}
