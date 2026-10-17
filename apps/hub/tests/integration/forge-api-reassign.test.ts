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
import {
  createForgeApiGrant,
  markGrantsRevoking,
  REVOKED_STATION_GONE,
} from "../../src/services/station-forge-api";
import { configureForgeApiReconcile, runForgeApiReconcile } from "../../src/services/forge-api-reconcile";
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
async function grantedStation(h: Harness, nodeId = NODE) {
  const agent = await newAgent(f);
  const st = await insertStation(f, nodeId, { principalId: agent.principalId });
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
