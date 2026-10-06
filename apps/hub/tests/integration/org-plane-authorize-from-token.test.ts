process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser, deleteTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { createPrincipal, forgetPrincipals } from "../helpers/principals";
import { setOrgPlaneForTests, TEST_PLANE } from "../../src/auth/org-plane/config";
import { setPrincipalDirectoryForTests, type PrincipalDirectory } from "../../src/services/org-plane/directory";
import { OrgPlaneError, type PlanePrincipal } from "../../src/services/org-plane/client";
import { OrgPlaneUnavailable, type TokenAuthority } from "../../src/auth/caller-authority";
import { isControlPairDenied, isGrantReachDenied } from "../../src/services/control-pair";
import { requireGrantReach, requireIssueCredentials } from "../../src/services/grant-reach";
import { createSession } from "../../src/services/acp-sessions";
import { stationAcpRoutes } from "../../src/routes/station-acp";
import { createStationSayRoutes } from "../../src/routes/station-say";
import { createMissionRoutes } from "../../src/routes/missions";
import { enrollmentTokenRoutes } from "../../src/routes/enrollment-tokens";
import { harnessConfigRoutes } from "../../src/routes/harness-config";
import { stationWriteRoutes } from "../../src/routes/station-writes";
import { createStationMatrixRoutes } from "../../src/routes/station-matrix";
import { stationCleanupRoutes } from "../../src/routes/station-cleanup";
import { createSkillManagementRoutes } from "../../src/routes/skill-management";

/**
 * Design §5.7: "No authorization path calls the plane. The one named exception is resolving an
 * inbound Matrix sender to a principal for gate approvals."
 *
 * Every test here runs under ORG_PLANE_* with a plane that is down and has nothing cached for the
 * CALLER: reading the caller's principal or grant throws. A request carrying a valid token must
 * still be authorized — or refused — from that token's own claims. Reads about anybody else (the
 * station's agent's handle, for display) still answer, so a test fails only where a check asks
 * the plane about the caller.
 */

// Under the plane AuthUser.id is the caller's prn_ — and, in this database, a user row too, because
// the FKs onto user.id are dropped only by the cutover script.
const ME = "prn_0f0f0f0f0f0f0f0f0f0f";
const NODE = "node_plane_authz";
const STATION = "station_plane_authz";
let AGENT: string;
let TENANT: string;

function downForCaller() {
  const callerReads: string[] = [];
  const dir: PrincipalDirectory = {
    principal: async (id) => {
      if (id === ME) {
        callerReads.push(id);
        throw new OrgPlaneError(0, "unreachable");
      }
      if (id === AGENT) {
        return {
          id: AGENT, kind: "agent", handle: "plane-authz-agent", displayName: "A", organizationId: null,
          suspended: false, grant: null,
        } satisfies PlanePrincipal;
      }
      return null;
    },
    identity: async () => {
      throw new OrgPlaneError(0, "unreachable");
    },
    identitiesOf: async () => {
      throw new OrgPlaneError(0, "unreachable");
    },
    list: async () => {
      throw new OrgPlaneError(0, "unreachable");
    },
    invalidate: () => {},
  };
  return { dir, callerReads };
}

const ALLOWED = (): TokenAuthority => ({ principalKind: "human", mayDispatch: [AGENT], mayGrantReach: true, scopes: [] });
const NO_DISPATCH = (): TokenAuthority => ({ principalKind: "human", mayDispatch: [], mayGrantReach: true, scopes: [] });
const NO_REACH = (): TokenAuthority => ({ principalKind: "human", mayDispatch: [AGENT], mayGrantReach: false, scopes: [] });

const caller = (authority?: TokenAuthority) => ({
  id: ME,
  authType: "org_plane" as const,
  tenantId: TENANT,
  ...(authority ? { authority } : {}),
});

function mount(authority: TokenAuthority | undefined, routes: Hono, at = "/api") {
  return new Hono()
    .use("*", async (c, next) => {
      c.set("user", caller(authority));
      await next();
    })
    .route(at, routes);
}

