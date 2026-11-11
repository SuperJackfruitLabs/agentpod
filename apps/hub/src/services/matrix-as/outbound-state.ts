/**
 * The room outbound path's state: what a caller passes in, what one attachment holds for its
 * session, the module's two maps (attachments and turn triggers), its timing constants, and the
 * two ways an attachment comes off. See `outbound.ts` for the path as a whole.
 */

import type { AcpEvent } from "@agentpod/contract";
import type { ToolRecord } from "./activity";
import { clearPendingPermission } from "./permissions";
import type { HarnessPermission } from "@superjackfruitlabs/treaty-matrix-events";
import type { SpokenTurn } from "./voice-reply";

export interface OutboundDeps {
  /**
   * The durable record of a permission request (`permission-records.ts`): written before the
   * permission.v2 message is sent, so an answer is judged against it. Optional: a deployment (or a
   * test) without it projects permission.v2 all the same, and answers fall back to the in-memory
   * request alone.
   */
  permissionRecords?: {
    record(roomId: string, permission: HarnessPermission): Promise<boolean>;
    noteEvent(requestId: string, eventId: string): Promise<void>;
    /**
     * A `permission-answer` the session recorded (any surface, or the session ending): close the
     * record and the card if nothing else has (`settleFromSessionEvent`).
     */
    settle?(
      sessionId: string,
      payload: unknown,
      post: { say(body: string): Promise<unknown>; sendOutcome(content: Record<string, unknown>): Promise<unknown> },
    ): Promise<void>;
  };
  client: {
    sendText(userId: string, roomId: string, body: string, extra?: Record<string, unknown>): Promise<string | null>;
    sendTyping(userId: string, roomId: string, typing: boolean): Promise<void>;
    sendReaction?(
      userId: string,
      roomId: string,
      targetEventId: string,
      key: string
    ): Promise<string | null>;
    redact?(userId: string, roomId: string, eventId: string): Promise<void>;
    /**
     * Push a turn's live text to the reader's own devices. Optional: a
     * deployment without it simply does not stream, and the room is identical
     * either way — see `live.ts`.
     */
    sendToDevice?(
      userId: string,
      targetUserId: string,
      eventType: string,
      content: Record<string, unknown>
    ): Promise<void>;
    /**
     * Send one of the suite's own event types into the room. Optional for the
     * same reason `sendToDevice` is: a deployment without it records no
     * activity card, and the conversation is identical either way.
     */
    sendCustomEvent?(
      userId: string,
      roomId: string,
      eventType: string,
      content: Record<string, unknown>
    ): Promise<string | null>;
  };
  /**
   * Who to stream this room's turns to — the reader's Matrix id, or null for a
   * room with nobody to show it to. Resolved once per attachment.
   */
  readerFor?: (roomId: string) => Promise<string | null>;
  /**
   * The agent's name as the fleet Live Activity shows it (the station's
   * display name). Looked up once per attachment, and only when the push
   * gateway is on. Falls back to the agent's localpart.
   */
  nameFor?: (roomId: string) => Promise<string | null>;
  subscribe?: (sessionId: string, fn: (e: AcpEvent) => void) => () => void;
  /**
   * A safety net, not a chunking strategy — see `FLUSH_SAFETY_MS`. 0 in tests
   * that assert on flush timing directly.
   */
  flushDelayMs?: number;
  /** How long an event waits for the previous one — see `EVENT_ORDER_WAIT_MS`. */
  eventOrderWaitMs?: number;
  /** How often to re-send a typing notice while a turn runs. See TYPING_REFRESH_MS. */
  typingRefreshMs?: number;
  /**
   * Speak a finished turn's reply as a voice message (`voice-reply.ts`).
   * Called — never awaited — once per turn that ended with text in the room
   * and no error; it decides from the station's settings whether to speak.
   * Optional: without it replies are text only, as before.
   */
  speak?: (turn: SpokenTurn) => Promise<unknown>;
}

