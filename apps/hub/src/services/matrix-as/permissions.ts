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

export interface PermissionOption {
  optionId: string;
  name: string;
}

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
  pending.delete(roomId);
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

/**
 * The option a reply selects, or null when it selects none.
 *
 * Accepts the position in the list, the option's name, or its id — the three
 * things a reply can unambiguously be. Everything else is null, including
 * anything that merely resembles agreement.
 */
export function matchPermissionAnswer(
  reply: string,
  options: PermissionOption[]
): string | null {
  const text = reply.trim().toLowerCase();
  if (text === "") return null;

  // A bare number, 1-based, as printed.
  if (/^\d+$/.test(text)) {
    const index = Number(text) - 1;
    return options[index]?.optionId ?? null;
  }

  const byName = options.find((o) => o.name.trim().toLowerCase() === text);
  if (byName) return byName.optionId;

  const byId = options.find((o) => o.optionId.trim().toLowerCase() === text);
  return byId?.optionId ?? null;
}

/** What to say when a reply matched nothing — the options again, not a scolding. */
export function unmatchedAnswerText(options: PermissionOption[]): string {
  const names = options.map((o, i) => `${i + 1}. ${o.name}`).join("\n");
  return [
    "That is not one of the options, so nothing has been approved.",
    "",
    names,
    "",
    "Reply with the number, or the option's name.",
  ].join("\n");
}
