/**
 * Reassignment, unassignment, station deletion and node removal revoke forge API access
 * (spec 2026-10-17-forge-api-access-design, "Reassignment", "Station deletion and un-adopt").
 *
 * The guards: the station's live grants move to `revoking` in the SAME transaction as the occupancy
 * change or deletion (a rolled-back change leaves them live); nothing calls the forge or the node
 * inline, so a forge outage never blocks an occupancy change; a deleted station's grant survives as
 * a row with `station_id` NULL and is revoked later by the reconcile sweep; a new occupant inherits
 * nothing.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { db, rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { stationForgeApiGrants as g } from "../../src/db/schema/forge-api-grants";
import { agentsAdminRouter } from "../../src/routes/agents-admin";
import { unadopt } from "../../src/services/station-registry";
import { removeNode } from "../../src/services/node-removal";
import { destroyRuntime } from "../../src/services/runtimes";
import {
  createForgeApiGrant,
  deliverFaults,
  markGrantsRevoking,
  revokeGrant,
  rotateGrant,
  withGrantClaim,
  REVOKED_STATION_GONE,
} from "../../src/services/station-forge-api";
import {
  configureForgeApiReconcile,
  kickForgeApiRevoke,
  runForgeApiReconcile,
} from "../../src/services/forge-api-reconcile";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { forgetPrincipals } from "../helpers/principals";
import { pollUntil } from "../helpers/wait";
import {
  OFFLINE,
  assertNoLeak,
  captureConsole,
  grantInput,
  harness,
  insertNode,
  insertStation,
  loadGrant,
  newAgent,
  type Fixture,
  type Harness,
} from "../helpers/forge-api-harness";

const RUN = `far${crypto.randomUUID().slice(0, 8)}`;
const OWNER = `test-user-${RUN}`;
const NODE = `node_${RUN}`;
const f: Fixture = { run: RUN, owner: OWNER, tenant: "", handles: [], seq: 0 };

function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: OWNER, authType: "api_key", tenantId: f.tenant } as never);
    await next();
  });
  a.route("/", agentsAdminRouter);
  return a;
}

const put = (stationId: string, principalId: string) =>
  app().request(`/stations/${stationId}/agent`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId }),
  });
const del = (stationId: string) => app().request(`/stations/${stationId}/agent`, { method: "DELETE" });

/** An occupied station with a delivered minted grant. */
async function grantedStation(h: Harness, nodeId = NODE, parentStationId?: string) {
  const agent = await newAgent(f);
  const st = await insertStation(f, nodeId, { principalId: agent.principalId, parentStationId });
  const grant = await createForgeApiGrant(h.deps, grantInput(f, st.id));
  expect(grant.state).toBe("delivered");
  h.reset();
  return { st, agent, grant };
}

const auditFor = (grantId: string) =>
  rawSql`SELECT verb, params_summary FROM station_audit WHERE tenant_id = ${f.tenant} AND params_summary->>'grantId' = ${grantId} AND verb = 'forge.api.revoking'`;

/** Make any write to one station row fail, inside whatever transaction is writing it. */
async function failWritesTo(stationId: string, op: "UPDATE" | "DELETE") {
  const fn = `test_fail_${RUN}_${op.toLowerCase()}`;
  await rawSql.unsafe(`
    CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$
    BEGIN
      IF OLD.id = '${stationId}' THEN RAISE EXCEPTION 'injected failure for ${stationId}'; END IF;
      RETURN ${op === "DELETE" ? "OLD" : "NEW"};
    END $$ LANGUAGE plpgsql;
    CREATE TRIGGER ${fn} BEFORE ${op} ON stations FOR EACH ROW EXECUTE FUNCTION ${fn}();`);
  return async () => {
    await rawSql.unsafe(`DROP TRIGGER IF EXISTS ${fn} ON stations; DROP FUNCTION IF EXISTS ${fn}();`);
  };
}

let con: ReturnType<typeof captureConsole>;
beforeEach(() => {
  con = captureConsole();
});
afterEach(() => {
  con.restore();
  configureForgeApiReconcile(null);
  deliverFaults.beforeSend = undefined;
});

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: `${OWNER}@example.com`, name: "FAR" });
  f.tenant = await resolveTenantForUser(OWNER);
  await insertNode(f, NODE);
});

