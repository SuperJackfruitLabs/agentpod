/**
 * An agent's plugin reports its turn through its node, and the hub puts it
 * on the station owner's fleet card — decided from the database and the
 * authenticated node, never from the report's word.
 *
 * The first half proves `reportingAgentFor` against real rows; the second
 * sends a real `fleet.report` frame over the node gateway.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { rawSql } from "../../src/db/drizzle";
import { createTestUser, deleteTestUsers } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { pollUntil, waitForNodeOnline } from "../helpers/wait";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { createPrincipal, forgetPrincipals, linkMatrixId } from "../helpers/principals";
import { mintEnrollmentToken, enrollNode } from "../../src/services/enrollment";
import { gatewayRoutes } from "../../src/routes/gateway";
import { websocket } from "../../src/ws";
import { reportingAgentFor } from "../../src/services/push/fleet/agent-identity";
import { setFleetSink, type FleetSink } from "../../src/services/push/fleet/sink";
import type { FleetEvent } from "../../src/services/push/fleet/state";

const RUN = Math.random().toString(36).slice(2, 8);
const OWNER = `test-user-fleet-reports-${RUN}`;
const OTHER_OWNER = `test-user-fleet-reports-other-${RUN}`;
const READER = `@owner_${RUN}:hs.test`;
const AGENT = `@agent_guild_echo_${RUN}:hs.test`;
const ROOM = `!echo_${RUN}:hs.test`;
const OTHER_ROOM = `!other_${RUN}:hs.test`;

let NODE = "";
let NODE_SECRET = "";
let OTHER_NODE = "";
let STATION = `station_fleet_reports_${RUN}`;
let OTHER_STATION = `station_fleet_reports_other_${RUN}`;
const principals: string[] = [];

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: `fleet-reports-${RUN}@example.com`, name: "Owner" });
  await createTestUser({ id: OTHER_OWNER, email: `fleet-reports-other-${RUN}@example.com`, name: "Other" });
  const owner = await createPrincipal({ kind: "human", handle: `fleet-reports-owner-${RUN}`, userId: OWNER });
  principals.push(owner);
  await linkMatrixId(owner, READER);
  principals.push(await createPrincipal({ kind: "human", handle: `fleet-reports-other-${RUN}`, userId: OTHER_OWNER }));

  const { token } = await mintEnrollmentToken(OWNER);
  ({ nodeId: NODE, nodeSecret: NODE_SECRET } = await enrollNode(token, {
    hostname: `guild-${RUN}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  }));
  const other = await enrollNode((await mintEnrollmentToken(OTHER_OWNER)).token, {
    hostname: `other-${RUN}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });
  OTHER_NODE = other.nodeId;

  const tenant = await resolveTenantForUser(OWNER);
  const otherTenant = await resolveTenantForUser(OTHER_OWNER);
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name,
                          matrix_id, matrix_identity_mode, created_at)
    VALUES (${STATION}, ${tenant}, ${OWNER}, ${NODE}, 'hermes', ${"hermes:echo-" + RUN}, 'leaf', 'Analyst Echo',
            ${AGENT}, 'harness', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name,
                          matrix_id, matrix_identity_mode, created_at)
    VALUES (${OTHER_STATION}, ${otherTenant}, ${OTHER_OWNER}, ${OTHER_NODE}, 'hermes', ${"hermes:other-" + RUN},
            'leaf', 'Other', ${"@agent_other_" + RUN + ":hs.test"}, 'harness', now())`;
  await rawSql`
    INSERT INTO matrix_rooms (room_id, tenant_id, station_id, alias, created_at)
    VALUES (${OTHER_ROOM}, ${otherTenant}, ${OTHER_STATION}, ${"#other_" + RUN + ":hs.test"}, now())`;
});

afterAll(async () => {
  setFleetSink(null);
  try {
    await rawSql`DELETE FROM matrix_rooms WHERE room_id = ${OTHER_ROOM}`;
    await rawSql`DELETE FROM stations WHERE id IN (${STATION}, ${OTHER_STATION})`;
    await rawSql`DELETE FROM nodes WHERE id IN (${NODE}, ${OTHER_NODE})`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id IN (${OWNER}, ${OTHER_OWNER})`;
    for (const p of principals) {
      await forgetPrincipals({ ids: [p] });
    }
    await deleteTestUsers([OWNER, OTHER_OWNER]);
  } catch {
    // cleanup only
  }
});

describe("reportingAgentFor — who a report is from", () => {
  test("the node's station that speaks as the agent: its owner's Matrix id, and its name", async () => {
    expect(await reportingAgentFor(NODE, AGENT, ROOM)).toEqual({ reader: READER, name: "Analyst Echo" });
  });

  test("the same agent claimed by another node is nobody", async () => {
    expect(await reportingAgentFor(OTHER_NODE, AGENT, ROOM)).toBeNull();
  });

  test("an agent the node does not host is nobody", async () => {
    expect(await reportingAgentFor(NODE, `@agent_nobody_${RUN}:hs.test`, ROOM)).toBeNull();
  });

  test("a room the hub knows is another station's is refused", async () => {
    expect(await reportingAgentFor(NODE, AGENT, OTHER_ROOM)).toBeNull();
  });

  test("an owner with no Matrix identity has no card to put it on", async () => {
    expect(await reportingAgentFor(OTHER_NODE, `@agent_other_${RUN}:hs.test`, `!elsewhere_${RUN}:hs.test`)).toBeNull();
  });
});

describe("a fleet.report frame over the node gateway", () => {
  test("reaches the owner's card; a frame for someone else does not", async () => {
    const noted: Array<{ reader: string; event: FleetEvent }> = [];
    const sink: FleetSink = {
      note: (reader, event) => noted.push({ reader, event }),
      clearDecision: () => {},
      reconcileGates: () => {},
      knowsDecision: () => false,
    };
    setFleetSink(sink);

    const server = Bun.serve({ fetch: new Hono().route("/public/nodes", gatewayRoutes).fetch, websocket, port: 0 });
    const ws = new WebSocket(`ws://localhost:${server.port}/public/nodes/gateway`, {
      headers: { Authorization: `Bearer ${NODE}:${NODE_SECRET}` },
    } as RequestInit & { headers: Record<string, string> });
    try {
      await new Promise<void>((res, rej) => {
        ws.onopen = () => res();
        ws.onerror = () => rej(new Error("WebSocket connection error"));
      });
      await waitForNodeOnline(NODE);

      const frame = (reader: string) =>
        JSON.stringify({
          type: "fleet.report",
          report: { agent: AGENT, roomId: ROOM, reader, at: Date.now(), event: { type: "turn-started" } },
        });
      ws.send(frame(`@someone_else_${RUN}:hs.test`));
      ws.send(frame(READER));

      await pollUntil(async () => noted.length > 0);
      expect(noted).toHaveLength(1);
      expect(noted[0]!.reader).toBe(READER);
      expect(noted[0]!.event).toMatchObject({ type: "turn-started", roomId: ROOM, name: "Analyst Echo" });
    } finally {
      ws.close();
      server.stop(true);
    }
  });
});
