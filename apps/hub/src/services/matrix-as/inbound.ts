/**
 * Where a Matrix message becomes work.
 *
 * This is what the identity work was for. An inbound message is an
 * authorization question the suite can already answer: `resolveMatrixId` gives a
 * principal, and the control pair says whether that principal may dispatch this
 * agent (`charter` → decisions/2026-08-13-ecosystem-identity.md, Decision 4).
 *
 * **A room is not a console session.** It is a shared space several people can
 * type into, so the grant is checked on every message rather than once when the
 * session was opened — otherwise the first permitted person to speak would open
 * a conversation everyone else in the room could then drive.
 *
 * **A refusal is a message, never silence.** A bridge that ignored what it would
 * not do looks like a broken agent, and sends an operator to the console, the
 * node and the harness — everywhere except the grant that actually refused.
 */

import { eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { matrixRooms } from "../../db/schema/matrix";
import { acpSessions } from "../../db/schema/acp";
import { stations } from "../../db/schema/stations";
import { nodes } from "../../db/schema/nodes";
import { resolveMatrixId } from "../matrix-identity";
import { getGrant, grantAllowsStation } from "../grants";
import { isControlPairEnforced } from "../control-pair";
import { bridgeUserId } from "./names";
import {
  clearPendingPermission,
  matchPermissionAnswer,
  pendingPermissionFor,
  unmatchedAnswerText,
} from "./permissions";
import { createLogger } from "../../utils/logger";

const log = createLogger("matrix-inbound");

export interface InboundEvent {
  type: string;
  sender: string;
  room_id?: string;
  event_id?: string;
  content?: Record<string, unknown>;
}

export interface InboundDeps {
  domain: string;
  client: {
    sendText(userId: string, roomId: string, body: string): Promise<string | null>;
  };
  acp: {
    createSession(input: {
      stationId: string;
      userId: string;
      mode: string;
    }): Promise<{ id: string }>;
    promptSession(userId: string, sessionId: string, text: string): Promise<void>;
    /**
     * Answer a permission request the agent is parked on. Optional so a
     * deployment (or a test) that only relays messages still type-checks.
     */
    answerPermission?(
      userId: string,
      sessionId: string,
      requestSeq: number,
      optionId: string
    ): Promise<void>;
  };
  /**
   * Start streaming this session into this room.
   *
   * Called on every message, not only when a session is created: attachments
   * live in memory, so after a hub restart the session row survives and the
   * listener does not — and a room whose session predates the restart would go
   * permanently quiet. Attaching is idempotent.
   */
  attach(sessionId: string, roomId: string, agentUser: string): void;
  /**
   * Which message started the turn about to run, so the agent can mark it —
   * 👀 while working, ✅ when done. Absent for a turn nobody asked for.
   */
  noteTrigger?(sessionId: string, eventId: string): void;
}

/** The room, its station, and the node name that station's identity is built from. */
async function roomContext(roomId: string) {
  const [row] = await db
    .select({
      roomId: matrixRooms.roomId,
      sessionId: matrixRooms.acpSessionId,
      stationId: stations.id,
      stationKey: stations.stationKey,
      identityMode: stations.matrixIdentityMode,
      nodeName: nodes.name,
      sessionStatus: acpSessions.status,
    })
    .from(matrixRooms)
    .innerJoin(stations, eq(stations.id, matrixRooms.stationId))
    .innerJoin(nodes, eq(nodes.id, stations.nodeId))
    .leftJoin(acpSessions, eq(acpSessions.id, matrixRooms.acpSessionId))
    .where(eq(matrixRooms.roomId, roomId));
  return row ?? null;
}

export async function handleRoomMessage(event: InboundEvent, deps: InboundDeps): Promise<void> {
  if (event.type !== "m.room.message") return;
  if (!event.room_id) return;

  const text = typeof event.content?.body === "string" ? event.content.body : "";
  // Whitespace is not a prompt. Sending one would start a turn with nothing in
  // it and cost an agent a round trip to say so.
  if (text.trim() === "") return;

  const room = await roomContext(event.room_id);
  // A room we do not own is not ours to answer in — anyone can invite the bot
  // anywhere.
  if (!room) return;

  // A harness-mode station answers for itself. Two answerers on one address is
  // the failure the mode exists to prevent.
  if (room.identityMode !== "bridge") return;

  const agentUser = bridgeUserId(room.nodeName, room.stationKey, deps.domain);
  const say = (body: string) => deps.client.sendText(agentUser, room.roomId, body);

  // ── Who is this? ──────────────────────────────────────────────────────────
  const identity = await resolveMatrixId(event.sender);
  if (identity?.kind !== "principal") {
    // Ambiguous is refused as firmly as unknown: `resolveMatrixId` fails closed
    // when one mxid is claimed by both a station and a principal, and guessing
    // would attribute a human's words to an agent.
    log.warn("matrix message from an unresolvable sender", {
      sender: event.sender,
      kind: identity?.kind ?? "none",
      room: room.roomId,
    });
    await say(
      "I do not recognise you. This hub has no principal linked to " +
        `${event.sender}, so I cannot act on your behalf.`
    );
    return;
  }
  const principalId = identity.principalId;

  // ── May they dispatch THIS agent? ─────────────────────────────────────────
  if (isControlPairEnforced()) {
    const grant = await getGrant(principalId);
    const allowed = grantAllowsStation(grant, {
      nodeName: room.nodeName,
      stationKey: room.stationKey,
    });

    if (!allowed) {
      log.warn("matrix message refused by the control pair", {
        principalId,
        node: room.nodeName,
        stationKey: room.stationKey,
      });
      await say(
        "You are not permitted to dispatch this agent. Your grant does not " +
          `cover ${room.nodeName}/${room.stationKey}.`
      );
      return;
    }
  }

  // ── Is this an answer to a question the agent is waiting on? ─────────────
  //
  // Checked after the grant, deliberately: approving an action is dispatching
  // the agent by another name, so somebody who may not dispatch it must not be
  // able to approve its next tool call either.
  //
  // Checked before prompting, because while a permission is pending the
  // session cannot take a prompt — it is parked. Treating the answer as a
  // message would lose the answer AND fail the prompt.
  const waiting = pendingPermissionFor(room.roomId);
  if (waiting) {
    const optionId = matchPermissionAnswer(text, waiting.options);
    if (!optionId) {
      // Not resolved to the nearest-looking option: approving a tool call the
      // operator did not mean to approve is the one failure this must not
      // have.
      await say(unmatchedAnswerText(waiting.options));
      return;
    }

    if (!deps.acp.answerPermission) {
      await say("This hub cannot answer permission requests from a room yet.");
      return;
    }

    try {
      await deps.acp.answerPermission(
        principalId,
        waiting.sessionId,
        waiting.requestSeq,
        optionId
      );
      // Only after it was accepted: a cleared question plus a failed answer
      // would leave the agent parked with nothing able to release it.
      clearPendingPermission(room.roomId);
      log.info("permission answered from a room", {
        principalId,
        room: room.roomId,
        optionId,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error("permission answer from a room was refused", {
        room: room.roomId,
        error: reason,
      });
      await say(`I could not record that answer: ${reason}`);
    }
    return;
  }

  // ── Say it to the agent ───────────────────────────────────────────────────
  try {
    // A session the hub has already ended is not a session. Boot reconciliation
    // ends every live one with "hub restarted", so without this check a room
    // prompts a corpse forever and every bridged room dies permanently at the
    // first restart — with "Session not found or not active" as the only clue.
    const sessionUsable = room.sessionId !== null && room.sessionStatus !== null && room.sessionStatus !== "ended";
    let sessionId = sessionUsable ? room.sessionId : null;

    if (!sessionId) {
      // One session per room, not per message: a conversation is a
      // conversation, and a session per message would throw away the agent's
      // context between two consecutive sentences.
      const session = await deps.acp.createSession({
        stationId: room.stationId,
        userId: principalId,
        mode: "default",
      });
      sessionId = session.id;
      await db
        .update(matrixRooms)
        .set({ acpSessionId: sessionId })
        .where(eq(matrixRooms.roomId, room.roomId));
    }

    // Before prompting, so the first words of the answer are not produced into
    // a stream nobody is listening to.
    deps.attach(sessionId, room.roomId, agentUser);
    if (event.event_id) deps.noteTrigger?.(sessionId, event.event_id);

    // The user's words, unchanged. Trimming or decorating them would put the
    // bridge's voice into the agent's input.
    await deps.acp.promptSession(principalId, sessionId, text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error("matrix message could not reach the station", {
      room: room.roomId,
      stationKey: room.stationKey,
      error: reason,
    });
    await say(`I could not reach this agent: ${reason}`);
  }
}
