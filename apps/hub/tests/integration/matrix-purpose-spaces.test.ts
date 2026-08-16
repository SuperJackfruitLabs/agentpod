import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { provisionStation } from "../../src/services/matrix-as/provision";

/**
 * Filing an agent's room under what it is for.
 *
 * The operator's fleet is laid out by use case, and a flat roster of every
 * agent stops being readable somewhere between 32 and 200. The axis is purpose
 * — not the node, which carries purpose only by accident in this fleet and is
 * already scheduled to stop.
 *
 * These assert against the real `provisionStation`, because filing has to be
 * part of provisioning rather than a second path: setting a purpose announces
 * the station, and the announcement is what re-files it.
 */

const OWNER = "test-user-purpose-spaces";
const NODE = "node_purpose_spaces";
const A = "station_ps_a";
const B = "station_ps_b";
const DOMAIN = "id.agentpod.dev";

interface Edge {
  space: string;
  child: string;
  creator?: string;
}

let created: Array<{ name: string; creator: string }> = [];
let addFails = false;
let added: Edge[] = [];
let removed: Edge[] = [];
let invited: Array<{ roomId: string; invitee: string }> = [];
let nextSpace = 0;

function deps() {
  return {
    domain: DOMAIN,
    client: {
      ensureUser: async () => {},
      ensureRoom: async (alias: string) => `!room-${alias.replace(/[^a-z0-9]/g, "")}:${DOMAIN}`,
      invite: async (_as: string, roomId: string, invitee: string) => {
        invited.push({ roomId, invitee });
      },
      createSpace: async (opts: { creator: string; name: string }) => {
        created.push(opts);
        nextSpace += 1;
        return `!space${nextSpace}:${DOMAIN}`;
      },
      addSpaceChild: async (creator: string, space: string, child: string) => {
        if (addFails) throw new Error("M_FORBIDDEN: not a member of the space");
        added.push({ space, child, creator });
      },
      removeSpaceChild: async (_creator: string, space: string, child: string) => {
        removed.push({ space, child });
      },
    },
  };
}

const spaceOf = async (stationId: string): Promise<string | null> => {
  const [row] = await rawSql`
    SELECT space_room_id FROM matrix_rooms WHERE station_id = ${stationId}`;
  return (row?.space_room_id as string | null) ?? null;
};

const setPurpose = (stationId: string, purpose: string | null) =>
  rawSql`UPDATE stations SET purpose = ${purpose} WHERE id = ${stationId}`;

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: "purpose-spaces@example.com", name: "PS" });
  const tenant = await resolveTenantForUser(OWNER);
  await rawSql`DELETE FROM matrix_rooms WHERE station_id IN (${A}, ${B})`;
  await rawSql`DELETE FROM stations WHERE node_id = ${NODE}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`DELETE FROM matrix_purpose_spaces WHERE tenant_id = ${tenant}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${OWNER}, 'ps-box', 'ps-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  for (const [id, key] of [
    [A, "openclaw:a"],
    [B, "openclaw:b"],
  ]) {
    await rawSql`
      INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
      VALUES (${id}, ${tenant}, ${OWNER}, ${NODE}, 'openclaw', ${key}, 'leaf', ${key}, '["acp"]'::jsonb, now(), now())`;
  }
  await rawSql`
    INSERT INTO principal_identities (id, principal_id, system, external_id, created_at)
    VALUES ('pi_ps', ${OWNER}, 'matrix', ${"@owner-ps:" + DOMAIN}, now())
    ON CONFLICT DO NOTHING`;
});

beforeEach(async () => {
  created = [];
  added = [];
  removed = [];
  invited = [];
  nextSpace = 0;
  addFails = false;
  const tenant = await resolveTenantForUser(OWNER);
  await rawSql`DELETE FROM matrix_rooms WHERE station_id IN (${A}, ${B})`;
  await rawSql`DELETE FROM matrix_purpose_spaces WHERE tenant_id = ${tenant}`;
  await setPurpose(A, null);
  await setPurpose(B, null);
});

