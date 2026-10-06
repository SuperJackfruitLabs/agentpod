/**
 * Route test: creating and assigning an agent.
 *
 * `charter → decisions/2026-08-30-an-agent-is-a-principal.md` says creating an
 * agent is "a deliberate act, not a side effect of a machine appearing" — until
 * this file, the only way to mint an agent principal was a seed script. This
 * proves the HTTP surface that replaces it, and what each of its refusals
 * looks like:
 *
 *   1. A handle that would be silently mangled into a different mxid → 400,
 *      not a quietly different address than the one typed.
 *   2. A handle already claimed → 409, not the 500 a bare unique-index
 *      violation would leak — `principals_org_handle_idx` exists because two
 *      claimants make the mxid it produces ambiguous.
 *   3. Assigning a suspended principal to a station → 403. A suspended agent
 *      that can still be handed a station is a suspension that does not
 *      suspend.
 *   4. Every one of these, behind the real `adminMiddleware` — a non-admin
 *      gets 403 from all three verbs.
 *
 * Uses the local Docker test-postgres (localhost:5434). Every fixture id is
 * unique per run (`crypto.randomUUID()`), and `afterAll` deletes what it
 * created — so this file passes on a fresh database AND on a second run
 * against the same one, immediately after, with no reset in between.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser } from "../../tests/helpers/database";
import { db, rawSql } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { mintEnrollmentToken, enrollNode } from "../services/enrollment";
import { createPrincipal, suspendPrincipal } from "../services/principals";
import { adminMiddleware } from "../auth/admin-middleware";
import { agentsAdminRouter } from "./agents-admin";
import { principals } from "../db/schema/organization";
import { onProvisionStation } from "../services/matrix-as/hooks";
import { setOrgPlaneForTests, TEST_PLANE } from "../auth/org-plane/config";
import { OrgPlaneError, setOrgPlaneClientForTests, type OrgPlaneClient, type PlanePrincipal } from "../services/org-plane/client";
import { setPrincipalDirectoryForTests, type PrincipalDirectory } from "../services/org-plane/directory";

const RUN = crypto.randomUUID().slice(0, 8);
const HANDLE_PREFIX = `agents-admin-it-${RUN}`;
const ADMIN_ACTOR = `test-admin-actor-agents-admin-${RUN}`;
const NON_ADMIN_ACTOR = `test-non-admin-actor-agents-admin-${RUN}`;

let stationId: string;
let principalId: string;
let suspendedPrincipalId: string;

/** The real guard, not a stub — "a non-admin can do none of it" is a claim
 *  about `adminMiddleware`, not about the router in isolation. */
function guardedApp(actorId: string) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: actorId, authType: "api_key", tenantId: "default" });
    await next();
  });
  a.use("*", adminMiddleware);
  a.route("/", agentsAdminRouter);
  return a;
}

const adminApp = guardedApp(ADMIN_ACTOR);
const userApp = guardedApp(NON_ADMIN_ACTOR);

async function stationRow(id: string): Promise<{ principalId: string | null } | undefined> {
  const [row] = await db
    .select({ principalId: stations.principalId })
    .from(stations)
    .where(eq(stations.id, id));
  return row;
}

