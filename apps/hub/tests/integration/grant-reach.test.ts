import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Capability } from "@agentpod/contract";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { setGrant, deleteGrant } from "../../src/services/grants";
import { resolveTenantForUser } from "../../src/auth/tenant";
import {
  REACH_BEARING,
  isReachBearing,
  requireGrantReach,
  requireFleetGrantReach,
} from "../../src/services/grant-reach";
import { isGrantReachDenied } from "../../src/services/control-pair";

/**
 * The second half of the control pair.
 *
 * `mayDispatch` asks whether you may ask an agent to work. This asks whether you
 * may change what it *is*. Without the second, the first guards the front door
 * of a building with no walls: a principal refused one agent opens a terminal on
 * an agent they ARE allowed to dispatch and writes credentials into it.
 */

const USER = "test-user-grant-reach";
const NODE = "node_grant_reach";

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER, email: "grant-reach@example.com", name: "GR" });
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  const tenant = await resolveTenantForUser(USER);
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${USER},
            'reach-box', 'reach-box', 'linux', 'amd64', 2, 'online', 'x', now())`;

  // The guards are no-ops when the pair is off — which is itself asserted below.
  process.env.ENFORCE_CONTROL_PAIR = "true";
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${USER}`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

const STATION = { nodeId: NODE, stationKey: "hermes:analyst-echo" };

async function denial(fn: () => Promise<void>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

describe("the capability classification", () => {
  test("covers every capability the contract defines", () => {
    // The Record type already fails the build when a capability is added. This
    // asserts the same thing at runtime, so widening the type later cannot
    // silently reopen the hole.
    expect(Object.keys(REACH_BEARING).sort()).toEqual([...Capability.options].sort());
  });

  test("names writes, shells and destruction — and nothing else", () => {
    expect(isReachBearing("fs.write")).toBe(true);
    expect(isReachBearing("terminal")).toBe(true);
    expect(isReachBearing("cleanup")).toBe(true);

    // Reads are not reach. A console that refused to show a diff or a log would
    // be routed around within a day.
    expect(isReachBearing("changeset")).toBe(false);
    expect(isReachBearing("fs.read")).toBe(false);
    expect(isReachBearing("logs")).toBe(false);
    expect(isReachBearing("health")).toBe(false);
    expect(isReachBearing("inventory")).toBe(false);

    // Operating an agent is not widening it, and dispatch already guards acp.
    expect(isReachBearing("lifecycle")).toBe(false);
    expect(isReachBearing("acp")).toBe(false);
  });
});

describe("requireGrantReach", () => {
  test("permits when the principal holds reach and the scope matches", async () => {
    await setGrant(USER, { mayDispatch: ["agentpod:reach-box/hermes:*"], mayGrantReach: true });
    expect(await denial(() => requireGrantReach(USER, STATION, "fs.write", "mutate"))).toBeNull();
  });

  test("refuses without the boolean, however wide the dispatch scope", async () => {
    // The whole point: dispatch permission is not permission to rewrite.
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });

    const e = await denial(() => requireGrantReach(USER, STATION, "fs.write", "mutate"));
    expect(isGrantReachDenied(e)).toBe(true);
  });

  test("refuses when the boolean is held but this station is out of scope", async () => {
    // One scope, shared with dispatch: you may rewrite only agents you may talk to.
    await setGrant(USER, { mayDispatch: ["agentpod:other-box/hermes:*"], mayGrantReach: true });

    const e = await denial(() => requireGrantReach(USER, STATION, "terminal", "mutate"));
    expect(isGrantReachDenied(e)).toBe(true);
  });

  test("refuses a principal with no grant at all", async () => {
    await deleteGrant(USER);
    const e = await denial(() => requireGrantReach(USER, STATION, "terminal", "mutate"));
    expect(isGrantReachDenied(e)).toBe(true);
  });

  test("lets a read through even on a reach-bearing capability", async () => {
    // `cleanup` covers plan (read) and apply (destroys) under one word.
    await setGrant(USER, { mayDispatch: [], mayGrantReach: false });
    expect(await denial(() => requireGrantReach(USER, STATION, "cleanup", "read"))).toBeNull();
  });

  test("lets an open capability through even when mutating", async () => {
    await setGrant(USER, { mayDispatch: [], mayGrantReach: false });
    expect(await denial(() => requireGrantReach(USER, STATION, "lifecycle", "mutate"))).toBeNull();
  });

  test("is a no-op when the pair is not enforced", async () => {
    const before = process.env.ENFORCE_CONTROL_PAIR;
    try {
      process.env.ENFORCE_CONTROL_PAIR = "false";
      await setGrant(USER, { mayDispatch: [], mayGrantReach: false });
      expect(await denial(() => requireGrantReach(USER, STATION, "terminal", "mutate"))).toBeNull();
    } finally {
      if (before === undefined) delete process.env.ENFORCE_CONTROL_PAIR;
      else process.env.ENFORCE_CONTROL_PAIR = before;
    }
  });
});

describe("requireFleetGrantReach", () => {
  test("permits a principal whose authority already spans the fleet", async () => {
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: true });
    expect(await denial(() => requireFleetGrantReach(USER))).toBeNull();
  });

  test("refuses a node-scoped principal, who could otherwise grow the fleet forever", async () => {
    // Decision 4 counts *registering* an agent as granting reach: build the
    // agent you want, then dispatch it. A machine added under a node-scoped
    // grant is a machine that grant never described.
    await setGrant(USER, { mayDispatch: ["agentpod:reach-box/hermes:*"], mayGrantReach: true });

    const e = await denial(() => requireFleetGrantReach(USER));
    expect(isGrantReachDenied(e)).toBe(true);
  });

  test("refuses fleet-wide dispatch without the boolean", async () => {
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });
    expect(isGrantReachDenied(await denial(() => requireFleetGrantReach(USER)))).toBe(true);
  });
});
