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
import { IDENTITY_UNAVAILABLE_TEXT, resolveMatrixId } from "../matrix";
import { OrgPlaneError } from "../../auth/org-plane/client";
import { getGrant, grantAllowsPrincipal } from "../../auth/org-plane/grants";
import { isControlPairEnforced } from "../control";
import { bridgeUserId } from "../matrix";
import { boardRoomFor } from "../board-chat";
import { principalHandle } from "../../auth/org-plane/principals";
import {
  clearPendingPermission,
  matchPermissionAnswer,
  pendingPermissionFor,
  unmatchedAnswerText,
} from "./permissions";
import { createLogger } from "../../utils/logger";
import { claim, park, parkedEvent, PENDING_TTL_MS, waiting as waitingForKeys } from "./pending-decrypts";
import { parseGateDecision } from "../board-chat";
import { parseQuestionAnswer } from "../board-chat";
import { parseDeliveryAnswer } from "../board-chat";
import { parseAttentionAnswer } from "../board-chat";
import { GATE_PULL_BACK_V2_SUITE_TYPE } from "../board-chat";
import { CHECK_OVERRIDE_V2_SUITE_TYPE } from "../board-chat";
import { PERMISSION_OUTCOME_TYPE, isPermissionAnswerMarked, parsePermissionAnswer } from "@superjackfruitlabs/treaty-matrix-events";
import {
  answerTypedPermission,
  handlePermissionAnswer,
  refuseLatePermissionReply,
  typedPermissionGate,
  type PermissionAnswerDeps,
} from "./permission-answer";
import type { PermissionAnswerer } from "../acp";
import { imageNote, imageSource, isRefusal, loadImage, type PromptImage } from "../matrix";
import {
  audioSource,
  isVoiceRefusal,
  loadVoice,
  transcriptContent,
  transcriptNotice,
  voiceNote,
  voicePrompt,
  type VoiceResult,
} from "./voice";
import { MAX_VOICE_SECONDS, type Transcriber } from "../speech";
import { RoomQueue, type DispatchOutcome, type FreeOutcome, type QueuedPrompt } from "./room-queue";
import { SESSION_BUSY_MESSAGE } from "../acp";

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
  decrypt?(roomId: string, asUserId: string, event: InboundEvent): Promise<Record<string, unknown> | null>;
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
  /**
   * Answering an agent's question — a plain message in a board room.
   *
   * Unlike a gate, which arrives as a structured event pointing at the message it
   * answers, this is ordinary text matched against the question currently open in
   * that room. That is what lets a question be answered from any Matrix client
   * rather than only one that knows a custom event type.
   *
   * Optional for the same reason `gates` is: a deployment with no board wired up
   * behaves exactly as before, and the tests that predate it construct deps without
   * it.
   */
  elicitations?: {
    handle(event: { sender: string; body: string }, roomId: string): Promise<unknown>;
  };
  /**
   * A structured answer to a question (`dev.superpipeline.question.answer.v2`) and to a delivery
   * follow-up (`dev.superpipeline.delivery.answer.v2`): the decision envelope's answers, which
   * name what they answer and reference its message, as a gate decision does. Optional, for the
   * reason `gates` is.
   */
  questions?: {
    handle(event: { sender: string; content: Record<string, unknown> }, roomId: string): Promise<unknown>;
  };
  deliveries?: {
    handle(event: { sender: string; content: Record<string, unknown> }, roomId: string): Promise<unknown>;
  };
  /** An answer to a waiting card (`dev.superpipeline.attention.answer.v2`): resume or archive it. */
  attention?: {
    handle(event: { sender: string; content: Record<string, unknown> }, roomId: string): Promise<unknown>;
  };
  /**
   * A held approval pulled back (`dev.superpipeline.gate.pull_back.v2`, charter 2026-11-09: an
   * approval may wait for its release time). Optional, for the reason `gates` is.
   */
  pullBacks?: {
    handle(event: { sender: string; content: Record<string, unknown> }, roomId: string): Promise<unknown>;
  };
  /**
   * A machine check overridden (`dev.superpipeline.check.override.v2`, charter 2026-11-09: a gate may
   * be decided by checks). Optional, for the reason `gates` is.
   */
  checkOverrides?: {
    handle(event: { sender: string; content: Record<string, unknown> }, roomId: string): Promise<unknown>;
  };
  client: {
    sendText(userId: string, roomId: string, body: string): Promise<string | null>;
    /**
     * Fetch media as `userId`. Optional so a relay-only deployment, and the
     * tests that predate images, still type-check; without it an image
     * reaches the agent as a note saying it could not be fetched.
     */
    downloadMedia?(userId: string, mxc: string): Promise<Uint8Array | null>;
    /**
     * Send any room event as `userId`. Used for the bridge's own words — a
     * refusal, a failure — sent as `m.notice`, so a client can show them as
     * the room talking rather than the agent. Optional: without it they fall
     * back to `sendText`.
     */
    sendCustomEvent?(
      userId: string,
      roomId: string,
      eventType: string,
      content: Record<string, unknown>
    ): Promise<string | null>;
  };
  /**
   * Speech to text for voice notes, asked per voice note for the room's
   * station — the console's station and hub settings, then TRANSCRIBE_* env
   * (`services/speech/transcription-settings.ts`). Null: none for that station.
   */
  transcriberFor?(stationId: string): Promise<{ transcriber: Transcriber; maxSeconds: number } | null>;
  /**
   * One transcriber for every station, at the default length limit. Used when
   * `transcriberFor` is absent — the tests that predate per-station settings.
   * Without either, a voice note reaches the agent as a note that it could
   * not be heard — see `voice.ts`.
   */
  transcriber?: Transcriber | null;
  acp: {
    createSession(input: {
      stationId: string;
      tenantId: string;
      userId: string;
      mode: string;
    }): Promise<{ id: string }>;
    promptSession(
      userId: string,
      sessionId: string,
      text: string,
      images?: PromptImage[]
    ): Promise<void>;
    /**
     * Whether the session is mid-turn, and when it will not be. Optional so
     * the tests that predate the queue still type-check; without them a busy
     * session's refusal is reported rather than queued.
     */
    isBusy?(sessionId: string): boolean;
    whenIdle?(sessionId: string): Promise<FreeOutcome>;
    /**
     * Answer a permission request the agent is parked on. Optional so a
     * deployment (or a test) that only relays messages still type-checks.
     */
    answerPermission?(
      userId: string,
      sessionId: string,
      requestSeq: number,
      optionId: string,
      answeredBy?: PermissionAnswerer
    ): Promise<void>;
  };
  /**
   * A person's label for a permission receipt ("Allow once — answered by …"); never an mxid.
   * Optional: without it a receipt names nobody.
   */
  displayNameFor?(principalId: string): Promise<string | null>;
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
  noteTrigger?(sessionId: string, eventId: string, opts?: { voice?: boolean }): void;
  /**
   * Take back a noted trigger whose prompt did not go out, so the next turn —
   * somebody else's — does not claim this message's marks and voice flag.
   */
  forgetTrigger?(sessionId: string, eventId: string): void;
}