beforeAll(async () => {
  await ensurePgMigrations();

  await createTestUser({
    id: ADMIN_ACTOR,
    email: `agents-admin-actor-${RUN}@example.com`,
    name: "Actor",
    role: "admin",
  });
  await createTestUser({
    id: NON_ADMIN_ACTOR,
    email: `agents-admin-nonactor-${RUN}@example.com`,
    name: "Non-actor",
  });

  const { token } = await mintEnrollmentToken(ADMIN_ACTOR);
  const { nodeId } = await enrollNode(token, {
    hostname: `agents-admin-host-${RUN}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 1,
  });

  stationId = `st_agtadm_${RUN}`;
  await db.insert(stations).values({
    id: stationId,
    tenantId: BOOTSTRAP_TENANT_ID,
    userId: ADMIN_ACTOR,
    nodeId,
    harness: "opencode",
    stationKey: `opencode:${RUN}`,
    kind: "workspace",
    displayName: "/workspace",
  });

  principalId = await createPrincipal({ kind: "agent", handle: `${HANDLE_PREFIX}-assignee` });
  suspendedPrincipalId = await createPrincipal({ kind: "agent", handle: `${HANDLE_PREFIX}-suspended` });
  await suspendPrincipal(suspendedPrincipalId);
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM stations WHERE user_id = ${ADMIN_ACTOR}`;
    await rawSql`DELETE FROM nodes WHERE user_id = ${ADMIN_ACTOR}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${ADMIN_ACTOR}`;
    await rawSql`DELETE FROM principals WHERE handle LIKE ${HANDLE_PREFIX + "%"}`;
    await rawSql`DELETE FROM "user" WHERE id IN (${ADMIN_ACTOR}, ${NON_ADMIN_ACTOR})`;
  } catch {
    // cleanup only
  }
});

describe("POST /api/admin/agents", () => {
  test("creates an agent principal with the handle given", async () => {
    const res = await adminApp.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: `${HANDLE_PREFIX}-writer`, displayName: "Writer Quill" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toMatch(/^prn_[0-9a-f]{20}$/);
  });

  test("refuses a handle already taken", async () => {
    // A handle becomes an mxid localpart. Two claimants make the address
    // ambiguous, which is why principals_org_handle_idx exists — surfaced as
    // a 409, not the 500 a bare constraint violation would leak.
    const taken = `${HANDLE_PREFIX}-taken`;
    await createPrincipal({ kind: "agent", handle: taken });

    const res = await adminApp.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: taken }),
    });
    expect(res.status).toBe(409);
  });

  test("refuses a handle that cannot be an mxid localpart", async () => {
    // Would be silently mangled by `clean()` in matrix-as/names.ts into a
    // different address than the one typed — refused up front instead.
    const res = await adminApp.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "Writer Quill!" }),
    });
    expect(res.status).toBe(400);
  });

  test("a non-admin cannot create an agent", async () => {
    const res = await userApp.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: `${HANDLE_PREFIX}-forbidden` }),
    });
    expect(res.status).toBe(403);
  });
});

