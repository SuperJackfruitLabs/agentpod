/**
 * The gate reads: which fleet a board belongs to, what this hub recorded when it posted a gate,
 * and who this hub speaks as in a room.
 *
 * Split out of `gates.ts`, which re-exports it.
 */

import { and, eq } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { bridgeAgents, bridgeDispatches } from "../../db/schema/bridge";
import { matrixGateEvents, matrixRooms, type MatrixGateOption, type MatrixGateVariant } from "../../db/schema/matrix";
import { stations } from "../../db/schema/stations";
import { stationSpeaker } from "../matrix";
import { principalHandle } from "../../auth/org-plane/principals";

/**
 * Which fleet a board's gates belong to.
 *
 * Answered from `bridge_dispatches` rather than from a board registry, because
 * there isn't one and shouldn't be: this hub knows a board exists only because
 * it dispatched work for it. A board it has never worked is a board whose gates
 * it has no business projecting — so "unknown board" is the right answer, and a
 * 404 is the right refusal.
 */
export async function tenantForBoard(boardId: string): Promise<string | null> {
  const [row] = await db
    .select({ tenantId: bridgeDispatches.tenantId })
    .from(bridgeDispatches)
    .where(
      and(
        eq(bridgeDispatches.externalSource, "superpipeline"),
        eq(bridgeDispatches.boardId, boardId)
      )
    )
    .limit(1);
  return row?.tenantId ?? null;
}

/** What this hub recorded when it posted a gate, or null if it never did. */
export async function projectionForGate(gateId: string): Promise<{
  tenantId: string;
  boardId: string;
  roomId: string;
  eventId: string;
  proseEventId: string | null;
  /** What the gate offered when it was projected (gate.v2); null for older gates. */
  options: MatrixGateOption[] | null;
  /** The subject a subject-bound gate approves; null when bound to none. */
  subjectId: string | null;
  subjectDigest: string | null;
  subjectPreviewComplete: boolean | null;
  /** A variant gate's variants as projected; null when the gate is not a choice. */
  variants: MatrixGateVariant[] | null;
} | null> {
  const [row] = await db
    .select({
      tenantId: matrixGateEvents.tenantId,
      boardId: matrixGateEvents.boardId,
      roomId: matrixGateEvents.roomId,
      eventId: matrixGateEvents.eventId,
      proseEventId: matrixGateEvents.proseEventId,
      options: matrixGateEvents.options,
      subjectId: matrixGateEvents.approvalSubjectId,
      subjectDigest: matrixGateEvents.approvalSubjectDigest,
      subjectPreviewComplete: matrixGateEvents.approvalSubjectPreviewComplete,
      variants: matrixGateEvents.approvalVariants,
    })
    .from(matrixGateEvents)
    .where(eq(matrixGateEvents.gateId, gateId))
    .limit(1);
  return row ?? null;
}

/**
 * The virtual user this hub speaks as in a given room.
 *
 * Used when a gate needs an answer *about* itself — "that was already decided"
 * — which must come from the agent whose room it is rather than from a bot
 * nobody invited.
 *
 * Answered from the room's OWN bound occupant (`matrixRooms.principalId`)
 * and from nothing else: a room keeps its resident even after that agent
 * moves to a different station, and a reply about an old gate must come from
 * the agent whose history is actually in this room.
 *
 * An UNBOUND room gets null — fix round 4, and a deliberate reversal. This
 * used to fall back to `stations.principalId`, the station's *current*
 * occupant, on the reasoning that a room from before the binding existed had
 * been speaking as that agent all along. Migration 0060 already backfilled
 * every such room, and what the fallback actually covers now is a room its
 * station's occupant never lived in — a harness-mode station's room,
 * provisioned while nobody occupied it (`provision.ts` writes
 * `principal_id: null` there), left behind when an occupant arrives who
 * already holds a room elsewhere. Answering that as the station's current
 * occupant puts the WRONG agent's name on a reply in somebody else's old
 * room. The schema genuinely cannot tell "never bound" from "a departed
 * occupant's, never bound" — but "cannot distinguish" argues for no answer,
 * not for a guess. The one caller (`index.ts`'s gate `reply`) already treats
 * null as "there is nobody to say this as" and stays silent, which is the
 * failure worth having: a missing reply is visible and recoverable, a
 * misattributed one is neither.
 */
export async function roomAgentUser(roomId: string, domain: string): Promise<string | null> {
  const [row] = await db
    .select({
      ownPrincipalId: matrixRooms.principalId,
      // The station is joined for its MODE, not for its occupant. Fix round
      // 4 removed a `stations.principal_id` fallback from here on purpose
      // and nothing below reinstates it: a room with no binding of its own
      // still answers null.
      identityMode: stations.matrixIdentityMode,
      harnessMxid: stations.matrixId,
    })
    .from(matrixRooms)
    .innerJoin(stations, eq(stations.id, matrixRooms.stationId))
    .where(eq(matrixRooms.roomId, roomId))
    .limit(1);
  if (!row?.ownPrincipalId) return null;
  const handle = await principalHandle(row.ownPrincipalId);
  if (!handle) return null;
  // Same rule as the send path, from the same function — a reply that goes
  // out as an identity the room's send path could not use would be the two
  // halves of one question answered two ways again.
  //
  // Known limit, stated rather than hidden: a station that changed modes
  // after this room was created is unknowable from the schema, which records
  // no creator. The mode is read live because it is the only answer there
  // is, and it is right for every room whose station has not changed modes.
  return stationSpeaker(
    { identityMode: row.identityMode, harnessMxid: row.harnessMxid, handle },
    domain
  );
}

/**
 * Every tenant that knows a board here: those that roster an agent on it and those this hub
 * dispatched its work for. Usually one. More than one makes `tenantForBoard` an arbitrary pick, so
 * a credential that is one workspace's (the SuperPipeline relay) is never used for such a board.
 */
export async function tenantsForBoard(boardId: string): Promise<string[]> {
  const rostered = await db
    .selectDistinct({ tenantId: bridgeAgents.tenantId })
    .from(bridgeAgents)
    .where(eq(bridgeAgents.boardId, boardId));
  const dispatched = await db
    .selectDistinct({ tenantId: bridgeDispatches.tenantId })
    .from(bridgeDispatches)
    .where(and(eq(bridgeDispatches.externalSource, "superpipeline"), eq(bridgeDispatches.boardId, boardId)));
  return [...new Set([...rostered, ...dispatched].map((r) => r.tenantId))].toSorted();
}
