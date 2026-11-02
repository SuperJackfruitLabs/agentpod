/**
 * The agent's answer, arriving in the room.
 *
 * A second subscriber to the same in-process fan-out the console's WebSocket
 * already uses (`acp/events.ts`). What it must not do is forward that stream
 * verbatim: a Matrix event per token would buzz a phone forty times for one
 * answer, hit the homeserver's rate limits, and make a shared room unreadable.
 *
 * So text is buffered and flushed when the turn ends, typing is shown while it
 * is in flight, and the only things that reach the room are the ones a person
 * needs to see: the answer, a permission question, and an error. *
 * This file is the path's surface: it attaches a room to a session and re-exports what the rest
 * of the appservice and the tests use, from the files that hold each concern:
 *
 *   outbound-state     what a caller passes in, one attachment's state, the attachment and
 *                      trigger maps, the timing constants, detaching
 *   outbound-payloads  reading chunks, permission requests and errors off an event
 *   outbound-send      a message into the room, and an edit of one
 *   outbound-streams   the reader's live view (answer, reasoning, tool calls) and the fleet
 *   outbound-flush     the turn's record and its text, as a message or an edit
 *   outbound-marks     typing, the mark on the message, the error notice
 *   outbound-handle    what each session event does to the room
 */

import type { AcpEvent } from "@agentpod/contract";
import { subscribe as subscribeToSession } from "../acp";
import { handleEvent } from "./outbound-handle";
import { log } from "./outbound-log";
import { isRecord } from "./outbound-payloads";
import {
  attached,
  EVENT_ORDER_WAIT_MS,
  FLUSH_SAFETY_MS,
  newAttachment,
  takeTrigger,
  TYPING_REFRESH_MS,
  type OutboundDeps,
  type RoomContext,
} from "./outbound-state";

export {
  _attachedCountForTest,
  detachRoom,
  EVENT_ORDER_WAIT_MS,
  FLUSH_SAFETY_MS,
  forgetTurnTrigger,
  noteTurnTrigger,
  TYPING_REFRESH_MS,
} from "./outbound-state";
export type { OutboundDeps } from "./outbound-state";

export function attachRoomToSession(
  sessionId: string,
  roomId: string,
  agentUser: string,
  deps: OutboundDeps
): void {
  if (attached.has(sessionId)) return;

  const subscribe = deps.subscribe ?? subscribeToSession;
  const eventOrderWaitMs = deps.eventOrderWaitMs ?? EVENT_ORDER_WAIT_MS;
  const state = newAttachment(roomId, agentUser);
  const ctx: RoomContext = {
    sessionId,
    roomId,
    agentUser,
    deps,
    state,
    flushDelayMs: deps.flushDelayMs ?? FLUSH_SAFETY_MS,
    typingRefreshMs: deps.typingRefreshMs ?? TYPING_REFRESH_MS,
    fleetContext: null,
  };

  state.unsubscribe = subscribe(sessionId, (event: AcpEvent) => {
    if (state.ended) return;

    // A `working` takes the trigger noted for it now, as it is fanned out,
    // rather than when its place in the chain below comes up: by then the
    // next prompt may have been noted, and this turn would take that one's.
    const noted =
      event.type === "state" && isRecord(event.payload) && event.payload.status === "working"
        ? takeTrigger(sessionId)
        : undefined;

    const previous = state.chain;
    state.chain = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = await Promise.race([
        previous.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), eventOrderWaitMs);
        }),
      ]);
      clearTimeout(timer);
      if (late) {
        log.warn("a room's previous event is still being handled; handling the next one anyway", {
          sessionId,
          roomId,
          type: event.type,
          waitedMs: eventOrderWaitMs,
        });
      }
      await handleEvent(ctx, event, noted);
    })().catch((err) => {
      log.error("could not handle a session event for its room", {
        sessionId,
        roomId,
        type: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  attached.set(sessionId, state);
}
