import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { provisionStation, provisionAll } from "../../src/services/matrix-as/provision";

/**
 * Giving every station a Matrix identity and somewhere to be talked to.
 *
 * Runs on adoption and again at boot, so it has to be idempotent in the way that
 * matters: not "does not crash on a second run", but "a second run changes
 * nothing an operator would notice".
 */

const OWNER = "test-user-mx-provision";
const NODE = "node_mx_provision";
const OPENCLAW = "station_mx_provision_openclaw";
const HERMES = "station_mx_provision_hermes";
const DOMAIN = "id.agentpod.dev";
const OWNER_MXID = "@owner-provision:id.agentpod.dev";

let registered: Array<{ localpart: string; displayName: string }> = [];
let rooms: Array<{
  alias: string;
  creator: string;
  name: string;
  topic: string;
  invite?: string;
  isDirect?: boolean;
}> = [];
let invites: Array<{ roomId: string; invitee: string }> = [];
let roomCounter = 0;
let uploaded: Array<{ bytes: number; contentType: string }> = [];
let avatars: Array<{ userId: string; mxcUrl: string }> = [];
let workspaceFiles: Record<string, { bytes: Uint8Array; contentType: string } | null> = {};

function deps() {
  return {
    domain: DOMAIN,
    client: {
      ensureUser: async (localpart: string, displayName: string) => {
        registered.push({ localpart, displayName });
      },
      ensureRoom: async (
        alias: string,
        opts: { creator: string; name: string; topic: string; invite?: string; isDirect?: boolean }
      ) => {
        rooms.push({ alias, ...opts } as any);
        return `!room${++roomCounter}:id.agentpod.dev`;
      },
      invite: async (_asUserId: string, roomId: string, invitee: string) => {
        invites.push({ roomId, invitee });
      },
      uploadImage: async (_userId: string, bytes: Uint8Array, contentType: string) => {
        uploaded.push({ bytes: bytes.length, contentType });
        return "mxc://id.agentpod.dev/abc123";
      },
      setAvatar: async (userId: string, mxcUrl: string) => {
        avatars.push({ userId, mxcUrl });
      },
    },
    readWorkspaceFile: async (_stationId: string, path: string) =>
      workspaceFiles[path] ?? null,
  };
}

async function roomRow(stationId: string) {
  const [row] = await rawSql`
    SELECT room_id, tenant_id, alias FROM matrix_rooms WHERE station_id = ${stationId}`;
  return row ?? null;
}

