import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { createMatrixAsRoutes } from "../../src/routes/matrix-as";
import {
  bridgeUserId,
  bridgeAlias,
  bridgeAliasForHandle,
} from "../../src/services/matrix-as/names";
import { provisionStationForAlias } from "../../src/services/matrix-as/provision";
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
  await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${STATION}`;
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
    await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${STATION}`;
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

/**
 * The route's own alias resolution, with the REAL provisioning behind it.
 *
 * The block above hands the route an `onProvisionAlias` that only records —
 * fine for asking "was provisioning called", useless for the bug fix round 4
 * found, which lived in front of it: the route gated on the station-derived
 * alias shape ALONE and answered `M_NOT_FOUND` before `onProvisionAlias`
 * (which had been taught both shapes in round 3) ever ran. An occupied
 * station's room alias is occupant-derived now, so the new branch was
 * unreachable for precisely the shape it was added for, and a homeserver
 * asking about an agent's alias for a room that did not exist yet got a 404
 * instead of a room.
 *
 * So this wires the route to the real `provisionStationForAlias` — the same
 * function `index.ts`'s bridge delegates to — with only the Matrix client
 * faked. Nothing about the resolution or the provisioning is reproduced here.
 */
describe("GET /_matrix/app/v1/rooms/:alias — the real path, both alias shapes", () => {
  const OCCUPANT_ALIAS = bridgeAliasForHandle("matrix-queries-it-agent", DOMAIN);

  /** The homeserver's alias directory, so a second create at one alias is seen. */
  let roomsByAlias: Map<string, string>;
  let created: string[];

  function realApp() {
    return new Hono().route(
      "/_matrix/app/v1",
      createMatrixAsRoutes({
        hsToken: HS_TOKEN,
        domain: DOMAIN,
        onEvent: async () => {},
        onProvisionAlias: (alias: string) =>
          provisionStationForAlias(alias, {
            domain: DOMAIN,
            client: {
              ensureUser: async () => {},
              ensureRoom: async (alias: string) => {
                const existing = roomsByAlias.get(alias);
                if (existing) return existing;
                const roomId = `!queries-${roomsByAlias.size + 1}:${DOMAIN}`;
                roomsByAlias.set(alias, roomId);
                created.push(alias);
                return roomId;
              },
              invite: async () => {},
            },
          }),
      })
    );
  }

  function realGet(path: string) {
    return realApp().request(`/_matrix/app/v1${path}`, {
      headers: { Authorization: `Bearer ${HS_TOKEN}` },
    });
  }

  async function roomRows() {
    return (await rawSql`
      SELECT room_id, alias, principal_id FROM matrix_rooms WHERE station_id = ${STATION}
    `) as unknown as Array<{ room_id: string; alias: string; principal_id: string | null }>;
  }

  test("an occupant-derived alias resolves and gets its room made; the legacy station-derived one still resolves to the same station", async () => {
    roomsByAlias = new Map();
    created = [];
    await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${STATION}`;

    // The shape an occupied station's room carries now. 404 here — which is
    // what the route answered before this fix — means the room behind an
    // agent's own address can never be created on demand.
    const occupant = await realGet(`/rooms/${encodeURIComponent(OCCUPANT_ALIAS)}`);
    expect(occupant.status).toBe(200);

    const afterOccupant = await roomRows();
    expect(afterOccupant).toHaveLength(1);
    expect(afterOccupant[0]!.alias).toBe(OCCUPANT_ALIAS);
    // Bound to the occupant at creation — the room is the agent's, not the
    // station's.
    expect(afterOccupant[0]!.principal_id).toBe(AGENT_PRINCIPAL);
    expect(created).toEqual([OCCUPANT_ALIAS]);

    // And the legacy shape, which the 32 rooms already on the infra box are
    // addressed by, must keep resolving — the fallback is the whole reason
    // `stationForLocalpart` is still consulted at all. Same station, so
    // provisioning is a no-op rather than a second room.
    const legacy = await realGet(`/rooms/${encodeURIComponent(REAL_ALIAS)}`);
    expect(legacy.status).toBe(200);

    const afterLegacy = await roomRows();
    expect(afterLegacy).toHaveLength(1);
    expect(afterLegacy[0]!.room_id).toBe(afterOccupant[0]!.room_id);
    expect(created).toEqual([OCCUPANT_ALIAS]);

    // Widening what the route claims must not widen it to everything: an
    // `agent_`-shaped alias with no principal behind it is a name somebody
    // typed hopefully, and claiming it would let anyone conjure an agent.
    const nobody = await realGet("/rooms/%23agentpod_agent_nobody-at-all%3Aid.agentpod.dev");
    expect(nobody.status).toBe(404);
    expect(created).toEqual([OCCUPANT_ALIAS]);
  });
});

describe("GET /_matrix/app/v1/ping", () => {
  test("answers, so the homeserver can prove it can reach us", async () => {
    const res = await get("/ping");
    expect(res.status).toBe(200);
  });
});
