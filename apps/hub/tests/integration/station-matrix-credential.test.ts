/**
 * Route test: POST /api/nodes/:nodeId/stations/:stationId/matrix-credential
 *
 * `station-token.ts`'s sibling — a node redeeming its long-term
 * `<nodeId>:<nodeSecret>` credential, but here to spend a human's Matrix
 * credential authorization (Task 1) rather than to mint a JWT. What is
 * proven here is mostly refusal, in the same order the route checks them:
 *
 *   1. A bad node credential → 401.
 *   2. A credential that verifies for a DIFFERENT node than the path names
 *      → 401 — the node proves who it is, not what the path claims.
 *   3. A station hosted by a different node (or unknown) → 403, identically,
 *      so a node cannot tell "not yours" from "doesn't exist".
 *   4. A station with no occupying principal → 409, distinctly — the
 *      ordinary state of an unassigned station, not a fault.
 *   5. No authorization to redeem, or one already spent → 403, identically —
 *      redeemCredentialAuthorization collapses both into `false`.
 *   6. Success: registers (or rotates) the principal-derived localpart via
 *      `bridgeLocalpart`, flips the station to harness mode, and the access
 *      token it hands back is never written to the audit line.
 *
 * Uses the local Docker test-postgres (localhost:5434). Every fixture id is
 * unique per run (`crypto.randomUUID()`), and `afterAll` deletes what it
 * created, except the fixed handle `writer-quill` — kept literal because it
 * is what `bridgeLocalpart` is asserted against, and cleaned up the way
 * `services/principals.test.ts` cleans up its own fixed handles: deleted in
 * `beforeAll` too, so a second run against the same database (no reset in
 * between) does not collide with a first run's leftovers.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { Hono } from "hono";

import { db, rawSql } from "../../src/db/drizzle";
import { stations } from "../../src/db/schema/stations";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { mintEnrollmentToken, enrollNode } from "../../src/services/enrollment";
import { createPrincipal } from "../../src/services/principals";
import {
  mintCredentialAuthorization,
  redeemCredentialAuthorization,
} from "../../src/services/matrix-credential";
import { createStationMatrixCredentialRoutes } from "../../src/routes/station-matrix-credential";
import { MatrixUserInUse } from "../../src/services/matrix-as/client";
import type { IssuedCredentials } from "../../src/routes/station-matrix";

const RUN = crypto.randomUUID().slice(0, 8);
const TEST_USER = `test-user-station-matrix-credential-${RUN}`;
const DOMAIN = "id.agentpod.dev";
/** Fixed, deliberately — see file header. */
const WRITER_QUILL_HANDLE = "writer-quill";

let nodeId: string;
let nodeSecret: string;
let otherNodeId: string;
let otherNodeSecret: string;
let stationId: string; // occupied by the writer-quill principal
let otherNodesStation: string;
let unoccupied: string;
/** Occupied, but never has `mintCredentialAuthorization` called for it — a
 * DIFFERENT station than `stationId`, since several tests above mint for
 * `stationId` without redeeming (leaving it with a live authorization) and
 * the occupancy-exclusive index (`0061_occupancy_exclusive.sql`) means it
 * needs its own principal too. */
let neverAuthorized: string;
let writerQuillPrincipal: string;

let issued: string[] = [];
let rotated: string[] = [];
let auditLines: string[] = [];
let identityExists = false;
let canRotate = true;

function nodeAuth(): Record<string, string> {
  return {
    Authorization: `Bearer ${nodeId}:${nodeSecret}`,
    "Content-Type": "application/json",
  };
}

function app() {
  const routes = createStationMatrixCredentialRoutes({
    credentials: {
      register: async (localpart: string): Promise<IssuedCredentials> => {
        if (identityExists) throw new MatrixUserInUse(localpart);
        issued.push(localpart);
        return {
          userId: `@${localpart}:${DOMAIN}`,
          accessToken: "syt_matrix_credential_secret_token",
          deviceId: "DEV1",
        };
      },
      rotate: canRotate
        ? async (localpart: string): Promise<IssuedCredentials> => {
            rotated.push(localpart);
            return {
              userId: `@${localpart}:${DOMAIN}`,
              accessToken: "syt_matrix_credential_rotated_token",
              deviceId: "DEV2",
            };
          }
        : undefined,
    },
    log: (line: string) => auditLines.push(line),
  });
  return new Hono().route("/api", routes);
}

