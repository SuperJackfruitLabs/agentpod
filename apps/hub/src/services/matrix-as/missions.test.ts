import { describe, expect, test } from "bun:test";
import { missionAlias, missionLocalpart } from "./missions";

/**
 * Names for rooms where several agents work together.
 *
 * A mission is not an agent, so its name is not derived from a node and a
 * station — it is a thing a person names, and the same cleaning rules apply for
 * the same reason: `_` never survives, so it stays available as a separator.
 */

const D = "id.agentpod.dev";

describe("mission names", () => {
  test("land inside the alias namespace the homeserver reserved", () => {
    // Same exclusive namespace as agent rooms: a name outside it cannot be
    // created by the appservice at all.
    expect(missionAlias("Q3 migration", D)).toBe("#agentpod_mission_q3-migration:id.agentpod.dev");
  });


  test("two missions that clean to the same name are the same mission", () => {
    // Not a collision to guard against — a mission is named by a person, and
    // "Q3 migration" and "Q3/migration" being one room is the honest reading of
    // somebody typing the same name twice. The unique index on alias enforces it.
    expect(missionLocalpart("Q3 migration")).toBe(missionLocalpart("Q3/migration"));
  });

  test("keeps a name a person can still read", () => {
    expect(missionLocalpart("Rescue the Friday deploy")).toBe("rescue-the-friday-deploy");
  });

  test("survives a name made entirely of punctuation", () => {
    // A room still needs an address. Falling back beats creating `#agentpod_mission_:`.
    expect(missionLocalpart("!!!")).toMatch(/^[a-z0-9-]+$/);
  });
});
