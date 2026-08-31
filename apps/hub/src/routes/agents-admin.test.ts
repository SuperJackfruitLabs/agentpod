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