const URL = () => `/api/nodes/${nodeId}/stations/${stationId}/matrix-credential`;

beforeAll(async () => {
  await ensurePgMigrations();
  // Second-run-without-reset safety for the one fixed handle this file uses.
  await rawSql`DELETE FROM principals WHERE handle = ${WRITER_QUILL_HANDLE}`;

  await createTestUser({
    id: TEST_USER,
    email: `station-matrix-credential-${RUN}@example.com`,
    name: "Station Matrix Credential Test User",
  });

  const { token } = await mintEnrollmentToken(TEST_USER);
  ({ nodeId, nodeSecret } = await enrollNode(token, {
    hostname: `station-matrix-credential-host-${RUN}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  }));

  const { token: otherToken } = await mintEnrollmentToken(TEST_USER);
  const other = await enrollNode(otherToken, {
    hostname: `station-matrix-credential-other-host-${RUN}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });
  otherNodeId = other.nodeId;
  otherNodeSecret = other.nodeSecret;

  writerQuillPrincipal = await createPrincipal({
    kind: "agent",
    handle: WRITER_QUILL_HANDLE,
  });
  const neverAuthorizedPrincipal = await createPrincipal({
    kind: "agent",
    handle: `never-authorized-${RUN}`,
  });

  stationId = `st_smc_${RUN}`;
  await db.insert(stations).values({
    id: stationId,
    tenantId: BOOTSTRAP_TENANT_ID,
    userId: TEST_USER,
    nodeId,
    harness: "hermes",
    stationKey: "hermes:writer-quill",
    kind: "leaf",
    displayName: "writer-quill",
    principalId: writerQuillPrincipal,
  });

  otherNodesStation = `st_smc_other_${RUN}`;
  await db.insert(stations).values({
    id: otherNodesStation,
    tenantId: BOOTSTRAP_TENANT_ID,
    userId: TEST_USER,
    nodeId: otherNodeId,
    harness: "hermes",
    stationKey: "hermes:elsewhere",
    kind: "leaf",
    displayName: "elsewhere",
  });

  unoccupied = `st_smc_unocc_${RUN}`;
  await db.insert(stations).values({
    id: unoccupied,
    tenantId: BOOTSTRAP_TENANT_ID,
    userId: TEST_USER,
    nodeId,
    harness: "hermes",
    stationKey: "hermes:idle",
    kind: "leaf",
    displayName: "idle",
  });

  neverAuthorized = `st_smc_never_auth_${RUN}`;
  await db.insert(stations).values({
    id: neverAuthorized,
    tenantId: BOOTSTRAP_TENANT_ID,
    userId: TEST_USER,
    nodeId,
    harness: "hermes",
    stationKey: "hermes:never-authorized",
    kind: "leaf",
    displayName: "never-authorized",
    principalId: neverAuthorizedPrincipal,
  });
});

beforeEach(async () => {
  issued = [];
  rotated = [];
  auditLines = [];
  identityExists = false;
  canRotate = true;
  await rawSql`UPDATE stations SET matrix_identity_mode = 'bridge' WHERE id = ${stationId}`;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id IN (${stationId}, ${otherNodesStation}, ${unoccupied}, ${neverAuthorized})`;
    await rawSql`DELETE FROM stations WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM nodes WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM principals WHERE handle = ${WRITER_QUILL_HANDLE}`;
    await rawSql`DELETE FROM principals WHERE handle = ${`never-authorized-${RUN}`}`;
    await rawSql`DELETE FROM "user" WHERE id = ${TEST_USER}`;
  } catch {
    // cleanup only
  }
});

describe("a node redeems a Matrix credential authorization for one of its stations", () => {
  test("401 when the node credential is wrong", async () => {
    await mintCredentialAuthorization(stationId);
    const res = await app().request(URL(), {
      method: "POST",
      headers: { Authorization: `Bearer ${nodeId}:wrong`, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  test("401 when the credential verifies for a DIFFERENT node than the path names", async () => {
    await mintCredentialAuthorization(stationId);
    // otherNodeId's own credential is genuinely valid — just not for THIS
    // path's nodeId, so it is refused the same way a wrong secret is.
    const res = await app().request(URL(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${otherNodeId}:${otherNodeSecret}`,
        "Content-Type": "application/json",
      },
    });
    expect(res.status).toBe(401);
  });

  test("403 when the station is not hosted by this node", async () => {
    // not 404: see station-token.ts — a station hosted elsewhere and one
    // that does not exist must be indistinguishable to this credential.
    await mintCredentialAuthorization(otherNodesStation);
    const res = await app().request(
      `/api/nodes/${nodeId}/stations/${otherNodesStation}/matrix-credential`,
      { method: "POST", headers: nodeAuth() }
    );
    expect(res.status).toBe(403);
    expect(issued).toHaveLength(0);
  });

  test("403 for a station that does not exist at all, identically", async () => {
    const res = await app().request(
      `/api/nodes/${nodeId}/stations/st_smc_does_not_exist/matrix-credential`,
      { method: "POST", headers: nodeAuth() }
    );
    expect(res.status).toBe(403);
  });

  test("409 when the station has no occupying principal", async () => {
    const res = await app().request(
      `/api/nodes/${nodeId}/stations/${unoccupied}/matrix-credential`,
      { method: "POST", headers: nodeAuth() }
    );
    expect(res.status).toBe(409);
    expect(issued).toHaveLength(0);
  });

  test("403 when no authorization was ever minted for this station", async () => {
    // A DIFFERENT station than `stationId`: several tests above mint for
    // `stationId` without redeeming, which would leave it with a live
    // authorization and make this assertion accidentally true for the wrong
    // reason.
    const res = await app().request(
      `/api/nodes/${nodeId}/stations/${neverAuthorized}/matrix-credential`,
      { method: "POST", headers: nodeAuth() }
    );
    expect(res.status).toBe(403);
    expect(issued).toHaveLength(0);
  });

  test("403 when the authorization has already been redeemed", async () => {
    await mintCredentialAuthorization(stationId);
    expect(await redeemCredentialAuthorization(stationId)).toBe(true);

    const res = await app().request(URL(), { method: "POST", headers: nodeAuth() });
    expect(res.status).toBe(403);
    expect(issued).toHaveLength(0);
  });

  test("issues a credential for the principal-derived localpart, once", async () => {
    await mintCredentialAuthorization(stationId);
    const res = await app().request(URL(), { method: "POST", headers: nodeAuth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; accessToken: string };
    // Derived from the OCCUPANT's principal handle, not from
    // (nodeName, stationKey) — the same move `bridgeUserId` already made in
    // station-matrix.ts.
    expect(body.userId).toBe("@agent_writer-quill:id.agentpod.dev");
    expect(body.accessToken).toBeTruthy();
    expect(issued).toEqual(["agent_writer-quill"]);

    const [row] = await rawSql`
      SELECT matrix_identity_mode FROM stations WHERE id = ${stationId}`;
    expect(row!.matrix_identity_mode).toBe("harness");

    // The authorization redeemed is spent — a replay against the same
    // station (this authenticated node, same station, no live record left)
    // gets no credential.
    const replay = await app().request(URL(), { method: "POST", headers: nodeAuth() });
    expect(replay.status).toBe(403);
  });

  test("rotates rather than failing when the identity already exists", async () => {
    identityExists = true;
    await mintCredentialAuthorization(stationId);
    const res = await app().request(URL(), { method: "POST", headers: nodeAuth() });
    expect(res.status).toBe(200);
    expect(rotated).toEqual(["agent_writer-quill"]);
    expect(issued).toHaveLength(0);
    expect(((await res.json()) as { accessToken: string }).accessToken).toBe(
      "syt_matrix_credential_rotated_token"
    );
  });

  test("the access token is never written to the audit line", async () => {
    // The audit records the device, deliberately not the credential —
    // routes/station-matrix.ts already does this and this endpoint copies
    // it.
    await mintCredentialAuthorization(stationId);
    const res = await app().request(URL(), { method: "POST", headers: nodeAuth() });
    const body = (await res.json()) as { accessToken: string };
    expect(auditLines.join("\n")).not.toContain(body.accessToken);
    // …and it still says something, so the act is auditable.
    expect(auditLines.join("\n")).toMatch(/credential/i);
  });
});
