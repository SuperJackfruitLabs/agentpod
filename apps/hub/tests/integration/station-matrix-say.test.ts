import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { setGrant } from "../../src/services/grants";
import { createPrincipal } from "../../src/services/principals";
import { createStationSayRoutes } from "../../src/routes/station-say";

/**
 * An agent speaking without being spoken to.
 *
 * hermes agents have cron jobs: they report in the morning, they raise things
 * nobody asked about. Bridge mode relays ACP session output, and an ACP session
 * only exists because somebody prompted it — so those messages had nowhere to
 * go, and an agent that used to announce things simply went quiet.
 *
 * This is the path back. It is deliberately NOT an ACP session: there is no
 * conversation, no turn, no transcript to attach — just a station saying
 * something in its own room, as itself.
 */

const OWNER = "test-user-say";
const NODE = "node_say";
const STATION = "station_say";
const ROOM = "!say:id.agentpod.dev";

let OWNER_PRINCIPAL: string;
/** The agent occupying STATION — the matcher compares a grant against this now. */
let AGENT_PRINCIPAL: string;
/** Some other agent, granted where a test wants to prove the scope check is real. */
const OTHER_AGENT = "prn_ffffffffffffffffffff";

let sent: Array<{ userId: string; roomId: string; body: string }> = [];

function app(user = { id: OWNER, role: "user" }) {
  const routes = createStationSayRoutes({
    domain: "id.agentpod.dev",
    client: {
      sendText: async (userId: string, roomId: string, body: string) => {
        sent.push({ userId, roomId, body });
        return "$evt";
      },
    },
  });
  return new Hono()
    .use("*", async (c, next) => {
      c.set("user", user);
      await next();
    })
    .route("/api", routes);
}

const say = (body: unknown, stationId = STATION) =>
  app().request(`/api/stations/${stationId}/matrix/say`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: "say@example.com", name: "Owner" });
  OWNER_PRINCIPAL = await createPrincipal({ kind: "human", handle: "station-say-it-owner", userId: OWNER });
  AGENT_PRINCIPAL = await createPrincipal({ kind: "agent", handle: "station-say-it-agent" });
  const tenant = await resolveTenantForUser(OWNER);
  await rawSql`DELETE FROM matrix_rooms WHERE room_id = ${ROOM}`;
  await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${OWNER}, 'say-box', 'say-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, principal_id, adopted_at, created_at)
    VALUES (${STATION}, ${tenant}, ${OWNER}, ${NODE}, 'hermes', 'hermes:cron-carl', 'leaf', 'cron-carl',
            '["acp"]'::jsonb, ${AGENT_PRINCIPAL}, now(), now())`;
  // `principal_id` bound at insert — fix round 2 on Task 5: `station-say.ts`
  // resolves a room through `station-room.ts` now, which answers for an
  // OCCUPIED station only with a room actually bound to that occupant
  // (never a bare `station_id` match). A room seeded here without it would
  // read as "not yet provisioned" and 409, which is not what this fixture
  // means to represent.
  await rawSql`
    INSERT INTO matrix_rooms (room_id, tenant_id, station_id, alias, principal_id, created_at)
    VALUES (${ROOM}, ${tenant}, ${STATION}, '#agentpod_say-box_hermes-cron-carl:id.agentpod.dev', ${AGENT_PRINCIPAL}, now())`;
  process.env.ENFORCE_CONTROL_PAIR = "true";
});

beforeEach(async () => {
  sent = [];
  await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
  await rawSql`UPDATE stations SET matrix_identity_mode = 'bridge' WHERE id = ${STATION}`;
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM matrix_rooms WHERE room_id = ${ROOM}`;
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${OWNER_PRINCIPAL}`;
    await rawSql`DELETE FROM principal_identities WHERE external_id = ${OWNER}`;
    await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
    await rawSql`DELETE FROM principals WHERE handle IN ('station-say-it-owner', 'station-say-it-agent')`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id = ${OWNER}`;
  } catch {
    // cleanup only
  }
});

describe("POST /api/stations/:id/matrix/say", () => {
  test("says it in the station's room, as the station", async () => {
    const res = await say({ body: "Morning report: 3 tasks done, 1 blocked." });

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      roomId: ROOM,
      // Built from the occupying agent's principal handle now, not from
      // where the station runs.
      userId: "@agent_station-say-it-agent:id.agentpod.dev",
      body: "Morning report: 3 tasks done, 1 blocked.",
    });
  });

  test("needs a grant covering the station, like dispatching it does", async () => {
    // Speaking as an agent is speaking AS it. Anyone who may not dispatch this
    // agent must not be able to put words in its mouth.
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [OTHER_AGENT], mayGrantReach: false });

    expect((await say({ body: "hello" })).status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  test("refuses an empty message rather than posting nothing", async () => {
    expect((await say({ body: "   " })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  test("404s for a station that is not the caller's", async () => {
    expect((await say({ body: "hi" }, "station_not_mine")).status).toBe(404);
  });

  test("says nothing for a station with no room yet", async () => {
    // Provisioning may not have run. Answering 409 tells the caller what to fix
    // rather than swallowing the message.
    await rawSql`DELETE FROM matrix_rooms WHERE room_id = ${ROOM}`;

    const res = await say({ body: "anyone there?" });

    expect(res.status).toBe(409);
    expect(sent).toHaveLength(0);

    const tenant = await resolveTenantForUser(OWNER);
    await rawSql`
      INSERT INTO matrix_rooms (room_id, tenant_id, station_id, alias, principal_id, created_at)
      VALUES (${ROOM}, ${tenant}, ${STATION}, '#agentpod_say-box_hermes-cron-carl:id.agentpod.dev', ${AGENT_PRINCIPAL}, now())`;
  });

  test("stays out of the way when the harness answers for itself", async () => {
    // A harness-mode station has its own Matrix client and posts its own
    // messages. Speaking for it too would double every announcement.
    await rawSql`UPDATE stations SET matrix_identity_mode = 'harness' WHERE id = ${STATION}`;

    expect((await say({ body: "hello" })).status).toBe(409);
    expect(sent).toHaveLength(0);
  });
});
