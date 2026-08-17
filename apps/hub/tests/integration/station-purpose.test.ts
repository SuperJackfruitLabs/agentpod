import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { adoptStations } from "../../src/services/station-registry";

/**
 * What a station is FOR, and where that fact comes from.
 *
 * The operator's decision, in their words: purpose lives on the station, the
 * node only supplies the default at adoption. Both halves matter and pull in
 * opposite directions — the node has to reach a station that has never been
 * labelled, and must never reach one that has.
 */

const USER = "test-user-purpose";
const NODE = "node_purpose";
const BARE_NODE = "node_purpose_bare";

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

const purposeOf = async (nodeId: string, key: string): Promise<string | null> => {
  const [row] = await rawSql`
    SELECT purpose FROM stations WHERE node_id = ${nodeId} AND station_key = ${key}`;
  return (row?.purpose as string | null) ?? null;
};

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER, email: "purpose@example.com", name: "P" });
  const tenant = await resolveTenantForUser(USER);
  for (const node of [NODE, BARE_NODE]) {
    await rawSql`DELETE FROM stations WHERE node_id = ${node}`;
    await rawSql`DELETE FROM nodes WHERE id = ${node}`;
  }
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, purpose, created_at)
    VALUES (${NODE}, ${tenant}, ${USER}, 'purpose-box', 'purpose-box', 'linux', 'amd64', 2, 'online', 'x', 'personal', now())`;
  // A node nobody has labelled — the fresh ad-hoc runtime case.
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${BARE_NODE}, ${tenant}, ${USER}, 'bare-box', 'bare-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
});

beforeEach(async () => {
  for (const node of [NODE, BARE_NODE]) {
    await rawSql`DELETE FROM stations WHERE node_id = ${node}`;
  }
});

afterAll(async () => {
  try {
    for (const node of [NODE, BARE_NODE]) {
      await rawSql`DELETE FROM stations WHERE node_id = ${node}`;
      await rawSql`DELETE FROM nodes WHERE id = ${node}`;
    }
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

describe("a station's purpose", () => {
  test("is inherited from its node at adoption", async () => {
    await adoptStations(USER, NODE, ["openclaw:one"], [detected("openclaw:one")]);

    expect(await purposeOf(NODE, "openclaw:one")).toBe("personal");
  });

  test("is null when the node has none — unlabelled, not invented", async () => {
    // The decision: a fresh ad-hoc runtime nobody has labelled stays out of
    // every space and shows up in All rooms. That is this null; a default of
    // `unsorted` here would file it somewhere and make the space rail lie.
    await adoptStations(USER, BARE_NODE, ["openclaw:adhoc"], [detected("openclaw:adhoc")]);

    expect(await purposeOf(BARE_NODE, "openclaw:adhoc")).toBeNull();
  });

  test("survives re-adoption, because the station is the truth", async () => {
    // Re-adoption is routine — it is how a station's capabilities refresh — so
    // a node default that overwrote on every detect would silently undo every
    // deliberate labelling, on a schedule.
    await adoptStations(USER, NODE, ["openclaw:one"], [detected("openclaw:one")]);
    await rawSql`
      UPDATE stations SET purpose = 'work' WHERE node_id = ${NODE} AND station_key = 'openclaw:one'`;

    await adoptStations(USER, NODE, ["openclaw:one"], [detected("openclaw:one")]);

    expect(await purposeOf(NODE, "openclaw:one")).toBe("work");
  });

  test("is filled in on re-adoption when the station never had one", async () => {
    // The other side of that guard. A station adopted before anyone labelled
    // its node must still be able to gain the default later, or the 32 stations
    // that already exist could never join a space without being deleted and
    // re-adopted.
    await adoptStations(USER, NODE, ["openclaw:late"], [detected("openclaw:late")]);
    await rawSql`
      UPDATE stations SET purpose = NULL WHERE node_id = ${NODE} AND station_key = 'openclaw:late'`;

    await adoptStations(USER, NODE, ["openclaw:late"], [detected("openclaw:late")]);

    expect(await purposeOf(NODE, "openclaw:late")).toBe("personal");
  });
});
