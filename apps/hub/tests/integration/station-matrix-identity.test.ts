import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { setGrant } from "../../src/services/grants";
import { createPrincipal } from "../../src/services/principals";
import { createStationMatrixRoutes } from "../../src/routes/station-matrix";
import { MatrixUserInUse } from "../../src/services/matrix-as/client";

/**
 * Registering an agent's Matrix identity, without an admin credential on a node.
 *
 * Today `hermes-agents onboard` holds a homeserver admin token in a file on
 * molt-bot and can create, deactivate or take over ANY account on that
 * homeserver — including a human's. An Application Service needs no such rights
 * to register users inside its own namespace, so the ordinary path drops the
 * admin credential entirely.
 *
 * The privileged path — issuing an agent its own access token — moves behind the
 * hub and behind `mayGrantReach`, because handing an agent a credential is the
 * definition of granting it reach.
 */

const OWNER = "test-user-station-matrix";
const NODE = "node_station_matrix";
const STATION = "station_station_matrix";
const DOMAIN = "id.agentpod.dev";

let OWNER_PRINCIPAL: string;
/** The agent occupying STATION — the matcher compares a grant against this now. */
let AGENT_PRINCIPAL: string;
/** Some other agent, granted where a test wants to prove the scope check is real. */
const OTHER_AGENT = "prn_ffffffffffffffffffff";

let provisioned: string[] = [];
let issued: Array<{ localpart: string }> = [];
let rotated: Array<{ localpart: string }> = [];
let canRotate = true;
/** The homeserver already has this localpart — the normal case on a real deployment. */
let identityExists = false;
let logged: string[] = [];

function app() {
  const routes = createStationMatrixRoutes({
    domain: DOMAIN,
    provisionStation: async (stationId: string) => {
      provisioned.push(stationId);
    },
    credentials: {
      register: async (localpart: string) => {
        if (identityExists) throw new MatrixUserInUse(localpart);
        issued.push({ localpart });
        return {
          userId: `@${localpart}:${DOMAIN}`,
          accessToken: "syt_secret_token_value",
          deviceId: "DEV1",
        };
      },
      rotate: canRotate
        ? async (localpart: string) => {
            rotated.push({ localpart });
            return {
              userId: `@${localpart}:${DOMAIN}`,
              accessToken: "syt_rotated_token_value",
              deviceId: "DEV2",
            };
          }
        : undefined,
    },
    log: (line: string) => logged.push(line),
  });

  return new Hono()
    .use("*", async (c, next) => {
      c.set("user", { id: OWNER, role: "user" });
      await next();
    })
    .route("/api", routes);
}

const post = (path: string) => app().request(`/api${path}`, { method: "POST" });

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: "station-matrix@example.com", name: "Owner" });
  OWNER_PRINCIPAL = await createPrincipal({ kind: "human", handle: "station-matrix-it-owner", userId: OWNER });
  AGENT_PRINCIPAL = await createPrincipal({ kind: "agent", handle: "station-matrix-it-agent" });
  const tenant = await resolveTenantForUser(OWNER);
  await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${STATION}`;
  await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${OWNER}, 'sm-box', 'sm-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, principal_id, adopted_at, created_at)
    VALUES (${STATION}, ${tenant}, ${OWNER}, ${NODE}, 'hermes', 'hermes:analyst-echo', 'leaf', 'analyst-echo',
            '["acp"]'::jsonb, ${AGENT_PRINCIPAL}, now(), now())`;
  process.env.ENFORCE_CONTROL_PAIR = "true";
});