export interface Attachment {
  roomId: string;
  agentUser: string;
  buffer: string[];
  timer: ReturnType<typeof setTimeout> | null;
  typingTimer: ReturnType<typeof setInterval> | null;
  unsubscribe: () => void;
  ended: boolean;
  /** The message that started the current turn, if a person started it. */
  triggerEventId: string | null;
  /** Monotonic delta counter for the current turn — see `live.ts`. */
  liveSeq: number;
  /** How much of the buffered text has already been streamed. */
  liveSentChars: number;
  /** When the last delta went out, for the boundary backstop. */
  liveSentAt: number;
  /**
   * The reader's Matrix id, resolved lazily on the first chunk and cached for
   * the room's life. `undefined` means "not looked up yet"; `null` means
   * "looked up, nobody to stream to" — a distinction that stops a room with no
   * reader repeating the lookup on every chunk.
   */
  reader: string | null | undefined;
  /** The 👀 we put on it, so it can be taken off again. */
  workingReactionId: string | null;
  /**
   * The reasoning stream's own buffer and cursor.
   *
   * Separate from the answer's rather than shared: the two arrive interleaved
   * and are read on different channels, so one cursor would make an agent's
   * thinking and its answer overwrite each other. See `THOUGHT_DELTA_TYPE`.
   */
  thoughtBuffer: string[];
  thoughtSeq: number;
  thoughtSentChars: number;
  thoughtSentAt: number;
  /**
   * This turn's tool calls, in the order they were first used, keyed by
   * `toolCallId` so an update merges rather than appending. Cleared with the
   * rest of the per-turn state in `flush`.
   */
  tools: Map<string, ToolRecord>;
  /** Monotonic per turn, shared by every tool update. */
  toolSeq: number;
  /**
   * Whether this turn produced anything at all — a word, or a tool call.
   *
   * A turn that produced nothing is not a turn that succeeded, and the ✅ this
   * used to put on the reader's message said otherwise. Measured on
   * 2026-08-17: a provider quota was exhausted, every model in the failover
   * chain failed, and openclaw ended the turn `idle` without emitting an ACP
   * error — so the room marked it done and showed nothing. The reader asked
   * twice and got a green tick both times.
   */
  produced: boolean;
  /** Whether the harness already explained a failure this turn. */
  reportedError: boolean;
  /**
   * An error the harness reported this turn, held until the turn ends.
   *
   * Not posted when it arrives: a harness with a fallback chain reports each
   * failed attempt and then retries on the next model. Posted at once, the
   * first attempt's error reached the room as the outcome — "This agent
   * reported an error: weekly usage limit" and a ❌ on the message — and the
   * real answer from the fallback arrived underneath it (Krishna, 2026-09-26,
   * issue #583). Held, it is dropped if the agent says anything after it, and
   * posted exactly as before if the turn ends with nothing more.
   */
  pendingError: unknown;
  /** Between `working` and `idle`/`ended`: whether a held error has a turn end to wait for. */
  inTurn: boolean;
  /**
   * The counts `recordTurn` wrote for the turn now ending, for the fleet
   * Live Activity's "Done · 7 steps" / "Failed at step 4 of 7". Set by the
   * flush, read and cleared when the turn ends.
   */
  lastTurnCounts: { total: number; failed: number; failedAt?: number } | null;
  /**
   * What this turn put in the room as text, and the last message's id — for
   * the voice reply. A turn can flush more than once (a permission pause, the
   * safety timer), so the parts are kept until the turn ends.
   */
  turnText: string[];
  turnTextEventId: string | null;
  /**
   * The message the safety timer posted and left open, and the text it holds.
   *
   * A timer flush is not a turn end, so it must not close the turn's message.
   * Measured in production on 2026-10-26: an agent streamed almost its whole
   * reply, then sent the last few characters only with the turn's final event
   * 20+ s later. The timer posted the bulk and the turn end posted "it?" as a
   * second message, which the voice reply then spoke. Now the next flush in
   * the same turn edits this event (`m.replace`) with the full text instead.
   */
  open: { eventId: string; text: string } | null;
  /** Whether a voice note from the user started this turn. */
  voiceTriggered: boolean;
  /**
   * The previous event's handling, which the next one waits for — see
   * `EVENT_ORDER_WAIT_MS`.
   */
  chain: Promise<void>;
}

/**
 * Everything the pieces of one attachment share: who it speaks as, where, for which session,
 * through which client, and the attachment's own state. Built once per attachment by
 * `attachRoomToSession`, beside the settings it resolved at attach time.
 */
export interface RoomContext {
  sessionId: string;
  roomId: string;
  agentUser: string;
  deps: OutboundDeps;
  state: Attachment;
  flushDelayMs: number;
  typingRefreshMs: number;
  /**
   * The fleet Live Activity's reader and agent name, looked up once per attachment — see
   * `fleet` in `outbound-streams.ts`.
   */
  fleetContext: Promise<{ reader: string; name: string } | null> | null;
}

/**
 * One attachment per session.
 *
 * Provisioning and a reconnect both attach, and two subscribers on one session
 * would say everything twice — which reads as an agent repeating itself, not as
 * a bridge bug.
 */
export const attached = new Map<string, Attachment>();

/**
 * How long buffered text may sit before it is sent without the turn having ended.
 *
 * **A safety net, not a chunking strategy.** The turn's end is what flushes; this
 * only exists so a turn that never ends does not swallow what the agent already
 * said.
 *
 * It was 400ms, which is short enough to fire on an ordinary mid-answer pause —
 * and it did, in production: the console showed one message while the room showed
 * "Hello! Analyst Echo" and " here, ready to turn your data into insights…" as
 * two. An agent pausing to think mid-sentence is not the end of its turn, and
 * treating it as one cuts sentences in half.
 */
export const FLUSH_SAFETY_MS = 20_000;

/**
 * How often a typing notice is renewed while a turn is running.
 *
 * A Matrix typing notice expires on its own — ours carries a 30s timeout — so a
 * three-minute turn would show typing for the first thirty seconds and then look
 * abandoned. Renewing at 20s keeps the room honest for as long as the agent is
 * actually working, and stops the moment it is not.
 */
