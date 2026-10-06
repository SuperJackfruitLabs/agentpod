process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser } from "../../tests/helpers/database";
import { db, rawSql } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { BOOTSTRAP_ORG_ID, principals } from "../db/schema/organization";
import { principalGrants } from "../db/schema/grants";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { createPrincipal } from "../services/principals";
import { mintEnrollmentToken, enrollNode } from "../services/enrollment";
import { adminMiddleware } from "../auth/admin-middleware";
import { agentsAdminRouter } from "./agents-admin";
import { onProvisionStation } from "../services/matrix-as/hooks";
import { setOrgPlaneForTests, TEST_PLANE } from "../auth/org-plane/config";
import {
  OrgPlaneError,
  setOrgPlaneClientForTests,
  type OrgPlaneClient,
  type PlaneGrant,
  type PlanePrincipal,
} from "../services/org-plane/client";
import {
  setPrincipalDirectoryForTests,
  type PrincipalDirectory,
} from "../services/org-plane/directory";
import { stationSetups } from "../db/schema/station-setup";
import { hubOperators } from "../db/schema/operators";
const run = crypto.randomUUID().slice(0, 8);
const actor = `setup-admin-${run}`;
/** Under the plane an AuthUser.id is the human's prn_ (contract §2). */
const planeActor = `prn_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
let nodeId: string;
let operatorId: string;
function app(userId = actor, tenantId = BOOTSTRAP_TENANT_ID) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", {
      id: userId,
      authType: "api_key",
      tenantId,
    });
    await next();
  });
  a.use("*", adminMiddleware);
  return a.route("/", agentsAdminRouter);
}
const request = (id: string, body: unknown, userId = actor) =>
  app(userId).request(`/stations/${id}/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
async function station(owner = actor) {
  const id = `setup-st-${crypto.randomUUID()}`;
  await db.insert(stations).values({
    id,
    userId: owner,
    tenantId: BOOTSTRAP_TENANT_ID,
    nodeId,
    harness: "codex",
    stationKey: id,
    kind: "leaf",
    displayName: "Test",
    capabilities: [],
  });
  return id;
}
const input = () => ({
  requestId: crypto.randomUUID(),
  agent: {
    kind: "new",
    handle: `setup-${run}-${crypto.randomUUID().slice(0, 8)}`,
    displayName: "Test agent",
  },
  dispatch: "me",
});
beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: actor, role: "admin" });
  await createTestUser({ id: `setup-user-${run}` });
  await createTestUser({ id: planeActor, role: "admin" });
  // Under the plane admin is a seat in hub_operators (decision D4), not user.role.
  await db.insert(hubOperators).values([{ principalId: planeActor }, { principalId: actor }]);
  operatorId = await createPrincipal({
    kind: "human",
    handle: `setup-${run}-operator`,
    userId: actor,
  });
  await db.insert(principalGrants).values({
    principalId: operatorId,
    mayDispatch: '["prn_00000000000000000099"]',
    mayGrantReach: true,
  });
  const { token } = await mintEnrollmentToken(actor);
  ({ nodeId } = await enrollNode(token, {
    hostname: "setup-test",
    os: "linux",
    arch: "amd64",
    cpuCount: 1,
  }));
});
afterAll(async () => {
  onProvisionStation(null);
  await rawSql`DELETE FROM nodes WHERE id=${nodeId}`;
  await rawSql`DELETE FROM principals WHERE handle LIKE ${`setup-${run}-%`}`;
  await rawSql`DELETE FROM hub_operators WHERE principal_id IN (${actor},${planeActor})`;
  await rawSql`DELETE FROM "user" WHERE id IN (${actor},${`setup-user-${run}`},${planeActor})`;
});
test("setup creates and assigns once; response-loss retry never regrants revoked access", async () => {
  const id = await station(),
    body = input();
  const first = await request(id, body);
  expect(first.status).toBe(200);
  const result = (await first.json()) as { principalId: string };
  expect(result.principalId).toMatch(/^prn_[a-f0-9]{20}$/);
  const [grant] = await db
    .select()
    .from(principalGrants)
    .where(eq(principalGrants.principalId, operatorId));
  expect(JSON.parse(grant!.mayDispatch)).toContain(result.principalId);
  expect(JSON.parse(grant!.mayDispatch)).toContain("prn_00000000000000000099");
  expect(grant!.mayGrantReach).toBe(true);
  await db
    .update(principalGrants)
    .set({ mayDispatch: "[]" })
    .where(eq(principalGrants.principalId, operatorId));
  const retry = await request(id, body);
  expect(retry.status).toBe(200);
  expect(((await retry.json()) as { principalId: string }).principalId).toBe(
    result.principalId,
  );
  const [after] = await db
    .select()
    .from(principalGrants)
    .where(eq(principalGrants.principalId, operatorId));
  expect(after!.mayDispatch).toBe("[]");
  expect((await request(id, { ...body, dispatch: "none" })).status).toBe(409);
});
test("occupied station refuses setup without minting a second identity", async () => {
  const id = await station();
  expect((await request(id, input())).status).toBe(200);
  const second = input();
  expect((await request(id, second)).status).toBe(409);
  expect(
    await db
      .select()
      .from(principals)
      .where(eq(principals.handle, second.agent.handle)),
  ).toHaveLength(0);
});
test("existing assigned agents cannot be moved by setup", async () => {
  const id = await station();
  const res = await request(id, input());
  const { principalId } = (await res.json()) as {
    principalId: string;
    matrix: { status: string };
  };
  const other = await station();
  expect(
    (
      await request(other, {
        requestId: crypto.randomUUID(),
        agent: { kind: "existing", principalId },
        dispatch: "none",
      })
    ).status,
  ).toBe(409);
});
test("setup is admin-only and owner-scoped", async () => {
  const id = await station();
  expect((await request(id, input(), `setup-user-${run}`)).status).toBe(403);
  expect((await request("missing", input())).status).toBe(404);
});
test("Matrix failure leaves assignment and exposes a retry without changing identity", async () => {
  onProvisionStation(async () => {
    throw new Error("homeserver unavailable");
  }, "matrix.example");
  const id = await station(),
    body = input();
  const res = await request(id, body);
  expect(res.status).toBe(200);
  const result = (await res.json()) as {
    principalId: string;
    matrix: { status: string };
  };
  expect(result.matrix.status).toBe("failed");
  onProvisionStation(async () => {}, "matrix.example");
  const retry = await app().request(`/stations/${id}/setup/matrix`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId: result.principalId }),
  });
  expect(retry.status).toBe(200);
  const [row] = await db.select().from(stations).where(eq(stations.id, id));
  expect(row!.principalId).toBe(result.principalId);
  onProvisionStation(null);
});

