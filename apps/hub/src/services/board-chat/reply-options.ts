/**
 * Matching a chat reply to one of a numbered list of options.
 *
 * Shared by board questions (here) and an agent's permission prompts (services/matrix-as),
 * which number their options the same way. Pure, so it is tested without a homeserver.
 *
 * **Nothing is guessed.** A reply that is not plainly one of the options is refused with the
 * list again, rather than resolved to the nearest-looking one: "yes" against options named
 * *Allow once* and *Allow always* is exactly the ambiguity that would approve the wrong thing.
 */

/** One numbered option a reply can pick. */
export interface PermissionOption {
  optionId: string;
  name: string;
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
