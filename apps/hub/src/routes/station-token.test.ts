/**
 * Route test: POST /api/nodes/:nodeId/stations/:stationId/token
 *
 * A node exchanges its long-term `<nodeId>:<nodeSecret>` credential for a
 * short-lived token naming the principal occupying one of its stations. This
 * is the endpoint a wrong subject would be minted from, so what is proven
 * here is mostly refusal:
 *
 *   1. Success mints for the station's OCCUPANT, not the node — sub is the
 *      agent principal, not the node id, and claims come from the same
 *      `buildTokenPayload` a human's token uses.
 *   2. A station hosted by a DIFFERENT node → 403. The node proves who it
 *      is, not what it may reach.
 *   3. A station with no occupying principal → 409, distinctly — the
 *      ordinary state of an unassigned station, not a fault.
 *   4. A suspended principal → 403 (`buildTokenPayload`'s refusal, surfaced
 *      rather than re-implemented, but not left as the 500 it throws as).
 *   5. A bad node credential → 401.
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
import { decodeJwt } from "jose";

import { db, rawSql } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser } from "../../tests/helpers/database";
import { mintEnrollmentToken, enrollNode } from "../services/enrollment";
import { createPrincipal, suspendPrincipal } from "../services/principals";
import { stationTokenRoutes } from "./station-token";

const RUN = crypto.randomUUID().slice(0, 8);
const TEST_USER = `test-user-station-token-${RUN}`;

const app = new Hono().route("/api", stationTokenRoutes);

let nodeId: string;
let nodeSecret: string;
let otherNodeId: string;
let stationId: string;
let otherNodesStation: string;
let unoccupied: string;
let agentPrincipalId: string;

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: `station-token-${RUN}@example.com`,
    name: "Station Token Test User",
  });

  const { token } = await mintEnrollmentToken(TEST_USER);
  ({ nodeId, nodeSecret } = await enrollNode(token, {
    hostname: `station-token-host-${RUN}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  }));

  const { token: otherToken } = await mintEnrollmentToken(TEST_USER);
  const other = await enrollNode(otherToken, {
    hostname: `station-token-other-host-${RUN}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });
  otherNodeId = other.nodeId;

  agentPrincipalId = await createPrincipal({
    kind: "agent",
    handle: `station-token-agent-${RUN}`,
  });

  stationId = `st_stt_${RUN}`;
  await db.insert(stations).values({
    id: stationId,
    tenantId: BOOTSTRAP_TENANT_ID,
    userId: TEST_USER,
    nodeId,
    harness: "opencode",
    stationKey: "opencode:ws",
    kind: "workspace",
    displayName: "/workspace",
    principalId: agentPrincipalId,
  });

  otherNodesStation = `st_stt_other_${RUN}`;
  await db.insert(stations).values({
    id: otherNodesStation,
    tenantId: BOOTSTRAP_TENANT_ID,
    userId: TEST_USER,
    nodeId: otherNodeId,
    harness: "opencode",
    stationKey: "opencode:ws",
    kind: "workspace",
    displayName: "/workspace",
  });

  unoccupied = `st_stt_unocc_${RUN}`;
  await db.insert(stations).values({
    id: unoccupied,
    tenantId: BOOTSTRAP_TENANT_ID,
    userId: TEST_USER,
    nodeId,
    harness: "opencode",
    stationKey: "opencode:idle",
    kind: "workspace",
    displayName: "/idle",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM stations WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM nodes WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM principals WHERE id = ${agentPrincipalId}`;
    await rawSql`DELETE FROM "user" WHERE id = ${TEST_USER}`;
  } catch {
    // cleanup only
  }
});

describe("a node exchanges for one of its stations", () => {
  test("mints for the station's occupant, naming the principal and its kind", async () => {
    const res = await app.request(`/api/nodes/${nodeId}/stations/${stationId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresIn: number };
    expect(typeof body.expiresIn).toBe("number");
    expect(body.expiresIn).toBeGreaterThan(0);
    const claims = decodeJwt(body.token);
    expect(claims.sub).toBe(agentPrincipalId);
    expect(claims.principalKind).toBe("agent");
    // The node minted this, the agent did not present a credential of its
    // own — act.sub names the node, so an auditor can tell "the agent
    // acted" apart from "node N minted for the agent", the fact that scopes
    // a compromised node's blast radius (service-signing.ts:19-25).
    expect(claims.act).toEqual({ sub: nodeId });
  });

  test("refuses a station hosted by a different node", async () => {
    // The node proves who it is, not what it may reach. Without this check any
    // node could mint for any agent in the fleet.
    const res = await app.request(`/api/nodes/${nodeId}/stations/${otherNodesStation}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
    });
    expect(res.status).toBe(403);
  });

  test("refuses a station with no occupying principal, distinctly", async () => {
    const res = await app.request(`/api/nodes/${nodeId}/stations/${unoccupied}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
    });
    expect(res.status).toBe(409);
  });

  test("refuses a suspended principal", async () => {
    await suspendPrincipal(agentPrincipalId);
    const res = await app.request(`/api/nodes/${nodeId}/stations/${stationId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
    });
    expect(res.status).toBe(403);
  });

  test("refuses a wrong node secret", async () => {
    const res = await app.request(`/api/nodes/${nodeId}/stations/${stationId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${nodeId}:wrong` },
    });
    expect(res.status).toBe(401);
  });
});
