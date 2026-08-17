/**
 * The live view of a turn, sent to the reader's own devices and never to the
 * room.
 *
 * **Why not edits.** The obvious way to stream in Matrix is to send a message
 * and then replace it repeatedly (`m.replace`, and MSC4357 formalises exactly
 * that). It works, every client understands it, and it is what Slack, Discord
 * and Telegram bots do — because a bot has no other channel to the client. It
 * is a workaround for not owning the transport, not a design anyone chose.
 *
 * The cost is that every intermediate state becomes a permanent event. That is
 * not storage — this homeserver is 91 MB — but four things that are real:
 * `/search` returns half-written fragments of one answer; back-pagination
 * fetches twenty events to reveal one message; read markers drift as edits land
 * after them; and every phone on the account receives the churn. Worst of all,
 * more events per turn means more limited syncs, and a limited sync unloads the
 * timeline (see supermessage's `core::timeline`) — so streaming by edits would
 * pay for itself by making the timeline blink more often.
 *
 * **So the stream and the record are different channels**, which is what every
 * product that owns both ends does — ChatGPT, Claude and Gemini stream over a
 * connection that persists nothing and write one record at the end. Matrix has
 * the same shape available: to-device messages are delivered per device and are
 * never part of room history.
 *
 * The room therefore ends a turn exactly as it does today: one message,
 * flushed when the turn ends. A reader watching in supermessage sees it arrive
 * a sentence at a time; a reader in Element sees it appear complete, which is
 * what Element does today anyway. Nothing regresses for anyone, and room
 * history is byte-for-byte unchanged.
 *
 * Deliberately **not** encrypted and deliberately best-effort: a dropped delta
 * costs a moment of staleness and is corrected by the next one, and by the real
 * message regardless. Nothing here is the source of truth.
 */

/** The to-device event type carrying a turn's live text. */
export const LIVE_DELTA_TYPE = "dev.agentpod.stream.delta";

/**
 * The smallest amount of new text worth sending on its own.
 *
 * Below this, a delta costs a round trip to move a few characters. Chosen
 * against a short sentence rather than a word: the point is to read as prose
 * arriving, not as a typewriter.
 */
export const MIN_DELTA_CHARS = 24;

/**
 * How long new text may sit unsent when it has not reached a boundary.
 *
 * The backstop for an agent that emits one enormous unpunctuated block — the
 * reader still sees movement, just not at a natural break.
 */
export const MAX_DELTA_WAIT_MS = 1_500;

/**
 * Whether the text accumulated since the last delta is worth sending now.
 *
 * Boundary-first rather than timer-first, and that is the whole point: a
 * timer chops sentences in half, which reads worse than waiting. A boundary
 * with enough behind it goes immediately; anything else waits, until the
 * backstop.
 */
export function shouldSendDelta(pending: string, msSincePrevious: number): boolean {
  if (pending.length === 0) return false;
  if (msSincePrevious >= MAX_DELTA_WAIT_MS) return true;
  return pending.length >= MIN_DELTA_CHARS && endsAtBoundary(pending);
}

/**
 * Whether text ends somewhere a reader would accept a pause.
 *
 * Sentence enders and newlines only. A comma is not a boundary: stopping there
 * reads as a stall rather than a beat.
 */
export function endsAtBoundary(text: string): boolean {
  return /[.!?…:;]["')\]]?\s*$/.test(text) || /\n\s*$/.test(text);
}

/** One delta, as it goes on the wire. */
export interface LiveDelta {
  roomId: string;
  sessionId: string;
  /** Monotonic per turn. A receiver drops anything older than what it has. */
  seq: number;
  /**
   * **Everything so far**, not the increment.
   *
   * To-device delivery is at-least-once and unordered, so an increment would
   * make a dropped or reordered delta corrupt the text with no way to notice.
   * Cumulative text plus a sequence number is self-correcting: apply the
   * highest seq seen and the result is right no matter what arrived when.
   */
  text: string;
  /** True on the last delta of a turn — the room now holds the real message. */
  done: boolean;
}

/** The wire body for a delta. Snake case, like every other Matrix event. */
export function deltaContent(delta: LiveDelta): Record<string, unknown> {
  return {
    room_id: delta.roomId,
    session_id: delta.sessionId,
    seq: delta.seq,
    text: delta.text,
    done: delta.done,
  };
}
