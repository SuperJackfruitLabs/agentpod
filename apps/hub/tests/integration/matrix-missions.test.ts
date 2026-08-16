import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { setGrant } from "../../src/services/grants";
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
  const tenant = await resolveTenantForUser(OWNER);
  await rawSql`DELETE FROM matrix_mission_members`;
  await rawSql`DELETE FROM matrix_missions`;
  await rawSql`DELETE FROM stations WHERE id IN (${A}, ${B})`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${OWNER}, 'mission-box', 'mission-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  for (const [id, key] of [[A, "hermes:one"], [B, "openclaw:two"]] as const) {
    await rawSql`
      INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
      VALUES (${id}, ${tenant}, ${OWNER}, ${NODE}, ${key.split(":")[0]}, ${key}, 'leaf', ${key},
              '["acp"]'::jsonb, now(), now())`;
  }
  await rawSql`DELETE FROM principal_identities WHERE principal_id = ${OWNER}`;
  await rawSql`
    INSERT INTO principal_identities (id, principal_id, system, external_id, created_at)
    VALUES ('pid_mission', ${OWNER}, 'matrix', ${OWNER_MXID}, now())`;
  process.env.ENFORCE_CONTROL_PAIR = "true";
});

beforeEach(async () => {
  rooms = [];
  spaces = [];
  children = [];
  invited = [];
  await rawSql`DELETE FROM matrix_mission_members`;
  await rawSql`DELETE FROM matrix_missions`;
  await rawSql`DELETE FROM matrix_purpose_spaces`;
  await rawSql`UPDATE stations SET purpose = NULL WHERE node_id = ${NODE}`;
  await setGrant(OWNER, { mayDispatch: ["agentpod:*/hermes:*", "agentpod:*/openclaw:*"], mayGrantReach: false });
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM matrix_mission_members`;
    await rawSql`DELETE FROM matrix_missions`;
    await rawSql`DELETE FROM matrix_purpose_spaces`;
    await rawSql`DELETE FROM principal_identities WHERE principal_id = ${OWNER}`;
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${OWNER}`;
    await rawSql`DELETE FROM stations WHERE id IN (${A}, ${B})`;
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

    const invitees = invited.map((i) => i.invitee);
    expect(invitees).toContain("@agent_mission-box_openclaw-two:id.agentpod.dev");
    expect(invitees).toContain(OWNER_MXID);
    expect(invitees).not.toContain("@agent_mission-box_hermes-one:id.agentpod.dev");
  });

  test("refuses a station the caller may not dispatch", async () => {
    // Putting an agent in a room is putting it to work. The grant that governs
    // dispatching it governs this too.
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });

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

describe("a mission and the purpose of its members", () => {
  test("hangs under the purpose its members agree on", async () => {
    // A mission of work agents is a work mission. Filing it under the general
    // missions space instead would put it somewhere the operator does not look
    // for the thing they were just doing.
    await rawSql`UPDATE stations SET purpose = 'work' WHERE id IN (${A}, ${B})`;

    await post("/missions", { name: "Q4 rollout", stationIds: [A, B] });

    expect(spaces).toEqual([{ name: "Work" }]);
    expect(children).toHaveLength(1);
    expect(children[0]!.space).toBe("!space1:id.agentpod.dev");
  });

  test("falls back to the general missions space when they disagree", async () => {
    // A cross-purpose mission is exactly the case one shared space is right
    // for: it belongs to both and to neither, and picking one member's purpose
    // would be picking a member.
    await rawSql`UPDATE stations SET purpose = 'work' WHERE id = ${A}`;
    await rawSql`UPDATE stations SET purpose = 'personal' WHERE id = ${B}`;

    await post("/missions", { name: "Cross thing", stationIds: [A, B] });

    expect(spaces).toEqual([{ name: "Missions" }]);
  });

  test("falls back when a member is unlabelled, rather than guessing from the rest", async () => {
    // One labelled member does not make a mission's purpose. Inferring from a
    // majority would file it somewhere nobody chose.
    await rawSql`UPDATE stations SET purpose = 'work' WHERE id = ${A}`;

    await post("/missions", { name: "Half known", stationIds: [A, B] });

    expect(spaces).toEqual([{ name: "Missions" }]);
  });
});
