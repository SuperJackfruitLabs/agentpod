/**
 * The agent's answer, arriving in the room.
 *
 * A second subscriber to the same in-process fan-out the console's WebSocket
 * already uses (`acp-sessions.ts`). What it must not do is forward that stream
 * verbatim: a Matrix event per token would buzz a phone forty times for one
 * answer, hit the homeserver's rate limits, and make a shared room unreadable.
 *
 * So text is buffered and flushed when the turn ends, typing is shown while it
 * is in flight, and the only things that reach the room are the ones a person
 * needs to see: the answer, a permission question, and an error.
 */

import type { AcpEvent } from "@agentpod/contract";
import { subscribe as subscribeToSession } from "../acp-sessions";
import { deltaContent, LIVE_DELTA_TYPE, shouldSendDelta } from "./live";
import {
  clearPendingPermission,
  notePendingPermission,
  permissionPrompt,
  type PermissionOption,
} from "./permissions";
import { createLogger } from "../../utils/logger";

const log = createLogger("matrix-outbound");

export interface OutboundDeps {
  client: {
    sendText(userId: string, roomId: string, body: string): Promise<string | null>;
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
  };
  /**
   * Who to stream this room's turns to — the reader's Matrix id, or null for a
   * room with nobody to show it to. Resolved once per attachment.
   */
  readerFor?: (roomId: string) => Promise<string | null>;
  subscribe?: (sessionId: string, fn: (e: AcpEvent) => void) => () => void;
  /**
   * A safety net, not a chunking strategy — see `FLUSH_SAFETY_MS`. 0 in tests
   * that assert on flush timing directly.
   */
  flushDelayMs?: number;
  /** How often to re-send a typing notice while a turn runs. See TYPING_REFRESH_MS. */
  typingRefreshMs?: number;
}

interface Attachment {
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
}

/**
 * One attachment per session.
 *
 * Provisioning and a reconnect both attach, and two subscribers on one session
 * would say everything twice — which reads as an agent repeating itself, not as
 * a bridge bug.
 */
const attached = new Map<string, Attachment>();

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
 * What a mark on a message means.
 *
 * The vocabulary hermes's own Matrix plugin used, kept deliberately: 👀 while
 * the agent is working, ✅ when the turn finished, ❌ when it failed. It answers
 * "did it even hear me" without costing a message.
 */
const REACTION = { working: "👀", done: "✅", failed: "❌" } as const;

/**
 * The message that started the turn about to run, per session.
 *
 * Set by the inbound path before it prompts. Kept outside the attachment because
 * a turn can be noted before the room is attached — and cleared with it.
 */
const triggers = new Map<string, string>();

/** Note which message started the next turn on this session. */
export function noteTurnTrigger(sessionId: string, eventId: string): void {
  triggers.set(sessionId, eventId);
}

