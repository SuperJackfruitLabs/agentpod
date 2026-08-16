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
import { createLogger } from "../../utils/logger";

const log = createLogger("matrix-outbound");

export interface OutboundDeps {
  client: {
    sendText(userId: string, roomId: string, body: string): Promise<string | null>;
    sendTyping(userId: string, roomId: string, typing: boolean): Promise<void>;
  };
  subscribe?: (sessionId: string, fn: (e: AcpEvent) => void) => () => void;
  /**
   * A safety net, not a chunking strategy — see `FLUSH_SAFETY_MS`. 0 in tests
   * that assert on flush timing directly.
   */
  flushDelayMs?: number;
}

interface Attachment {
  roomId: string;
  agentUser: string;
  buffer: string[];
  timer: ReturnType<typeof setTimeout> | null;
  unsubscribe: () => void;
  ended: boolean;
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

/** A permission request, rendered as a question a person can answer. */
function permissionText(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const toolCall = isRecord(payload.toolCall) ? payload.toolCall : {};
  const what = typeof toolCall.title === "string" ? toolCall.title : "an action";

  const options = Array.isArray(payload.options)
    ? payload.options
        .map((o) => (isRecord(o) && typeof o.name === "string" ? o.name : null))
        .filter((n): n is string => n !== null)
    : [];

  const choices = options.length > 0 ? ` — ${options.join(" / ")}` : "";
  return `Permission needed: ${what}${choices}. Answer in the console; this room cannot yet.`;
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
    unsubscribe: () => {},
    ended: false,
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
    state.buffer = [];
    if (text.trim() === "") return;
    await say(text);
  };

  const scheduleFlush = () => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => void flush(), flushDelayMs);
  };

  const detach = () => {
    if (state.ended) return;
    state.ended = true;
    if (state.timer) clearTimeout(state.timer);
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
            scheduleFlush();
          }
          return;
        }

        case "state": {
          const status = isRecord(event.payload) ? event.payload.status : undefined;

          if (status === "working") {
            // Without this the room looks dead for the ten seconds an agent
            // spends thinking.
            await deps.client
              .sendTyping(agentUser, roomId, true)
              .catch(() => {});
            return;
          }

          if (status === "idle" || status === "ended") {
            await flush();
            await deps.client.sendTyping(agentUser, roomId, false).catch(() => {});
            // A session that ended takes its attachment with it — an
            // unsubscribed listener is the leak `_subscriberCountForTest`
            // exists to catch.
            if (status === "ended") detach();
          }
          return;
        }

        case "permission-request": {
          const text = permissionText(event.payload);
          if (text) await say(text);
          return;
        }

        case "error": {
          const message = isRecord(event.payload) ? event.payload.message : undefined;
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
  if (!state) return;
  state.ended = true;
  if (state.timer) clearTimeout(state.timer);
  state.unsubscribe();
  attached.delete(sessionId);
}
