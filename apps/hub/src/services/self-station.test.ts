/**
 * Self-scoping: the station a principal occupies, and nobody else's.
 *
 * The route audit concluded that opening the existing station routes to agents was the wrong
 * move, because they take a station id and an ownership check beside an id is a thing a future
 * handler can forget. This derivation is the alternative — a surface with no id to tamper with.
 * So the tests that matter are the ones proving it cannot be made to answer for another station.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "../db/drizzle";
import { nodes } from "../db/schema/nodes";
import { stations } from "../db/schema/stations";
import { createPrincipal } from "./principals";
import { principalOccupies, stationForPrincipal } from "./self-station";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";

const RUN = Date.now().toString(36);
let nodeId: string;
let mine: string;   // principal occupying a station
let theirs: string; // principal occupying a DIFFERENT station
let homeless: string; // principal occupying nothing
let myStationId: string;
let theirStationId: string;

const TEST_USER = `usr_selfscope_${Date.now().toString(36)}`;

async function station(key: string, principalId: string | null): Promise<string> {
  const id = `station_selfscope_${key}_${RUN}`;
  await db.insert(stations).values({
    tenantId: BOOTSTRAP_TENANT_ID,
    id,
    userId: TEST_USER,
    nodeId,
    stationKey: `opencode:${key}-${RUN}`,
    harness: "opencode",
    kind: "workspace",
    displayName: "/workspace",
    principalId,
  });
  return id;
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: TEST_USER, email: `selfscope-${RUN}@example.com`, name: "Self Scope" });

  nodeId = `nod_selfscope_${RUN}`;
  await db.insert(nodes).values({
    tenantId: BOOTSTRAP_TENANT_ID,
    id: nodeId,
    userId: TEST_USER,
    name: `selfscope-${RUN}`,
    hostname: `selfscope-${RUN}`,
    os: "linux",
    arch: "amd64",
    secretHash: "x",
    status: "online",
  });

  mine = await createPrincipal({ kind: "agent", handle: `selfscope-mine-${RUN}` });
  theirs = await createPrincipal({ kind: "agent", handle: `selfscope-theirs-${RUN}` });
  homeless = await createPrincipal({ kind: "agent", handle: `selfscope-none-${RUN}` });

  myStationId = await station("mine", mine);
  theirStationId = await station("theirs", theirs);
});

describe("stationForPrincipal", () => {
  test("answers with the station this principal occupies", async () => {
    const s = await stationForPrincipal(mine);
    expect(s?.id).toBe(myStationId);
    expect(s?.stationKey).toContain("mine");
    expect(s?.nodeId).toBe(nodeId);
    // The join is there so a tool can say WHERE it is running without a second lookup.
    expect(s?.nodeName).toBe(`selfscope-${RUN}`);
  });

  test("never answers with somebody else's", async () => {
    const s = await stationForPrincipal(mine);
    expect(s?.id).not.toBe(theirStationId);
  });

  test("null for a principal occupying nothing — an ordinary state, not a fault", async () => {
    // An agent between assignments. A caller should say so plainly rather than failing.
    expect(await stationForPrincipal(homeless)).toBeNull();
  });

  test("null for an unknown principal, and for an empty one", async () => {
    expect(await stationForPrincipal("prn_does_not_exist")).toBeNull();
    expect(await stationForPrincipal("")).toBeNull();
  });

  test("a station whose occupant is removed stops answering for them", async () => {
    // Eviction is a real act (`DELETE /stations/:id/agent`), and the derivation must follow it
    // immediately — a stale answer here is an agent reading a station it no longer occupies.
    const p = await createPrincipal({ kind: "agent", handle: `selfscope-evict-${RUN}` });
    const sid = await station("evict", p);
    expect((await stationForPrincipal(p))?.id).toBe(sid);

    await db.update(stations).set({ principalId: null }).where(eq(stations.id, sid));
    expect(await stationForPrincipal(p)).toBeNull();
  });
});

describe("principalOccupies", () => {
  test("true only for the station actually occupied", async () => {
    expect(await principalOccupies(mine, myStationId)).toBe(true);
    expect(await principalOccupies(mine, theirStationId)).toBe(false);
  });

  test("false for a principal occupying nothing", async () => {
    expect(await principalOccupies(homeless, myStationId)).toBe(false);
  });

  test("false for empty inputs rather than matching something", async () => {
    // A guard that returns true on empty input is a guard that opens on a missing parameter.
    expect(await principalOccupies("", myStationId)).toBe(false);
    expect(await principalOccupies(mine, "")).toBe(false);
    expect(await principalOccupies("", "")).toBe(false);
  });
});
