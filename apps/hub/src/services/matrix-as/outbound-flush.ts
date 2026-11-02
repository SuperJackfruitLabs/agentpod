/**
 * Ending a stretch of the turn: the turn's record of tool calls, then its text, as a new message
 * or as an edit of the one the safety timer left open.
 */

import { beginQuietSend, noteAnswerEvent, type TurnCounts } from "../push";
import { TURN_ACTIVITY_TYPE, turnActivityContent, type ToolRecord } from "./activity";
import { log } from "./outbound-log";
import { edit, say } from "./outbound-send";
import type { RoomContext } from "./outbound-state";
import { streamLive } from "./outbound-streams";

export async function flush(ctx: RoomContext, byTimer = false): Promise<void> {
  const { roomId, state } = ctx;
  // Taken (or kept, for another timer flush) before any await, like the
  // tools below: a turn-end flush racing a timer flush must not edit twice.
  const open = state.open;
  if (!byTimer) state.open = null;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const text = state.buffer.join("");
  // Before the buffer is cleared: the last delta carries the whole answer and
  // marks the live view finished, so a reader's provisional text is replaced
  // by the room's own message rather than lingering beside it.
  await streamLive(ctx, true);
  state.buffer = [];
  // A new turn starts its own sequence — the reader keys on it to know that
  // what follows is a fresh answer rather than more of the last one.
  state.liveSeq = 0;
  state.liveSentChars = 0;
  state.liveSentAt = 0;
  // The reasoning and tool state belong to the turn that just ended. Without
  // clearing it, the next turn reports the previous one's work as its own.
  state.thoughtBuffer = [];
  state.thoughtSeq = 0;
  state.thoughtSentChars = 0;
  state.thoughtSentAt = 0;

  // Handed over and replaced in the same step, before the `await` below.
  // `flush` runs twice for an ordinary turn — once on the debounce, once when
  // the state event ends it — and the second call must find nothing left to
  // record. Clearing after the await instead would let the second flush start
  // while the first was still sending, and the turn would be recorded twice.
  const tools = state.tools;
  state.tools = new Map();
  state.toolSeq = 0;
  const counts = tools.size > 0 ? await recordTurn(ctx, tools) : null;
  if (text.trim() === "") return;
  if (open) {
    const full = open.text + text;
    if (byTimer) state.open = { eventId: open.eventId, text: full };
    const id = await edit(ctx, open.eventId, full);
    if (id) {
      // The turn's text and its event stay the original message's: that is
      // the one the voice reply attaches to, now holding the whole answer.
      const i = state.turnText.lastIndexOf(open.text);
      if (i >= 0) state.turnText[i] = full;
      else state.turnText.push(full);
      state.turnTextEventId = open.eventId;
      return;
    }
    // The edit did not land: the tail goes out on its own, as it used to,
    // rather than not at all.
    if (byTimer) state.open = null;
  }
  const posted = (id: string | null) => {
    if (!id) return;
    state.turnText.push(text);
    state.turnTextEventId = id;
    if (byTimer) state.open = { eventId: id, text };
  };
  if (!counts) {
    posted(await say(ctx, text));
    return;
  }
  // The answer that ends a turn with a record carries the turn's counts on
  // its push (spec A5). Announced before it is sent, like a quiet send, so a
  // push that beats the send's response waits for them — see `hub-events.ts`.
  const end = beginQuietSend(roomId);
  try {
    const id = await say(ctx, text);
    noteAnswerEvent(id, counts);
    posted(id);
  } finally {
    end();
  }
}

/**
 * Write what the agent did during the turn into the room, once.
 *
 * Before the answer, so the room reads in the order things happened: did
 * these things, then said this. Best-effort like every other outbound call
 * here — a card that fails to send must not cost the answer behind it.
 */
export async function recordTurn(ctx: RoomContext, tools: Map<string, ToolRecord>): Promise<TurnCounts> {
  const { sessionId, roomId, agentUser, deps, state } = ctx;
  const content = turnActivityContent(sessionId, tools);
  const counts = { total: content.counts.total, failed: content.counts.failed };
  const firstFailed = [...tools.values()].findIndex((t) => t.status === "failed");
  state.lastTurnCounts = { ...counts, ...(firstFailed >= 0 ? { failedAt: firstFailed + 1 } : {}) };
  const send = deps.client.sendCustomEvent;
  if (!send) return counts;
  await send(agentUser, roomId, TURN_ACTIVITY_TYPE, content).catch(
    (err) => {
      log.error("could not record a turn's activity in its room", {
        sessionId,
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  );
  return counts;
}

export function scheduleFlush(ctx: RoomContext): void {
  const { state } = ctx;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => void flush(ctx, true), ctx.flushDelayMs);
}