export const TYPING_REFRESH_MS = 20_000;

/**
 * How long one event's handling waits for the previous event's to finish.
 *
 * **A room handles a session's events in the order they happened.** Each
 * event used to be handled on its own, concurrently with the others, and a
 * turn's end awaits the homeserver several times — the answer, the typing
 * stop, the ✅. A turn queued behind it (`RoomQueue`) is prompted on the same
 * `idle` fan-out, so its `working` arrived while the previous turn was still
 * ending and overwrote that turn's trigger and voice flag before it was
 * spoken: krishna, 2026-09-30, a voice note answered in text only, because
 * "Hi?" typed a second later started its turn 51 ms after the voice turn went
 * idle. The ✅ went on the wrong message too.
 *
 * Bounded, not absolute: the Matrix client has no request timeout, and one
 * hung send must delay the room, not stop it for good.
 */
export const EVENT_ORDER_WAIT_MS = 30_000;

/**
 * What a mark on a message means.
 *
 * The vocabulary hermes's own Matrix plugin used, kept deliberately: 👀 while
 * the agent is working, ✅ when the turn finished, ❌ when it failed. It answers
 * "did it even hear me" without costing a message.
 */
export const REACTION = { working: "👀", done: "✅", failed: "❌" } as const;

/**
 * What the room is told when a turn ends having produced nothing.
 *
 * Deliberately says only what is known. The hub sees a turn go `working` and
 * then `idle` with no text, no tool call and no error — it does not know
 * whether the model refused, ran out of quota, or crashed, because the harness
 * that failed did not say. Guessing would be worse than the tick this replaces.
 */
export const SILENT_TURN_NOTICE =
  "This turn ended without a reply — the agent reported no answer and no error. " +
  "Its own logs will say why.";

/**
 * The message that started the turn about to run, per session.
 *
 * Set by the inbound path before it prompts. Kept outside the attachment because
 * a turn can be noted before the room is attached — and cleared with it.
 */
const triggers = new Map<string, { eventId: string; voice: boolean }>();

/**
 * Note which message started the next turn on this session, and whether it
 * was a voice note — a station set to answer voice with voice speaks only
 * those turns.
 */
export function noteTurnTrigger(sessionId: string, eventId: string, opts: { voice?: boolean } = {}): void {
  triggers.set(sessionId, { eventId, voice: opts.voice === true });
}

/**
 * Take back a trigger whose prompt never went out — a lost busy race, a
 * refused prompt — so the next turn, somebody else's, does not claim it.
 * Only that message's: one already taken, or replaced, is left alone.
 */
export function forgetTurnTrigger(sessionId: string, eventId: string): void {
  if (triggers.get(sessionId)?.eventId === eventId) triggers.delete(sessionId);
}

/**
 * Taken, not read: a trigger belongs to the one turn it started. Left in the
 * map, a later turn nobody asked for would mark it again.
 */
export function takeTrigger(sessionId: string): { eventId: string; voice: boolean } | undefined {
  const noted = triggers.get(sessionId);
  triggers.delete(sessionId);
  return noted;
}

/** Leak detection, mirroring `_subscriberCountForTest` in acp-sessions. */
export function _attachedCountForTest(): number {
  return attached.size;
}

/** A fresh attachment for a room: nothing buffered, no turn running, nothing sent. */
export function newAttachment(roomId: string, agentUser: string): Attachment {
  return {
    roomId,
    agentUser,
    buffer: [],
    timer: null,
    typingTimer: null,
    unsubscribe: () => {},
    ended: false,
    triggerEventId: null,
    workingReactionId: null,
    liveSeq: 0,
    liveSentChars: 0,
    liveSentAt: 0,
    reader: undefined,
    thoughtBuffer: [],
    thoughtSeq: 0,
    thoughtSentChars: 0,
    thoughtSentAt: 0,
    tools: new Map(),
    toolSeq: 0,
    produced: false,
    reportedError: false,
    pendingError: null,
    inTurn: false,
    lastTurnCounts: null,
    turnText: [],
    turnTextEventId: null,
    open: null,
    voiceTriggered: false,
    chain: Promise.resolve(),
  };
}

/** Take a session's attachment off when its session ended. Idempotent. */
export function detachEnded(sessionId: string, state: Attachment): void {
  if (state.ended) return;
  state.ended = true;
  clearPendingPermission(state.roomId);
  if (state.timer) clearTimeout(state.timer);
  if (state.typingTimer) clearInterval(state.typingTimer);
  triggers.delete(sessionId);
  state.unsubscribe();
  attached.delete(sessionId);
}

/** Stop streaming a session into its room. Idempotent. */
export function detachRoom(sessionId: string): void {
  const state = attached.get(sessionId);
  triggers.delete(sessionId);
  if (!state) return;
  clearPendingPermission(state.roomId);
  state.ended = true;
  if (state.timer) clearTimeout(state.timer);
  if (state.typingTimer) clearInterval(state.typingTimer);
  state.unsubscribe();
  attached.delete(sessionId);
}
