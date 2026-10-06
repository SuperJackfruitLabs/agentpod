process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser, deleteTestUser } from "../../tests/helpers/database";
import { setOrgPlaneForTests, TEST_PLANE } from "./org-plane/config";
import { setPrincipalDirectoryForTests, type PrincipalDirectory } from "../services/org-plane/directory";
import { OrgPlaneError } from "../services/org-plane/client";
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

describe("with the plane unreachable and nothing cached", () => {
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

describe("a caller with no token authority reads the directory", () => {
  const USER = "prn_caca0000000000000000";
  beforeAll(async () => {
    await ensurePgMigrations();
    await createTestUser({ id: USER, email: "caller-authority@example.com", name: "CA" });
    await setGrant(USER, { mayDispatch: [AGENT], mayGrantReach: false, scopes: [] });
  });
  afterAll(async () => {
    await deleteTestUser(USER);
  });

  test("the static API_TOKEN or a background path: principal and grant from the plane", async () => {
    expect(await callerPrincipal(USER)).toEqual(expect.objectContaining({ id: USER, kind: "human" }));
    expect(await callerGrant(USER, USER)).toEqual({ mayDispatch: [AGENT], mayGrantReach: false, scopes: [] });
    expect(await callerPrincipal("prn_0000000000000000dead")).toBeNull();
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
