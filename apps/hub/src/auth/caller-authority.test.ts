process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser } from "../../tests/helpers/database";
import { rawSql } from "../db/drizzle";
import { setOrgPlaneForTests, TEST_PLANE } from "./org-plane/config";
import { createPrincipalDirectory, setPrincipalDirectoryForTests, type PrincipalDirectory } from "../services/org-plane/directory";
import { OrgPlaneError } from "../services/org-plane/client";
import { createPrincipal } from "../services/principals";
import { setGrant } from "../services/grants";
import {
  authorityFromClaims,
  callerGrant,
  callerPrincipal,
  OrgPlaneUnavailable,
  orgPlaneOutageBody,
  type TokenAuthority,
} from "./caller-authority";

/** A plane that is down with nothing cached: every read throws, and counts. */
function downPlane() {
  const reads: string[] = [];
  const fail = async (what: string): Promise<never> => {
    reads.push(what);
    throw new OrgPlaneError(0, "unreachable");
  };
  const dir: PrincipalDirectory = {
    principal: (id) => fail(`principal:${id}`),
    identity: (s, e) => fail(`identity:${s}:${e}`),
    identitiesOf: (id, s) => fail(`identitiesOf:${id}:${s}`),
    list: () => fail("list"),
    invalidate: () => {},
  };
  return { dir, reads };
}

const ME = "prn_cccccccccccccccccccc";
const AGENT = "prn_dddddddddddddddddddd";
const AUTH: TokenAuthority = { principalKind: "human", mayDispatch: [AGENT], mayGrantReach: true, scopes: [] };

const restores: Array<() => void> = [];
afterEach(() => restores.splice(0).reverse().forEach((r) => r()));

describe("authorityFromClaims", () => {
  test("a human's `scope` is an OAuth scope string and never a grant (contract §2)", () => {
    const a = authorityFromClaims({
      principalKind: "human", mayDispatch: [AGENT], mayGrantReach: false, scope: "openid evidence:read",
    } as never);
    expect(a).toEqual({ principalKind: "human", mayDispatch: [AGENT], mayGrantReach: false, scopes: [] });
  });

  test("an agent's or a service's `scope` is its grant's scopes", () => {
    expect(authorityFromClaims({ principalKind: "service", mayDispatch: [], mayGrantReach: false, scope: "evidence:read runs:write" } as never).scopes)
      .toEqual(["evidence:read", "runs:write"]);
  });
});

describe("under the plane, with the plane unreachable and nothing cached", () => {
  test("the caller's principal and grant come from their token, and the plane is never read", async () => {
    const { dir, reads } = downPlane();
    restores.push(setOrgPlaneForTests(TEST_PLANE), setPrincipalDirectoryForTests(dir));
    const caller = { id: ME, authority: AUTH };
    expect(await callerPrincipal(caller)).toEqual({ id: ME, kind: "human" });
    expect(await callerGrant(caller, ME)).toEqual({ mayDispatch: [AGENT], mayGrantReach: true, scopes: [] });
    expect(reads).toEqual([]);
  });

  test("a caller with no token authority fails closed as OrgPlaneUnavailable (503), not a bare OrgPlaneError", async () => {
    const { dir } = downPlane();
    restores.push(setOrgPlaneForTests(TEST_PLANE), setPrincipalDirectoryForTests(dir));
    const p = callerPrincipal(ME);
    await expect(p).rejects.toBeInstanceOf(OrgPlaneUnavailable);
    await p.catch((e: OrgPlaneUnavailable) => expect(e.status).toBe(503));
    await expect(callerGrant(ME, ME)).rejects.toBeInstanceOf(OrgPlaneUnavailable);
  });

  test("another principal's grant is not answered from the caller's token", async () => {
    const { dir, reads } = downPlane();
    restores.push(setOrgPlaneForTests(TEST_PLANE), setPrincipalDirectoryForTests(dir));
    await expect(callerGrant({ id: ME, authority: AUTH }, AGENT)).rejects.toBeInstanceOf(OrgPlaneUnavailable);
    expect(reads).toEqual([`principal:${AGENT}`]);
  });
});

describe("under the plane, after a long outage (security review finding 7c)", () => {
  test("a dispatch-path grant read serves the last good grant for 15 minutes, then fails closed as org_plane_unavailable", async () => {
    let now = 1_900_000_000_000;
    let down = false;
    const grant = { mayDispatch: [ME], mayGrantReach: false, scopes: [] };
    const dir = createPrincipalDirectory({
      now: () => now,
      client: () => ({
        getPrincipal: async (id: string) => {
          if (down) throw new OrgPlaneError(0, "unreachable");
          return { id, kind: "agent" as const, handle: "a", displayName: "A", organizationId: "org_00000000000000000000", suspended: false, grant };
        },
        lookupIdentity: async () => null,
        identitiesOf: async () => null,
        listPrincipals: async () => [],
      }),
    });
    restores.push(setOrgPlaneForTests(TEST_PLANE), setPrincipalDirectoryForTests(dir));
    const caller = { id: ME, authority: AUTH };
    expect(await callerGrant(caller, AGENT)).toEqual(grant);
    down = true;
    now += 10 * 60_000;
    expect(await callerGrant(caller, AGENT)).toEqual(grant); // inside the cap: the outage is ridden out
    now += 6 * 60_000;
    const err = await callerGrant(caller, AGENT).catch((e) => e);
    expect(err).toBeInstanceOf(OrgPlaneUnavailable);
    expect(orgPlaneOutageBody(err)?.error).toBe("org_plane_unavailable");
  });
});

describe("legacy mode is principalForUser and getGrant, unchanged", () => {
  const USER = "test-user-caller-authority";
  let PRN: string;
  beforeAll(async () => {
    await ensurePgMigrations();
    await createTestUser({ id: USER, email: "caller-authority@example.com", name: "CA" });
    PRN = await createPrincipal({ kind: "human", handle: "caller-authority-it", userId: USER });
    await setGrant(PRN, { mayDispatch: [AGENT], mayGrantReach: false, scopes: [] });
  });
  afterAll(async () => {
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${PRN}`;
    await rawSql`DELETE FROM principal_identities WHERE external_id = ${USER}`;
    await rawSql`DELETE FROM principals WHERE handle = 'caller-authority-it'`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  });

  test("an authority on the caller is ignored: the hub's own tables answer", async () => {
    // Never set in legacy mode by the middleware; if one were, it must not count.
    const caller = { id: USER, authority: { ...AUTH, mayGrantReach: true, mayDispatch: ["prn_eeeeeeeeeeeeeeeeeeee"] } };
    expect((await callerPrincipal(caller))?.id).toBe(PRN);
    expect(await callerGrant(caller, PRN)).toEqual({ mayDispatch: [AGENT], mayGrantReach: false, scopes: [] });
    expect(await callerPrincipal("nobody-at-all")).toBeNull();
  });
});

describe("orgPlaneOutageBody — the app's error handler answers a plane outage with 503", () => {
  test("for OrgPlaneUnavailable, and for a bare OrgPlaneError from a non-authorization read", () => {
    const e = new OrgPlaneError(0, "unreachable");
    expect(orgPlaneOutageBody(new OrgPlaneUnavailable(e))?.error).toBe("org_plane_unavailable");
    expect(orgPlaneOutageBody(e)?.error).toBe("org_plane_unavailable");
  });

  test("and for nothing else", () => {
    expect(orgPlaneOutageBody(new Error("boom"))).toBeNull();
  });
});
