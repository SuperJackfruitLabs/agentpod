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

describe("namespaced matching", () => {
  test("matches this plane's namespace exactly", () => {
    expect(patternMatchesStation("agentpod:hermes:analyst-echo", "hermes:analyst-echo")).toBe(true);
    expect(patternMatchesStation("agentpod:hermes:analyst-echo", "hermes:coder-kai")).toBe(false);
  });

  test("a trailing wildcard does not cross the separator", () => {
    expect(patternMatchesStation("agentpod:hermes:*", "hermes:anything")).toBe(true);
    expect(patternMatchesStation("agentpod:hermes:*", "openclaw:anything")).toBe(false);
  });

  test("ignores another plane's namespace rather than denying on it", () => {
    // The rule from the decision. A plane that refused values it did not
    // understand would break the day a third plane appeared — and a claim is
    // read by MORE planes over time, not fewer.
    expect(patternMatchesStation("kaambaan:agt_7abfe2d7b3c64880", "hermes:analyst-echo")).toBe(false);
    expect(patternMatchesStation("org-plane:agent:xyz", "hermes:analyst-echo")).toBe(false);

    // And a grant holding only other planes' values permits nothing here, while
    // still being a perfectly valid grant over there.
    expect(
      grantAllowsStation({ mayDispatch: ["kaambaan:agt_x"], mayGrantReach: false }, "hermes:analyst-echo")
    ).toBe(false);
  });

  test("an unnamespaced value matches nothing", () => {
    // The old `CONTROL_PAIR_GRANTS` format. It must not silently keep working
    // against the new store, or a half-migrated deployment would enforce two
    // different rules depending on which reader ran.
    expect(patternMatchesStation("hermes:analyst-echo", "hermes:analyst-echo")).toBe(false);
    expect(patternMatchesStation("hermes:*", "hermes:analyst-echo")).toBe(false);
  });
});
