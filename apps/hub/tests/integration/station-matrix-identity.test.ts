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
import type { PreJoinOutcome } from "../../src/services/matrix-as/identity-move";
import { moveState, onNodeReportedMatrixId } from "../../src/services/matrix-as/identity-move";
import { signalNodeToAdopt } from "../../src/services/matrix-as/adopt-signal";
import { onStationMatrixIdReported } from "../../src/services/matrix-as/hooks";
import { connectionManager } from "../../src/services/connection-manager";
import { handleNodeMessage } from "../../src/services/broker";
import type { GatewayServerMessage } from "@agentpod/contract";

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
/**
 * What the ordered move's step 2 answered — injected, so this file stays about
 * the ROUTE. The pre-join's own behaviour (invite-then-join, the ambiguous-room
 * refusal, both identities in the room at once) is proven against a real
 * homeserver in `identity-move.test.ts`; what belongs here is that the route
 * runs it BEFORE it mints anything, and refuses the whole move when it refuses.
 */
let preJoined: PreJoinOutcome = { status: "joined", roomId: "!r:x", newMxid: "@n:x", oldMxid: "@o:x" };
let preJoinCalls: string[] = [];
/**
 * The promises `signalNodeToAdopt` returns.
 *
 * The route fires it and does NOT await it (Ruling 9: a node's whole round
 * trip is a credential fetch, a profile write and a harness restart, and
 * blocking the operator's HTTP response on that would be a worse design).
 * A test that asserts on what the signal DID has to wait for it, so the deps
 * hand it over rather than the test polling the database and hoping.
 */
let inFlightSignals: Array<Promise<unknown>> = [];