beforeEach(async () => {
  provisioned = [];
  issued = [];
  rotated = [];
  logged = [];
  canRotate = true;
  identityExists = false;
  await rawSql`UPDATE stations SET matrix_identity_mode = 'bridge' WHERE id = ${STATION}`;
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${STATION}`;
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${OWNER_PRINCIPAL}`;
    await rawSql`DELETE FROM principal_identities WHERE external_id = ${OWNER}`;
    await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
    await rawSql`DELETE FROM principals WHERE handle IN ('station-matrix-it-owner', 'station-matrix-it-agent')`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id = ${OWNER}`;
  } catch {
    // cleanup only
  }
});

describe("POST /api/stations/:id/matrix/identity", () => {
  test("provisions an identity with no admin credential involved", async () => {
    const res = await post(`/stations/${STATION}/matrix/identity`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { mxid: string; alias: string; mode: string };
    // The mxid is built from the occupying agent's principal handle, not from
    // where the station runs (`charter` → the-mission decisions on an
    // agent-is-a-principal) — and so, since fix round 3, is the room's alias.
    // This asserted the station-derived `#agentpod_sm-box_hermes-analyst-echo`
    // until fix round 5, which is an address no room this endpoint can answer
    // for has ever held: it 409s below unless the station HAS an occupant, and
    // an occupied station's room is created at `bridgeAliasForHandle`.
    expect(body.mxid).toBe("@agent_station-matrix-it-agent:id.agentpod.dev");
    expect(body.alias).toBe("#agentpod_agent_station-matrix-it-agent:id.agentpod.dev");
    expect(body.mode).toBe("bridge");
    expect(provisioned).toEqual([STATION]);
    // Issuing an identity is the appservice acting in its own namespace. No
    // token is minted and nothing privileged happens.
    expect(issued).toHaveLength(0);
  });

  test("does not need mayGrantReach, because it grants nothing", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [], mayGrantReach: false });

    expect((await post(`/stations/${STATION}/matrix/identity`)).status).toBe(200);
  });

  test("is idempotent — the same identity comes back", async () => {
    const a = await (await post(`/stations/${STATION}/matrix/identity`)).json();
    const b = await (await post(`/stations/${STATION}/matrix/identity`)).json();
    expect(b).toEqual(a);
  });

  test("404s for a station that is not this principal's", async () => {
    const res = await post("/stations/station_does_not_exist/matrix/identity");
    expect(res.status).toBe(404);
  });

  test("reports the alias the station's room is ACTUALLY reachable at, not one re-derived here", async () => {
    // A room that already exists, at an address neither derivation would
    // produce today — an ordinary state on the deployed box, where the 32
    // live rooms were created before a room's alias followed its occupant.
    // Re-deriving would misreport every one of them; the stored alias is the
    // only thing that is true about where the room actually is.
    const tenant = await resolveTenantForUser(OWNER);
    const storedAlias = "#agentpod_sm-box_hermes-analyst-echo-legacy:id.agentpod.dev";
    await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${STATION}`;
    await rawSql`
      INSERT INTO matrix_rooms (room_id, tenant_id, station_id, alias, principal_id, created_at)
      VALUES (${"!sm-legacy:" + DOMAIN}, ${tenant}, ${STATION}, ${storedAlias}, ${AGENT_PRINCIPAL}, now())`;

    try {
      const body = (await (await post(`/stations/${STATION}/matrix/identity`)).json()) as {
        alias: string;
      };
      expect(body.alias).toBe(storedAlias);
    } finally {
      await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${STATION}`;
    }
  });
});

