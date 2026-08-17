import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { purposeRoutes } from "../../src/routes/purpose";
import { onStationsAdopted } from "../../src/services/matrix-as/hooks";

/**
 * Setting what a station is for.
 *
 * Two rules pull against each other and both are asserted here: the node has
 * to be able to label the stations nobody has labelled — otherwise an existing
 * fleet can never be filed without clicking through it one station at a time —
 * and it must never touch one that carries a purpose of its own, or "purpose
 * lives on the station" stops being true in exactly the moment an operator is
 * reorganising.
 */

const OWNER = "test-user-purpose-routes";
const OTHER = "test-user-purpose-routes-other";
const NODE = "node_purpose_routes";
const A = "station_purpose_a";
const B = "station_purpose_b";

let announced: string[][] = [];

function app() {
  return new Hono()
    .use("*", async (c, next) => {
      c.set("user", { id: OWNER, role: "user" });
      await next();
    })
    .route("/api", purposeRoutes);
}

const put = (path: string, body: unknown) =>
  app().request(`/api${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const purposeOf = async (stationId: string): Promise<string | null> => {
  const [row] = await rawSql`SELECT purpose FROM stations WHERE id = ${stationId}`;
  return (row?.purpose as string | null) ?? null;
};

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: "purpose-routes@example.com", name: "PR" });
  await createTestUser({ id: OTHER, email: "purpose-other@example.com", name: "PO" });
  const tenant = await resolveTenantForUser(OWNER);
  await rawSql`DELETE FROM stations WHERE node_id = ${NODE}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${OWNER}, 'purpose-routes-box', 'prb', 'linux', 'amd64', 2, 'online', 'x', now())`;
  for (const [id, key] of [
    [A, "openclaw:a"],
    [B, "openclaw:b"],
  ]) {
    await rawSql`
      INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
      VALUES (${id}, ${tenant}, ${OWNER}, ${NODE}, 'openclaw', ${key}, 'leaf', ${key}, '["acp"]'::jsonb, now(), now())`;
  }
});

beforeEach(async () => {
  announced = [];
  // Async, like the real provisioner the hook was built for.
  onStationsAdopted(async (ids) => {
    announced.push(ids);
  });
  await rawSql`UPDATE stations SET purpose = NULL WHERE node_id = ${NODE}`;
  await rawSql`UPDATE nodes SET purpose = NULL WHERE id = ${NODE}`;
});

afterEach(() => {
  onStationsAdopted(null);
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM stations WHERE node_id = ${NODE}`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id IN (${OWNER}, ${OTHER})`;
  } catch {
    // cleanup only
  }
});

describe("PUT /api/stations/:id/purpose", () => {
  test("sets it, and announces the station so its room is re-filed", async () => {
    const res = await put(`/stations/${A}/purpose`, { purpose: "personal" });

    expect(res.status).toBe(200);
    expect(await purposeOf(A)).toBe("personal");
    // Re-filing is provisioning's job — one reconciler for a station's whole
    // Matrix presence, rather than a second path that only knows about spaces.
    expect(announced).toEqual([[A]]);
  });

  test("trims, and treats an empty string as no purpose at all", async () => {
    await put(`/stations/${A}/purpose`, { purpose: "  work  " });
    expect(await purposeOf(A)).toBe("work");

    await put(`/stations/${A}/purpose`, { purpose: "   " });
    expect(await purposeOf(A)).toBeNull();
  });

  test("unlabels on null, which files it under no space at all", async () => {
    await put(`/stations/${A}/purpose`, { purpose: "personal" });

    const res = await put(`/stations/${A}/purpose`, { purpose: null });

    expect(res.status).toBe(200);
    expect(await purposeOf(A)).toBeNull();
    // Still announced: the room has to be taken OUT of the space it was in,
    // and nothing else would notice.
    expect(announced.at(-1)).toEqual([A]);
  });

  test("404s for a station that is not this principal's", async () => {
    const res = await put("/stations/station_not_mine/purpose", { purpose: "work" });
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/nodes/:id/purpose", () => {
  test("labels the stations that have none, and says how many", async () => {
    const res = await put(`/nodes/${NODE}/purpose`, { purpose: "personal" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: NODE,
      purpose: "personal",
      stationsLabelled: 2,
    });
    expect(await purposeOf(A)).toBe("personal");
    expect(await purposeOf(B)).toBe("personal");
  });

  test("leaves a station that already has one alone", async () => {
    await put(`/stations/${A}/purpose`, { purpose: "work" });

    const res = await put(`/nodes/${NODE}/purpose`, { purpose: "personal" });

    expect((await res.json()).stationsLabelled).toBe(1);
    expect(await purposeOf(A)).toBe("work");
    expect(await purposeOf(B)).toBe("personal");
  });

  test("clearing the node's default changes no station", async () => {
    // The node's field is where a FUTURE adoption gets its answer. Clearing it
    // says "stop answering for the next one", not "unfile everything already
    // here" — that would make one careless click undo the whole layout.
    await put(`/nodes/${NODE}/purpose`, { purpose: "personal" });
    announced = [];

    const res = await put(`/nodes/${NODE}/purpose`, { purpose: null });

    expect((await res.json()).stationsLabelled).toBe(0);
    expect(await purposeOf(A)).toBe("personal");
    expect(announced).toEqual([]);
  });

  test("404s for a node that is not this principal's", async () => {
    const res = await put("/nodes/node_not_mine/purpose", { purpose: "work" });
    expect(res.status).toBe(404);
  });
});
