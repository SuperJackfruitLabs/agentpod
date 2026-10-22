process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser, deleteTestUsers } from "../helpers/database";
import { fakePlane, signPlaneToken, TEST_ORG } from "../helpers/fake-plane";
import { authMiddleware } from "../../src/auth/middleware";
import { adminRouter } from "../../src/routes/admin";
import { meRoutes } from "../../src/routes/me";
import { TEST_PLANE } from "../../src/auth/org-plane/config";
import type { OrgPlaneClient } from "../../src/services/org-plane/client";
import {
  credentialOrg,
  hubHomeOrg,
  HubHomeOrgConfigError,
  HubHomeOrgMismatchError,
  learnHubHomeOrg,
  parseHubHomeOrg,
  setHubHomeOrgForTests,
} from "../../src/services/hub-home-org";
import { collectConfigErrors } from "../../src/utils/validate-config";
import { config } from "../../src/config";

/**
 * Workspace authority, W2/W3 as superseded 2026-10-22: owners and admins of the workspace that
 * owns the hub's service credential are hub operators; `hub_operators` stays an optional extra list.
 */

const OTHER_ORG = "org_33333333333333333333";
const RUN = crypto.randomUUID().slice(0, 8);
let PERSON: string; // no seat
let SEATED: string; // seat in hub_operators, member of another org

const app = new Hono().use("/api/*", authMiddleware).route("/api/admin", adminRouter).route("/api", meRoutes);

async function settings(sub: string, claims: Record<string, unknown>) {
  const headers = { Authorization: `Bearer ${await signPlaneToken({ sub, ...claims })}` };
  const s = await app.request("/api/admin/settings", { headers });
  const me = (await (await app.request("/api/me", { headers })).json()) as { isHubOperator: boolean };
  return { status: s.status, isHubOperator: me.isHubOperator };
}

let restore: () => void = () => {};
beforeAll(async () => {
  await ensurePgMigrations();
  PERSON = (await createTestUser({ email: `hho-p-${RUN}@example.com` })).id;
  SEATED = (await createTestUser({ email: `hho-s-${RUN}@example.com`, role: "admin" })).id;
});
afterEach(() => restore());
afterAll(async () => {
  await deleteTestUsers([PERSON, SEATED]);
});

describe("derived hub operators", () => {
  test("an owner of the hub's home workspace reaches the hub settings", async () => {
    restore = setHubHomeOrgForTests(TEST_ORG);
    expect(await settings(PERSON, { org: TEST_ORG, orgRole: "owner" })).toEqual({ status: 200, isHubOperator: true });
  });

  test("an admin of the home workspace is an operator", async () => {
    restore = setHubHomeOrgForTests(TEST_ORG);
    expect(await settings(PERSON, { org: TEST_ORG, orgRole: "admin" })).toEqual({ status: 200, isHubOperator: true });
  });

  test("a member of the home workspace is not", async () => {
    restore = setHubHomeOrgForTests(TEST_ORG);
    expect(await settings(PERSON, { org: TEST_ORG, orgRole: "member" })).toEqual({ status: 403, isHubOperator: false });
  });

  test("an owner of another workspace is not (W2 holds)", async () => {
    restore = setHubHomeOrgForTests(TEST_ORG);
    expect(await settings(PERSON, { org: OTHER_ORG, orgRole: "owner" })).toEqual({ status: 403, isHubOperator: false });
  });

  test("a seated principal outside the home workspace is an operator", async () => {
    restore = setHubHomeOrgForTests(TEST_ORG);
    expect(await settings(SEATED, { org: OTHER_ORG, orgRole: "member" })).toEqual({ status: 200, isHubOperator: true });
  });

  test("home workspace unknown: nobody is derived (fail closed)", async () => {
    restore = setHubHomeOrgForTests(null);
    expect(await settings(PERSON, { org: TEST_ORG, orgRole: "owner" })).toEqual({ status: 403, isHubOperator: false });
  });
});

const planeWith = (org: string | null, down = false): OrgPlaneClient =>
  ({
    ...fakePlane,
    async serviceToken(aud: string | string[]) {
      if (down) throw new Error("plane unreachable");
      return { accessToken: await signPlaneToken({ sub: "prn_0000000000000000c0b1", principalKind: "service", aud, ...(org ? { org } : { org: undefined }) }), expiresIn: 300 };
    },
  }) as OrgPlaneClient;

describe("learning the home workspace", () => {
  test("the org of the credential's service token", async () => {
    expect(await credentialOrg(fakePlane, TEST_PLANE.audience)).toBe(TEST_ORG);
    restore = setHubHomeOrgForTests(null);
    const stop = await learnHubHomeOrg({ client: planeWith(OTHER_ORG), audience: TEST_PLANE.audience, pinned: null });
    stop();
    expect(hubHomeOrg()).toBe(OTHER_ORG);
  });

  test("plane down: unknown, then learned by the background retry", async () => {
    restore = setHubHomeOrgForTests(null);
    let down = true;
    const client = { ...planeWith(TEST_ORG), serviceToken: (a: string) => (down ? Promise.reject(new Error("down")) : planeWith(TEST_ORG).serviceToken(a)) } as OrgPlaneClient;
    const stop = await learnHubHomeOrg({ client, audience: TEST_PLANE.audience, pinned: null, retryMs: () => 5 });
    expect(hubHomeOrg()).toBeNull();
    down = false;
    for (let i = 0; i < 100 && hubHomeOrg() === null; i++) await new Promise((r) => setTimeout(r, 5));
    stop();
    expect(hubHomeOrg()).toBe(TEST_ORG);
  });

  test("HUB_HOME_ORG that disagrees with the credential refuses the boot", async () => {
    restore = setHubHomeOrgForTests(null);
    await expect(learnHubHomeOrg({ client: planeWith(TEST_ORG), audience: TEST_PLANE.audience, pinned: OTHER_ORG })).rejects.toBeInstanceOf(HubHomeOrgMismatchError);
  });

  test("HUB_HOME_ORG that agrees is accepted", async () => {
    restore = setHubHomeOrgForTests(null);
    (await learnHubHomeOrg({ client: planeWith(TEST_ORG), audience: TEST_PLANE.audience, pinned: TEST_ORG }))();
    expect(hubHomeOrg()).toBe(TEST_ORG);
  });

  test("a token with no org is not learned", async () => {
    await expect(credentialOrg(planeWith(null), TEST_PLANE.audience)).rejects.toThrow("no org");
  });

  test("a malformed HUB_HOME_ORG is refused by config validation", () => {
    expect(parseHubHomeOrg(undefined)).toBeNull();
    expect(parseHubHomeOrg(" ")).toBeNull();
    expect(parseHubHomeOrg(TEST_ORG)).toBe(TEST_ORG);
    expect(() => parseHubHomeOrg("org_nope")).toThrow(HubHomeOrgConfigError);
    const errs = collectConfigErrors(config, () => {}, undefined, [], undefined, "org_nope");
    expect(errs.some((e) => e.field === "HUB_HOME_ORG")).toBe(true);
  });
});
