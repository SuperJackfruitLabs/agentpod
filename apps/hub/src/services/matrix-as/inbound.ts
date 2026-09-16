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
import { getGrant, grantAllowsPrincipal } from "../grants";
import { isControlPairEnforced } from "../control-pair";
import { bridgeUserId } from "./names";
import { principalHandle } from "../principals";
import {
  clearPendingPermission,
  matchPermissionAnswer,
  pendingPermissionFor,
  unmatchedAnswerText,
} from "./permissions";
import { createLogger } from "../../utils/logger";
import { parseGateDecision } from "./gates";

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
  /**
   * Turn an `m.room.encrypted` event back into the event it was.
   *
   * Optional, and absent for a plaintext bridge — which is every deployment
   * until a crypto store is configured. Returning null means the key never
   * arrived, which is ordinary rather than exceptional: it happens for
   * everything sent before this agent joined, and for anything sent while it
   * was offline that the sender has since forgotten.
   */
  decrypt?(roomId: string, asUserId: string, event: InboundEvent): Promise<InboundEvent | null>;
  /**
   * Answering a superpipeline approval gate.
   *
   * Optional so a deployment with no board wired up behaves exactly as before,
   * and so the existing tests construct deps without it.
   */
  gates?: {
    handle(
      event: { sender: string; content: Record<string, unknown> },
      roomId: string
    ): Promise<unknown>;
  };
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
      stationUserId: stations.userId,
      stationKey: stations.stationKey,
      identityMode: stations.matrixIdentityMode,
      nodeName: nodes.name,
      principalId: stations.principalId,
      sessionStatus: acpSessions.status,
    })
    .from(matrixRooms)
    .innerJoin(stations, eq(stations.id, matrixRooms.stationId))
    .innerJoin(nodes, eq(nodes.id, stations.nodeId))
    .leftJoin(acpSessions, eq(acpSessions.id, matrixRooms.acpSessionId))
    .where(eq(matrixRooms.roomId, roomId));
  return row ?? null;
}

/**
 * The event as it was written, decrypting first when it arrived encrypted.
 *
 * Returns null when there is nothing to act on — either the key is missing,
 * or the room is one we hold no agent for and therefore cannot decrypt for
 * anybody.
 *
 * Deliberately ahead of the `m.room.message` check below: an encrypted event
 * has type `m.room.encrypted` on the wire whatever it turns out to be, so a
 * type check that runs first would discard every encrypted message in the
 * room as uninteresting — silently, and while looking like it worked.
 */
async function asPlaintext(
  event: InboundEvent,
  deps: InboundDeps,
  { retrying = false } = {}
): Promise<InboundEvent | null> {
  if (event.type !== "m.room.encrypted") return event;
  if (!deps.decrypt || !event.room_id) return null;

  const room = await roomContext(event.room_id);
  if (!room) return null;

  // Only a bridge-mode room. A harness holds its own keys and reads its own
  // messages; the bridge has no store for that identity and asking it to
  // decrypt would fail on every message forever.
  if (room.identityMode !== "bridge") return null;

  // **The agent's mxid, not `stationUserId`.** That column is
  // `stations.userId` — the *owner's* AgentPod account id, which is what the
  // ACP permission path below correctly wants and what this path took by its
  // name. The keys belong to the agent, so decryption was being asked for an
  // identity that holds no crypto store at all: the first real encrypted
  // message to an agent failed with `400 M_EXCLUSIVE`, the appservice having
  // tried to log in as a Better Auth id outside its namespace.
  const handle = room.principalId ? await principalHandle(room.principalId) : null;
  if (!handle) return null;

  const plain = await deps.decrypt(event.room_id, bridgeUserId(handle, deps.domain), event);
  if (!plain) {
    if (!retrying) remember(event);
    return null;
  }

  // The envelope kept, the payload taken. A megolm plaintext carries `type`
  // and `content` and need not carry `sender`, `event_id` or `room_id` — those
  // belong to the event that wrapped it, and everything below this line reads
  // them. Returning the payload alone would bail one line later on a missing
  // `room_id`, which looks exactly like a message nobody sent.
  return { ...event, ...plain } as InboundEvent;
}

/**
 * Messages that arrived before the key that opens them.
 *
 * **A message is not lost because its key is late.** The room key travels as a
 * to-device message and the event travels in the room, and nothing makes the
 * first arrive before the second: a client that has just started a megolm
 * session sends both at once, and they can land in either order, in different
 * appservice transactions. The first version dropped an event it could not
 * decrypt on the spot and never looked at it again — so an agent could hold the
 * key seconds later and still never answer the message that key was for. That
 * is what happened on the first real encrypted message sent to an agent: it
 * decrypted perfectly when asked again, and the station never saw it.
 *
 * So an undecryptable event waits here and is tried again whenever new keys
 * arrive, which `onCryptoTransaction` signals. Bounded in both directions: an
 * event that stays unreadable is dropped after `PENDING_TTL_MS` with one
 * warning, and the map cannot outgrow `PENDING_MAX` — a room whose keys we
 * genuinely lack must not become a memory leak that also hides newer failures.
 */