afterAll(async () => {
  try {
    const tenant = await resolveTenantForUser(OWNER);
    await rawSql`DELETE FROM matrix_rooms WHERE station_id IN (${A}, ${B})`;
    await rawSql`DELETE FROM matrix_purpose_spaces WHERE tenant_id = ${tenant}`;
    await rawSql`DELETE FROM principal_identities WHERE principal_id = ${OWNER}`;
    await rawSql`DELETE FROM stations WHERE node_id = ${NODE}`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id = ${OWNER}`;
  } catch {
    // cleanup only
  }
});

describe("filing a station's room by purpose", () => {
  test("hangs the room under a space named for its purpose", async () => {
    await setPurpose(A, "personal");

    await provisionStation(A, deps());

    expect(created).toEqual([{ name: "Personal", creator: expect.any(String) }]);
    expect(added).toHaveLength(1);
    expect(await spaceOf(A)).toBe(added[0]!.space);
  });

  test("invites the owner, or the space is one nobody can see", async () => {
    // The rail lists JOINED spaces. A space the operator was never invited to
    // is a container that exists and does nothing.
    await setPurpose(A, "personal");

    await provisionStation(A, deps());

    expect(invited.some((i) => i.invitee === `@owner-ps:${DOMAIN}`)).toBe(true);
  });

  test("two stations with one purpose share one space", async () => {
    await setPurpose(A, "work");
    await setPurpose(B, "work");

    await provisionStation(A, deps());
    await provisionStation(B, deps());

    expect(created).toHaveLength(1);
    expect(await spaceOf(A)).toBe(await spaceOf(B));
  });

  test("an unlabelled station hangs nowhere at all", async () => {
    // Not under an invented `Unsorted`: that is a claim nobody made. It still
    // appears in All rooms, which is where a fresh ad-hoc runtime belongs.
    await provisionStation(A, deps());

    expect(created).toEqual([]);
    expect(added).toEqual([]);
    expect(await spaceOf(A)).toBeNull();
  });

  test("a changed purpose moves the room instead of adding a second parent", async () => {
    await setPurpose(A, "personal");
    await provisionStation(A, deps());
    const personal = added[0]!.space;

    await setPurpose(A, "work");
    await provisionStation(A, deps());

    expect(removed).toEqual([{ space: personal, child: expect.any(String) }]);
    expect(await spaceOf(A)).not.toBe(personal);
    expect(added).toHaveLength(2);
  });

  test("clearing a purpose takes the room out of its space", async () => {
    await setPurpose(A, "personal");
    await provisionStation(A, deps());
    const personal = added[0]!.space;

    await setPurpose(A, null);
    await provisionStation(A, deps());

    expect(removed).toEqual([{ space: personal, child: expect.any(String) }]);
    expect(await spaceOf(A)).toBeNull();
  });

  test("provisioning again changes nothing", async () => {
    // Provisioning runs at every boot. A second run that re-sent the child
    // event would be harmless on the homeserver and a lie in the logs; worse,
    // it is the shape of code that eventually re-creates the space too.
    await setPurpose(A, "personal");
    await provisionStation(A, deps());

    created = [];
    added = [];
    removed = [];
    await provisionStation(A, deps());

    expect(created).toEqual([]);
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });
});

describe("who writes the child edge", () => {
  test("the space's creator, not the room's own agent", async () => {
    // Found in production: `m.space.child` state lives ON THE SPACE, and an
    // agent that merely owns one of the rooms is not a member of the space, so
    // the homeserver refused every edge after the first. Ten rooms were
    // recorded as filed and one of them was.
    await setPurpose(A, "personal");
    await provisionStation(A, deps());
    const creatorOfSpace = created[0]!.creator;

    await setPurpose(B, "personal");
    await provisionStation(B, deps());

    expect(added).toHaveLength(2);
    expect(added[1]!.creator).toBe(creatorOfSpace);
    // …which is emphatically not B's own agent, the actor that used to be used.
    expect(added[1]!.creator).not.toBe(added[1]!.child);
  });

  test("a refused edge is not recorded as a filing", async () => {
    // The other half of the same bug: the failure was caught and the room was
    // marked as filed anyway, so the next run saw nothing to do and the room
    // stayed outside the space forever.
    await setPurpose(A, "personal");
    addFails = true;

    await provisionStation(A, deps());

    expect(await spaceOf(A)).toBeNull();
  });

  test("and the next run tries again", async () => {
    await setPurpose(A, "personal");
    addFails = true;
    await provisionStation(A, deps());

    addFails = false;
    await provisionStation(A, deps());

    expect(added).toHaveLength(1);
    expect(await spaceOf(A)).toBe(added[0]!.space);
  });
});
