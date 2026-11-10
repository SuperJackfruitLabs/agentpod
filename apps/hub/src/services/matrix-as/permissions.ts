/**
 * Approving an agent's action from the room it asked in.
 *
 * The bridge used to post "Permission needed: … Answer in the console; this
 * room cannot yet." — which is the whole product with the last step missing.
 * An agent that asks for permission and can only be answered somewhere else
 * has not moved the decision to where the operator is; it has added a
 * notification.
 *
 * Two pieces live here, and both are pure so they can be tested without a
 * homeserver: what the question looks like when it arrives in a room, and how
 * a reply is matched back to one of the options. The state — which room is
 * waiting on which request — is a map, because a room can hold at most one
 * pending question at a time (the session parks until it is answered).
 *
 * **Nothing is guessed.** A reply that is not plainly one of the options is
 * refused with the list again, rather than resolved to the nearest-looking
 * one. Approving a tool call the operator did not mean to approve is the one
 * failure this must never have, and "yes" against options named *Allow once*
 * and *Allow always* is exactly the ambiguity that would cause it.
 */

import { matchPermissionAnswer, unmatchedAnswerText } from "../board-chat";
import type { PermissionOption } from "../board-chat";
import { clearFleetDecision, permissionDecisionKey } from "../push";

// Matching a reply to a numbered option is shared with board questions, so it lives in
// board-chat; it is re-exported here for the permission path that already imports it.
export { matchPermissionAnswer, unmatchedAnswerText };
export type { PermissionOption };


export interface PendingPermission {
  sessionId: string;
  /** The seq of the `permission-request` event, which is how the answer is addressed. */
  requestSeq: number;
  options: PermissionOption[];
}

/** Keyed by room: the operator answers where the question was asked. */
const pending = new Map<string, PendingPermission>();

export function notePendingPermission(roomId: string, permission: PendingPermission): void {
  pending.set(roomId, permission);
}

export function pendingPermissionFor(roomId: string): PendingPermission | undefined {
  return pending.get(roomId);
}

export function clearPendingPermission(roomId: string): void {
  // The fleet Live Activity shows the pending question on the Lock Screen; it
  // goes the moment the question stops standing, however it was settled.
  if (pending.delete(roomId)) clearFleetDecision(permissionDecisionKey(roomId));
}

/** Leak detection, mirroring `_attachedCountForTest` in `outbound.ts`. */
export function _pendingCountForTest(): number {
  return pending.size;
}

/**
 * The question, as it arrives in the room.
 *
 * Numbered, because a number is the shortest thing a person can type on a
 * phone and the only answer that cannot be misspelled. The names are shown
 * too — the operator is approving an action, and "1" alone would make the
 * transcript unreadable afterwards.
 */
export function permissionPrompt(title: string, options: PermissionOption[]): string {
  if (options.length === 0) {
    // Nothing to choose between. Say so rather than posting an empty list and
    // waiting for an answer that cannot exist.
    return `Permission needed: ${title}. There are no options to choose from — answer in the console.`;
  }

  const lines = options.map((option, index) => `${index + 1}. ${option.name}`);
  return [
    `Permission needed: ${title}`,
    "",
    ...lines,
    "",
    "Reply with the number, or the option's name.",
  ].join("\n");
}