test("concurrent retries create exactly one identity", async () => {
  const id = await station(),
    body = { ...input(), dispatch: "none" };
  const responses = await Promise.all([request(id, body), request(id, body)]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  const results = await Promise.all(
    responses.map((r) => r.json() as Promise<{ principalId: string }>),
  );
  expect(results[0]!.principalId).toBe(results[1]!.principalId);
  expect(
    await db
      .select()
      .from(principals)
      .where(eq(principals.handle, body.agent.handle)),
  ).toHaveLength(1);
});
test("invalid handles and non-agent identities are refused", async () => {
  const id = await station();
  expect(
    (
      await request(id, {
        ...input(),
        agent: { kind: "new", handle: "Upper Case", displayName: "Bad" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(id, {
        ...input(),
        agent: { kind: "existing", principalId: operatorId },
      })
    ).status,
  ).toBe(404);
  const [row] = await db.select().from(stations).where(eq(stations.id, id));
  expect(row!.principalId).toBeNull();
});
test("existing unassigned identity does not gain dispatchers without consent", async () => {
  const existing = await createPrincipal({
    kind: "agent",
    handle: `setup-${run}-spare`,
  });
  const before = await db
    .select()
    .from(principalGrants)
    .where(eq(principalGrants.principalId, operatorId));
  expect(
    (
      await request(await station(), {
        requestId: crypto.randomUUID(),
        agent: { kind: "existing", principalId: existing },
        dispatch: "none",
      })
    ).status,
  ).toBe(200);
  expect(
    await db
      .select()
      .from(principalGrants)
      .where(eq(principalGrants.principalId, operatorId)),
  ).toEqual(before);
});
test("suspended agents are neither offered nor assigned", async () => {
  const existing = await createPrincipal({
    kind: "agent",
    handle: `setup-${run}-suspended`,
  });
  await db
    .update(principals)
    .set({ suspendedAt: new Date() })
    .where(eq(principals.id, existing));
  const options = (await (
    await app().request("/station-setup/options")
  ).json()) as { agents: { id: string }[] };
  expect(options.agents.some((a) => a.id === existing)).toBe(false);
  expect(
    (
      await request(await station(), {
        requestId: crypto.randomUUID(),
        agent: { kind: "existing", principalId: existing },
        dispatch: "none",
      })
    ).status,
  ).toBe(403);
});
test("Matrix failure survives reload; a no-op provisioner does not prove a room exists", async () => {
  onProvisionStation(async () => {
    throw new Error("offline");
  }, "matrix.example");
  const id = await station();
  const first = (await (await request(id, input())).json()) as {
    principalId: string;
  };
  const status = (await (
    await app().request(`/stations/${id}/setup`)
  ).json()) as { matrix: { status: string } };
  expect(status.matrix.status).toBe("failed");
  onProvisionStation(async () => {}, "matrix.example");
  const retry = await app().request(`/stations/${id}/setup/matrix`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId: first.principalId }),
  });
  expect(
    ((await retry.json()) as { matrix: { status: string } }).matrix.status,
  ).toBe("pending");
  onProvisionStation(null);
});

test("setup endpoints reject another owner and a mismatched tenant", async () => {
  const id = await station();
  const stranger = `setup-other-admin-${run}`;
  await createTestUser({ id: stranger, role: "admin" });
  try {
    for (const client of [app(stranger), app(actor, "fleet_99999999999999999999")]) {
      expect((await client.request(`/stations/${id}/setup`)).status).toBe(404);
      for (const [suffix, body] of [
        ["", input()],
        ["/matrix", { principalId: "prn_00000000000000000001" }],
      ] as const) {
        expect(
          (
            await client.request(`/stations/${id}/setup${suffix}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          ).status,
        ).toBe(404);
      }
    }
  } finally {
    await rawSql`DELETE FROM "user" WHERE id=${stranger}`;
  }
});

// ---------------------------------------------------------------------------
// Under ORG_PLANE_*: the agent is created at the plane (decision D3).
// ---------------------------------------------------------------------------

const hex20 = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);

/** An in-memory plane: the principals it knows, and every write the hub asked of it. */
function fakePlane(
  o: {
    humanGrant?: PlaneGrant | null;
    agents?: PlanePrincipal[];
    onCreate?: (id: string) => Promise<void>;
    grantFails?: () => Error;
  } = {},
) {
  const calls: string[] = [];
  const created: string[] = [];
  const known = new Map<string, PlanePrincipal>();
  const add = (p: PlanePrincipal) => known.set(p.id, p);
  add({
    id: planeActor,
    kind: "human",
    handle: `setup-${run}-planeop`,
    displayName: null,
    organizationId: "org_test",
    suspended: false,
    grant: o.humanGrant ?? null,
  });
  for (const a of o.agents ?? []) add(a);
  const unexpected = async (): Promise<never> => {
    throw new Error("station setup must not make this plane call");
  };
  const client: OrgPlaneClient = {
    agentToken: unexpected,
    assertionToken: unexpected,
    lookupIdentity: unexpected,
    getPrincipal: unexpected,
    listPrincipals: unexpected,
    unsuspend: unexpected,
    createAgent: async ({ handle, displayName }) => {
      const id = `prn_${hex20()}`;
      created.push(id);
      calls.push(`create ${handle}`);
      add({ id, kind: "agent", handle, displayName, organizationId: "org_test", suspended: false, grant: null });
      await o.onCreate?.(id);
      return { id };
    },
    linkIdentity: async (id, system, ext) => void calls.push(`link ${id} ${system} ${ext}`),
    putGrant: async (id, grant) => {
      calls.push(`grant ${id} ${JSON.stringify(grant)}`);
      if (o.grantFails) throw o.grantFails();
      known.set(id, { ...known.get(id)!, grant });
    },
    suspend: async (id) => {
      calls.push(`suspend ${id}`);
      known.set(id, { ...known.get(id)!, suspended: true });
    },
  };
  const directory: PrincipalDirectory = {
    principal: async (id) => known.get(id) ?? null,
    identity: unexpected,
    list: async (kind) => [...known.values()].filter((p) => !kind || p.kind === kind),
    invalidate: () => {},
  };
  const restores = [
    setOrgPlaneForTests(TEST_PLANE),
    setOrgPlaneClientForTests(client),
    setPrincipalDirectoryForTests(directory),
  ];
  return { calls, created, restore: () => restores.reverse().forEach((r) => r()) };
}
const planeAgent = (handle: string, suspended = false): PlanePrincipal => ({
  id: `prn_${hex20()}`,
  kind: "agent",
  handle,
  displayName: handle,
  organizationId: "org_test",
  suspended,
  grant: null,
});
const planeRequest = (id: string, body: unknown) => request(id, body, planeActor);
const localPrincipalCount = async () => (await db.select().from(principals)).length;

test("under the plane, a new agent is created and linked remotely; the hub mints no principal of its own", async () => {
  onProvisionStation(async () => {}, "matrix.example");
  const plane = fakePlane();
  try {
    const id = await station(planeActor);
    const before = await localPrincipalCount();
    const body = { ...input(), dispatch: "none" };
    const res = await planeRequest(id, body);
    expect(res.status).toBe(200);
    const result = (await res.json()) as { principalId: string; matrix: { address: string | null } };
    expect(result.principalId).toBe(plane.created[0]!);
    // Deviation from the plan's "never inserts into principals": stations.principal_id is a
    // foreign key into principals until Task 17, so placement writes one mirror row carrying the
    // PLANE's id. Nothing is minted locally, and no identity or grant is written here.
    expect(await localPrincipalCount()).toBe(before + 1);
    expect(await db.select({ id: principals.id }).from(principals).where(eq(principals.handle, body.agent.handle))).toEqual([
      { id: result.principalId },
    ]);
    expect(await db.select().from(principalGrants).where(eq(principalGrants.principalId, result.principalId))).toEqual([]);
    expect(plane.calls).toEqual([
      `create ${body.agent.handle}`,
      `link ${result.principalId} matrix @agent_${body.agent.handle}:matrix.example`,
    ]);
    const [row] = await db.select().from(stations).where(eq(stations.id, id));
    expect(row!.principalId).toBe(result.principalId);
    // The address comes from the plane's handle, not a local principals row that does not exist.
    expect(result.matrix.address).toBe(`@agent_${body.agent.handle}:matrix.example`);
  } finally {
    plane.restore();
    onProvisionStation(null);
  }
});

test("under the plane, dispatch me appends the agent to the placing human's grant once; a retry never regrants", async () => {
  const plane = fakePlane({ humanGrant: { mayDispatch: ["prn_00000000000000000099"], mayGrantReach: true, scopes: ["runs:write"] } });
  try {
    const id = await station(planeActor);
    const body = input();
    const first = await planeRequest(id, body);
    expect(first.status).toBe(200);
    const { principalId } = (await first.json()) as { principalId: string };
    expect(plane.calls.filter((c) => c.startsWith("grant "))).toEqual([
      `grant ${planeActor} ${JSON.stringify({ mayDispatch: ["prn_00000000000000000099", principalId], mayGrantReach: true, scopes: ["runs:write"] })}`,
    ]);
    const retry = await planeRequest(id, body);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { principalId: string }).principalId).toBe(principalId);
    // The receipt answers the retry: no second agent, no second grant write.
    expect(plane.created).toHaveLength(1);
    expect(plane.calls.filter((c) => c.startsWith("grant "))).toHaveLength(1);
  } finally {
    plane.restore();
  }
});

test("under the plane, a dispatch grant the plane did not record is a 502 naming the placed agent, which stays placed and active", async () => {
  const plane = fakePlane({ grantFails: () => new OrgPlaneError(0, "unreachable") });
  try {
    const id = await station(planeActor);
    const res = await planeRequest(id, input());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { principalId: string };
    expect(body.principalId).toBe(plane.created[0]!);
    const [row] = await db.select().from(stations).where(eq(stations.id, id));
    expect(row!.principalId).toBe(body.principalId);
    expect(plane.calls.some((c) => c.startsWith("suspend "))).toBe(false);
  } finally {
    plane.restore();
  }
});

test("under the plane, a failure after the commit never suspends the agent the station now holds", async () => {
  const plane = fakePlane({ grantFails: () => new TypeError("a bug, not a refusal") });
  try {
    const id = await station(planeActor);
    expect((await planeRequest(id, input())).status).toBe(500);
    const [row] = await db.select().from(stations).where(eq(stations.id, id));
    expect(row!.principalId).toBe(plane.created[0]!);
    expect(plane.calls.some((c) => c.startsWith("suspend "))).toBe(false);
  } finally {
    plane.restore();
  }
});

test("under the plane, an occupied station refuses setup without creating an agent at the plane", async () => {
  const plane = fakePlane();
  try {
    const id = await station(planeActor);
    expect((await planeRequest(id, { ...input(), dispatch: "none" })).status).toBe(200);
    expect((await planeRequest(id, { ...input(), dispatch: "none" })).status).toBe(409);
    expect(plane.created).toHaveLength(1);
  } finally {
    plane.restore();
  }
});

test("under the plane, a placement that fails after the agent was created suspends that agent", async () => {
  let id = "";
  const occupant = `prn_${hex20()}`;
  await db.insert(principals).values({ id: occupant, kind: "agent", orgId: BOOTSTRAP_ORG_ID, handle: `setup-${run}-occupant` });
  // The station is taken between the hub's pre-check and its transaction.
  const plane = fakePlane({
    onCreate: async () => {
      await db.update(stations).set({ principalId: occupant }).where(eq(stations.id, id));
    },
  });
  try {
    id = await station(planeActor);
    const res = await planeRequest(id, { ...input(), dispatch: "none" });
    expect(res.status).toBe(409);
    expect(plane.created).toHaveLength(1);
    expect(plane.calls).toContain(`suspend ${plane.created[0]}`);
  } finally {
    plane.restore();
  }
});

test("under the plane, concurrent retries place one agent and suspend the one that lost", async () => {
  const plane = fakePlane();
  try {
    const id = await station(planeActor);
    const body = { ...input(), dispatch: "none" };
    const responses = await Promise.all([planeRequest(id, body), planeRequest(id, body)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const ids = await Promise.all(responses.map(async (r) => ((await r.json()) as { principalId: string }).principalId));
    expect(ids[0]).toBe(ids[1]!);
    const [row] = await db.select().from(stations).where(eq(stations.id, id));
    expect(row!.principalId).toBe(ids[0]!);
    // Every agent the plane created but the station did not take is suspended.
    for (const c of plane.created.filter((c) => c !== ids[0])) expect(plane.calls).toContain(`suspend ${c}`);
    expect(plane.calls).not.toContain(`suspend ${ids[0]}`);
  } finally {
    plane.restore();
  }
});

test("under the plane, an existing agent is checked at the plane, not in the local tables", async () => {
  const ok = planeAgent(`setup-${run}-plane-spare`);
  const susp = planeAgent(`setup-${run}-plane-susp`, true);
  const plane = fakePlane({ agents: [ok, susp] });
  try {
    const place = async (principalId: string) =>
      planeRequest(await station(planeActor), {
        requestId: crypto.randomUUID(),
        agent: { kind: "existing", principalId },
        dispatch: "none",
      });
    expect((await place(susp.id)).status).toBe(403);
    expect((await place(`prn_${hex20()}`)).status).toBe(404);
    expect((await place(planeActor)).status).toBe(404); // a human, not an agent
    const res = await place(ok.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { principalId: string }).principalId).toBe(ok.id);
    expect(plane.created).toHaveLength(0);
  } finally {
    plane.restore();
  }
});

test("under the plane, dispatch me needs the caller to be a principal, and is refused before any agent is created", async () => {
  const plane = fakePlane();
  try {
    // `actor` is a legacy user id, not a prn_: under the plane it names no human principal.
    const res = await request(await station(), input());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Your active operator identity is required to grant dispatch access",
    );
    expect(plane.created).toHaveLength(0);
  } finally {
    plane.restore();
  }
});

test("under the plane, the options list unplaced, unsuspended agents from the plane with their dispatchers", async () => {
  const free = planeAgent(`setup-${run}-plane-free`);
  const susp = planeAgent(`setup-${run}-plane-off`, true);
  const placed = planeAgent(`setup-${run}-plane-placed`);
  const plane = fakePlane({ agents: [free, susp, placed], humanGrant: { mayDispatch: [free.id], mayGrantReach: false, scopes: [] } });
  try {
    const id = await station(planeActor);
    await db.insert(principals).values({ id: placed.id, kind: "agent", orgId: BOOTSTRAP_ORG_ID, handle: placed.handle });
    await db.update(stations).set({ principalId: placed.id }).where(eq(stations.id, id));
    const options = (await (await app(planeActor).request("/station-setup/options")).json()) as {
      agents: { id: string; handle: string; displayName: string | null; dispatchers: string[] }[];
    };
    expect(options.agents).toEqual([{ id: free.id, handle: free.handle, displayName: free.displayName, dispatchers: [`setup-${run}-planeop`] }]);
  } finally {
    plane.restore();
  }
});

test("legacy setup still writes the local principal and receipt (no plane call)", async () => {
  const id = await station();
  const body = { ...input(), dispatch: "none" };
  const res = await request(id, body);
  expect(res.status).toBe(200);
  const { principalId } = (await res.json()) as { principalId: string };
  expect(await db.select().from(principals).where(eq(principals.id, principalId))).toHaveLength(1);
  expect(await db.select().from(stationSetups).where(eq(stationSetups.requestId, body.requestId))).toHaveLength(1);
});