const pending = new Map<string, { event: InboundEvent; first: number }>();
const PENDING_TTL_MS = 5 * 60_000;
const PENDING_MAX = 200;

function remember(event: InboundEvent): void {
  const id = event.event_id;
  if (!id || pending.has(id)) return;
  if (pending.size >= PENDING_MAX) {
    const oldest = pending.keys().next().value;
    if (oldest) pending.delete(oldest);
  }
  pending.set(id, { event, first: Date.now() });
}

/**
 * Try the waiting messages again, now that more keys are in hand.
 *
 * Called after each transaction's crypto half, which is the only moment new
 * keys can have arrived.
 */
export async function retryPendingDecrypts(deps: InboundDeps): Promise<void> {
  if (pending.size === 0) return;

  for (const [id, held] of [...pending]) {
    if (Date.now() - held.first > PENDING_TTL_MS) {
      pending.delete(id);
      // The one line worth an operator's attention: an agent that cannot read
      // a message is indistinguishable, from the outside, from an agent that
      // is ignoring one.
      log.warn("gave up decrypting a message for an agent", {
        eventId: id,
        roomId: held.event.room_id,
        sender: held.event.sender,
        waitedMs: Date.now() - held.first,
      });
      continue;
    }

    const plain = await asPlaintext(held.event, deps, { retrying: true });
    if (!plain) continue;

    pending.delete(id);
    log.info("decrypted a message once its key arrived", {
      eventId: id,
      roomId: held.event.room_id,
      waitedMs: Date.now() - held.first,
    });
    await handleRoomMessage(plain, deps);
  }
}

export async function handleRoomMessage(rawEvent: InboundEvent, deps: InboundDeps): Promise<void> {
  const event = await asPlaintext(rawEvent, deps);
  if (!event) return;

  if (event.type !== "m.room.message") return;
  if (!event.room_id) return;

  // ── A decision, before anything else ──────────────────────────────────────
  //
  // Checked here rather than below the guards, and the position is the point.
  // A decision is not a prompt: it answers a question the *board* asked, it
  // never reaches the harness, and it must work in a harness-mode room — which
  // the `identityMode !== "bridge"` guard further down would silently drop.
  // That drop would look exactly like a button that did nothing.
  if (deps.gates && event.content && parseGateDecision(event.content)) {
    await deps.gates.handle(
      { sender: event.sender, content: event.content },
      event.room_id
    );
    return;
  }

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

  // A station with no occupying agent has no handle and therefore no mxid to
  // speak as. This should not happen — provisioning refuses to create a room
  // for an unoccupied bridge-mode station in the first place — but a defensive
  // check beats inventing an address from `(nodeName, stationKey)` if it ever
  // does.
  const handle = room.principalId ? await principalHandle(room.principalId) : null;
  if (!handle) {
    log.warn("matrix room's station has no occupying agent; cannot speak as it", {
      room: room.roomId,
      stationKey: room.stationKey,
    });
    return;
  }

  const agentUser = bridgeUserId(handle, deps.domain);
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
    const allowed = grantAllowsPrincipal(grant, room.principalId);

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
      // The station's owner, for the same reason `createSession` takes it:
      // `requireLive` scopes on the session's `user_id`, a Better Auth id.
      await deps.acp.answerPermission(
        room.stationUserId,
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
      // The station's OWNER, not the sender's principal. `createSession` looks
      // the station up with `getStation(userId, stationId)`, which scopes on
      // `stations.user_id` — a Better Auth id. Passing a `prn_…` matched no
      // row, so every bridged room failed with "Station not found." after the
      // hub had already received, resolved and authorised the message.
      //
      // Authorisation still belongs to the principal: the control-pair check
      // above is what decides whether this sender may dispatch this agent, and
      // it must stay that way — a grant can cover a station its holder does not
      // own. What this line settles is only which user the station is read as.
      //
      // The cost, recorded rather than hidden: `acp_sessions.user_id` now names
      // the owner, so a transcript no longer says WHICH principal asked. That
      // needs its own column, not this one doing two jobs.
      const session = await deps.acp.createSession({
        stationId: room.stationId,
        userId: room.stationUserId,
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
    // The owner again, not the principal: `promptSession` resolves the live
    // session with `requireLive(userId, sessionId)`. Passing a `prn_…` meant
    // the session was created correctly and then could not be prompted —
    // "Session not found or not active." The same defect as the station
    // lookup, one call later; it survived the first fix because only the
    // createSession site was corrected.
    await deps.acp.promptSession(room.stationUserId, sessionId, text);
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