afterAll(async () => {
  await rawSql`DELETE FROM station_forge_api_grants WHERE station_id_snapshot LIKE ${`station_${RUN}_%`}`;
  await rawSql`DELETE FROM station_audit WHERE user_id = ${OWNER}`;
  await rawSql`DELETE FROM provisioned_runtimes WHERE user_id = ${OWNER}`;
  await rawSql`DELETE FROM stations WHERE user_id = ${OWNER}`;
  await rawSql`DELETE FROM nodes WHERE user_id = ${OWNER}`;
  await forgetPrincipals({ handles: f.handles });
});

describe("unassign", () => {
  test("unassign marks grants revoking in the same transaction and never calls the forge inline", async () => {
    const h = harness();
    const { st, grant } = await grantedStation(h);

    const res = await del(st.id);
    expect(res.status).toBe(200);

    const row = await loadGrant(grant.id);
    expect(row.state).toBe("revoking");
    expect(row.stateReason).toContain("provider-pending");
    expect(row.stateReason).toContain("wipe-pending");
    expect(row.stateReason).toContain("unassigned");
    expect(row.sealedBlob).toBeNull();
    // Never inline: no provider call and no node frame happened during the request.
    expect(h.revoked).toEqual([]);
    expect(h.calls).toEqual([]);
    const audit = await auditFor(grant.id);
    expect(audit.length).toBe(1);
    expect(audit[0]!.params_summary).toMatchObject({ grantId: grant.id, provider: "forgejo", mode: "minted", action: "revoking:unassigned" });
    await assertNoLeak(h, f, con.lines);
  });

  test("an unassign that rolls back leaves the grant live (same transaction)", async () => {
    const h = harness();
    const { st, grant } = await grantedStation(h);
    const restore = await failWritesTo(st.id, "UPDATE");
    try {
      const res = await del(st.id);
      expect(res.status).toBe(500);
    } finally {
      await restore();
    }
    expect((await loadGrant(grant.id)).state).toBe("delivered");
    expect((await auditFor(grant.id)).length).toBe(0);
  });

  test("markGrantsRevoking writes nothing outside the caller's transaction", async () => {
    const h = harness();
    const { st, grant } = await grantedStation(h);
    let ids: string[] = [];
    let inside: string | undefined;
    await db
      .transaction(async (tx) => {
        ids = await markGrantsRevoking(tx, { tenantId: f.tenant, stationId: st.id, cause: "unassigned", actor: OWNER });
        inside = (await tx.select().from(g).where(eq(g.id, grant.id)))[0]?.state;
        throw new Error("roll back");
      })
      .catch(() => undefined);
    expect(ids).toEqual([grant.id]);
    expect(inside).toBe("revoking");
    expect((await loadGrant(grant.id)).state).toBe("delivered");
    expect((await auditFor(grant.id)).length).toBe(0);
  });
});

