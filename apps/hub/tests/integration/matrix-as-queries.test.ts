import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { createMatrixAsRoutes } from "../../src/routes/matrix-as";
import { bridgeUserId, bridgeAlias } from "../../src/services/matrix-as/names";
import { createPrincipal } from "../../src/services/principals";

/**
 * What the homeserver asks before it will let anyone talk to one of our users
 * or join one of our rooms.
 *
 * Answering 200 is what makes the thing exist. So the question this route is
 * really answering is "is there a station behind this name" — and a bridge that
 * claimed every conceivable name would let anyone conjure an agent by typing a
 * room address.
 */

const USER = "test-user-matrix-queries";
const NODE = "node_matrix_queries";
const STATION = "station_matrix_queries";
const DOMAIN = "id.agentpod.dev";
const HS_TOKEN = "test-hs-token-queries";

/** Rooms the bridge was asked to create, so provisioning can be asserted. */
let provisioned: string[] = [];
/** The agent occupying STATION — a user's mxid is built from its handle now. */
let AGENT_PRINCIPAL: string;

function app() {
  return new Hono().route(
    "/_matrix/app/v1",
    createMatrixAsRoutes({
      hsToken: HS_TOKEN,
      domain: DOMAIN,
      onEvent: async () => {},
      onProvisionAlias: async (alias: string) => {
        provisioned.push(alias);
      },
    })
  );
}

function get(path: string, token = HS_TOKEN) {
  return app().request(`/_matrix/app/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER, email: "matrix-queries@example.com", name: "MQ" });
  const tenant = await resolveTenantForUser(USER);
  await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`DELETE FROM principals WHERE handle = 'matrix-queries-it-agent'`;
  AGENT_PRINCIPAL = await createPrincipal({ kind: "agent", handle: "matrix-queries-it-agent" });
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${USER}, 'query-box', 'query-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, principal_id, adopted_at, created_at)
    VALUES (${STATION}, ${tenant}, ${USER}, ${NODE}, 'openclaw', 'openclaw:krishna', 'leaf', 'krishna',
            '["acp"]'::jsonb, ${AGENT_PRINCIPAL}, now(), now())`;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM principals WHERE handle = 'matrix-queries-it-agent'`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

// A user's mxid is built from its occupying principal's immutable handle now
// (`names.ts`'s `bridgeUserId`), not from `(nodeName, stationKey)` — only the
// room ALIAS is still station-derived.
const REAL_USER = bridgeUserId("matrix-queries-it-agent", DOMAIN);
const REAL_ALIAS = bridgeAlias("query-box", "openclaw:krishna", DOMAIN);

describe("GET /_matrix/app/v1/users/:userId", () => {
  test("claims a user that maps to an adopted station", async () => {
    const res = await get(`/users/${encodeURIComponent(REAL_USER)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  test("disclaims a name in our namespace with no station behind it", async () => {
    // 404, not 200. Claiming everything would let anyone summon an agent that
    // does not exist by typing a name, and the room would then look real.
    const res = await get("/users/%40agent_nowhere__nothing%3Aid.agentpod.dev");
    expect(res.status).toBe(404);
    expect((await res.json()).errcode).toBe("M_NOT_FOUND");
  });

  test("disclaims a user outside our namespace entirely", async () => {
    const res = await get("/users/%40rakesh%3Aid.agentpod.dev");
    expect(res.status).toBe(404);
  });

  test("needs the homeserver's token like everything else here", async () => {
    const res = await get(`/users/${encodeURIComponent(REAL_USER)}`, "wrong");
    expect(res.status).toBe(403);
  });
});

describe("GET /_matrix/app/v1/rooms/:alias", () => {
  test("claims an alias that maps to a station, and provisions the room", async () => {
    // The homeserver asks because someone tried to resolve the alias. Answering
    // 200 without creating the room would send them to a room that is not there.
    provisioned = [];

    const res = await get(`/rooms/${encodeURIComponent(REAL_ALIAS)}`);

    expect(res.status).toBe(200);
    expect(provisioned).toEqual([REAL_ALIAS]);
  });

  test("disclaims an alias with no station behind it, and provisions nothing", async () => {
    provisioned = [];

    const res = await get("/rooms/%23agentpod_nowhere__nothing%3Aid.agentpod.dev");

    expect(res.status).toBe(404);
    expect(provisioned).toEqual([]);
  });

  test("a station on a different node is a different room", async () => {
    // The node is in the name because station keys repeat. An alias naming
    // another node must not resolve to this station.
    const otherNode = bridgeAlias("some-other-box", "openclaw:krishna", DOMAIN);
    const res = await get(`/rooms/${encodeURIComponent(otherNode)}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /_matrix/app/v1/ping", () => {
  test("answers, so the homeserver can prove it can reach us", async () => {
    const res = await get("/ping");
    expect(res.status).toBe(200);
  });
});