let callerReads: string[];
const restores: Array<() => void> = [];

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: ME, email: "plane-authz@example.com", name: "Plane AuthZ" });
  AGENT = await createPrincipal({ kind: "agent", handle: "plane-authz-agent" });
  TENANT = await resolveTenantForUser(ME);
  await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${TENANT}, ${ME}, 'plane-authz-box', 'plane-authz-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, principal_id, adopted_at, created_at)
    VALUES (${STATION}, ${TENANT}, ${ME}, ${NODE}, 'hermes', 'hermes:plane-authz', 'leaf', 'plane-authz',
            '["acp","fs.write","terminal","cleanup","skills.manage"]'::jsonb, ${AGENT}, now(), now())`;
  process.env.ENFORCE_CONTROL_PAIR = "true";
});

beforeEach(() => {
  const down = downForCaller();
  callerReads = down.callerReads;
  restores.push(setOrgPlaneForTests(TEST_PLANE), setPrincipalDirectoryForTests(down.dir));
});

afterEach(() => restores.splice(0).reverse().forEach((r) => r()));

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM station_audit WHERE user_id = ${ME}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${ME}`;
    await rawSql`DELETE FROM hub_operators WHERE principal_id = ${ME}`;
    await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
    await forgetPrincipals({ handles: ["plane-authz-agent"] });
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await deleteTestUser(ME);
  } catch {
    // cleanup only
  }
});

const STATION_REF = { nodeId: NODE, stationKey: "hermes:plane-authz" };

describe("services/acp-sessions createSession — the dispatch control pair", () => {
  test("a token whose mayDispatch covers the agent passes the pair without reading the plane", async () => {
    // Past the pair, the next gate is readiness: the node is not connected in this process.
    await expect(
      createSession({ stationId: STATION, userId: ME, mode: "ask", authority: ALLOWED() }),
    ).rejects.toThrow("Node is offline.");
    expect(callerReads).toEqual([]);
  });

  test("a token whose mayDispatch does not cover it is refused by the pair", async () => {
    const err = await createSession({ stationId: STATION, userId: ME, mode: "ask", authority: NO_DISPATCH() }).catch((e) => e);
    expect(isControlPairDenied(err)).toBe(true);
    expect(callerReads).toEqual([]);
  });

  test("with no token to read (bridge, Matrix: the station's owner) it fails closed as OrgPlaneUnavailable", async () => {
    const err = await createSession({ stationId: STATION, userId: ME, mode: "ask" }).catch((e) => e);
    expect(err).toBeInstanceOf(OrgPlaneUnavailable);
  });

  test("the console route hands the caller's token to the pair: 403 from the claims, and 503 is never needed", async () => {
    const post = (a: TokenAuthority | undefined) =>
      mount(a, stationAcpRoutes).request(`/api/stations/${STATION}/acp/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "ask" }),
      });
    expect((await post(NO_DISPATCH())).status).toBe(403);
    const allowed = await post(ALLOWED());
    expect(((await allowed.json()) as { error: string }).error).toBe("Node is offline.");
    expect(callerReads).toEqual([]);
  });

  test("the console route answers a plane outage with 503, never a 500 or a refusal", async () => {
    // The static API_TOKEN carries no token authority, so it must ask the directory.
    const res = await mount(undefined, stationAcpRoutes).request(`/api/stations/${STATION}/acp/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "ask" }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("org_plane_unavailable");
  });
});

describe("services/grant-reach", () => {
  test("requireGrantReach decides from the caller's token", async () => {
    await requireGrantReach(caller(ALLOWED()), STATION_REF, "terminal", "mutate");
    expect(isGrantReachDenied(await requireGrantReach(caller(NO_REACH()), STATION_REF, "terminal", "mutate").catch((e) => e))).toBe(true);
    expect(isGrantReachDenied(await requireGrantReach(caller(NO_DISPATCH()), STATION_REF, "terminal", "mutate").catch((e) => e))).toBe(true);
    expect(callerReads).toEqual([]);
  });

  test("requireIssueCredentials decides from the caller's token", async () => {
    await requireIssueCredentials(caller(ALLOWED()), STATION_REF);
    expect(isGrantReachDenied(await requireIssueCredentials(caller(NO_REACH()), STATION_REF).catch((e) => e))).toBe(true);
    expect(callerReads).toEqual([]);
  });

  test("a bare user id (a station's owner, no token) fails closed as OrgPlaneUnavailable", async () => {
    await expect(requireGrantReach(ME, STATION_REF, "terminal", "mutate")).rejects.toBeInstanceOf(OrgPlaneUnavailable);
  });
});