describe("assign / move / evict", () => {
  test("forge down during reassignment does not block it", async () => {
    const h = harness();
    const { st, grant } = await grantedStation(h);
    const other = await newAgent(f);
    // The forge hangs (then fails) and the node is offline. The out-of-band kick that follows the
    // commit reaches the hung forge; the assignment must answer without waiting for it.
    let forgeDown!: () => void;
    const hung = new Promise<void>((_, reject) => (forgeDown = () => reject(new Error("forge: revoking was refused (HTTP 503)."))));
    hung.catch(() => undefined);
    const realRevoke = h.provider.revoke!;
    h.provider.revoke = async (account, handle) => {
      await hung;
      return realRevoke(account, handle);
    };
    h.replies["forge.api.revoke"] = () => OFFLINE;
    configureForgeApiReconcile(h.deps, { schedule: false });

    const res = await Promise.race([
      put(st.id, other.principalId),
      new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 3000)),
    ]);
    expect(res === "blocked" ? res : res.status).toBe(200);
    expect((await loadGrant(grant.id)).state).toBe("revoking");
    forgeDown();
    // The kick did run, out of band, and the outage left it pending — never blocked, never lost.
    const settled = await pollUntil(async () => {
      const r = await loadGrant(grant.id);
      return r.stateReason?.startsWith("provider-pending: forge") ? r : null;
    });
    expect(settled.state).toBe("revoking");
    expect(settled.stateReason).toContain("wipe-pending");
  });

  test("an assignment that rolls back leaves the evicted occupant's grant live", async () => {
    const h = harness();
    const { st, grant } = await grantedStation(h);
    const other = await newAgent(f);
    const restore = await failWritesTo(st.id, "UPDATE");
    try {
      expect((await put(st.id, other.principalId)).status).toBe(500);
    } finally {
      await restore();
    }
    expect((await loadGrant(grant.id)).state).toBe("delivered");
  });

  test("move vacates the old station's grants", async () => {
    const h = harness();
    const { st, agent, grant } = await grantedStation(h);
    const target = await insertStation(f, NODE);

    expect((await put(target.id, agent.principalId)).status).toBe(200);

    const row = await loadGrant(grant.id);
    expect(row.state).toBe("revoking");
    expect(row.stateReason).toContain("reassigned");
    expect(row.stationId).toBe(st.id);
    // The principal arrives at the new station with nothing.
    const there = await rawSql`SELECT id FROM station_forge_api_grants WHERE station_id_snapshot = ${target.id}`;
    expect(there.length).toBe(0);
    expect(h.minted).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("re-assigning the same principal to the same station is a no-op for grants", async () => {
    const h = harness();
    const { st, agent, grant } = await grantedStation(h);
    expect((await put(st.id, agent.principalId)).status).toBe(200);
    const row = await loadGrant(grant.id);
    expect(row.state).toBe("delivered");
    expect((await auditFor(grant.id)).length).toBe(0);
  });

  test("new occupant gets no grant (evict)", async () => {
    const h = harness();
    const { st, grant } = await grantedStation(h);
    const other = await newAgent(f);

    expect((await put(st.id, other.principalId)).status).toBe(200);

    expect((await loadGrant(grant.id)).state).toBe("revoking");
    const live = await rawSql`SELECT id FROM station_forge_api_grants WHERE station_id_snapshot = ${st.id} AND state NOT IN ('revoking','revoked')`;
    expect(live.length).toBe(0);
    expect(h.minted).toEqual([]);
    const audit = await auditFor(grant.id);
    expect(audit[0]!.params_summary).toMatchObject({ action: "revoking:reassigned" });
  });
});

describe("station deletion and node removal", () => {
  test("deleting a station with a live grant keeps the row (station_id NULL) in revoking; reconcile revokes it via the snapshot", async () => {
    const h = harness();
    const { st, grant } = await grantedStation(h);

    await unadopt(OWNER, st.id);

    expect((await rawSql`SELECT id FROM stations WHERE id = ${st.id}`).length).toBe(0);
    const row = await loadGrant(grant.id);
    expect(row.stationId).toBeNull();
    expect(row.stationIdSnapshot).toBe(st.id);
    expect(row.state).toBe("revoking");
    expect(row.stateReason).toContain("station-deleted");
    expect(h.calls).toEqual([]);
    expect(h.revoked).toEqual([]);

    const report = await runForgeApiReconcile(h.deps);
    const done = await loadGrant(grant.id);
    expect(done.state).toBe("revoked");
    expect(done.stateReason).toBe(REVOKED_STATION_GONE);
    // The sweep covers every grant in the database; this one's token is among those revoked.
    expect(h.revoked.map((r) => r.name)).toContain(grant.tokenHandle!.name);
    expect(report.actions.some((a) => a.grantId === grant.id && a.action === "revoke")).toBe(true);
    await assertNoLeak(h, f, con.lines, [report]);
  });

  test("a station deletion that rolls back leaves its grant live", async () => {
    const h = harness();
    const { st, grant } = await grantedStation(h);
    const restore = await failWritesTo(st.id, "DELETE");
    try {
      await expect(unadopt(OWNER, st.id)).rejects.toThrow();
    } finally {
      await restore();
    }
    const row = await loadGrant(grant.id);
    expect(row.state).toBe("delivered");
    expect(row.stationId).toBe(st.id);
  });

  test("un-adopting a node revokes every grant on it", async () => {
    const h = harness();
    const node = `node_${RUN}_rm`;
    await insertNode(f, node);
    await rawSql`UPDATE nodes SET status = 'offline' WHERE id = ${node}`;
    const a = await grantedStation(h, node);
    const b = await grantedStation(h, node);

    const out = await removeNode(OWNER, node, { force: true });
    expect(out.kind).toBe("removed");
    for (const { grant } of [a, b]) {
      const row = await loadGrant(grant.id);
      expect(row.state).toBe("revoking");
      expect(row.stationId).toBeNull();
      expect(row.stateReason).toContain("node-removed");
    }
    expect(h.calls).toEqual([]);

    await runForgeApiReconcile(h.deps);
    for (const { grant } of [a, b]) expect((await loadGrant(grant.id)).state).toBe("revoked");
    expect(h.revoked.map((r) => r.name)).toEqual(expect.arrayContaining([a.grant.tokenHandle!.name, b.grant.tokenHandle!.name]));
    await assertNoLeak(h, f, con.lines);
  });
});