function app() {
  const routes = createStationMatrixRoutes({
    domain: DOMAIN,
    preJoinNewIdentity: async (stationId: string) => {
      preJoinCalls.push(stationId);
      return preJoined;
    },
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
    // The REAL signal path, not a stub: it is the whole of convergence's
    // trigger, and stubbing it here would leave the thing this file is best
    // placed to prove — that the mxid a node reports on `matrix.adopt` reaches
    // the hub's convergence listener — exercised nowhere at all. Its broker
    // dependency is already driven for real below, through `connectionManager`
    // and `handleNodeMessage`.
    signalNodeToAdopt: (args, signalDeps) => {
      const signalled = signalNodeToAdopt(args, signalDeps);
      inFlightSignals.push(signalled);
      return signalled;
    },
    moveState: (stationId: string) => moveState(stationId),
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
  preJoined = { status: "joined", roomId: "!r:x", newMxid: "@n:x", oldMxid: "@o:x" };
  preJoinCalls = [];
  inFlightSignals = [];
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

  /**
   * The ordering the whole slice exists for (design §4). The naive order —
   * authorise, let the node switch the credential, then move the room — is
   * what left 14 stations logged in as users their rooms did not contain on
   * 2026-08-31.
   */
  describe("the ordered move", () => {
    test("the new identity is put in the room BEFORE anything is minted", async () => {
      await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });
      await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;

      const res = await post(`/stations/${STATION}/matrix/authorize-move`);

      expect(res.status).toBe(200);
      expect(preJoinCalls).toEqual([STATION]);
      const rows = await rawSql`
        SELECT count(*)::int AS n FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
      expect((rows[0] as { n: number }).n).toBe(1);
    });

    test("a refused pre-join refuses the move: nothing minted, nothing signalled", async () => {
      // §4's failure table: "step 2 fails → nothing has changed yet". A
      // station whose room choice is ambiguous is the case that refusal was
      // written for, and it must not become an authorization a node can
      // redeem — a credential switched with the room unmoved is the outage.
      await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });
      await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
      preJoined = { status: "ambiguous-room", candidates: ["!a:x", "!b:x"] };

      const res = await post(`/stations/${STATION}/matrix/authorize-move`);

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("!a:x");
      const rows = await rawSql`
        SELECT count(*)::int AS n FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
      expect((rows[0] as { n: number }).n).toBe(0);
    });
  });

  /**
   * Defect 3: minting used to be the whole route — nothing ever told the
   * node to move. `broker.request`'s own contract (never rejects; "node
   * offline" is an ordinary `{ok:false}`) is exercised for real here via
   * `connectionManager` and `handleNodeMessage`, not mocked: registering a
   * fake sender under `NODE` and replying synchronously to `matrix.adopt`
   * is enough to drive the whole round trip without a real websocket.
   */
  describe("signalling the node", () => {
    let sentReqs: Array<{ id: string; verb: string; params: unknown }>;

    /** A fake node connection that ACKs matrix.adopt synchronously. */
    function connectRespondingNode() {
      sentReqs = [];
      const send = (msg: GatewayServerMessage) => {
        if (msg.type !== "req") return;
        sentReqs.push({ id: msg.id, verb: msg.verb, params: msg.params });
        if (msg.verb === "matrix.adopt") {
          handleNodeMessage(NODE, { type: "res", id: msg.id, ok: true, data: { accepted: true } });
        }
      };
      connectionManager.register(NODE, send);
    }

    afterAll(() => {
      connectionManager.unregister(NODE);
    });

    test("sends matrix.adopt with the station's key AND its database id — not the key alone", async () => {
      await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });
      connectRespondingNode();

      try {
        const res = await post(`/stations/${STATION}/matrix/authorize-move`);
        expect(res.status).toBe(200);

        const adopts = sentReqs.filter((r) => r.verb === "matrix.adopt");
        expect(adopts).toHaveLength(1);
        // The node's profile-directory lookup needs the station KEY; the
        // hub's redemption endpoint is keyed by the station's database ID.
        // Sending only one or the other leaves the node unable to build a
        // URL the hub can resolve.
        expect(adopts[0]!.params).toEqual({ key: "hermes:analyst-echo", stationId: STATION });
      } finally {
        connectionManager.unregister(NODE);
      }
    });

    test("an offline node does not fail the authorization — the record still stands", async () => {
      await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });
      // Deliberately not connected: connectionManager has no sender for
      // NODE, so broker.request resolves {ok:false, error:"node offline"}.
      connectionManager.unregister(NODE);

      const res = await post(`/stations/${STATION}/matrix/authorize-move`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { expiresAt: string };
      expect(body.expiresAt).toBeTruthy();
    });
  });

  /**
   * The whole-branch review's CRITICAL, driven from the trigger rather than
   * from the listener.
   *
   * Design §4 step 5 said "the node reports the new mxid on its next detect".
   * There is no next detect: `matrix.adopt` restarts the HARNESS, not the
   * node-agent, so the websocket whose `onOpen` calls
   * `refreshAdoptedCapabilities` never reopens, and no node→hub message
   * carries an mxid. So after a successful move the station worked and
   * `stations.matrix_id` stayed stale FOREVER — `moveState` read `waiting`,
   * `onNodeReportedMatrixId` never fired, `retireOldIdentity` never ran, and
   * the old credential stayed live.
   *
   * It was invisible because every existing test calls
   * `onNodeReportedMatrixId` directly. These start where a real move starts —
   * an operator's POST — and end where it ends: the two columns agreeing, and
   * the old identity retired. Everything between is production wiring:
   * `signalNodeToAdopt`, the real broker, the real `stationReportedMatrixId`
   * hook, and the boot listener from `index.ts`.
   */
  describe("convergence, from the node's answer", () => {
    const OLD_MXID = "@agent_guild_hermes-analyst-echo:id.agentpod.dev";
    const NEW_MXID = "@agent_station-matrix-it-agent:id.agentpod.dev";

    /** What `retireOldIdentity` was asked to do, so step 6 is observable. */
    let retired: Array<{ userId: string; op: string }>;

    /**
     * `index.ts`'s own boot wiring, verbatim in shape: the hook every detect
     * announces through, pointed at the convergence listener. Registering it
     * here is what makes this an end-to-end assertion rather than a check that
     * one function calls another.
     */
    function wireConvergenceListener() {
      retired = [];
      onStationMatrixIdReported(async (stationId, mxid) => {
        await onNodeReportedMatrixId(stationId, mxid, {
          domain: DOMAIN,
          client: {
            invite: async () => {},
            join: async () => {},
            leave: async (userId: string) => {
              retired.push({ userId, op: "leave" });
            },
            // No room row for this station, so the leave path is not reached;
            // recording and revoking are, and they are what §5 is about.
            isJoined: async () => true,
            retireAccount: async (userId: string) => {
              retired.push({ userId, op: "retire" });
              return { credentialsRevoked: true, accountDeactivated: false };
            },
          },
        });
      });
    }

    /** A node that adopts and reports back what its profile now reads as. */
    function connectNodeReporting(matrixId: string | null | undefined) {
      const send = (msg: GatewayServerMessage) => {
        if (msg.type !== "req" || msg.verb !== "matrix.adopt") return;
        handleNodeMessage(NODE, {
          type: "res",
          id: msg.id,
          ok: true,
          data: matrixId === undefined ? { accepted: true } : { accepted: true, matrixId },
        });
      };
      connectionManager.register(NODE, send);
    }

    beforeEach(async () => {
      await rawSql`
        UPDATE stations SET matrix_id = ${OLD_MXID}, bridge_matrix_id = ${NEW_MXID}
        WHERE id = ${STATION}`;
      await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
      await rawSql`DELETE FROM principal_identities WHERE principal_id = ${AGENT_PRINCIPAL}`;
      await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });
    });

    afterAll(async () => {
      onStationMatrixIdReported(null);
      connectionManager.unregister(NODE);
      await rawSql`UPDATE stations SET matrix_id = NULL, bridge_matrix_id = NULL WHERE id = ${STATION}`;
      await rawSql`DELETE FROM principal_identities WHERE principal_id = ${AGENT_PRINCIPAL}`;
    });

    test("the mxid a node reports on matrix.adopt converges the station and retires the old identity", async () => {
      wireConvergenceListener();
      connectNodeReporting(NEW_MXID);

      try {
        const res = await post(`/stations/${STATION}/matrix/authorize-move`);
        expect(res.status).toBe(200);
        await Promise.all(inFlightSignals);

        // §1's invariant, now true — and reached without anything in this test
        // touching `onNodeReportedMatrixId`.
        const [row] = (await rawSql`
          SELECT matrix_id, bridge_matrix_id FROM stations WHERE id = ${STATION}`) as Array<{
          matrix_id: string;
          bridge_matrix_id: string;
        }>;
        expect(row!.matrix_id).toBe(NEW_MXID);
        expect(row!.matrix_id).toBe(row!.bridge_matrix_id);

        // Step 6 ran, on the old identity and only on it.
        expect(retired).toContainEqual({ userId: OLD_MXID, op: "retire" });
        expect(retired.some((r) => r.userId === NEW_MXID)).toBe(false);

        // …and §5's record, which is what keeps the room's history
        // attributable once the account is gone.
        const identities = (await rawSql`
          SELECT external_id FROM principal_identities
          WHERE principal_id = ${AGENT_PRINCIPAL} AND system = 'matrix'`) as Array<{
          external_id: string;
        }>;
        expect(identities.map((i) => i.external_id)).toContain(OLD_MXID);
      } finally {
        onStationMatrixIdReported(null);
        connectionManager.unregister(NODE);
      }
    });

    test("a node that reports no identity leaves the station exactly as it was", async () => {
      // §3's failure: the credential was written somewhere the harness never
      // loads, so the reader finds nothing. The safe state is the whole point —
      // the station keeps its old identity, and step 6 does NOT run.
      wireConvergenceListener();
      connectNodeReporting(null);

      try {
        expect((await post(`/stations/${STATION}/matrix/authorize-move`)).status).toBe(200);
        await Promise.all(inFlightSignals);

        const [row] = (await rawSql`
          SELECT matrix_id FROM stations WHERE id = ${STATION}`) as Array<{ matrix_id: string }>;
        expect(row!.matrix_id).toBe(OLD_MXID);
        expect(retired).toEqual([]);
      } finally {
        onStationMatrixIdReported(null);
        connectionManager.unregister(NODE);
      }
    });

    test("an older node that omits the field is not read as convergence", async () => {
      wireConvergenceListener();
      connectNodeReporting(undefined);

      try {
        expect((await post(`/stations/${STATION}/matrix/authorize-move`)).status).toBe(200);
        await Promise.all(inFlightSignals);

        const [row] = (await rawSql`
          SELECT matrix_id FROM stations WHERE id = ${STATION}`) as Array<{ matrix_id: string }>;
        expect(row!.matrix_id).toBe(OLD_MXID);
        expect(retired).toEqual([]);
      } finally {
        onStationMatrixIdReported(null);
        connectionManager.unregister(NODE);
      }
    });

    test("a node reporting something OTHER than the minted address is not convergence", async () => {
      // A harness that ignored the new credential and came back up as itself.
      // §4's failure table: no convergence, no retirement, station working.
      wireConvergenceListener();
      connectNodeReporting(OLD_MXID);

      try {
        expect((await post(`/stations/${STATION}/matrix/authorize-move`)).status).toBe(200);
        await Promise.all(inFlightSignals);

        const [row] = (await rawSql`
          SELECT matrix_id FROM stations WHERE id = ${STATION}`) as Array<{ matrix_id: string }>;
        expect(row!.matrix_id).toBe(OLD_MXID);
        expect(retired).toEqual([]);
      } finally {
        onStationMatrixIdReported(null);
        connectionManager.unregister(NODE);
      }
    });
  });

  /**
   * Ruling 9 made re-authorising the retry, and the Critical above made
   * retries routine. Without a guard each press inserted another live row.
   */
  describe("re-authorising", () => {
    test("refreshes the station's live authorization rather than adding another", async () => {
      await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });
      await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
      connectionManager.unregister(NODE); // offline: nothing redeems

      const first = await post(`/stations/${STATION}/matrix/authorize-move`);
      const second = await post(`/stations/${STATION}/matrix/authorize-move`);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const rows = (await rawSql`
        SELECT count(*)::int AS n FROM matrix_credential_authorizations
        WHERE station_id = ${STATION} AND used_at IS NULL`) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);

      // And the retry is a real one: the window moved, so pressing again is
      // not a no-op on an authorization that was about to expire.
      const expiries = (await rawSql`
        SELECT expires_at FROM matrix_credential_authorizations
        WHERE station_id = ${STATION}`) as Array<{ expires_at: Date }>;
      expect(expiries).toHaveLength(1);
      const body = (await second.json()) as { expiresAt: string };
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThanOrEqual(
        new Date((await first.json() as { expiresAt: string }).expiresAt).getTime()
      );
    });
  });

  /**
   * §6's third state, made readable outside the hub. `moveState` computed all
   * four and nothing could read any of them — the console re-derived three
   * from raw columns and could not see `waiting` at all, because the
   * authorisation it is derived from lives only here.
   */
  describe("GET /api/stations/:id/matrix/move-state", () => {
    const OLD_MXID = "@agent_guild_hermes-analyst-echo:id.agentpod.dev";
    const NEW_MXID = "@agent_station-matrix-it-agent:id.agentpod.dev";

    const getState = (path: string) => app().request(`/api${path}`);

    afterAll(async () => {
      await rawSql`UPDATE stations SET matrix_id = NULL, bridge_matrix_id = NULL WHERE id = ${STATION}`;
      await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
    });

    test("bridge mode: the appservice speaks for it", async () => {
      await rawSql`UPDATE stations SET matrix_id = NULL, bridge_matrix_id = ${NEW_MXID} WHERE id = ${STATION}`;
      const res = await getState(`/stations/${STATION}/matrix/move-state`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "bridge" });
    });

    test("a station running under a retired identity, with nobody having asked it to move", async () => {
      await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
      await rawSql`UPDATE stations SET matrix_id = ${OLD_MXID}, bridge_matrix_id = ${NEW_MXID} WHERE id = ${STATION}`;
      const res = await getState(`/stations/${STATION}/matrix/move-state`);
      expect(await res.json()).toMatchObject({
        status: "retired-identity",
        runningAs: OLD_MXID,
        willBecome: NEW_MXID,
      });
    });

    test("waiting: authorised, not yet converged — and it survives having no browser to remember it", async () => {
      // The state the console could not see. It is derived here from the
      // authorisation record, which is why a component-local flag could never
      // answer it after a reload.
      await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });
      await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
      await rawSql`UPDATE stations SET matrix_id = ${OLD_MXID}, bridge_matrix_id = ${NEW_MXID} WHERE id = ${STATION}`;
      connectionManager.unregister(NODE); // offline: authorised, nothing adopts

      expect((await post(`/stations/${STATION}/matrix/authorize-move`)).status).toBe(200);

      const res = await getState(`/stations/${STATION}/matrix/move-state`);
      expect(await res.json()).toMatchObject({
        status: "waiting",
        runningAs: OLD_MXID,
        willBecome: NEW_MXID,
      });
    });

    test("converged means the two columns agree — and says nothing about health", async () => {
      await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
      await rawSql`UPDATE stations SET matrix_id = ${NEW_MXID}, bridge_matrix_id = ${NEW_MXID} WHERE id = ${STATION}`;
      const res = await getState(`/stations/${STATION}/matrix/move-state`);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ status: "converged", mxid: NEW_MXID });
      // No health field, no room field, nothing that could be read as "this
      // station can post". Whether it can is a Matrix fact in neither column.
      expect(Object.keys(body).sort()).toEqual(["mxid", "status"]);
    });

    test("404 for a station this caller does not own", async () => {
      const res = await getState(`/stations/station_not_mine/matrix/move-state`);
      expect(res.status).toBe(404);
    });
  });
});
