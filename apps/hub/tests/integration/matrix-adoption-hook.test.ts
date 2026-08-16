import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { adoptStations } from "../../src/services/station-registry";
import { onStationsAdopted } from "../../src/services/matrix-as/hooks";

/**
 * A station adopted at noon should not wait for a restart to get a room.
 *
 * Provisioning ran only at boot, which is enough for a fleet that changes when
 * the hub restarts and wrong for one that doesn't: the agent would exist
 * everywhere except the place you had been told to talk to it.
 */

const USER = "test-user-adopt-hook";
const NODE = "node_adopt_hook";

let announced: string[][] = [];

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER, email: "adopt-hook@example.com", name: "AH" });
  const tenant = await resolveTenantForUser(USER);
  await rawSql`DELETE FROM stations WHERE node_id = ${NODE}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${USER}, 'adopt-box', 'adopt-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
});

beforeEach(async () => {
  announced = [];
  await rawSql`DELETE FROM stations WHERE node_id = ${NODE}`;
});

afterAll(async () => {
  onStationsAdopted(null);
  try {
    await rawSql`DELETE FROM stations WHERE node_id = ${NODE}`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

const detected = (key: string) => ({
  key,
  harness: "openclaw",
  kind: "leaf" as const,
  displayName: key,
  parentKey: null,
  workspacePath: null,
  capabilities: ["acp"],
  matrixId: null,
});

describe("adopting a station", () => {
  test("announces it, so the bridge can give it a room", async () => {
    onStationsAdopted(async (ids) => {
      announced.push(ids);
    });

    const rows = await adoptStations(USER, NODE, ["openclaw:new"], [detected("openclaw:new")]);

    expect(rows).toHaveLength(1);
    expect(announced).toHaveLength(1);
    expect(announced[0]).toEqual([rows[0]!.id]);
  });

  test("adoption still succeeds when the listener throws", async () => {
    // The station IS adopted. A bridge that could not make a room must not make
    // it look as though adoption failed.
    onStationsAdopted(async () => {
      throw new Error("homeserver unreachable");
    });

    const rows = await adoptStations(USER, NODE, ["openclaw:two"], [detected("openclaw:two")]);

    expect(rows).toHaveLength(1);
  });

  test("says nothing when nothing was adopted", async () => {
    onStationsAdopted(async (ids) => {
      announced.push(ids);
    });

    await adoptStations(USER, NODE, [], []);

    expect(announced).toHaveLength(0);
  });

  test("nobody listens when the bridge is off", async () => {
    onStationsAdopted(null);

    const rows = await adoptStations(USER, NODE, ["openclaw:three"], [detected("openclaw:three")]);

    expect(rows).toHaveLength(1);
  });
});
