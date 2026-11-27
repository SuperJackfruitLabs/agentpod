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
 * The spoken turn a message carries (C3), or null for an ordinary message.
 *
 * Only an `m.text` whose marker names THIS room's agent and carries a non-empty `turn_id`. A
 * marker naming another agent, or malformed, makes the message an ordinary typed one: its reply
 * goes to the room alone, never to a call it was not asked for.
 */
export function spokenTurn(content: Record<string, unknown> | undefined, agentUserId: string): { turnId: string } | null {
  if (!content || content.msgtype !== "m.text") return null;
  const marker = content[SPOKEN_KEY];
  if (!isRecord(marker)) return null;
  const { turn_id: turnId, agent_user_id: agent } = marker;
  if (typeof turnId !== "string" || turnId === "" || agent !== agentUserId) return null;
  return { turnId };
}

/** What the agent reads for a spoken turn: the contract's prefix, then the words. */
export function spokenPrompt(text: string): string {
  return `${SPOKEN_PROMPT_PREFIX} ${text.trim()}`;
}

/** turn_id → the session it was prompted into. */
const sessions = new Map<string, string>();
/** turn_ids superdial-agent cancelled while they ran. */
const cancelled = new Set<string>();

/** Note that these spoken turns were prompted into this session (several when merged). */
export function noteCallTurns(sessionId: string, turnIds: readonly string[]): void {
  for (const turnId of turnIds) sessions.set(turnId, sessionId);
}

/** The session a spoken turn was prompted into, or undefined for one the hub does not know. */
export function callTurnSession(turnId: string): string | undefined {
  return sessions.get(turnId);
}

export function markCallTurnCancelled(turnId: string): void {
  if (sessions.has(turnId)) cancelled.add(turnId);
}

/**
 * Whether the caller cancelled any of these turns (C6 cancel, at hang-up). Merged turns share one
 * call, so one cancelled means the call they were spoken in has gone.
 */
export function callTurnsCancelled(turnIds: readonly string[]): boolean {
  return turnIds.some((turnId) => cancelled.has(turnId));
}

/** How a spoken turn ended, for its reply: a cancel wins over an error, an error over ok. */
export function callTurnOutcome(turnId: string, errored: boolean): "ok" | "cancelled" | "error" {
  if (cancelled.has(turnId)) return "cancelled";
  return errored ? "error" : "ok";
}

/** The turns are over and answered: nothing more will be asked of them. */
export function forgetCallTurns(turnIds: readonly string[]): void {
  for (const turnId of turnIds) {
    sessions.delete(turnId);
    cancelled.delete(turnId);
  }
}

export function resetCallTurnsForTest(): void {
  sessions.clear();
  cancelled.clear();
}
