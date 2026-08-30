/**
 * Service Test: principals (mint + Better Auth lookup)
 *
 * Uses the local Docker test-postgres (localhost:5434).
 * DATABASE_URL must be set before any src/ modules are imported.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser } from "../../tests/helpers/database";
import { resolveTenantForUser } from "../auth/tenant";
import { db, rawSql } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { seedAgentPrincipals } from "../../scripts/seed-agent-principals";
import { createPrincipal, principalForUser } from "./principals";

beforeAll(async () => {
  await ensurePgMigrations();
});

describe("principals", () => {
  test("mints an agent principal with a grammar-valid id", async () => {
    const id = await createPrincipal({ kind: "agent", handle: "writer-quill" });
    expect(id).toMatch(/^prn_[0-9a-f]{20}$/);
  });

  test("refuses a second principal on the same handle", async () => {
    await createPrincipal({ kind: "agent", handle: "analyst-echo" });
    // A handle is an address: two claimants make the mxid it produces ambiguous.
    expect(createPrincipal({ kind: "agent", handle: "analyst-echo" })).rejects.toThrow();
  });

  test("finds the principal behind a Better Auth user", async () => {
    const id = await createPrincipal({ kind: "human", handle: "rakesh", userId: "usr-uuid-here" });
    const found = await principalForUser("usr-uuid-here");
    expect(found?.id).toBe(id);
    expect(found?.kind).toBe("human");
  });

  test("a user with no principal resolves to null, never to a default", async () => {
    // Falling back would hand one principal's authority to an unmapped caller.
    expect(await principalForUser("usr-nobody")).toBeNull();
  });
});

// ─── stations record which agent occupies them ────────────────────────────────

const STATION_USER = "test-user-station-occupancy";
const STATION_NODE = "node_station_occupancy";
const UNOCCUPIED_STATION_ID = "station_unoccupied_test";

const stationRow = async (id: string) => {
  const [row] = await db.select().from(stations).where(eq(stations.id, id));
  if (!row) throw new Error(`no station row for ${id}`);
  return row;
};

beforeAll(async () => {
  await createTestUser({
    id: STATION_USER,
    email: "station-occupancy@example.com",
    name: "Station Occupancy",
  });
  const tenant = await resolveTenantForUser(STATION_USER);
  await rawSql`DELETE FROM stations WHERE node_id = ${STATION_NODE}`;
  await rawSql`DELETE FROM nodes WHERE id = ${STATION_NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${STATION_NODE}, ${tenant}, ${STATION_USER}, 'occupancy-box', 'occupancy-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, created_at)
    VALUES (${UNOCCUPIED_STATION_ID}, ${tenant}, ${STATION_USER}, ${STATION_NODE}, 'openclaw', 'openclaw:unoccupied', 'leaf', 'unoccupied', now())`;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM stations WHERE node_id = ${STATION_NODE}`;
    await rawSql`DELETE FROM nodes WHERE id = ${STATION_NODE}`;
    await rawSql`DELETE FROM "user" WHERE id = ${STATION_USER}`;
  } catch {
    // cleanup only
  }
});

describe("stations record which agent occupies them", () => {
  test("a station with no agent has no principal, and that is legal", async () => {
    const s = await stationRow(UNOCCUPIED_STATION_ID);
    expect(s.principalId).toBeNull();
  });

  test("seeding gives every adopted station an agent principal, and is idempotent", async () => {
    const first = await seedAgentPrincipals();
    const second = await seedAgentPrincipals();
    expect(first.created).toBeGreaterThan(0);
    expect(second.created).toBe(0); // re-running must not mint a second identity

    // The station this suite set up is one of the ones seeding must have
    // reached — otherwise `first.created > 0` could be satisfied by some
    // other suite's leftover row and this test would prove nothing about
    // the station above.
    const s = await stationRow(UNOCCUPIED_STATION_ID);
    expect(s.principalId).toMatch(/^prn_[0-9a-f]{20}$/);
  });
});
