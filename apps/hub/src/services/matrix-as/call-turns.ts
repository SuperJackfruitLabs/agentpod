/**
 * Spoken turns: which ACP turn each superdial `turn_id` became.
 *
 * A message marked `dev.superdial.spoken` (C3) carries the `turn_id` superdial-agent gave what it
 * heard. When the hub prompts the room's session with it, the id is noted against that session
 * here, so a cancel from superdial-agent (C6) can find the turn to stop, and the turn's end knows
 * whether it was cancelled.
 *
 * In memory, like the turn triggers in `outbound-state.ts`: a restart ends every turn anyway
 * (boot reconciliation ends live sessions), and a cancel for a turn the hub no longer knows stops
 * nothing, which is the truth.
 */

import { SPOKEN_KEY, SPOKEN_PROMPT_PREFIX } from "./call-config";
import { isRecord } from "./outbound-payloads";

/**
 * treaty's `turn_id` (C2, C3): a UUIDv4 in lower case. The id keys the hub's turn map and is a path
 * segment at superdial-agent, so nothing else is taken.
 */
const TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The spoken turn a message carries (C3), or null for an ordinary message.
 *
 * Only an `m.text` whose marker names THIS room's agent and carries a `turn_id` in the contract's
 * shape. A marker naming another agent, or malformed, makes the message an ordinary typed one: its
 * reply goes to the room alone, never to a call it was not asked for.
 */
export function spokenTurn(content: Record<string, unknown> | undefined, agentUserId: string): { turnId: string } | null {
  if (!content || content.msgtype !== "m.text") return null;
  const marker = content[SPOKEN_KEY];
  if (!isRecord(marker)) return null;
  const { turn_id: turnId, agent_user_id: agent } = marker;
  if (typeof turnId !== "string" || !TURN_ID.test(turnId) || agent !== agentUserId) return null;
  return { turnId };
}

/** What the agent reads for a spoken turn: the contract's prefix, then the words. */
export function spokenPrompt(text: string): string {
  return `${SPOKEN_PROMPT_PREFIX} ${text.trim()}`;
}

/**
 * Per room, turn_id → the session it was prompted into. A turn id is its room's: the id comes
 * from a message anybody in the room can write, so the same id in another room is another turn
 * and must not overwrite, cancel or forget this one.
 */
const sessions = new Map<string, Map<string, string>>();
/** Per room, the turn_ids superdial-agent cancelled while they ran. */
const cancelled = new Map<string, Set<string>>();

/** Note that these spoken turns were prompted into this session (several when merged). */
export function noteCallTurns(roomId: string, sessionId: string, turnIds: readonly string[]): void {
  let room = sessions.get(roomId);
  if (!room) {
    room = new Map();
    sessions.set(roomId, room);
  }
  for (const turnId of turnIds) room.set(turnId, sessionId);
}

/** The session a room's spoken turn was prompted into, or undefined for one the hub does not know. */
export function callTurnSession(roomId: string, turnId: string): string | undefined {
  return sessions.get(roomId)?.get(turnId);
}

export function markCallTurnCancelled(roomId: string, turnId: string): void {
  if (!sessions.get(roomId)?.has(turnId)) return;
  let room = cancelled.get(roomId);
  if (!room) {
    room = new Set();
    cancelled.set(roomId, room);
  }
  room.add(turnId);
}

/**
 * Whether the caller cancelled any of these turns (C6 cancel, at hang-up). Merged turns share one
 * call, so one cancelled means the call they were spoken in has gone.
 */
export function callTurnsCancelled(roomId: string, turnIds: readonly string[]): boolean {
  const room = cancelled.get(roomId);
  return room !== undefined && turnIds.some((turnId) => room.has(turnId));
}

/** How a spoken turn ended, for its reply: a cancel wins over an error, an error over ok. */
export function callTurnOutcome(roomId: string, turnId: string, errored: boolean): "ok" | "cancelled" | "error" {
  if (cancelled.get(roomId)?.has(turnId)) return "cancelled";
  return errored ? "error" : "ok";
}

/** The turns are over and answered, or never ran: nothing more will be asked of them. */
export function forgetCallTurns(roomId: string, turnIds: readonly string[]): void {
  const room = sessions.get(roomId);
  const roomCancelled = cancelled.get(roomId);
  for (const turnId of turnIds) {
    room?.delete(turnId);
    roomCancelled?.delete(turnId);
  }
  if (room?.size === 0) sessions.delete(roomId);
  if (roomCancelled?.size === 0) cancelled.delete(roomId);
}

export function resetCallTurnsForTest(): void {
  sessions.clear();
  cancelled.clear();
}
