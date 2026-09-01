/**
 * Integration test: matrix credential authorization — mint + single-use redeem.
 *
 * There is no token: the node that redeems is already authenticated by its
 * own `<nodeId>:<nodeSecret>` and already proven to host the station (see
 * `routes/station-matrix-credential.ts`), so redemption is "this
 * authenticated node, for this station, against the live record" — nothing
 * else identifies which record to spend. `redeemCredentialAuthorization`
 * takes only `stationId`.
 *
 * Uses the local Docker test-postgres (localhost:5434).
 * DATABASE_URL must be set before any src/ modules are imported.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db, rawSql } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { nodes } from "../db/schema/nodes";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser } from "../../tests/helpers/database";
import { mintEnrollmentToken, enrollNode } from "./enrollment";
import {
  mintCredentialAuthorization,
  redeemCredentialAuthorization,
  UnknownStationError,
} from "./matrix-credential";

const TEST_USER = "test-user-matrix-cred-svc-001";

let STATION = "";
let OTHER_STATION = "";
/** Never minted for — proves "no live authorization" independent of any
 * other test's redeem/expiry leftovers on a shared station. */
let NEVER_AUTHORIZED_STATION = "";

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "matrix-cred-svc-test@example.com",
    name: "Matrix Credential Service Test User",
  });

  const { token } = await mintEnrollmentToken(TEST_USER);
  const { nodeId } = await enrollNode(token, {
    hostname: "matrix-cred-test-host",
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });

  const [nodeRow] = await db
    .select({ tenantId: nodes.tenantId })
    .from(nodes)
    .where(eq(nodes.id, nodeId));
  const tenantId = nodeRow!.tenantId;

  const insertStation = async (stationKey: string) => {
    const id = `station_${crypto.randomUUID()}`;
    await db.insert(stations).values({
      id,
      tenantId,
      userId: TEST_USER,
      nodeId,
      harness: "hermes",
      stationKey,
      kind: "leaf",
      displayName: stationKey,
    });
    return id;
  };

  STATION = await insertStation("matrix-cred-test-station");
  OTHER_STATION = await insertStation("matrix-cred-test-other-station");
  NEVER_AUTHORIZED_STATION = await insertStation("matrix-cred-test-never-authorized-station");
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id IN (${STATION}, ${OTHER_STATION}, ${NEVER_AUTHORIZED_STATION})`;
    await rawSql`DELETE FROM stations              WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM nodes                 WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens     WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM "user"                WHERE id      = ${TEST_USER}`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test("mint returns only an expiry — no token, nothing for a node to present", async () => {
  const result = await mintCredentialAuthorization(STATION);
  expect(result.expiresAt).toBeInstanceOf(Date);
  expect(Object.keys(result)).toEqual(["expiresAt"]);
});

test("a freshly minted authorization redeems exactly once", async () => {
  await mintCredentialAuthorization(STATION);
  expect(await redeemCredentialAuthorization(STATION)).toBe(true);
  // The second attempt is a replay. A replay that succeeded would hand out a
  // second working credential for one human approval.
  expect(await redeemCredentialAuthorization(STATION)).toBe(false);
});

test("an expired authorization does not redeem", async () => {
  await mintCredentialAuthorization(STATION, { ttlMs: -1 });
  expect(await redeemCredentialAuthorization(STATION)).toBe(false);
});

test("a station with no live authorization refuses", async () => {
  // Never minted for at all — not merely spent or expired.
  expect(await redeemCredentialAuthorization(NEVER_AUTHORIZED_STATION)).toBe(false);
});

test("an authorization minted for one station does not redeem for another", async () => {
  await mintCredentialAuthorization(STATION);
  expect(await redeemCredentialAuthorization(OTHER_STATION)).toBe(false);
});

test("minting for an unknown station throws a typed error, not a bare one", async () => {
  // An operator-facing caller needs to tell "unknown station" apart from a
  // real failure without string-matching a message.
  expect(mintCredentialAuthorization("station_does_not_exist")).rejects.toBeInstanceOf(
    UnknownStationError
  );
});
