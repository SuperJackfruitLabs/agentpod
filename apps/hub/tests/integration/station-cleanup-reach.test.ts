import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { setGrant } from "../../src/services/grants";
import { createPrincipal } from "../../src/services/principals";
import { stationCleanupRoutes } from "../../src/routes/station-cleanup";
import { stationChangesetRoutes } from "../../src/routes/station-changeset";
import { stationLifecycleRoutes } from "../../src/routes/station-lifecycle";

/**
 * Where the line falls inside a single capability, and where it does not fall
 * at all.
 *
 * `cleanup` covers a read (`plan`) and a destruction (`apply`) under one word,
 * so the classification alone cannot decide — the route's effect has to. And the
 * negative cases below are the ones that matter most: an over-broad
 * classification refuses people work they are entitled to do, which is how a
 * control gets switched off rather than narrowed.
 */

const USER = "test-user-cleanup-reach";
const NODE = "node_cleanup_reach";
const STATION = "station_cleanup_reach";

let USER_PRINCIPAL: string;
/** The agent occupying STATION — the matcher compares a grant against this now. */
let AGENT_PRINCIPAL: string;

function mount(routes: Hono) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: USER, role: "user" });
    await next();
  });
  a.route("/", routes);
  return a;
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER, email: "cleanup-reach@example.com", name: "CR" });
  USER_PRINCIPAL = await createPrincipal({ kind: "human", handle: "cleanup-reach-it-user", userId: USER });
  AGENT_PRINCIPAL = await createPrincipal({ kind: "agent", handle: "cleanup-reach-it-agent" });
  const tenant = await resolveTenantForUser(USER);
  await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${USER}, 'cleanup-box', 'cleanup-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, principal_id, adopted_at, created_at)
    VALUES (${STATION}, ${tenant}, ${USER}, ${NODE}, 'hermes', 'hermes:cleanup', 'leaf', 'Cleanup',
            '["cleanup","changeset","lifecycle"]'::jsonb, ${AGENT_PRINCIPAL}, now(), now())`;
  process.env.ENFORCE_CONTROL_PAIR = "true";
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM station_audit WHERE user_id = ${USER}`;
    await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${USER_PRINCIPAL}`;
    await rawSql`DELETE FROM principal_identities WHERE external_id = ${USER}`;
    await rawSql`DELETE FROM principals WHERE handle IN ('cleanup-reach-it-user', 'cleanup-reach-it-agent')`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

function post(routes: Hono, path: string, body: Record<string, unknown> = {}) {
  return mount(routes).request(`/stations/${STATION}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Dispatch as wide as it goes, and no reach — the principal this control is for. */
async function dispatchOnly() {
  await setGrant(USER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
}

describe("cleanup splits on the effect, not the capability", () => {
  test("apply is refused without reach", async () => {
    await dispatchOnly();

    const res = await post(stationCleanupRoutes, "cleanup/apply", { paths: ["node_modules"] });

    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/permission to change this agent/i);
  });

  test("plan is not, because looking is not changing", async () => {
    // Guarding the capability word would refuse someone permission to find out
    // what a cleanup would delete — a read, and the one you want before the write.
    await dispatchOnly();

    const res = await post(stationCleanupRoutes, "cleanup/plan");

    expect(res.status).not.toBe(403);
  });
});

describe("the open capabilities are untouched", () => {
  test("changeset status is allowed without reach", async () => {
    await dispatchOnly();
    const res = await post(stationChangesetRoutes, "changeset/status");
    expect(res.status).not.toBe(403);
  });

  test("changeset diff is allowed without reach", async () => {
    await dispatchOnly();
    const res = await post(stationChangesetRoutes, "changeset/diff", { path: "a.txt" });
    expect(res.status).not.toBe(403);
  });

  test("lifecycle is allowed without reach", async () => {
    // Starting and stopping an agent grants it no capability it did not have.
    // Recorded as a judgement call in the design, not an oversight.
    await dispatchOnly();
    const res = await post(stationLifecycleRoutes, "lifecycle", { action: "restart" });
    expect(res.status).not.toBe(403);
  });
});
