/**
 * What an agent is FOR, as the console handles it.
 *
 * The fleet is laid out by use case — personal agents on one node, work agents
 * on another, the rest ad hoc — and until this field existed that fact lived
 * only in the operator's head and, by coincidence, in the node names. The
 * coincidence is already scheduled to break: coming use cases span harnesses
 * and runtimes, and one node will host more than one of them.
 *
 * Setting a purpose files the agent's Matrix room under that purpose's space,
 * which is what keeps a roster of a hundred agents readable. The rules that
 * decide what gets sent are here rather than in the component, because they are
 * the part worth testing without a DOM.
 */

/** The longest a purpose may be — matched to the hub's own bound. */
export const PURPOSE_MAX = 64;

/**
 * What to send for what was typed.
 *
 * Trimmed, and an empty box means **no purpose** rather than a purpose that is
 * the empty string: unlabelled is a real state with its own meaning (filed
 * under no space, still visible in All rooms), so clearing the field has to
 * reach it rather than land somewhere in between.
 */
export function normalisePurpose(input: string): string | null {
  const trimmed = input.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Whether saving would change anything.
 *
 * Guards the button so a click that would be a no-op is not offered — and,
 * more usefully, so the "Saved" flash means something happened.
 */
export function purposeChanged(input: string, current: string | null): boolean {
  return normalisePurpose(input) !== current;
}

/** Why this cannot be saved, or null when it can. */
export function purposeProblem(input: string): string | null {
  if (input.trim().length > PURPOSE_MAX) {
    return `Keep it under ${PURPOSE_MAX} characters.`;
  }
  return null;
}

/**
 * What a node's purpose does to the agents already on it, said before it
 * happens.
 *
 * Setting a node's purpose labels the stations on it that have none — a real
 * write to rows the operator did not name, so it is worth saying out loud
 * rather than reporting afterwards. `unlabelled` is how many of those there
 * are.
 */
export function nodePurposeConsequence(unlabelled: number): string {
  if (unlabelled === 0) {
    return "Only future agents adopted here. Every agent on this node already has its own purpose.";
  }
  if (unlabelled === 1) {
    return "Also labels the 1 agent here that has no purpose of its own.";
  }
  return `Also labels the ${unlabelled} agents here that have no purpose of their own.`;
}
