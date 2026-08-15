import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import {
  getGrant,
  setGrant,
  deleteGrant,
  listGrants,
  grantAllowsStation,
  patternMatchesStation,
  NO_GRANT,
} from "../../src/services/grants";

/**
 * Grants as data — the source of authority replacing `CONTROL_PAIR_GRANTS`.
 *
 * The env var was the interim the 2026-08-13 decision blessed: static
 * configuration **in the shape of the eventual claim**, so that this change
 * would be a data move rather than a redesign. These assert the shape survived
 * the move, and that the dangerous readings are all refused.
 */

const ALICE = "test-user-grants-alice";
const BOB = "test-user-grants-bob";

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: ALICE, email: "grants-alice@example.com", name: "Alice" });
  await createTestUser({ id: BOB, email: "grants-bob@example.com", name: "Bob" });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM principal_grants WHERE principal_id IN (${ALICE}, ${BOB})`;
    await rawSql`DELETE FROM "user" WHERE id IN (${ALICE}, ${BOB})`;
  } catch {
    // cleanup only
  }
});

describe("the grant store", () => {
  test("a principal with no row has no grant, which is not an unrestricted one", async () => {
    expect(await getGrant(BOB)).toBeNull();
    expect(grantAllowsStation(null, "hermes:analyst-echo")).toBe(false);
    expect(grantAllowsStation(NO_GRANT, "hermes:analyst-echo")).toBe(false);
  });

  test("round-trips a grant unchanged", async () => {
    await setGrant(ALICE, {
      mayDispatch: ["agentpod:hermes:*", "kaambaan:agt_7abfe2d7b3c64880"],
      mayGrantReach: true,
    });

    const grant = await getGrant(ALICE);
    expect(grant).toEqual({
      mayDispatch: ["agentpod:hermes:*", "kaambaan:agt_7abfe2d7b3c64880"],
      mayGrantReach: true,
    });
  });

  test("updates in place rather than accumulating rows", async () => {
    // One principal, one grant. Two rows would be two answers to a question that
    // must have one, and "which row wins" is not a question an authorization
    // check should ever ask.
    await setGrant(ALICE, { mayDispatch: ["agentpod:hermes:analyst-echo"], mayGrantReach: false });

    const grant = await getGrant(ALICE);
    expect(grant!.mayDispatch).toEqual(["agentpod:hermes:analyst-echo"]);
    expect(grant!.mayGrantReach).toBe(false);

    const all = await listGrants();
    expect(all.filter((g) => g.principalId === ALICE)).toHaveLength(1);
  });

  test("refuses a grant missing half the pair", async () => {
    await expect(
      setGrant(BOB, { mayDispatch: ["agentpod:hermes:*"] } as never)
    ).rejects.toThrow(/both halves/i);
  });

  test("refuses a mayDispatch that is not an array of strings", async () => {
    await expect(
      setGrant(BOB, { mayDispatch: "agentpod:hermes:*" as never, mayGrantReach: false })
    ).rejects.toThrow(/array/i);
  });

  test("refuses to interpret a corrupt stored grant", async () => {
    // Neither "everything" nor "nothing": a corrupt grant is loud. Reading it
    // generously would be catastrophic and reading it as empty would be silent,
    // and silence is how a broken authorization control looks exactly like a
    // working one.
    await rawSql`
      INSERT INTO principal_grants (principal_id, may_dispatch, may_grant_reach)
      VALUES (${BOB}, '[1, 2, 3]', false)
      ON CONFLICT (principal_id) DO UPDATE SET may_dispatch = '[1, 2, 3]'`;

    await expect(getGrant(BOB)).rejects.toThrow(/malformed|array of strings/i);
    await deleteGrant(BOB);
  });

  test("deleting is idempotent", async () => {
    await deleteGrant(BOB);
    await deleteGrant(BOB);
    expect(await getGrant(BOB)).toBeNull();
  });
});

describe("a grant names a node and a station", () => {
  const on = (nodeName: string, stationKey: string) => ({ nodeName, stationKey });

  test("matches an exact node and station", () => {
    expect(patternMatchesStation("agentpod:molt-bot/hermes:analyst-echo", on("molt-bot", "hermes:analyst-echo"))).toBe(true);
    expect(patternMatchesStation("agentpod:molt-bot/hermes:analyst-echo", on("superchotu", "hermes:analyst-echo"))).toBe(false);
  });

  test("distinguishes the same station key on different nodes", () => {
    // The defect that produced this shape. `opencode:c52ddf65` exists on two
    // nodes in production; a grant for one must not authorise the other, which
    // is a different host with different credentials and a different workspace.
    const pattern = "agentpod:9247e5a88cfa/opencode:c52ddf65";
    expect(patternMatchesStation(pattern, on("9247e5a88cfa", "opencode:c52ddf65"))).toBe(true);
    expect(patternMatchesStation(pattern, on("cloudchamber", "opencode:c52ddf65"))).toBe(false);
  });

  test("a node wildcard means every node, said out loud", () => {
    // Fleet-wide permission is still expressible — it just has to be written
    // rather than obtained by accident, which is what the old two-part form gave.
    expect(patternMatchesStation("agentpod:*/hermes:*", on("molt-bot", "hermes:x"))).toBe(true);
    expect(patternMatchesStation("agentpod:*/hermes:*", on("superchotu", "hermes:y"))).toBe(true);
    expect(patternMatchesStation("agentpod:*/hermes:*", on("molt-bot", "openclaw:z"))).toBe(false);
  });

  test("a station wildcard is scoped to its node", () => {
    expect(patternMatchesStation("agentpod:molt-bot/hermes:*", on("molt-bot", "hermes:anything"))).toBe(true);
    expect(patternMatchesStation("agentpod:molt-bot/hermes:*", on("superchotu", "hermes:anything"))).toBe(false);
  });

  test("a station wildcard still does not cross the colon", () => {
    expect(patternMatchesStation("agentpod:molt-bot/hermes:*", on("molt-bot", "openclaw:x"))).toBe(false);
  });

  test("the retired two-part form matches nothing", () => {
    // `agentpod:hermes:*` cannot say which node it meant. Reading it as "any
    // node" is precisely the over-grant this shape removes, so it is refused
    // rather than generously interpreted.
    expect(patternMatchesStation("agentpod:hermes:*", on("molt-bot", "hermes:x"))).toBe(false);
    expect(patternMatchesStation("agentpod:hermes:analyst-echo", on("molt-bot", "hermes:analyst-echo"))).toBe(false);
  });

  test("ignores another plane's namespace rather than denying on it", () => {
    expect(patternMatchesStation("kaambaan:agt_x", on("molt-bot", "hermes:x"))).toBe(false);
    expect(patternMatchesStation("org-plane:agent:xyz", on("molt-bot", "hermes:x"))).toBe(false);
    expect(
      grantAllowsStation({ mayDispatch: ["kaambaan:agt_x"], mayGrantReach: false }, on("molt-bot", "hermes:x"))
    ).toBe(false);
  });

  test("an unnamespaced value matches nothing", () => {
    expect(patternMatchesStation("molt-bot/hermes:*", on("molt-bot", "hermes:x"))).toBe(false);
  });
});