/** The room, its station, and the node name that station's identity is built from. */
async function roomContext(roomId: string) {
  const [row] = await db
    .select({
      roomId: matrixRooms.roomId,
      sessionId: matrixRooms.acpSessionId,
      stationId: stations.id,
      stationUserId: stations.userId,
      stationTenantId: stations.tenantId,
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

  /**
   * A board room first, because it is the one the hub can always read.
   *
   * `charter → decisions/2026-09-28-a-gate-belongs-to-its-board-not-to-an-agents-room.md`.
   * A board room is spoken by an identity whose keys this hub owns outright — that
   * is the entire reason it exists — so it is decryptable by construction and needs
   * none of the station reasoning below. It has no station at all, so the station
   * lookup would answer null and a gate decision would be dropped unread, which is
   * exactly what happened on 2026-09-28.
   */
  const board = await boardRoomFor(event.room_id);
  if (board) {
    const plainBoard = await deps.decrypt(event.room_id, board.speakerMxid, event);
    if (!plainBoard) {
      if (!retrying) await remember(event);
      return null;
    }
    // Same shape as the station path below, and for the same reason: the envelope
    // is kept because a megolm plaintext need not carry `room_id` or `sender`, and
    // everything downstream reads them.
    return { ...event, ...plainBoard };
  }

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
    if (!retrying) await remember(event);
    return null;
  }

  // The envelope kept, the payload taken. A megolm plaintext carries `type`
  // and `content` and need not carry `sender`, `event_id` or `room_id` — those
  // belong to the event that wrapped it, and everything below this line reads
  // them. Returning the payload alone would bail one line later on a missing
  // `room_id`, which looks exactly like a message nobody sent.
  return { ...event, ...plain };
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
 * So an undecryptable event waits (`pending-decrypts.ts`) and is tried again
 * whenever new keys arrive, which `onCryptoTransaction` signals, and once when
 * the hub starts. **It waits in the database.** The second version kept it in
 * memory, so a restart before the key arrived lost it without a word, after the
 * homeserver had been told it was delivered: on 2026-11-11 a gate approved from
 * chat across a hub restart never reached the board, and nothing was logged.
 * Bounded in both directions: an event that stays unreadable is dropped after
 * `PENDING_TTL_MS` with one warning, and at most `PENDING_MAX` wait.
 */
async function remember(event: InboundEvent): Promise<void> {
  const id = event.event_id;
  if (!id || !event.room_id) return;
  try {
    if (await park(id, event.room_id, { ...event })) {
      // One line per parked event, so a message waiting on its key is never invisible.
      log.info("a message cannot be decrypted yet; it waits for its key", {
        eventId: id,
        roomId: event.room_id,
        sender: event.sender,
      });
    }
  } catch (err) {
    log.error("could not park a message that cannot be decrypted yet; it is lost", {
      eventId: id,
      roomId: event.room_id,
      sender: event.sender,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The transcription service for a station's voice note, and its length limit.
 * A lookup that fails is a voice note that cannot be heard — reported like
 * any other reason — never a message that is lost.
 */
async function voiceServiceFor(
  deps: InboundDeps,
  stationId: string
): Promise<{ transcriber: Transcriber | null; maxSeconds: number } | { reason: string }> {
  if (!deps.transcriberFor) return { transcriber: deps.transcriber ?? null, maxSeconds: MAX_VOICE_SECONDS };
  try {
    const found = await deps.transcriberFor(stationId);
    return found ?? { transcriber: null, maxSeconds: MAX_VOICE_SECONDS };
  } catch (err) {
    log.error("could not read a station's transcription settings", {
      stationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { reason: "its transcription settings could not be read" };
  }
}

/**
 * Try the waiting messages again, now that more keys are in hand.
 *
 * Called after each transaction's crypto half, which is the only moment new
 * keys can have arrived, and once at boot for whatever a restart left waiting.
 * An event is handled only by the call that takes it off the list, so two
 * retries running at once never act on it twice.
 */
export async function retryPendingDecrypts(deps: InboundDeps): Promise<void> {
  const held = await waitingForKeys();
  for (const row of held) {
    const waitedMs = Date.now() - row.firstSeenAt.getTime();
    const event = parkedEvent(row.event);
    if (!event || waitedMs > PENDING_TTL_MS) {
      if (!(await claim(row.eventId))) continue;
      // The one line worth an operator's attention: an agent that cannot read
      // a message is indistinguishable, from the outside, from an agent that
      // is ignoring one.
      log.warn("gave up decrypting a message for an agent", {
        eventId: row.eventId,
        roomId: row.roomId,
        sender: event?.sender,
        waitedMs,
      });
      continue;
    }

    const plain = await asPlaintext(event, deps, { retrying: true });
    if (!plain) continue;
    if (!(await claim(row.eventId))) continue;

    log.info("decrypted a message once its key arrived", {
      eventId: row.eventId,
      roomId: row.roomId,
      waitedMs,
    });
    // At most once, deliberately: the row is taken before the message is handled, which is what
    // stops two retries acting on it twice. The price is that a handler that throws here loses
    // the message, so that is said, by event id, rather than left silent.
    try {
      await handleRoomMessage(plain, deps);
    } catch (err) {
      log.error("a message decrypted after waiting for its key failed to be handled; it is lost", {
        eventId: row.eventId,
        roomId: row.roomId,
        sender: plain.sender,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
  // The envelope's other two answers, for the same reasons and in the same place: never a prompt,
  // and never read as a typed reply to the question open in the room.
  if (deps.questions && event.content && parseQuestionAnswer(event.content)) {
    await deps.questions.handle({ sender: event.sender, content: event.content }, event.room_id);
    return;
  }
  if (deps.deliveries && event.content && parseDeliveryAnswer(event.content)) {
    await deps.deliveries.handle({ sender: event.sender, content: event.content }, event.room_id);
    return;
  }
  if (deps.attention && event.content && parseAttentionAnswer(event.content)) {
    await deps.attention.handle({ sender: event.sender, content: event.content }, event.room_id);
    return;
  }
  // A pull-back answers the board too, never the agent, for the same reasons and in the same place.
  // Matched by its marker alone, so a malformed one is refused there rather than read as a prompt.
  if (deps.pullBacks && event.content?.suite_event_type === GATE_PULL_BACK_V2_SUITE_TYPE) {
    await deps.pullBacks.handle({ sender: event.sender, content: event.content }, event.room_id);
    return;
  }
  // So does a check's override: the board decides it, and a malformed one is refused there too.
  if (deps.checkOverrides && event.content?.suite_event_type === CHECK_OVERRIDE_V2_SUITE_TYPE) {
    await deps.checkOverrides.handle({ sender: event.sender, content: event.content }, event.room_id);
    return;
  }

  // A permission.answer.v2 (AgentPod's own envelope) is judged below, after the sender and the
  // grant — it answers the agent, so it is dispatching by another name. Whatever it carries, it is
  // never a prompt, and its body may be anything (or nothing).
  const permissionAnswer = isPermissionAnswerMarked(event.content);

  // An image's `body` is its file name, not something the sender said — the
  // bridge used to send that name as the whole message, and the agent could
  // only guess at a picture it never received (2026-09-24). Its words are the
  // caption, if there is one; the picture itself is fetched below, once the
  // room and the agent speaking in it are known.
  const image = imageSource(event.content);
  // A voice note's `body` is its file name too; its words are transcribed
  // below, the same way the picture is fetched.
  const audio = image ? null : audioSource(event.content);
  const text = image
    ? image.caption
    : audio
      ? audio.caption
      : typeof event.content?.body === "string"
        ? event.content.body
        : "";
  // Whitespace is not a prompt. Sending one would start a turn with nothing in
  // it and cost an agent a round trip to say so. A bare image or voice note is
  // not nothing.
  if (text.trim() === "" && !image && !audio && !permissionAnswer) return;

  // ── A board room answers questions; it never starts sessions ──────────────
  //
  // A board room has no station, which is the point of it: it is spoken by an
  // identity whose keys this hub owns outright, so it can both encrypt and decrypt
  // there. Before this, a message typed into one fell through to the station lookup
  // below, found nothing, and was dropped in silence — correct for chatter, and
  // wrong for the one thing a board room exists to carry back.
  //
  // The sender check is not a nicety. The hub posts the question AS the speaker and
  // the appservice hands that message straight back; without this the hub would
  // answer its own question the instant it asked it, choosing whichever option its
  // own prose happened to match.
  const board = await boardRoomFor(event.room_id);
  if (board) {
    if (permissionAnswer) return;
    if (deps.elicitations && event.sender !== board.speakerMxid) {
      await deps.elicitations.handle({ sender: event.sender, body: text }, event.room_id);
    }
    return;
  }

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
  const say = (body: string) => notice(deps, agentUser, room.roomId, body);

  // ── Who is this? ──────────────────────────────────────────────────────────
  //
  // Under the org plane this, and the grant below, are the reads design §5.7 allows on this path,
  // served from a 60 s cache with last-good. A plane that cannot be reached with nothing cached is
  // said as such — "I do not recognise you" would be a lie that sends somebody to relink.
  let identity: Awaited<ReturnType<typeof resolveMatrixId>>;
  try {
    identity = await resolveMatrixId(event.sender);
  } catch (err) {
    if (!(err instanceof OrgPlaneError)) throw err;
    log.warn("matrix sender could not be resolved: the org plane is unreachable", {
      sender: event.sender,
      room: room.roomId,
      status: err.status,
    });
    await say(IDENTITY_UNAVAILABLE_TEXT);
    return;
  }
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
    let grant: Awaited<ReturnType<typeof getGrant>>;
    try {
      grant = await getGrant(principalId);
    } catch (err) {
      if (!(err instanceof OrgPlaneError)) throw err;
      log.warn("matrix sender's grant could not be read: the org plane is unreachable", {
        principalId,
        room: room.roomId,
        status: err.status,
      });
      await say(IDENTITY_UNAVAILABLE_TEXT);
      return;
    }
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
  const answerer = { principalId, mxid: event.sender };
  const permissionDeps: PermissionAnswerDeps = {
    answer: async (sessionId, requestSeq, optionId, answeredBy) => {
      if (!deps.acp.answerPermission) throw new Error("This hub cannot answer permission requests from a room yet.");
      // The station's owner, for the reason the typed path below gives.
      await deps.acp.answerPermission(room.stationUserId, sessionId, requestSeq, optionId, answeredBy);
    },
    say,
    sendOutcome: async (content) =>
      deps.client.sendCustomEvent ? deps.client.sendCustomEvent(agentUser, room.roomId, PERMISSION_OUTCOME_TYPE, content) : null,
    displayNameFor: async (id) => (await deps.displayNameFor?.(id)) ?? null,
  };

  // ── A structured answer to a permission request (permission.answer.v2) ────
  if (permissionAnswer) {
    const parsed = parsePermissionAnswer(event.content);
    if (!parsed) {
      log.warn("a malformed permission.answer.v2, ignored", { room: room.roomId, sender: event.sender });
      return;
    }
    await handlePermissionAnswer(parsed, { roomId: room.roomId, sessionId: room.sessionId, answerer }, permissionDeps);
    return;
  }

  const waiting = pendingPermissionFor(room.roomId);
  if (waiting) {
    // Judged against the durable record first: a request that expired or was settled elsewhere
    // is refused and dropped, never answered — and never left to swallow the next message.
    const gate = await typedPermissionGate(waiting, room.roomId, permissionDeps);
    if (gate === "refused") return;
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

    // A recorded request is answered under the same checks as permission.answer.v2 — the preview
    // rule included — and claimed before the agent is answered (`answerTypedPermission`).
    if (gate) {
      const out = await answerTypedPermission(gate, optionId, { roomId: room.roomId, sessionId: waiting.sessionId, answerer }, permissionDeps);
      log.info("permission answer from a room", { principalId, room: room.roomId, optionId, status: out.status });
      return;
    }

    try {
      // The station's owner, for the same reason `createSession` takes it:
      // `requireLive` scopes on the session's `user_id`, a Better Auth id.
      await deps.acp.answerPermission(
        room.stationUserId,
        waiting.sessionId,
        waiting.requestSeq,
        optionId,
        { via: "room", principalId, mxid: event.sender }
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

  // ── A late answer to a permission request that is no longer waiting ───────
  //
  // Nothing is parked, but the room's last request closed moments ago (answered in the console,
  // expired) or was left behind by a restart, and this reply is one of its options. Passing it on
  // would hand the agent a bare "1" as an instruction; it is refused in the room instead.
  if (!image && !audio && (await refuseLatePermissionReply(room.roomId, text, permissionDeps))) return;

  // ── Say it to the agent ───────────────────────────────────────────────────
  //
  // The picture, fetched as the agent — a member of the room, so allowed to
  // read what was posted in it — and decrypted when the room is encrypted.
  // One that cannot be had still reaches the agent, as a note saying why,
  // rather than as a file name it would try to interpret.
  let prompt = text;
  const images: PromptImage[] = [];
  if (image) {
    const download = deps.client.downloadMedia;
    const loaded = download
      ? await loadImage(image, (mxc) => download(agentUser, mxc))
      : { reason: "this hub cannot fetch images" };
    if (isRefusal(loaded)) {
      log.warn("an image for an agent could not be passed on", {
        room: room.roomId,
        reason: loaded.reason,
      });
      prompt = [text, imageNote(image.name, loaded.reason)].filter((p) => p.trim() !== "").join("\n");
    } else {
      images.push(loaded);
    }
  }

  // The voice note, heard: fetched as the agent, decrypted, transcribed. The
  // transcript goes into the room as a reply to the note — so whoever sent it
  // sees what the agent heard — and to the agent as the message. One that
  // cannot be heard reaches the agent as a note saying why, and the room is
  // told the same.
  if (audio) {
    const download = deps.client.downloadMedia;
    const service = download ? await voiceServiceFor(deps, room.stationId) : null;
    const heard: VoiceResult = !download || !service
      ? { reason: "this hub cannot fetch audio" }
      : "reason" in service
        ? service
        : await loadVoice(audio, (mxc) => download(agentUser, mxc), service.transcriber, service.maxSeconds);
    if (isVoiceRefusal(heard)) {
      log.warn("a voice note for an agent could not be transcribed", {
        room: room.roomId,
        reason: heard.reason,
      });
      await say(`I could not transcribe this voice note: ${heard.reason}.`);
      prompt = [text, voiceNote(audio.name, heard.reason)].filter((p) => p.trim() !== "").join("\n");
    } else {
      log.info("transcribed a voice note for an agent", {
        room: room.roomId,
        seconds: heard.seconds,
        language: heard.transcript.language,
      });
      await notice(
        deps,
        agentUser,
        room.roomId,
        transcriptNotice(heard.transcript),
        event.event_id,
        transcriptContent(heard.transcript, heard.seconds)
      );
      prompt = voicePrompt(heard.transcript, heard.seconds, text);
    }
  }

  // A voice note — heard or not — marks the turn as spoken to, which is what
  // a station set to answer voice with voice (`voice_in`) speaks.
  const turn: QueuedPrompt = {
    text: prompt,
    images,
    ...(event.event_id ? { eventId: event.event_id } : {}),
    ...(audio ? { voice: true } : {}),
  };
  // Mid-turn is not a refusal. The message waits and goes with the next turn
  // — see `RoomQueue`. Only a hub that cannot tell when a turn ends refuses.
  if ((await dispatchTurn(room, agentUser, turn, deps)) === "busy") {
    if (deps.acp.whenIdle) {
      queueFor(deps).enqueue(room.roomId, turn);
    } else {
      await say(`I could not reach this agent: ${SESSION_BUSY_MESSAGE}`);
    }
  }
}

type RoomRow = NonNullable<Awaited<ReturnType<typeof roomContext>>>;

/**
 * The bridge's own words — a refusal, a failure, a dropped queue — as an
 * `m.notice`. Sent as the agent, because only the agent is in the room, but
 * marked as a notice so a client can show it as the room speaking: posted as
 * ordinary text, "Session is busy" read as the agent turning the person away.
 */
function notice(
  deps: InboundDeps,
  agentUser: string,
  roomId: string,
  body: string,
  replyTo?: string,
  extra?: Record<string, unknown>
) {
  if (deps.client.sendCustomEvent) {
    return deps.client.sendCustomEvent(agentUser, roomId, "m.room.message", {
      // Extra keys beside the body, never over it: `msgtype` and `body` below
      // are what every client falls back to.
      ...(extra ?? {}),
      msgtype: "m.notice",
      body,
      // A reply, when it is about one message — a voice note's transcript —
      // so a client shows it under that message.
      ...(replyTo ? { "m.relates_to": { "m.in_reply_to": { event_id: replyTo } } } : {}),
    });
  }
  return deps.client.sendText(agentUser, roomId, body);
}

/**
 * Hand one turn to the room's agent: find or open the session, attach the
 * room to it, mark the message, prompt.
 *
 * "busy" when the session is mid-turn — checked BEFORE the trigger is noted,
 * because noting it would move the running turn's ✅ onto a message that has
 * not been answered. Any other failure is reported to the room and counts as
 * handled.
 */
async function dispatchTurn(
  room: RoomRow,
  agentUser: string,
  turn: QueuedPrompt,
  deps: InboundDeps
): Promise<DispatchOutcome> {
  let noted: { sessionId: string; eventId: string } | null = null;
  try {
    // A session the hub has already ended is not a session. Boot reconciliation
    // ends every live one with "hub restarted", so without this check a room
    // prompts a corpse forever and every bridged room dies permanently at the
    // first restart — with "Session not found or not active" as the only clue.
    const sessionUsable = room.sessionId !== null && room.sessionStatus !== null && room.sessionStatus !== "ended";
    let sessionId = sessionUsable ? room.sessionId : null;

    if (sessionId && deps.acp.isBusy?.(sessionId)) return "busy";

    if (!sessionId) {
      // One session per room, not per message: a conversation is a
      // conversation, and a session per message would throw away the agent's
      // context between two consecutive sentences.
      // The station's OWNER, not the sender's principal: the session is the
      // owner's (sessions stay a person's own, W4), and it opens in the
      // station's tenant. It once mattered for the lookup too: `getStation`
      // scoped on `stations.user_id`, so a `prn_…` matched no row and every
      // bridged room failed with "Station not found.".
      //
      // Authorisation still belongs to the principal: the control-pair check
      // in `handleRoomMessage` is what decides whether this sender may dispatch
      // this agent, and it must stay that way — a grant can cover a station its
      // holder does not own. What this line settles is only which user the
      // station is read as.
      //
      // The cost, recorded rather than hidden: `acp_sessions.user_id` now names
      // the owner, so a transcript no longer says WHICH principal asked. That
      // needs its own column, not this one doing two jobs.
      const session = await deps.acp.createSession({
        stationId: room.stationId,
        tenantId: room.stationTenantId,
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
    if (turn.eventId && deps.noteTrigger) {
      deps.noteTrigger(sessionId, turn.eventId, { voice: turn.voice === true });
      noted = { sessionId, eventId: turn.eventId };
    }

    // The user's words, unchanged. Trimming or decorating them would put the
    // bridge's voice into the agent's input.
    // The owner again, not the principal: `promptSession` resolves the live
    // session with `requireLive(userId, sessionId)`. Passing a `prn_…` meant
    // the session was created correctly and then could not be prompted —
    // "Session not found or not active." The same defect as the station
    // lookup, one call later; it survived the first fix because only the
    // createSession site was corrected.
    await deps.acp.promptSession(room.stationUserId, sessionId, turn.text, turn.images);
    return "sent";
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // This prompt did not start a turn, so its trigger must not wait for one.
    if (noted) deps.forgetTrigger?.(noted.sessionId, noted.eventId);
    // Lost the race between the check above and the prompt: another message
    // started a turn in between. Waiting is still the answer.
    if (reason === SESSION_BUSY_MESSAGE) return "busy";
    log.error("matrix message could not reach the station", {
      room: room.roomId,
      stationKey: room.stationKey,
      error: reason,
    });
    await notice(deps, agentUser, room.roomId, `I could not reach this agent: ${reason}`);
    return "sent";
  }
}

/** One queue per set of deps — one in production, one per test. */
const queues = new WeakMap<InboundDeps, RoomQueue>();

function queueFor(deps: InboundDeps): RoomQueue {
  let queue = queues.get(deps);
  if (queue) return queue;
  queue = new RoomQueue({
    async waitUntilFree(roomId) {
      const room = await roomContext(roomId);
      const usable = room?.sessionId && room.sessionStatus && room.sessionStatus !== "ended";
      if (!room || !usable || !deps.acp.whenIdle) return "ended";
      return deps.acp.whenIdle(room.sessionId!);
    },
    async dispatch(roomId, prompt) {
      // Re-read: the session may have ended, or been replaced, while waiting.
      const room = await roomContext(roomId);
      const handle = room?.principalId ? await principalHandle(room.principalId) : null;
      if (!room || !handle) return "sent";
      return dispatchTurn(room, bridgeUserId(handle, deps.domain), prompt, deps);
    },
    async giveUp(roomId, dropped) {
      const room = await roomContext(roomId);
      const handle = room?.principalId ? await principalHandle(room.principalId) : null;
      if (!room || !handle) return;
      log.warn("gave up on messages queued behind a turn that never ended", { room: roomId, dropped });
      await notice(
        deps,
        bridgeUserId(handle, deps.domain),
        roomId,
        dropped === 1
          ? "One message was not passed on: the agent's previous turn never finished."
          : `${dropped} messages were not passed on: the agent's previous turn never finished.`
      );
    },
  });
  queues.set(deps, queue);
  return queue;
}
