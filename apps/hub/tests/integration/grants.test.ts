import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser, deleteTestUsers } from "../helpers/database";
import { getGrant, setGrant, grantAllowsPrincipal, NO_GRANT } from "../../src/services/grants";
import { createPrincipal, forgetPrincipals } from "../helpers/principals";
import { fakePlane } from "../helpers/fake-plane";

/**
 * Grants as data — the source of authority that replaced `CONTROL_PAIR_GRANTS`, now held by the
 * organization plane (contract §3.5; the hub's `principal_grants` was dropped in P3 Task 17).
 * `getGrant` reads it through the directory, `setGrant` writes it with `PUT …/grants`. These assert
 * the shape survived, and that the dangerous readings are all refused at the hub's writer.
 */

const ALICE = `prn_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
const BOB = `prn_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: ALICE, email: "grants-alice@example.com", name: "Alice" });
  await createTestUser({ id: BOB, email: "grants-bob@example.com", name: "Bob" });
});

afterAll(async () => {
  await forgetPrincipals({ handleLike: "scopes-%" });
  await deleteTestUsers([ALICE, BOB]);
});

describe("the grant store", () => {
  test("a principal with no grant has none, which is not an unrestricted one", async () => {
    expect(await getGrant(BOB)).toBeNull();
    expect(await getGrant("prn_0000000000000000dead")).toBeNull();
    expect(grantAllowsPrincipal(null, "prn_0123456789abcdef0123")).toBe(false);
    expect(grantAllowsPrincipal(NO_GRANT, "prn_0123456789abcdef0123")).toBe(false);
  });

  test("round-trips a grant unchanged", async () => {
    await setGrant(ALICE, {
      mayDispatch: ["prn_0123456789abcdef0123", "prn_ffffffffffffffffffff"],
      mayGrantReach: true,
    });

    expect(await getGrant(ALICE)).toEqual({
      mayDispatch: ["prn_0123456789abcdef0123", "prn_ffffffffffffffffffff"],
      mayGrantReach: true,
      scopes: [],
    });
  });

  test("a write replaces the grant: one principal, one answer", async () => {
    await setGrant(ALICE, { mayDispatch: ["prn_0123456789abcdef0123"], mayGrantReach: false });

    const grant = await getGrant(ALICE);
    expect(grant!.mayDispatch).toEqual(["prn_0123456789abcdef0123"]);
    expect(grant!.mayGrantReach).toBe(false);
  });

  test("refuses a grant missing half the pair, and sends nothing to the plane", async () => {
    const before = structuredClone(fakePlane.principals.get(BOB)!.grant);
    await expect(
      setGrant(BOB, { mayDispatch: ["prn_0123456789abcdef0123"] } as never)
    ).rejects.toThrow(/both halves/i);
    expect(fakePlane.principals.get(BOB)!.grant).toEqual(before);
  });

  test("refuses a mayDispatch that is not an array of strings", async () => {
    await expect(
      setGrant(BOB, { mayDispatch: "prn_0123456789abcdef0123" as never, mayGrantReach: false })
    ).rejects.toThrow(/array/i);
  });
});

// The matcher itself — equality, no patterns, no namespace — is pure logic
// with no database dependency, so its tests live beside it in
// `src/services/grants.test.ts` rather than here.

describe("scopes", () => {
  test("a grant stores scopes, and an update that does not mention them keeps them", async () => {
    const id = await createPrincipal({ kind: "service", handle: `scopes-it-${crypto.randomUUID().slice(0, 8)}` });
    await setGrant(id, { mayDispatch: [], mayGrantReach: false, scopes: ["evidence:read"] });
    expect((await getGrant(id))!.scopes).toEqual(["evidence:read"]);

    // A caller that speaks only the control pair. Absent is not empty: the plane's PUT replaces,
    // so the hub carries the current scopes over.
    await setGrant(id, { mayDispatch: [], mayGrantReach: true });
    expect(await getGrant(id)).toEqual({ mayDispatch: [], mayGrantReach: true, scopes: ["evidence:read"] });

    await setGrant(id, { mayDispatch: [], mayGrantReach: true, scopes: [] });
    expect((await getGrant(id))!.scopes).toEqual([]);
  });

  test("an unknown scope is refused at the writer", async () => {
    const id = await createPrincipal({ kind: "service", handle: `scopes-bad-${crypto.randomUUID().slice(0, 8)}` });
    await expect(setGrant(id, { mayDispatch: [], mayGrantReach: false, scopes: ["evidence:write"] })).rejects.toThrow(
      /unknown scope/,
    );
  });

  test("runs:write is a scope a grant may hold, alone or beside evidence:read", async () => {
    const id = await createPrincipal({ kind: "service", handle: `scopes-it-${crypto.randomUUID().slice(0, 8)}` });
    await setGrant(id, { mayDispatch: [], mayGrantReach: false, scopes: ["runs:write"] });
    expect((await getGrant(id))!.scopes).toEqual(["runs:write"]);
    await setGrant(id, { mayDispatch: [], mayGrantReach: false, scopes: ["evidence:read", "runs:write"] });
    expect((await getGrant(id))!.scopes).toEqual(["evidence:read", "runs:write"]);
  });

  test("a repeated scope is written once", async () => {
    const id = await createPrincipal({ kind: "service", handle: `scopes-it-${crypto.randomUUID().slice(0, 8)}` });
    await setGrant(id, { mayDispatch: [], mayGrantReach: false, scopes: ["evidence:read", "evidence:read"] });
    expect((await getGrant(id))!.scopes).toEqual(["evidence:read"]);
  });
});