describe("POST /api/stations/:id/matrix/credentials", () => {
  test("requires mayGrantReach, because a credential IS reach", async () => {
    // Dispatch permission is not enough: handing an agent an access token is
    // the definition of granting it reach.
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });

    const res = await post(`/stations/${STATION}/matrix/credentials`);

    expect(res.status).toBe(403);
    expect(issued).toHaveLength(0);
  });

  test("requires the station to be in scope as well", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [OTHER_AGENT], mayGrantReach: true });

    expect((await post(`/stations/${STATION}/matrix/credentials`)).status).toBe(403);
  });

  test("mints a token and flips the station to harness mode", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });

    const res = await post(`/stations/${STATION}/matrix/credentials`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string; mxid: string };
    expect(body.accessToken).toBe("syt_secret_token_value");

    const [row] = await rawSql`
      SELECT matrix_identity_mode FROM stations WHERE id = ${STATION}`;
    expect(row!.matrix_identity_mode).toBe("harness");
  });

  test("never writes the token it just issued into a log", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });

    await post(`/stations/${STATION}/matrix/credentials`);

    expect(logged.join("\n")).not.toContain("syt_secret_token_value");
    // …and it still says something, so the act is auditable.
    expect(logged.join("\n")).toMatch(/credential/i);
  });

  test("rotates rather than failing when the identity already exists", async () => {
    // The identity is provisioned long before anyone asks for credentials, so
    // "already registered" is the normal case, not an error.
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });
    identityExists = true;

    const res = await post(`/stations/${STATION}/matrix/credentials`);

    expect(res.status).toBe(200);
    expect(rotated).toHaveLength(1);
    expect(((await res.json()) as { accessToken: string }).accessToken).toBe(
      "syt_rotated_token_value"
    );
  });

  test("says plainly when rotation is impossible rather than pretending", async () => {
    // Rotating an existing identity needs the homeserver's admin account. If it
    // is not configured, the honest answer is that this cannot be done here —
    // not a 500, and not a silent no-op that leaves a harness without a token.
    canRotate = false;
    identityExists = true;
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });

    const res = await post(`/stations/${STATION}/matrix/credentials`);

    expect(res.status).toBe(409);
    expect((await res.text()).toLowerCase()).toMatch(/rotate|configur/);
  });

  test("a station in BRIDGE mode whose identity exists is rotated, not refused", async () => {
    // The regression this file did not have. The bridge provisions an identity
    // for every station it adopts, so a station in `bridge` mode has one — it
    // simply does not hold its own credentials. Branching on the mode sent every
    // station on a real deployment down the register path, where all 32 of them
    // failed M_USER_IN_USE and the operator saw a 500.
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });
    await rawSql`UPDATE stations SET matrix_identity_mode = 'bridge' WHERE id = ${STATION}`;
    identityExists = true;

    const res = await post(`/stations/${STATION}/matrix/credentials`);

    expect(res.status).toBe(200);
    expect(rotated).toHaveLength(1);
    expect(issued).toHaveLength(0);
    expect(((await res.json()) as { mode: string }).mode).toBe("harness");
  });

  test("registers, without rotating, when the identity is genuinely new", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });
    identityExists = false;

    const res = await post(`/stations/${STATION}/matrix/credentials`);

    expect(res.status).toBe(200);
    expect(issued).toHaveLength(1);
    expect(rotated).toHaveLength(0);
  });
});

/**
 * The operator's half of the pull described in
 * `docs/superpowers/specs/2026-09-01-uniform-matrix-identity-design.md` §2: a
 * human authorises one station's move, and the node redeems that
 * authorisation for the credential itself (Task 2). This route mints only —
 * it never returns the token, because the token goes to the node, never
 * through the operator.
 */
describe("POST /api/stations/:id/matrix/authorize-move", () => {
  test("403 when the caller's grant does not permit granting reach", async () => {
    // The gate from charter → decisions/2026-08-15-granting-reach-is-changing-an-agent.md.
    // It is the whole reason the node cannot self-serve, so it is asserted here.
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });

    const res = await post(`/stations/${STATION}/matrix/authorize-move`);

    expect(res.status).toBe(403);
  });

  test("authorising mints an authorization and returns no credential", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });

    const res = await post(`/stations/${STATION}/matrix/authorize-move`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { expiresAt: string };
    expect(body.expiresAt).toBeTruthy();
    // The token goes to the node over Task 2's endpoint, never through the
    // operator — so it must not be reachable in this response body at all.
    expect(JSON.stringify(body)).not.toContain("accessToken");
    expect(JSON.stringify(body)).not.toContain("token");
  });

  test("409 when the station has no occupying agent", async () => {
    // With no occupant, `requireIssueCredentials`'s own scope check (a grant
    // names a PRINCIPAL, and there isn't one here) would refuse with 403
    // before this route ever got a chance to say why — so this proves the
    // occupancy 409 with the control pair off, the same way the identity
    // route's occupancy checks are proven independent of the reach gate.
    delete process.env.ENFORCE_CONTROL_PAIR;
    await rawSql`UPDATE stations SET principal_id = NULL WHERE id = ${STATION}`;

    try {
      const res = await post(`/stations/${STATION}/matrix/authorize-move`);
      expect(res.status).toBe(409);
    } finally {
      await rawSql`UPDATE stations SET principal_id = ${AGENT_PRINCIPAL} WHERE id = ${STATION}`;
      process.env.ENFORCE_CONTROL_PAIR = "true";
    }
  });

  test("409 when the station's harness has no profile writer", async () => {
    // Slice 2 adds the rest. Until then an unsupported harness refuses by name
    // and the station is left exactly as it was.
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });
    await rawSql`UPDATE stations SET harness = 'openclaw' WHERE id = ${STATION}`;

    try {
      const res = await post(`/stations/${STATION}/matrix/authorize-move`);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("openclaw");
    } finally {
      await rawSql`UPDATE stations SET harness = 'hermes' WHERE id = ${STATION}`;
    }
  });
});