describe("cascades: child stations and runtime destroy", () => {
  async function expectDeleted(grantId: string, stationId: string, cause: string) {
    const row = await loadGrant(grantId);
    expect(row.state).toBe("revoking");
    expect(row.stationId).toBeNull();
    expect(row.stationIdSnapshot).toBe(stationId);
    expect(row.stateReason).toContain(cause);
  }

  test("deleting a parent station marks its descendants' grants in the same transaction", async () => {
    const h = harness();
    const parent = await grantedStation(h);
    const child = await grantedStation(h, NODE, parent.st.id);
    const grandchild = await grantedStation(h, NODE, child.st.id);

    await unadopt(OWNER, parent.st.id);

    for (const x of [parent, child, grandchild]) await expectDeleted(x.grant.id, x.st.id, "station-deleted");
    expect((await auditFor(child.grant.id)).length).toBe(1);
    expect(h.calls).toEqual([]);
  });

  test("a parent deletion that rolls back leaves the child's grant live", async () => {
    const h = harness();
    const parent = await grantedStation(h);
    const child = await grantedStation(h, NODE, parent.st.id);
    const restore = await failWritesTo(parent.st.id, "DELETE");
    try {
      await expect(unadopt(OWNER, parent.st.id)).rejects.toThrow();
    } finally {
      await restore();
    }
    expect((await loadGrant(child.grant.id)).state).toBe("delivered");
  });

  for (const order of ["parent-first", "child-first"] as const) {
    test(`node removal with a parent/child pair (${order}) marks both`, async () => {
      const h = harness();
      const node = `node_${RUN}_pc_${order}`;
      await insertNode(f, node);
      await rawSql`UPDATE nodes SET status = 'offline' WHERE id = ${node}`;
      let parent, child;
      if (order === "parent-first") {
        parent = await grantedStation(h, node);
        child = await grantedStation(h, node, parent.st.id);
      } else {
        // The child row is inserted (and so listed) before its parent.
        const tmp = await insertStation(f, node);
        child = await grantedStation(h, node, tmp.id);
        parent = await grantedStation(h, node);
        await rawSql`UPDATE stations SET parent_station_id = ${parent.st.id} WHERE id = ${child.st.id}`;
        await unadopt(OWNER, tmp.id);
      }
      expect((await removeNode(OWNER, node, { force: true })).kind).toBe("removed");
      await expectDeleted(parent.grant.id, parent.st.id, "node-removed");
      await expectDeleted(child.grant.id, child.st.id, "node-removed");
    });
  }

  test("destroying a provisioned runtime marks its stations' grants", async () => {
    const h = harness();
    const node = `node_${RUN}_rt`;
    await insertNode(f, node);
    const rt = `rt_${RUN}`;
    await rawSql`
      INSERT INTO provisioned_runtimes (tenant_id, id, user_id, provider, external_id, status, name, resource_tier, harness, node_id, created_at, updated_at)
      VALUES (${f.tenant}, ${rt}, ${OWNER}, 'docker', NULL, 'online', ${rt}, 'small', 'none', ${node}, now(), now())`;
    const x = await grantedStation(h, node);

    await destroyRuntime(OWNER, rt);

    expect((await rawSql`SELECT id FROM nodes WHERE id = ${node}`).length).toBe(0);
    await expectDeleted(x.grant.id, x.st.id, "node-removed");
    expect(h.calls).toEqual([]);
  });
});

