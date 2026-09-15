/**
 * The bridge must not hold a harness agent's keys.
 *
 * Pinned because the failure is invisible from the bridge's side: it creates a
 * device, publishes an identity, and reports nothing wrong. What breaks is the
 * *other* client — the harness agent's own device cannot be cross-signed,
 * because the identity belongs to a process that is not it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { nodes } from "../../db/schema/nodes";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { stations } from "../../db/schema/stations";
import { bridgeModeOnly, resetBridgeModeCache } from "./bridge-agents";
import { createTestUser } from "../../../tests/helpers/database";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";

const NODE = `node_bridgemode_${Date.now().toString(36)}`;
const USER = `usr_bridgemode_${Date.now().toString(36)}`;
const HARNESS = "@agent_harness_probe:id.agentpod.dev";
const BRIDGED = "@agent_bridged_probe:id.agentpod.dev";

describe("whose keys the bridge holds", () => {
  beforeEach(async () => {
    await ensurePgMigrations();
    resetBridgeModeCache();
    await createTestUser({ id: USER, email: `${NODE}@example.com`, name: "Bridge Mode" });
    await db
      .insert(nodes)
      .values({
        tenantId: BOOTSTRAP_TENANT_ID,
        id: NODE,
        userId: USER,
        name: NODE,
        hostname: NODE,
        os: "linux",
        arch: "amd64",
        secretHash: "x",
        status: "offline",
      })
      .onConflictDoNothing();
    await db
      .insert(stations)
      .values([
        {
          id: `${NODE}_h`,
          nodeId: NODE,
          userId: USER,
          tenantId: BOOTSTRAP_TENANT_ID,
          stationKey: "hermes:probe",
          harness: "hermes",
          kind: "agent",
          displayName: "harness probe",
          matrixIdentityMode: "harness",
          matrixId: HARNESS,
        },
        {
          id: `${NODE}_b`,
          nodeId: NODE,
          userId: USER,
          tenantId: BOOTSTRAP_TENANT_ID,
          stationKey: "pi:probe",
          harness: "pi",
          kind: "agent",
          displayName: "bridge probe",
          matrixIdentityMode: "bridge",
          matrixId: BRIDGED,
        },
      ])
      .onConflictDoNothing();
  });

  afterEach(async () => {
    await db.delete(stations).where(eqId(`${NODE}_h`));
    await db.delete(stations).where(eqId(`${NODE}_b`));
    await db.delete(nodes).where(eqNode(NODE));
    resetBridgeModeCache();
  });

  test("a harness agent is not ours to hold keys for", async () => {
    const ours = await bridgeModeOnly();
    expect(ours(HARNESS)).toBe(false);
  });

  test("a bridge agent is", async () => {
    const ours = await bridgeModeOnly();
    expect(ours(BRIDGED)).toBe(true);
  });

  test("an agent nothing knows about is treated as ours", async () => {
    // A station that has not been recorded yet is far likelier to be a bridge
    // agent mid-provision than a harness one, and the cost of the two mistakes
    // is not symmetric: holding keys briefly for something that turns out to
    // be harness-mode is repairable, while refusing to hold them for a bridge
    // agent makes it unreadable for as long as the gap lasts.
    const ours = await bridgeModeOnly();
    expect(ours("@agent_never_seen:id.agentpod.dev")).toBe(true);
  });
});

const eqId = (id: string) => eq(stations.id, id);
const eqNode = (id: string) => eq(nodes.id, id);