async function stationRow(id: string) {
  const [row] = await rawSql`
    SELECT matrix_id, bridge_matrix_id, matrix_identity_mode FROM stations WHERE id = ${id}`;
  return row!;
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: "mx-provision@example.com", name: "Owner" });
  const tenant = await resolveTenantForUser(OWNER);

  await rawSql`DELETE FROM matrix_rooms WHERE station_id IN (${OPENCLAW}, ${HERMES})`;
  await rawSql`DELETE FROM stations WHERE id IN (${OPENCLAW}, ${HERMES})`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${OWNER}, 'prov-box', 'prov-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
    VALUES (${OPENCLAW}, ${tenant}, ${OWNER}, ${NODE}, 'openclaw', 'openclaw:krishna', 'leaf', 'krishna',
            '["acp"]'::jsonb, now(), now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
    VALUES (${HERMES}, ${tenant}, ${OWNER}, ${NODE}, 'hermes', 'hermes:analyst-echo', 'leaf', 'analyst-echo',
            '["acp"]'::jsonb, now(), now())`;

  await rawSql`DELETE FROM principal_identities WHERE principal_id = ${OWNER}`;
  await rawSql`
    INSERT INTO principal_identities (id, principal_id, system, external_id, created_at)
    VALUES ('pid_mx_provision', ${OWNER}, 'matrix', ${OWNER_MXID}, now())`;
});

beforeEach(async () => {
  registered = [];
  rooms = [];
  invites = [];
  uploaded = [];
  avatars = [];
  workspaceFiles = {};
  await rawSql`DELETE FROM matrix_rooms WHERE station_id IN (${OPENCLAW}, ${HERMES})`;
  await rawSql`
    UPDATE stations SET bridge_matrix_id = NULL, matrix_identity_mode = 'bridge', matrix_id = NULL
    WHERE id IN (${OPENCLAW}, ${HERMES})`;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM matrix_rooms WHERE station_id IN (${OPENCLAW}, ${HERMES})`;
    await rawSql`DELETE FROM principal_identities WHERE principal_id = ${OWNER}`;
    await rawSql`DELETE FROM stations WHERE id IN (${OPENCLAW}, ${HERMES})`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id = ${OWNER}`;
  } catch {
    // cleanup only
  }
});

describe("provisioning a station", () => {
  test("gives it a user, a room, and a name a person can read", async () => {
    await provisionStation(OPENCLAW, deps());

    expect(registered).toHaveLength(1);
    expect(registered[0]!.localpart).toBe("agent_prov-box_openclaw-krishna");
    // The display name carries the readability a derived mxid does not have.
    expect(registered[0]!.displayName).toBe("krishna (openclaw @ prov-box)");
    expect(rooms[0]!.alias).toBe("#agentpod_prov-box_openclaw-krishna:id.agentpod.dev");
  });

  test("records the room, with the tenant it belongs to", async () => {
    await provisionStation(OPENCLAW, deps());

    const row = await roomRow(OPENCLAW);
    expect(row!.room_id).toMatch(/^!room/);
    expect(row!.tenant_id).toBeTruthy();
    expect(row!.alias).toBe("#agentpod_prov-box_openclaw-krishna:id.agentpod.dev");
  });

  test("records the identity it minted, without touching the harness column", async () => {
    await provisionStation(OPENCLAW, deps());

    const row = await stationRow(OPENCLAW);
    expect(row.bridge_matrix_id).toBe("@agent_prov-box_openclaw-krishna:id.agentpod.dev");
    expect(row.matrix_id).toBeNull();
    expect(row.matrix_identity_mode).toBe("bridge");
  });

  test("invites the station's owner, so the room is not a locked door", async () => {
    await provisionStation(OPENCLAW, deps());

    // Invited at creation rather than afterwards: the flag that makes this a DM
    // rides on the invite's member event, and can only be set there.
    expect(rooms[0]!.invite).toBe(OWNER_MXID);
  });

  test("a one-to-one agent room is a DM, which is what hermes's rooms were", async () => {
    // Talking to one agent is a conversation with one correspondent. Element
    // files it under People, and 32 agents in a Rooms list is a wall.
    //
    // `is_direct` at creation rather than writing the human's m.direct: that is
    // what hermes did, and it needed a human's access token — the credential
    // this bridge exists to stop keeping. A conformant client files the DM
    // itself when it sees the flag on its invite.
    await provisionStation(OPENCLAW, deps());

    expect(rooms[0]!.isDirect).toBe(true);
  });

  test("a station whose owner has no Matrix identity gets a room, not a DM", async () => {
    // Nobody to be direct WITH. The room still exists so the agent has somewhere
    // to be, and somebody can be invited later.
    await rawSql`DELETE FROM principal_identities WHERE principal_id = ${OWNER}`;

    await provisionStation(OPENCLAW, deps());

    expect(rooms[0]!.isDirect).toBeFalsy();
    expect(rooms[0]!.invite).toBeUndefined();

    await rawSql`
      INSERT INTO principal_identities (id, principal_id, system, external_id, created_at)
      VALUES ('pid_mx_provision', ${OWNER}, 'matrix', ${OWNER_MXID}, now())`;
  });

  test("provisions a hermes station exactly like every other", async () => {
    // No exception list. The name is derived the same way, and the display name
    // carries the readability its old bespoke address used to.
    await provisionStation(HERMES, deps());

    expect(registered[0]!.localpart).toBe("agent_prov-box_hermes-analyst-echo");
    expect(registered[0]!.displayName).toBe("analyst-echo (hermes @ prov-box)");
  });

  test("a second run changes nothing", async () => {
    // Idempotent in the way that matters: not "does not crash", but "an
    // operator would not notice it ran twice".
    await provisionStation(OPENCLAW, deps());
    const first = await roomRow(OPENCLAW);

    registered = [];
    rooms = [];
    invites = [];
    await provisionStation(OPENCLAW, deps());

    const second = await roomRow(OPENCLAW);
    expect(second!.room_id).toBe(first!.room_id);
    // The room is not created again, and nobody is re-invited into a room they
    // are already in.
    expect(rooms).toHaveLength(0);
    expect(invites).toHaveLength(0);
  });

  test("still ensures the user on a second run, so a rename lands", async () => {
    // ensureUser is where the display name is set, and a station renamed after
    // its first provision must stop introducing itself by the old name.
    await provisionStation(OPENCLAW, deps());
    registered = [];

    await provisionStation(OPENCLAW, deps());

    expect(registered).toHaveLength(1);
  });

  test("leaves a harness-mode station's identity alone", async () => {
    // That station answers for itself: it has its own account and its own
    // client, and registering over it would produce two answerers.
    await rawSql`
      UPDATE stations SET matrix_identity_mode = 'harness', matrix_id = '@analyst-echo:id.agentpod.dev'
      WHERE id = ${HERMES}`;

    await provisionStation(HERMES, deps());

    expect(registered).toHaveLength(0);
    // The room is still made, because a harness client needs somewhere to talk,
    // and it is created BY the identity that answers there.
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.creator).toBe("@analyst-echo:id.agentpod.dev");
  });

  test("skips a harness-mode station that has no identity at all", async () => {
    // Nothing to create the room as, and inventing one would be the bridge
    // answering for a station that is supposed to answer for itself.
    await rawSql`
      UPDATE stations SET matrix_identity_mode = 'harness', matrix_id = NULL WHERE id = ${HERMES}`;

    await provisionStation(HERMES, deps());

    expect(rooms).toHaveLength(0);
    expect(await roomRow(HERMES)).toBeNull();
  });
});

describe("provisioning the whole fleet", () => {
  test("covers every adopted station", async () => {
    const result = await provisionAll(deps());

    expect(result.provisioned).toBeGreaterThanOrEqual(2);
    expect(await roomRow(OPENCLAW)).toBeTruthy();
    expect(await roomRow(HERMES)).toBeTruthy();
  });

  test("one station's failure does not stop the rest", async () => {
    // Boot runs this. A single station whose homeserver call fails must not
    // leave the other 31 without rooms — and the failure must be counted, not
    // swallowed, so "provisioned 31 of 32" is visible.
    let calls = 0;
    const d = deps();
    const failing = {
      ...d,
      client: {
        ...d.client,
        ensureUser: async (localpart: string, displayName: string) => {
          if (++calls === 1) throw new Error("homeserver said no");
          registered.push({ localpart, displayName });
        },
      },
    };

    const result = await provisionAll(failing);

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.provisioned).toBeGreaterThanOrEqual(1);
  });
});

describe("an agent's face, if it has one", () => {
  test("uploads the image it finds and puts it on the agent", async () => {
    // hermes profiles carry a pfp.png and hermes's tooling uploaded it, which is
    // why those agents had faces and everything else had a letter. The bridge
    // looks in the same places whatever the harness is.
    workspaceFiles["pfp.png"] = {
      bytes: new Uint8Array([137, 80, 78, 71]),
      contentType: "image/png",
    };

    await provisionStation(OPENCLAW, deps());

    expect(uploaded).toHaveLength(1);
    expect(avatars.at(-1)).toMatchObject({
      userId: "@agent_prov-box_openclaw-krishna:id.agentpod.dev",
      mxcUrl: "mxc://id.agentpod.dev/abc123",
    });
  });

  test("provisions exactly as far for an agent with no image", async () => {
    // Optional means optional: no face is not a failure, and the room, the
    // identity and the display name all still land.
    await provisionStation(OPENCLAW, deps());

    expect(avatars).toHaveLength(0);
    expect(rooms).toHaveLength(1);
    expect(registered).toHaveLength(1);
  });

  test("a node that will not answer costs the agent a face, not a room", async () => {
    // The image lives on another machine, which may be offline. Provisioning
    // must not depend on it.
    const d = deps();
    const failing = {
      ...d,
      readWorkspaceFile: async () => {
        throw new Error("node offline");
      },
    };

    await provisionStation(OPENCLAW, failing);

    expect(avatars).toHaveLength(0);
    expect(rooms).toHaveLength(1);
  });

  test("does not re-upload an agent's face on every boot", async () => {
    // Provisioning runs at every restart. Reading and uploading an image per
    // station per boot is a cost with no benefit — the picture has not changed.
    workspaceFiles["pfp.png"] = {
      bytes: new Uint8Array([137, 80, 78, 71]),
      contentType: "image/png",
    };
    await provisionStation(OPENCLAW, deps());
    uploaded = [];
    avatars = [];

    await provisionStation(OPENCLAW, deps());

    expect(uploaded).toHaveLength(0);
  });
});
