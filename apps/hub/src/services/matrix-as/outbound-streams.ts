/**
 * What reaches the reader's own devices while a turn runs (the answer, the reasoning, each tool
 * call), and what reaches the fleet Live Activity. Best-effort throughout: none of it touches the
 * room.
 */

import { cardName, fleetSink, noteFleet, type FleetEvent } from "../push";
import type { ToolRecord } from "./activity";
import {
  deltaContent,
  LIVE_DELTA_TYPE,
  shouldSendDelta,
  THOUGHT_DELTA_TYPE,
  TOOL_UPDATE_TYPE,
  toolUpdateContent,
} from "./live";
import { log } from "./outbound-log";
import type { RoomContext } from "./outbound-state";

/**
 * Push what the agent has said so far to the reader's devices.
 *
 * Best-effort in every direction: no reader, no `sendToDevice`, or a failed
 * send all mean the same thing — no live view this turn — and none of them
 * touch the room. The durable message is unaffected either way, which is
 * what makes this safe to run against a live fleet.
 */
export async function streamLive(ctx: RoomContext, done: boolean): Promise<void> {
  const { sessionId, roomId, agentUser, deps, state } = ctx;
  const send = deps.client.sendToDevice;
  if (!send) return;

  const reader = await resolveReader(ctx);
  if (!reader) return;

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
    reader,
    LIVE_DELTA_TYPE,
    deltaContent({ roomId, sessionId, seq: state.liveSeq, text, done })
  ).catch((err) => {
    log.debug("could not stream a turn to the reader's devices", {
      sessionId,
      roomId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * The reader's Matrix id, looked up once per room and cached.
 *
 * Shared by all three live channels so a room with no reader does the lookup
 * once rather than once per stream.
 */
export async function resolveReader(ctx: RoomContext): Promise<string | null> {
  const { roomId, deps, state } = ctx;
  if (state.reader === undefined) {
    state.reader = deps.readerFor ? await deps.readerFor(roomId).catch(() => null) : null;
  }
  return state.reader;
}

/**
 * Tell the fleet Live Activity what just happened in this room.
 *
 * The reader and the agent's name are looked up once, and only when the
 * push gateway is on (a sink is installed). Every note chains on that one
 * lookup, so notes reach the fleet in the order they were made.
 */
export function fleet(
  ctx: RoomContext,
  make: (agent: { name: string; mxid: string; at: number }) => FleetEvent | null
): void {
  const { roomId, agentUser, deps } = ctx;
  if (!fleetSink()) return;
  ctx.fleetContext ??= (async () => {
    const reader = await resolveReader(ctx);
    if (!reader) return null;
    const looked = deps.nameFor ? await deps.nameFor(roomId).catch(() => null) : null;
    return { reader, name: cardName(looked ?? "", agentUser) };
  })();
  const at = Date.now();
  void ctx.fleetContext.then((found) => {
    if (!found) return;
    // The agent's Matrix id keys its avatar on the card.
    const event = make({ name: found.name, mxid: agentUser, at });
    if (event) noteFleet(found.reader, event);
  });
}

/**
 * Push the agent's reasoning so far to the reader's devices.
 *
 * The same policy and the same best-effort posture as `streamLive`, against
 * its own buffer and cursor. Unlike the answer there is no durable copy
 * behind this: a dropped delta is simply reasoning nobody saw, which costs
 * nothing, because reasoning is never written to the room at all.
 */
export async function streamThought(ctx: RoomContext, done: boolean): Promise<void> {
  const { sessionId, roomId, agentUser, deps, state } = ctx;
  const send = deps.client.sendToDevice;
  if (!send) return;
  const reader = await resolveReader(ctx);
  if (!reader) return;

  const text = state.thoughtBuffer.join("");
  const pending = text.slice(state.thoughtSentChars);
  if (!done && !shouldSendDelta(pending, Date.now() - state.thoughtSentAt)) return;
  if (done && pending.length === 0 && state.thoughtSeq === 0) return;

  state.thoughtSeq += 1;
  state.thoughtSentChars = text.length;
  state.thoughtSentAt = Date.now();

  await send(
    agentUser,
    reader,
    THOUGHT_DELTA_TYPE,
    deltaContent({ roomId, sessionId, seq: state.thoughtSeq, text, done })
  ).catch((err) => {
    log.debug("could not stream a turn's reasoning to the reader's devices", {
      sessionId,
      roomId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Push one tool call's current state to the reader's devices.
 *
 * Sent on every change rather than batched: this is the answer to "what is it
 * doing right now", and a batched ticker is a contradiction. The durable
 * record at the end of the turn is what makes it worth not batching — nothing
 * here has to survive, so nothing here has to be complete.
 */
export async function streamTool(ctx: RoomContext, record: ToolRecord): Promise<void> {
  const { sessionId, roomId, agentUser, deps, state } = ctx;
  const send = deps.client.sendToDevice;
  if (!send) return;
  const reader = await resolveReader(ctx);
  if (!reader) return;

  state.toolSeq += 1;
  await send(
    agentUser,
    reader,
    TOOL_UPDATE_TYPE,
    toolUpdateContent({
      roomId,
      sessionId,
      seq: state.toolSeq,
      toolCallId: record.id,
      title: record.title,
      kind: record.kind,
      status: record.status,
      locations: record.locations,
    })
  ).catch((err) => {
    log.debug("could not stream a tool call to the reader's devices", {
      sessionId,
      roomId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
