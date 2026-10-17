/**
 * The forge API reconcile sweep (spec 2026-10-17-forge-api-access-design, "Reconcile", "Node
 * offline", "Sealed-blob expiry", "Version skew").
 *
 * The guards: it acts through the lifecycle service only, so every step is claim-guarded and
 * idempotent; a rotating row without a blob is VERIFIED (which undoes the rotation), never
 * re-delivered; an expired rotation blob undoes the rotation; superseded and orphan handles are
 * revoked; tokens the provider lists that no row knows are REPORTED, never deleted; one failing
 * grant never stops the sweep; a node without `forge.api` receives no frame; ticks never overlap;
 * timers stop; no token reaches any sink.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { connectionManager } from "../../src/services/connection-manager";
import {
  createForgeApiGrant,
  revokeGrant,
  rotateGrant,
  verifyGrant,
  withGrantClaim,
} from "../../src/services/station-forge-api";
import {
  configureForgeApiReconcile,
  createFailureTracker,
  forgeApiReconcileTimerActive,
  runForgeApiReconcile,
  tickForgeApiReconcile,
} from "../../src/services/forge-api-reconcile";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { forgetPrincipals } from "../helpers/principals";
import { pollUntil } from "../helpers/wait";
import {
  ACK,
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

const RUN = `frc${crypto.randomUUID().slice(0, 8)}`;
const OWNER = `test-user-${RUN}`;
const f: Fixture = { run: RUN, owner: OWNER, tenant: "", handles: [], seq: 0 };
let nodeSeq = 0;

/** Each test gets its own node so a sweep scoped to "this node" sees only this test's grants. */
async function freshNode() {
  const id = `node_${RUN}_${nodeSeq++}`;
  await insertNode(f, id);
  return id;
}

/** A node-scoped run: only this test's grants, every node treated as online unless said. */
const run = (h: Harness, nodeId: string, extra: Record<string, unknown> = {}) =>
  runForgeApiReconcile({ ...h.deps, nodeId, isNodeOnline: () => true, failures: createFailureTracker(), ...extra });

async function granted(h: Harness, nodeId: string, opts: { capabilities?: string[] } = {}) {
  const agent = await newAgent(f);
  const st = await insertStation(f, nodeId, { principalId: agent.principalId, capabilities: opts.capabilities });
  h.setLogin(agent.handle);
  const grant = await createForgeApiGrant(h.deps, grantInput(f, st.id));
  return { st, agent, grant, ref: { tenantId: f.tenant, grantId: grant.id } };
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
  await createTestUser({ id: OWNER, email: `${OWNER}@example.com`, name: "FRC" });
  f.tenant = await resolveTenantForUser(OWNER);
});

afterAll(async () => {
  await rawSql`DELETE FROM station_forge_api_grants WHERE station_id_snapshot LIKE ${`station_${RUN}_%`}`;
  await rawSql`DELETE FROM station_audit WHERE user_id = ${OWNER} OR (verb LIKE 'forge.api.reconcile.%' AND params_summary->>'username' LIKE ${`${RUN}%`})`;
  await rawSql`DELETE FROM stations WHERE user_id = ${OWNER}`;
  await rawSql`DELETE FROM nodes WHERE user_id = ${OWNER}`;
  await forgetPrincipals({ handles: f.handles });
});

