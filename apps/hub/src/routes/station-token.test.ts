/**
 * Route test: POST /api/nodes/:nodeId/stations/:stationId/token
 *
 * A node exchanges its long-term `<nodeId>:<nodeSecret>` credential for a
 * short-lived token naming the principal occupying one of its stations. This
 * is the endpoint a wrong subject would be minted from, so what is proven
 * here is mostly refusal:
 *
 *   1. Success returns the org plane's token for the station's OCCUPANT, not
 *      the node — sub is the agent principal (the hub signs nothing).
 *   2. A station hosted by a DIFFERENT node → 403. The node proves who it
 *      is, not what it may reach.
 *   3. A station with no occupying principal → 409, distinctly — the
 *      ordinary state of an unassigned station, not a fault.
 *   4. A suspended principal → 403 (the plane's 423, translated).
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
import { createPrincipal } from "../../tests/helpers/principals";
import { fakePlane } from "../../tests/helpers/fake-plane";
import { createStationTokenRoutes, stationAudiences, stationTokenRoutes } from "./station-token";
import { TEST_PLANE } from "../auth/org-plane/config";
import { OrgPlaneError } from "../services/org-plane/client";

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
    fakePlane.remove(agentPrincipalId);
    fakePlane.remove(TEST_USER);
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
    // The ACTUAL bound, not its sign. TOKEN_TTL = "5m" is the revocation SLA
    // (jwt-claims.ts: verification is offline, there is no revocation list,
    // "the expiry IS the revocation SLA") — it is precisely how long a
    // suspended principal's already-issued token keeps working. Asserting
    // only `> 0` would let a drift to "5h" pass the whole suite in silence.
    // Bounded rather than exact for the same reason service-signing.test.ts
    // bounds its 120s: iat and exp are wall-clock seconds and minting costs
    // real time.
    expect(body.expiresIn).toBeGreaterThan(280);
    expect(body.expiresIn).toBeLessThanOrEqual(300);
    const claims = decodeJwt(body.token);
    // Same bound read off the token itself, since `expiresIn` is a number the
    // response computes and a consumer verifying offline reads only these.
    expect((claims.exp as number) - (claims.iat as number)).toBe(body.expiresIn);
    expect(claims.sub).toBe(agentPrincipalId);
    expect(claims.principalKind).toBe("agent");
    // Spent where the plane was asked to make it spendable: this hub, first.
    expect(claims.aud).toEqual(stationAudiences(TEST_PLANE).length === 1 ? TEST_PLANE.audience : stationAudiences(TEST_PLANE));
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
    await fakePlane.suspend(agentPrincipalId);
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

/** An unsigned JWT-shaped string: the hub only decodes the plane's token to log its jti. */
function planeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "EdDSA", kid: "k1" })}.${b64(claims)}.c2ln`;
}

describe("the org plane's answers", () => {
  const asked: Array<{ principal: string; audience: string | string[] }> = [];
  const planeApp = (agentToken: (p: string, a: string | string[]) => Promise<{ accessToken: string; expiresIn: number }>) =>
    new Hono().route("/api", createStationTokenRoutes({ plane: () => TEST_PLANE, client: () => ({ agentToken }) }));
  const post = (a: Hono, station: string, secret = nodeSecret) =>
    a.request(`/api/nodes/${nodeId}/stations/${station}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${nodeId}:${secret}` },
    });
  const never = (flag: { called: boolean }) => async () => {
    flag.called = true;
    return { accessToken: "x", expiresIn: 300 };
  };

  test("asks the plane for the station's agent, for the hub's audience, and returns its token", async () => {
    const token = planeJwt({ sub: agentPrincipalId, jti: "jti-1" });
    const a = planeApp(async (principal, audience) => {
      asked.push({ principal, audience });
      return { accessToken: token, expiresIn: 300 };
    });
    const res = await post(a, stationId);
    expect(res.status).toBe(200);
    // Shape unchanged: the node's internal/stationtoken reads exactly { token, expiresIn }.
    expect(await res.json()).toEqual({ token, expiresIn: 300 });
    expect(asked.at(-1)).toEqual({ principal: agentPrincipalId, audience: TEST_PLANE.audience });
  });

  test("logs { nodeId, stationId, principal, jti } for every exchange, and never the token", async () => {
    const token = planeJwt({ sub: agentPrincipalId, jti: "jti-logged" });
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      const res = await post(planeApp(async () => ({ accessToken: token, expiresIn: 300 })), stationId);
      expect(res.status).toBe(200);
    } finally {
      console.log = original;
    }
    const entries = lines.flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
    const entry = entries.find((e) => e.component === "station-token" && e.context?.jti === "jti-logged");
    expect(entry?.context).toEqual({ nodeId, stationId, principal: agentPrincipalId, jti: "jti-logged" });
    expect(lines.join("\n")).not.toContain(token);
  });

  test("a wrong node secret never reaches the plane", async () => {
    const flag = { called: false };
    const res = await post(planeApp(never(flag)), stationId, "wrong");
    expect(res.status).toBe(401);
    expect(flag.called).toBe(false);
  });

  test("another node's station never reaches the plane", async () => {
    const flag = { called: false };
    const res = await post(planeApp(never(flag)), otherNodesStation);
    expect(res.status).toBe(403);
    expect(flag.called).toBe(false);
  });

  test("an unoccupied station is still 409 without asking the plane", async () => {
    const flag = { called: false };
    const res = await post(planeApp(never(flag)), unoccupied);
    expect(res.status).toBe(409);
    expect(flag.called).toBe(false);
  });

  test.each([
    [423, "suspended", 403, "principal suspended"],
    [404, "unknown_principal", 409, "station's principal is unknown to the org plane"],
    [403, "not_permitted", 502, "the org plane refused this hub"],
    [500, "error", 502, "the org plane refused this hub"],
    [0, "unreachable", 503, "the org plane is unreachable"],
  ])("plane %i %s → %i", async (status, code, want, message) => {
    const res = await post(
      planeApp(async () => {
        throw new OrgPlaneError(status, code);
      }),
      stationId,
    );
    expect(res.status).toBe(want);
    expect(await res.json()).toEqual({ error: message });
  });

  test("the hub's own audience is the plane's, with configured work planes after it", () => {
    expect(stationAudiences(TEST_PLANE)[0]).toBe(TEST_PLANE.audience);
    expect(stationAudiences(TEST_PLANE, ["https://app.test", TEST_PLANE.audience, "https://app.test"])).toEqual([
      TEST_PLANE.audience,
      "https://app.test",
    ]);
  });

  test("several audiences are sent as an array (contract §3.4)", async () => {
    const sent: Array<string | string[]> = [];
    const a = new Hono().route(
      "/api",
      createStationTokenRoutes({
        plane: () => TEST_PLANE,
        audiences: () => [TEST_PLANE.audience, "https://app.test"],
        client: () => ({
          agentToken: async (_p, aud) => (sent.push(aud), { accessToken: planeJwt({ jti: "j" }), expiresIn: 300 }),
        }),
      }),
    );
    expect((await post(a, stationId)).status).toBe(200);
    expect(sent).toEqual([[TEST_PLANE.audience, "https://app.test"]]);
  });
});