describe("routes", () => {
  test("station-say: refused or allowed from the token", async () => {
    const say = (a: TokenAuthority) =>
      mount(a, createStationSayRoutes({ domain: "id.test", client: { sendText: async () => "$e" } })).request(
        `/api/stations/${STATION}/matrix/say`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "hi" }) },
      );
    expect((await say(NO_DISPATCH())).status).toBe(403);
    // Allowed: the next thing it says is that there is no room yet.
    const ok = await say(ALLOWED());
    expect(ok.status).toBe(409);
    expect(await ok.text()).toMatch(/no Matrix room yet/);
    expect(callerReads).toEqual([]);
  });

  test("missions: every member checked against the token's mayDispatch", async () => {
    const res = await mount(
      NO_DISPATCH(),
      createMissionRoutes({
        domain: "id.test",
        client: {
          ensureRoom: async () => null,
          createSpace: async () => null,
          addSpaceChild: async () => {},
          invite: async () => {},
        },
      }),
    ).request("/api/missions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "plane authz mission", stationIds: [STATION] }),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/not permitted to dispatch/);
    expect(callerReads).toEqual([]);
  });

  test("missions: allowed by the token gets past the pair (no room: 502 from the stub, not a refusal)", async () => {
    const res = await mount(
      ALLOWED(),
      createMissionRoutes({
        domain: "id.test",
        client: { ensureRoom: async () => null, createSpace: async () => null, addSpaceChild: async () => {}, invite: async () => {} },
      }),
    ).request("/api/missions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "plane authz mission ok", stationIds: [STATION] }),
    });
    expect(res.status).toBe(502);
    expect(callerReads).toEqual([]);
  });

  test("enrollment tokens: the caller's principal is their token's sub; admin is the hub_operators seat", async () => {
    const post = () => mount(ALLOWED(), enrollmentTokenRoutes, "/").request("/", { method: "POST" });
    expect((await post()).status).toBe(403);
    await rawSql`INSERT INTO hub_operators (principal_id) VALUES (${ME}) ON CONFLICT DO NOTHING`;
    try {
      expect((await post()).status).toBe(200);
    } finally {
      await rawSql`DELETE FROM hub_operators WHERE principal_id = ${ME}`;
    }
    expect(callerReads).toEqual([]);
  });

  test("harness-config: the non-human refusal reads the token's principalKind", async () => {
    const get = (a: TokenAuthority) => mount(a, harnessConfigRoutes).request("/api/fleet/config/settings");
    expect((await get(ALLOWED())).status).toBe(200);
    expect((await get({ ...ALLOWED(), principalKind: "service" })).status).toBe(403);
    expect(callerReads).toEqual([]);
  });

  test("station-writes: reach refused from the token's mayGrantReach", async () => {
    const res = await mount(NO_REACH(), stationWriteRoutes).request(`/api/stations/${STATION}/fs/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "x", content: "y", encoding: "utf8" }),
    });
    expect(res.status).toBe(403);
    expect(callerReads).toEqual([]);
  });

  test("station-writes: allowed by the token gets past reach (node offline: 409)", async () => {
    const res = await mount(ALLOWED(), stationWriteRoutes).request(`/api/stations/${STATION}/fs/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "x", content: "y", encoding: "utf8" }),
    });
    expect(res.status).toBe(409);
    expect(callerReads).toEqual([]);
  });

  test("station-matrix: issuing credentials and authorizing a move are refused from the token", async () => {
    const routes = createStationMatrixRoutes({
      domain: "id.test",
      provisionStation: async () => {},
      credentials: { register: async () => { throw new Error("must not be reached"); } },
      preJoinNewIdentity: async () => { throw new Error("must not be reached"); },
      signalNodeToAdopt: async () => { throw new Error("must not be reached"); },
      moveState: async () => { throw new Error("must not be reached"); },
      log: () => {},
    });
    for (const path of ["credentials", "authorize-move"]) {
      const res = await mount(NO_REACH(), routes).request(`/api/stations/${STATION}/matrix/${path}`, { method: "POST" });
      expect(res.status).toBe(403);
    }
    expect(callerReads).toEqual([]);
  });

  test("station-cleanup: deleting is refused from the token's mayGrantReach", async () => {
    const res = await mount(NO_REACH(), stationCleanupRoutes).request(`/api/stations/${STATION}/cleanup/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["x"] }),
    });
    expect(res.status).toBe(403);
    expect(callerReads).toEqual([]);
  });

  test("skill-management: a mutating station route is refused, or let through, from the token", async () => {
    const plan = (a: TokenAuthority) =>
      mount(a, createSkillManagementRoutes()).request(`/api/stations/${STATION}/skills/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    expect((await plan(NO_REACH())).status).toBe(403);
    // Allowed: the next thing it says is that the (empty) request is invalid.
    expect((await plan(ALLOWED())).status).toBe(400);
    expect(callerReads).toEqual([]);
  });
});