describe("revoking grants", () => {
  test("reconcile revokes at the provider and then wipes on node reconnect", async () => {
    const h = harness();
    const node = await freshNode();
    const { grant, ref } = await granted(h, node);
    // Node offline: the provider side completes, the wipe is queued.
    h.replies["forge.api.revoke"] = () => OFFLINE;
    await rawSql`UPDATE station_forge_api_grants SET state = 'revoking', state_reason = 'provider-pending; wipe-pending; cause: unassigned' WHERE id = ${grant.id}`;
    h.reset();

    await run(h, node, { isNodeOnline: () => false });
    let row = await loadGrant(grant.id);
    expect(h.revoked.map((r) => r.name)).toEqual([grant.tokenHandle!.name]);
    expect(row.state).toBe("revoking");
    expect(row.stateReason).toStartWith("wipe-pending");

    // The node reconnects: the wipe goes out and the grant is a tombstone. The provider is not asked again.
    h.replies["forge.api.revoke"] = () => ({ ok: true, data: { removed: true } });
    h.reset();
    configureForgeApiReconcile({ ...h.deps, isNodeOnline: () => true, failures: createFailureTracker() }, { schedule: false });
    connectionManager.register(node, () => undefined);
    try {
      row = await pollUntil(async () => {
        const r = await loadGrant(grant.id);
        return r.state === "revoked" ? r : null;
      });
    } finally {
      connectionManager.unregister(node);
    }
    expect(h.callsOf("forge.api.revoke").map((c) => (c.params as { grantId: string }).grantId)).toEqual([grant.id]);
    expect(h.revoked).toEqual([]);
    expect(row.stateReason).toBeNull();
    await assertNoLeak(h, f, con.lines);
    void ref;
  });

  test("a node without forge.api gets no frame; its wipe stays wipe-pending", async () => {
    const h = harness();
    const node = await freshNode();
    const { st, grant } = await granted(h, node);
    await rawSql`UPDATE stations SET capabilities = '["acp"]'::jsonb WHERE id = ${st.id}`;
    await rawSql`UPDATE station_forge_api_grants SET state = 'revoking', state_reason = 'provider-pending; wipe-pending' WHERE id = ${grant.id}`;
    h.reset();

    const report = await run(h, node);
    const row = await loadGrant(grant.id);
    expect(h.calls).toEqual([]);
    expect(h.revoked.length).toBe(1);
    expect(row.state).toBe("revoking");
    expect(row.stateReason).toContain("wipe-pending");
    expect(row.stateReason).toContain("forge.api");
    void report;
  });
});

describe("delivery retries", () => {
  test("provisioned grant with a live blob is re-sent once the node is back, without a re-mint", async () => {
    const h = harness();
    const node = await freshNode();
    h.replies["forge.api.deliver"] = () => OFFLINE;
    const { grant } = await granted(h, node);
    expect(grant.state).toBe("provisioned");
    h.replies["forge.api.deliver"] = () => ACK;
    h.reset();

    await run(h, node);
    const row = await loadGrant(grant.id);
    expect(row.state).toBe("delivered");
    expect(row.generation).toBe(grant.generation);
    expect(h.minted).toEqual([]);
    expect(h.callsOf("forge.api.deliver").length).toBe(1);
  });

  test("an offline node is skipped, not retried into a failure", async () => {
    const h = harness();
    const node = await freshNode();
    h.replies["forge.api.deliver"] = () => OFFLINE;
    const { grant } = await granted(h, node);
    h.reset();
    const report = await run(h, node, { isNodeOnline: () => false });
    expect(h.calls).toEqual([]);
    expect(report.skipped).toContainEqual({ grantId: grant.id, why: "node-offline" });
  });

  test("expired sealed blob → revoke + re-mint generation+1", async () => {
    const h = harness();
    const node = await freshNode();
    h.replies["forge.api.deliver"] = () => OFFLINE;
    const { grant } = await granted(h, node);
    await rawSql`UPDATE station_forge_api_grants SET sealed_expires_at = now() - interval '1 minute' WHERE id = ${grant.id}`;
    h.replies["forge.api.deliver"] = () => ACK;
    h.reset();

    await run(h, node);
    const row = await loadGrant(grant.id);
    expect(h.revoked.map((r) => r.name)).toEqual([grant.tokenHandle!.name]);
    expect(h.minted.length).toBe(1);
    expect(row.generation).toBe(grant.generation + 1);
    expect(row.tokenHandle!.name).not.toBe(grant.tokenHandle!.name);
    expect(row.state).toBe("delivered");
    await assertNoLeak(h, f, con.lines);
  });

  test("a no-capability node is skipped and reported", async () => {
    const h = harness();
    const node = await freshNode();
    h.replies["forge.api.deliver"] = () => OFFLINE;
    const { st, grant } = await granted(h, node);
    await rawSql`UPDATE stations SET capabilities = '["acp"]'::jsonb WHERE id = ${st.id}`;
    h.reset();
    const report = await run(h, node);
    expect(h.calls).toEqual([]);
    expect(report.skipped).toContainEqual({ grantId: grant.id, why: "node-lacks-forge.api" });
    expect((await loadGrant(grant.id)).state).toBe("provisioned");
  });

  test("policy-pending is re-sent on reconnect", async () => {
    const h = harness();
    const node = await freshNode();
    const { grant } = await granted(h, node);
    await rawSql`UPDATE station_forge_api_grants SET state_reason = 'policy-pending: node offline', preset = 'issues' WHERE id = ${grant.id}`;
    h.reset();
    await run(h, node);
    const frames = h.callsOf("forge.api.policy");
    expect(frames.length).toBe(1);
    expect((frames[0]!.params as { preset: string }).preset).toBe("issues");
    expect((await loadGrant(grant.id)).stateReason).toBeNull();
  });
});

