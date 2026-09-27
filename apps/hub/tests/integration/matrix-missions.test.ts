import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { setGrant } from "../../src/services/grants";
import { createPrincipal } from "../../src/services/principals";
import { createMissionRoutes } from "../../src/routes/missions";

/**
 * Rooms where several agents work together.
 *
 * The other half of the split: a per-agent room is a DM, because talking to one
 * agent has one correspondent. A mission has several, so it is an ordinary room
 * — and ordinary rooms are what a space can group, which is the thing DMs did
 * not need.
 */

const OWNER = "test-user-mission";
const NODE = "node_mission";
const A = "station_mission_a";
const B = "station_mission_b";
const OWNER_MXID = "@owner-mission:id.agentpod.dev";

let OWNER_PRINCIPAL: string;
/** The agents occupying A and B — the matcher compares a grant against these now. */
let AGENT_A: string;
let AGENT_B: string;

let rooms: Array<{ alias: string; name: string; invite?: string }> = [];
let spaces: Array<{ name: string }> = [];
let children: Array<{ space: string; child: string }> = [];
let invited: Array<{ roomId: string; invitee: string }> = [];

function app() {
  const routes = createMissionRoutes({
    domain: "id.agentpod.dev",
    client: {
      ensureRoom: async (alias: string, opts: any) => {
        rooms.push({ alias, name: opts.name, invite: opts.invite });
        return `!mission${rooms.length}:id.agentpod.dev`;
      },
      createSpace: async (opts: any) => {
        spaces.push({ name: opts.name });
        return `!space${spaces.length}:id.agentpod.dev`;
      },
      addSpaceChild: async (_creator: string, space: string, child: string) => {
        children.push({ space, child });
      },
      invite: async (_as: string, roomId: string, invitee: string) => {
        invited.push({ roomId, invitee });
      },
    },
  });
  return new Hono()
    .use("*", async (c, next) => {
      c.set("user", { id: OWNER, role: "user" });
      await next();
    })
    .route("/api", routes);
}

const post = (path: string, body: unknown) =>
  app().request(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: "mission@example.com", name: "Owner" });
  OWNER_PRINCIPAL = await createPrincipal({ kind: "human", handle: "mission-it-owner", userId: OWNER });
  AGENT_A = await createPrincipal({ kind: "agent", handle: "mission-it-agent-a" });
  AGENT_B = await createPrincipal({ kind: "agent", handle: "mission-it-agent-b" });
  const tenant = await resolveTenantForUser(OWNER);
  await rawSql`DELETE FROM matrix_mission_members`;
  await rawSql`DELETE FROM matrix_missions`;
  await rawSql`DELETE FROM stations WHERE id IN (${A}, ${B})`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${OWNER}, 'mission-box', 'mission-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  for (const [id, key, agent] of [[A, "hermes:one", AGENT_A], [B, "openclaw:two", AGENT_B]] as const) {
    await rawSql`
      INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, principal_id, adopted_at, created_at)
      VALUES (${id}, ${tenant}, ${OWNER}, ${NODE}, ${key.split(":")[0]}, ${key}, 'leaf', ${key},
              '["acp"]'::jsonb, ${agent}, now(), now())`;
  }
  // `principal_identities.principal_id` is a foreign key onto `principals.id`
  // now, not the Better Auth user id — the row this route reads to invite the
  // human back into their own mission has to be keyed by the real principal.
  // Only the 'matrix' row is cleared: `createPrincipal` above already wrote
  // this principal's 'better-auth' row, and deleting every system's row for
  // this principal_id would take that one with it — `principalForUser` would
  // then find nobody, and the route would fail closed for a caller who really
  // does have a principal.
  await rawSql`DELETE FROM principal_identities WHERE principal_id = ${OWNER_PRINCIPAL} AND system = 'matrix'`;
  await rawSql`
    INSERT INTO principal_identities (id, principal_id, system, external_id, created_at)
    VALUES ('pid_mission', ${OWNER_PRINCIPAL}, 'matrix', ${OWNER_MXID}, now())`;
  process.env.ENFORCE_CONTROL_PAIR = "true";
});