/** Leak detection, mirroring `_subscriberCountForTest` in acp-sessions. */
export function _attachedCountForTest(): number {
  return attached.size;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** The text of an `agent_message_chunk`, or undefined for anything else. */
function messageChunkText(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  // Thought chunks are deliberately excluded: reasoning belongs in the
  // console's transcript, not in a room people share, where it would turn one
  // answer into a monologue.
  if (payload.sessionUpdate !== "agent_message_chunk") return undefined;
  const content = payload.content;
  if (!isRecord(content) || content.type !== "text") return undefined;
  return typeof content.text === "string" ? content.text : undefined;
}

/** What an agent is asking to do, and the answers it will accept. */
function permissionRequest(payload: unknown): {
  title: string;
  options: PermissionOption[];
} | null {
  if (!isRecord(payload)) return null;
  const toolCall = isRecord(payload.toolCall) ? payload.toolCall : {};
  const title = typeof toolCall.title === "string" ? toolCall.title : "an action";

  // Both halves or neither: an option the room can name but not answer with
  // would be worse than one it never showed.
  const options = Array.isArray(payload.options)
    ? payload.options
        .map((o) =>
          isRecord(o) && typeof o.name === "string" && typeof o.optionId === "string"
            ? { optionId: o.optionId, name: o.name }
            : null
        )
        .filter((o): o is PermissionOption => o !== null)
    : [];

  return { title, options };
}

export function attachRoomToSession(
  sessionId: string,
  roomId: string,
  agentUser: string,
  deps: OutboundDeps
): void {
  if (attached.has(sessionId)) return;

  const subscribe = deps.subscribe ?? subscribeToSession;
  const flushDelayMs = deps.flushDelayMs ?? FLUSH_SAFETY_MS;

  const state: Attachment = {
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
  };

  const say = async (body: string) => {
    try {
      await deps.client.sendText(agentUser, roomId, body);
    } catch (err) {
      // A homeserver hiccup must not silently detach the room: the next turn
      // should still arrive. Losing one message loudly beats losing the
      // conversation quietly.
      log.error("could not send an agent message into its room", {
        sessionId,
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const flush = async () => {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const text = state.buffer.join("");
    // Before the buffer is cleared: the last delta carries the whole answer and
    // marks the live view finished, so a reader's provisional text is replaced
    // by the room's own message rather than lingering beside it.
    await streamLive(true);
    state.buffer = [];
    // A new turn starts its own sequence — the reader keys on it to know that
    // what follows is a fresh answer rather than more of the last one.
    state.liveSeq = 0;
    state.liveSentChars = 0;
    state.liveSentAt = 0;
    if (text.trim() === "") return;
    await say(text);
  };

  /**
   * Push what the agent has said so far to the reader's devices.
   *
   * Best-effort in every direction: no reader, no `sendToDevice`, or a failed
   * send all mean the same thing — no live view this turn — and none of them
   * touch the room. The durable message is unaffected either way, which is
   * what makes this safe to run against a live fleet.
   */
  const streamLive = async (done: boolean) => {
    const send = deps.client.sendToDevice;
    if (!send) return;

    if (state.reader === undefined) {
      state.reader = deps.readerFor ? await deps.readerFor(roomId).catch(() => null) : null;
    }
    if (!state.reader) return;

    const text = state.buffer.join("");
    const pending = text.slice(state.liveSentChars);
    if (!done && !shouldSendDelta(pending, Date.now() - state.liveSentAt)) return;
    // The final delta is worth sending even with nothing new: it is what tells
    // a reader the live view is over and the room now holds the real message.
    if (done && pending.length === 0 && state.liveSeq === 0) return;

    state.liveSeq += 1;
    state.liveSentChars = text.length;
    state.liveSentAt = Date.now();

    await send(
      agentUser,
      state.reader,
      LIVE_DELTA_TYPE,
      deltaContent({ roomId, sessionId, seq: state.liveSeq, text, done })
    ).catch((err) => {
      log.debug("could not stream a turn to the reader's devices", {
        sessionId,
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const scheduleFlush = () => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => void flush(), flushDelayMs);
  };

  const typingRefreshMs = deps.typingRefreshMs ?? TYPING_REFRESH_MS;

  const stopTyping = async () => {
    if (state.typingTimer) {
      clearInterval(state.typingTimer);
      state.typingTimer = null;
    }
    await deps.client.sendTyping(agentUser, roomId, false).catch(() => {});
  };

  const startTyping = async () => {
    await deps.client.sendTyping(agentUser, roomId, true).catch(() => {});
    if (state.typingTimer) clearInterval(state.typingTimer);
    // Renewed rather than set once: the notice expires on its own, and a long
    // turn would otherwise look abandoned halfway through.
    state.typingTimer = setInterval(() => {
      void deps.client.sendTyping(agentUser, roomId, true).catch(() => {});
    }, typingRefreshMs);
  };

  /** Put a mark on the message that started this turn, replacing any earlier one. */
  const mark = async (key: string) => {
    const target = state.triggerEventId;
    if (!target || !deps.client.sendReaction) return;

    // Two marks on one message would read as two states at once, so the
    // previous one is taken off before the next goes on.
    if (state.workingReactionId && deps.client.redact) {
      await deps.client.redact(agentUser, roomId, state.workingReactionId).catch(() => {});
      state.workingReactionId = null;
    }

    const id = await deps.client
      .sendReaction(agentUser, roomId, target, key)
      .catch(() => null);
    if (key === REACTION.working) state.workingReactionId = id ?? null;
  };

  const detach = () => {
    if (state.ended) return;
    state.ended = true;
    clearPendingPermission(roomId);
    if (state.timer) clearTimeout(state.timer);
    if (state.typingTimer) clearInterval(state.typingTimer);
    triggers.delete(sessionId);
    state.unsubscribe();
    attached.delete(sessionId);
  };

  state.unsubscribe = subscribe(sessionId, (event: AcpEvent) => {
    if (state.ended) return;

    void (async () => {
      switch (event.type) {
        case "agent-update": {
          const text = messageChunkText(event.payload);
          if (text !== undefined) {
            state.buffer.push(text);
            void streamLive(false);
            scheduleFlush();
          }
          return;
        }

        case "state": {
          const status = isRecord(event.payload) ? event.payload.status : undefined;

          if (status === "working") {
            // Without this the room looks dead for the ten seconds an agent
            // spends thinking. The trigger is picked up here rather than at
            // attach time, because a room outlives any one turn.
            state.triggerEventId = triggers.get(sessionId) ?? null;
            await startTyping();
            await mark(REACTION.working);
            return;
          }

          // A question only stands while the agent is waiting on it. A turn
          // that moved on — answered in the console, cancelled, failed — must
          // not leave the room able to "approve" something already decided.
          if (status !== "waiting") clearPendingPermission(roomId);

          // Anything that is not `working` means the agent is not typing —
          // including `waiting`, which is a permission request this room cannot
          // yet answer and could sit there for hours. Enumerating only idle and
          // ended left typing on for exactly that case.
          await flush();
          await stopTyping();

          if (status === "idle" || status === "ended") await mark(REACTION.done);

          if (status === "ended") {
            // A session that ended takes its attachment with it — an
            // unsubscribed listener is the leak `_subscriberCountForTest`
            // exists to catch.
            detach();
          }
          return;
        }

        case "permission-request": {
          const request = permissionRequest(event.payload);
          if (!request) return;

          // Remembered BEFORE the message is sent: an answer cannot arrive
          // before the question, but a reply racing a slow homeserver would
          // find nothing pending and be treated as an ordinary prompt.
          //
          // `event.seq` is the request's own sequence number, which is how
          // `answerPermission` addresses it — the same address the console's
          // WebSocket sends.
          if (request.options.length > 0) {
            notePendingPermission(roomId, {
              sessionId,
              requestSeq: event.seq,
              options: request.options,
            });
          }

          await say(permissionPrompt(request.title, request.options));
          return;
        }

        case "error": {
          const message = isRecord(event.payload) ? event.payload.message : undefined;
          await stopTyping();
          await mark(REACTION.failed);
          await say(`This agent reported an error: ${String(message ?? "unknown")}`);
          return;
        }

        default:
          // user-prompt and permission-answer are echoes of what already
          // happened in the room, or of a console action. Repeating them would
          // make the agent quote the person it is talking to.
          return;
      }
    })();
  });

  attached.set(sessionId, state);
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