describe("rotations", () => {
  test("rotating crash (i): no blob, no ack → verifyGrant undoes the rotation; nothing is delivered", async () => {
    const h = harness();
    const node = await freshNode();
    const { grant } = await granted(h, node);
    const g1 = grant.tokenHandle!.name;
    const g2 = `agentpod-${grant.id}-g${grant.generation + 1}`;
    const handle = {
      name: g2,
      previous: { ...grant.tokenHandle!, disposition: "live-until-verified", generation: grant.generation, deliveredAt: grant.deliveredAt!.toISOString() },
    };
    await rawSql`UPDATE station_forge_api_grants SET token_handle = ${JSON.stringify(handle)}::jsonb, generation = ${grant.generation + 1}, delivered_at = NULL, state_reason = 'rotation-pending: minting' WHERE id = ${grant.id}`;
    h.reset();

    await run(h, node);
    const row = await loadGrant(grant.id);
    expect(h.callsOf("forge.api.deliver")).toEqual([]);
    expect(row.tokenHandle!.name).toBe(g1);
    expect(row.tokenHandle!.previous).toBeUndefined();
    expect(row.generation).toBe(grant.generation);
    expect(row.stateReason).toStartWith("rotation-failed");
    expect(h.revoked.map((r) => r.name)).toEqual([g2]);
  });

  test("rotating (ii): a live unacknowledged blob is re-sent, verified, and the old token revoked", async () => {
    const h = harness();
    const node = await freshNode();
    const { grant, ref } = await granted(h, node);
    h.replies["forge.api.deliver"] = () => OFFLINE;
    const pending = await rotateGrant(h.deps, ref);
    expect(pending.sealedBlob).not.toBeNull();
    h.replies["forge.api.deliver"] = () => ACK;
    h.reset();

    await run(h, node);
    const row = await loadGrant(grant.id);
    expect(row.state).toBe("verified");
    expect(row.tokenHandle!.previous).toBeUndefined();
    expect(h.revoked.map((r) => r.name)).toEqual([grant.tokenHandle!.name]);
    await assertNoLeak(h, f, con.lines);
  });

  test("rotating with an expired blob and no ack → the rotation is undone (n+1 revoked, n restored)", async () => {
    const h = harness();
    const node = await freshNode();
    const { grant, ref } = await granted(h, node);
    h.replies["forge.api.deliver"] = () => OFFLINE;
    const pending = await rotateGrant(h.deps, ref);
    await rawSql`UPDATE station_forge_api_grants SET sealed_expires_at = now() - interval '1 minute' WHERE id = ${grant.id}`;
    h.reset();

    await run(h, node, { isNodeOnline: () => false });
    const row = await loadGrant(grant.id);
    expect(h.revoked.map((r) => r.name)).toEqual([pending.tokenHandle!.name]);
    expect(row.tokenHandle!.name).toBe(grant.tokenHandle!.name);
    expect(row.tokenHandle!.previous).toBeUndefined();
    expect(row.generation).toBe(grant.generation);
    expect(row.sealedBlob).toBeNull();
    expect(row.stateReason).toStartWith("rotation-failed");
  });

  test("a previous with disposition revoke and an orphan handle are revoked and cleared", async () => {
    const h = harness();
    const node = await freshNode();
    const { grant, ref } = await granted(h, node);
    expect((await verifyGrant(h.deps, ref)).outcome).toBe("verified");
    const cur = grant.tokenHandle!;
    const handle = { ...cur, previous: { name: "agentpod-old-g0", disposition: "revoke" }, orphan: { name: "agentpod-orphan-g9" } };
    await rawSql`UPDATE station_forge_api_grants SET token_handle = ${JSON.stringify(handle)}::jsonb, state_reason = 'previous-revoke-pending: HTTP 503' WHERE id = ${grant.id}`;
    h.reset();

    await run(h, node, { isNodeOnline: () => false });
    const row = await loadGrant(grant.id);
    expect(h.revoked.map((r) => r.name).sort()).toEqual(["agentpod-old-g0", "agentpod-orphan-g9"]);
    expect(row.tokenHandle).toEqual(cur);
    expect(row.state).toBe("verified");
    expect(row.stateReason).toBeNull();
  });
});

