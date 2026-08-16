/**
 * Names for rooms where several agents work together.
 *
 * A per-agent room is a DM, and its name is derived from the node and station it
 * belongs to. A mission is the other shape: several stations and several people
 * in one place, named by a person rather than by the fleet.
 *
 * The cleaning rules are the same as `names.ts` and for the same reason — `_`
 * never survives, so it stays available as a separator between the kind prefix
 * and the name.
 */

/**
 * Narrower than `names.ts`: `/` is replaced here too.
 *
 * A station key is machine-shaped and never contains one. A mission name is free
 * text somebody types, where `/` is ordinary — and an alias containing it is
 * legal but has to be escaped in every URL that carries it, for no benefit.
 */
const ILLEGAL = /[^a-z0-9.=-]/g;

/**
 * A person's words, made addressable.
 *
 * Two names that clean to the same localpart are the same mission. That is not
 * a collision to defend against: a mission is named by a person, and somebody
 * typing "Q3 migration" and "Q3/migration" means one room both times. The unique
 * index on `alias` is what enforces it.
 */
export function missionLocalpart(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(ILLEGAL, "-")
    // Collapse runs and trim edges, so "Q3   migration!" is not
    // "q3---migration-".
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  // A room still needs an address. A name made entirely of punctuation would
  // otherwise produce `#agentpod_mission_:domain`.
  return cleaned || "mission";
}

/** `#agentpod_mission_<name>` — an ordinary room, inside the reserved namespace. */
export function missionAlias(name: string, domain: string): string {
  return `#agentpod_mission_${missionLocalpart(name)}:${domain}`;
}

/** `#agentpod_space_<name>` — the space that groups missions. */
export function spaceAlias(name: string, domain: string): string {
  return `#agentpod_space_${missionLocalpart(name)}:${domain}`;
}