describe("PUT/DELETE /api/admin/stations/:stationId/agent", () => {
  test("assigning makes the station dispatchable, unassigning makes it nobody's", async () => {
    const put = await adminApp.request(`/stations/${stationId}/agent`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId }),
    });
    expect(put.status).toBe(200);
    expect((await stationRow(stationId))!.principalId).toBe(principalId);

    const del = await adminApp.request(`/stations/${stationId}/agent`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await stationRow(stationId))!.principalId).toBeNull();
  });

  test("refuses to assign a suspended principal — a suspension that can still be given a station does not suspend", async () => {
    const res = await adminApp.request(`/stations/${stationId}/agent`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: suspendedPrincipalId }),
    });
    expect(res.status).toBe(403);
    expect((await stationRow(stationId))!.principalId).toBeNull();
  });

  test("refuses an unknown principal id", async () => {
    const res = await adminApp.request(`/stations/${stationId}/agent`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "prn_ffffffffffffffffff00" }),
    });
    expect(res.status).toBe(404);
  });

  test("refuses an unknown station id", async () => {
    const res = await adminApp.request("/stations/st_doesnotexist/agent", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId }),
    });
    expect(res.status).toBe(404);
  });

  test("a non-admin can assign or unassign none of it", async () => {
    const put = await userApp.request(`/stations/${stationId}/agent`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId }),
    });
    expect(put.status).toBe(403);

    const del = await userApp.request(`/stations/${stationId}/agent`, { method: "DELETE" });
    expect(del.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Under ORG_PLANE_*: the agent is created and linked at the plane (decision D3).
// ---------------------------------------------------------------------------

describe("under the org plane", () => {
  const hex20 = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);

  function fakePlane(o: { createStatus?: number } = {}) {
    const calls: string[] = [];
    const known = new Map<string, PlanePrincipal>();
    const unexpected = async (): Promise<never> => {
      throw new Error("this route must not make this plane call");
    };
    const client: OrgPlaneClient = {
      agentToken: unexpected,
      assertionToken: unexpected,
      lookupIdentity: unexpected,
      getPrincipal: unexpected,
      listPrincipals: unexpected,
      unsuspend: unexpected,
      putGrant: unexpected,
      createAgent: async ({ handle, displayName }) => {
        calls.push(`create ${handle} ${displayName}`);
        if (o.createStatus) throw new OrgPlaneError(o.createStatus, "conflict");
        const id = `prn_${hex20()}`;
        known.set(id, { id, kind: "agent", handle, displayName, organizationId: "org_test", suspended: false, grant: null });
        return { id };
      },
      linkIdentity: async (id, system, ext) => void calls.push(`link ${id} ${system} ${ext}`),
      suspend: async (id) => void calls.push(`suspend ${id}`),
    };
    const directory: PrincipalDirectory = {
      principal: async (id) => known.get(id) ?? null,
      identity: unexpected,
      list: async () => [...known.values()],
      invalidate: () => {},
    };
    const restores = [setOrgPlaneForTests(TEST_PLANE), setOrgPlaneClientForTests(client), setPrincipalDirectoryForTests(directory)];
    return { calls, known, restore: () => restores.reverse().forEach((r) => r()) };
  }

  test("POST /agents creates the agent at the plane and links its Matrix id; nothing is written locally", async () => {
    onProvisionStation(async () => {}, "matrix.example");
    const plane = fakePlane();
    try {
      const handle = `${HANDLE_PREFIX}-plane-made`;
      const res = await adminApp.request("/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle, displayName: "Plane Made" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; kind: string; handle: string };
      expect(body).toMatchObject({ kind: "agent", handle });
      expect(plane.calls).toEqual([`create ${handle} Plane Made`, `link ${body.id} matrix @agent_${handle}:matrix.example`]);
      expect(await db.select().from(principals).where(eq(principals.handle, handle))).toEqual([]);
    } finally {
      plane.restore();
      onProvisionStation(null);
    }
  });

  test("POST /agents answers the plane's 409 for a taken handle as 409", async () => {
    const plane = fakePlane({ createStatus: 409 });
    try {
      const res = await adminApp.request("/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: `${HANDLE_PREFIX}-plane-taken` }),
      });
      expect(res.status).toBe(409);
    } finally {
      plane.restore();
    }
  });

  test("PUT /stations/:id/agent places a plane-made agent (a mirror row keeps the station's foreign key)", async () => {
    const plane = fakePlane();
    try {
      const { id } = await orgPlaneClientForAssign(plane, `${HANDLE_PREFIX}-plane-placed`);
      const res = await adminApp.request(`/stations/${stationId}/agent`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ principalId: id }),
      });
      expect(res.status).toBe(200);
      expect((await stationRow(stationId))!.principalId).toBe(id);
      expect(await db.select({ id: principals.id }).from(principals).where(eq(principals.id, id))).toEqual([{ id }]);
      await adminApp.request(`/stations/${stationId}/agent`, { method: "DELETE" });
    } finally {
      plane.restore();
    }
  });

  test("PUT /stations/:id/agent refuses a human under the plane: only an agent occupies a station", async () => {
    const plane = fakePlane();
    try {
      const human = `prn_${hex20()}`;
      plane.known.set(human, { id: human, kind: "human", handle: `${HANDLE_PREFIX}-human`, displayName: null, organizationId: "org_test", suspended: false, grant: null });
      const res = await adminApp.request(`/stations/${stationId}/agent`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ principalId: human }),
      });
      expect(res.status).toBe(400);
      expect((await stationRow(stationId))!.principalId).toBeNull();
    } finally {
      plane.restore();
    }
  });

  /** An agent that exists at the plane only — the way one made at the plane's pages does. */
  async function orgPlaneClientForAssign(plane: ReturnType<typeof fakePlane>, handle: string) {
    const id = `prn_${hex20()}`;
    plane.known.set(id, { id, kind: "agent", handle, displayName: handle, organizationId: "org_test", suspended: false, grant: null });
    return { id };
  }
});