describe("orphan scan", () => {
  test("orphan token found by name prefix is reported and NOT deleted", async () => {
    const h = harness();
    const node = await freshNode();
    const { agent, grant } = await granted(h, node);
    const ghost = `agentpod-fag_ghost${RUN}-g1`;
    h.tokens.set(agent.handle, [grant.tokenHandle!.name, ghost, "someone-elses-token"]);
    h.reset();

    const report = await runForgeApiReconcile({ ...h.deps, isNodeOnline: () => true, failures: createFailureTracker() });
    const mine = report.orphans.filter((o) => o.account === agent.handle);
    expect(mine).toEqual([{ provider: "forgejo", instance: grant.instance, account: agent.handle, name: ghost }]);
    expect(h.revoked.map((r) => r.name)).not.toContain(ghost);
    expect(h.tokens.get(agent.handle)).toContain(ghost);
    const audit = await rawSql`SELECT params_summary FROM station_audit WHERE verb = 'forge.api.reconcile.orphan' AND params_summary->>'key' = ${ghost}`;
    expect(audit.length).toBe(1);
    expect(audit[0]!.params_summary).toMatchObject({ provider: "forgejo", username: agent.handle, key: ghost });
  });
});

describe("robustness", () => {
  test("one failing grant doesn't abort the sweep", async () => {
    const h = harness();
    const node = await freshNode();
    h.replies["forge.api.deliver"] = () => OFFLINE;
    const bad = await granted(h, node);
    const good = await granted(h, node);
    await rawSql`UPDATE station_forge_api_grants SET sealed_expires_at = now() - interval '1 minute' WHERE id = ${bad.grant.id}`;
    await rawSql`UPDATE station_forge_api_grants SET state = 'revoking', state_reason = 'provider-pending; wipe-pending', sealed_blob = NULL, sealed_expires_at = NULL WHERE id = ${good.grant.id}`;
    // The bad grant's station key cannot be fetched, so its re-mint throws.
    h.replies["forge.api.status"] = () => ({ ok: false, error: "station exploded" });
    h.replies["forge.api.deliver"] = () => ACK;
    h.reset();

    const report = await run(h, node);
    expect((await loadGrant(good.grant.id)).state).toBe("revoked");
    expect(report.errors.map((e) => e.grantId)).toEqual([bad.grant.id]);
    expect(report.errors[0]!.error).toContain("station-key-unavailable");
    await assertNoLeak(h, f, con.lines, [report]);
  });

  test("a grant failing the same way three sweeps in a row is written to the audit log once", async () => {
    const h = harness();
    const node = await freshNode();
    const { grant } = await granted(h, node);
    await rawSql`UPDATE station_forge_api_grants SET state = 'revoking', state_reason = 'provider-pending; wipe-pending' WHERE id = ${grant.id}`;
    h.failRevoke.all = true;
    const failures = createFailureTracker();
    const reports = [];
    for (let i = 0; i < 4; i++) reports.push(await run(h, node, { failures }));
    expect(reports.map((r) => r.repeatedFailures.includes(grant.id))).toEqual([false, false, true, true]);
    const audit = await rawSql`SELECT params_summary FROM station_audit WHERE verb = 'forge.api.reconcile.failing' AND params_summary->>'grantId' = ${grant.id}`;
    expect(audit.length).toBe(1);
  });

  test("claim grant-busy is skipped and reported", async () => {
    const h = harness();
    const node = await freshNode();
    const { grant } = await granted(h, node);
    await rawSql`UPDATE station_forge_api_grants SET state = 'revoking', state_reason = 'provider-pending; wipe-pending' WHERE id = ${grant.id}`;
    h.reset();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const holder = withGrantClaim(f.tenant, grant.id, async () => {
      entered();
      await held;
    });
    await inside;
    try {
      const report = await run(h, node);
      expect(report.skipped).toContainEqual({ grantId: grant.id, why: "grant-busy" });
      expect(h.revoked).toEqual([]);
      expect((await loadGrant(grant.id)).state).toBe("revoking");
    } finally {
      release();
      await holder;
    }
  });
});