describe("deliver after the mark", () => {
  const mark = (stationId: string) =>
    db.transaction((tx) => markGrantsRevoking(tx, { tenantId: f.tenant, stationId, cause: "unassigned", actor: OWNER }));

  test("a rotation whose grant is marked between blob persist and send sends no frame", async () => {
    const h = harness();
    const { st, agent, grant } = await grantedStation(h);
    h.setLogin(agent.handle);
    deliverFaults.beforeSend = async () => {
      await mark(st.id);
    };
    const err = await rotateGrant(h.deps, { tenantId: f.tenant, grantId: grant.id }).catch((e) => e);
    deliverFaults.beforeSend = undefined;
    expect(err?.code).toBe("grant-revoking");
    expect(h.callsOf("forge.api.deliver")).toEqual([]);
    const row = await loadGrant(grant.id);
    expect(row.state).toBe("revoking");
    // The revoke that follows takes both generations back.
    await revokeGrant(h.deps, { tenantId: f.tenant, grantId: grant.id });
    expect(h.revoked.map((r) => r.name).sort()).toEqual([grant.tokenHandle!.name, row.tokenHandle!.name].sort());
    await assertNoLeak(h, f, con.lines, [err]);
  });

  test("a first delivery whose grant is marked before send sends no frame", async () => {
    const h = harness();
    const agent = await newAgent(f);
    const st = await insertStation(f, NODE, { principalId: agent.principalId });
    deliverFaults.beforeSend = async () => {
      await mark(st.id);
    };
    const err = await createForgeApiGrant(h.deps, grantInput(f, st.id)).catch((e) => e);
    expect(err?.code).toBe("grant-revoking");
    expect(h.callsOf("forge.api.deliver")).toEqual([]);
  });

  test("an ack that lands after revocation began re-queues the node wipe", async () => {
    const h = harness();
    const agent = await newAgent(f);
    const st = await insertStation(f, NODE, { principalId: agent.principalId });
    let grantId = "";
    h.replies["forge.api.deliver"] = async (params) => {
      grantId = (params as { grantId: string }).grantId;
      // Revocation began and its wipe already ran: only the provider side is outstanding.
      await rawSql`UPDATE station_forge_api_grants SET state = 'revoking', state_reason = 'provider-pending: forge down', sealed_blob = NULL, sealed_expires_at = NULL WHERE id = ${grantId}`;
      return { ok: true, data: { ok: true, stored: true, isolation: "same-user" } };
    };
    const err = await createForgeApiGrant(h.deps, grantInput(f, st.id)).catch((e) => e);
    expect(err?.code).toBe("grant-revoking");
    expect((await loadGrant(grantId)).stateReason).toContain("wipe-pending");
    h.reset();
    await revokeGrant(h.deps, { tenantId: f.tenant, grantId });
    expect(h.callsOf("forge.api.revoke").length).toBe(1);
    expect((await loadGrant(grantId)).state).toBe("revoked");
  });

  test("the post-commit kick retries grant-busy before deferring to the sweep", async () => {
    const h = harness();
    const { st, grant } = await grantedStation(h);
    await mark(st.id);
    configureForgeApiReconcile(h.deps, { schedule: false, kickBackoffMs: 30 });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const holder = withGrantClaim(f.tenant, grant.id, async () => {
      entered();
      await held;
    });
    await inside;
    kickForgeApiRevoke([{ tenantId: f.tenant, grantId: grant.id }]);
    await new Promise((r) => setTimeout(r, 40));
    release();
    await holder;
    const done = await pollUntil(async () => ((await loadGrant(grant.id)).state === "revoked" ? true : null));
    expect(done).toBe(true);
  });
});