beforeEach(async () => {
  rooms = [];
  spaces = [];
  children = [];
  invited = [];
  await rawSql`DELETE FROM matrix_mission_members`;
  await rawSql`DELETE FROM matrix_missions`;
  await rawSql`DELETE FROM matrix_spaces`;
  await rawSql`UPDATE stations SET purpose = NULL WHERE node_id = ${NODE}`;
  await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_A, AGENT_B], mayGrantReach: false });
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM matrix_mission_members`;
    await rawSql`DELETE FROM matrix_missions`;
    await rawSql`DELETE FROM matrix_spaces`;
    await rawSql`DELETE FROM principal_identities WHERE principal_id = ${OWNER_PRINCIPAL}`;
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${OWNER_PRINCIPAL}`;
    await rawSql`DELETE FROM stations WHERE id IN (${A}, ${B})`;
    await rawSql`DELETE FROM principals WHERE handle IN ('mission-it-owner', 'mission-it-agent-a', 'mission-it-agent-b')`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id = ${OWNER}`;
  } catch {
    // cleanup only
  }
});

describe("POST /api/missions", () => {
  test("makes an ordinary room, not a DM", async () => {
    // Several agents and several people. `is_direct` would file it under
    // People as though it were one correspondent.
    const res = await post("/missions", { name: "Q3 migration", stationIds: [A, B] });

    expect(res.status).toBe(200);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.alias).toBe("#agentpod_mission_q3-migration:id.agentpod.dev");
    expect((rooms[0] as any).isDirect).toBeUndefined();
  });

  test("invites the other agents and the person who made it", async () => {
    // The room is created BY one of its members — an appservice must act as
    // some user in its namespace, and a room made by a member reads better than
    // one made by a nameless bot. That member is already in it, so inviting it
    // would be an error on some homeservers and noise on all of them.
    await post("/missions", { name: "Q3 migration", stationIds: [A, B] });

    // Built from each occupying agent's principal handle now, not from where
    // the station runs. A (agent-a) is the first member in `stationIds`, so it
    // speaks for the room and is never on its own invite list.
    const invitees = invited.map((i) => i.invitee);
    expect(invitees).toContain("@agent_mission-it-agent-b:id.agentpod.dev");
    expect(invitees).toContain(OWNER_MXID);
    expect(invitees).not.toContain("@agent_mission-it-agent-a:id.agentpod.dev");
  });

  test("refuses a station the caller may not dispatch", async () => {
    // Putting an agent in a room is putting it to work. The grant that governs
    // dispatching it governs this too.
    // Covers A (agent-a) but not B (agent-b).
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_A], mayGrantReach: false });

    const res = await post("/missions", { name: "Half a mission", stationIds: [A, B] });

    expect(res.status).toBe(403);
    // Nothing half-made: no room for a mission that was refused.
    expect(rooms).toHaveLength(0);
  });

  test("hangs the room under a space, which is what groups missions", async () => {
    await post("/missions", { name: "Q3 migration", stationIds: [A] });

    expect(spaces).toEqual([{ name: "Missions" }]);
    expect(children).toHaveLength(1);
    expect(children[0]!.child).toBe("!mission1:id.agentpod.dev");
  });

  test("reuses the space rather than making one per mission", async () => {
    await post("/missions", { name: "First", stationIds: [A] });
    spaces = [];

    await post("/missions", { name: "Second", stationIds: [A] });

    expect(spaces).toHaveLength(0);
    expect(children).toHaveLength(2);
  });

  test("a station can be in several missions at once", async () => {
    // An agent is not consumed by the work it is doing, and one mission per
    // agent is the DM we already have.
    await post("/missions", { name: "First", stationIds: [A] });
    const res = await post("/missions", { name: "Second", stationIds: [A] });

    expect(res.status).toBe(200);
    const rows = await rawSql`SELECT count(*)::int AS n FROM matrix_mission_members WHERE station_id = ${A}`;
    expect(rows[0]!.n).toBe(2);
  });

  test("refuses a mission with no agents in it", async () => {
    // That is a room, not a mission, and the bridge is not a chat host.
    expect((await post("/missions", { name: "Empty", stationIds: [] })).status).toBe(400);
  });

  test("a repeated name returns the same mission rather than a second room", async () => {
    const first = await (await post("/missions", { name: "Q3 migration", stationIds: [A] })).json();
    rooms = [];

    const second = await (await post("/missions", { name: "Q3 migration", stationIds: [A] })).json();

    expect((second as any).id).toBe((first as any).id);
    expect(rooms).toHaveLength(0);
  });
});

describe("where a mission hangs", () => {
  test("always in the one Missions space, whatever nodes its members are on", async () => {
    // Grouping is by node now, and a mission that spans machines — which is
    // most of them, since that is the point of a mission — belongs to all of
    // them and to none. Filing it under one member's node would be picking a
    // member.
    await rawSql`UPDATE stations SET purpose = 'work' WHERE id IN (${A}, ${B})`;

    await post("/missions", { name: "Q4 rollout", stationIds: [A, B] });

    expect(spaces).toEqual([{ name: "Missions" }]);
    expect(children).toHaveLength(1);
  });

  test("a purpose on its members changes nothing", async () => {
    // `purpose` is still recorded — it is what an agent is FOR — but nothing
    // groups by it any more.
    await rawSql`UPDATE stations SET purpose = 'work' WHERE id = ${A}`;
    await rawSql`UPDATE stations SET purpose = 'personal' WHERE id = ${B}`;

    await post("/missions", { name: "Cross thing", stationIds: [A, B] });

    expect(spaces).toEqual([{ name: "Missions" }]);
  });
});