describe("scheduling", () => {
  test("overlap guard: a tick while one runs is skipped", async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const inFirst = new Promise<void>((r) => (started = r));
    const slow = { ...h.provider, listTokens: async () => { started(); await gate; return []; } };
    const node = await freshNode();
    await granted(h, node);
    configureForgeApiReconcile({ ...h.deps, providers: () => slow, isNodeOnline: () => false, failures: createFailureTracker() }, { schedule: false });

    const first = tickForgeApiReconcile();
    await inFirst;
    const second = await tickForgeApiReconcile();
    expect(second).toBeNull();
    release();
    expect(await first).not.toBeNull();
  });

  test("timers cleaned up: start schedules an unref'd interval, stop clears it", () => {
    const h = harness();
    expect(forgeApiReconcileTimerActive()).toBe(false);
    configureForgeApiReconcile(h.deps, { intervalMs: 60_000 });
    expect(forgeApiReconcileTimerActive()).toBe(true);
    configureForgeApiReconcile(null);
    expect(forgeApiReconcileTimerActive()).toBe(false);
  });

  test("hook parity: onNodeOnline reconciles only that node's grants and never throws into registration", async () => {
    const h = harness();
    const nodeA = await freshNode();
    const nodeB = await freshNode();
    const a = await granted(h, nodeA);
    const b = await granted(h, nodeB);
    for (const x of [a, b]) {
      await rawSql`UPDATE station_forge_api_grants SET state = 'revoking', state_reason = 'provider-pending; wipe-pending' WHERE id = ${x.grant.id}`;
    }
    configureForgeApiReconcile({ ...h.deps, isNodeOnline: () => true, failures: createFailureTracker() }, { schedule: false });
    connectionManager.register(nodeA, () => undefined);
    try {
      await pollUntil(async () => ((await loadGrant(a.grant.id)).state === "revoked" ? true : null));
    } finally {
      connectionManager.unregister(nodeA);
    }
    expect((await loadGrant(b.grant.id)).state).toBe("revoking");

    // A sweep that throws is logged, not thrown into the node's registration.
    const broken = { select: () => { throw new Error("boom"); } } as unknown as typeof h.deps.db;
    configureForgeApiReconcile({ ...h.deps, db: broken, failures: createFailureTracker() }, { schedule: false });
    expect(() => connectionManager.register(nodeB, () => undefined)).not.toThrow();
    connectionManager.unregister(nodeB);
    await pollUntil(() => con.lines.some((l) => l.includes("forge api reconcile failed")));
    await revokeGrant(h.deps, b.ref);
  });
});
