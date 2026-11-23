/**
 * Which unmapped board is worth a retry, read from the real tables.
 *
 * A decision for a board with no dispatch here has no fleet to go to. Two cases look alike there:
 *
 * - the board is rostered (a `bridge_agents` row) but nothing has been dispatched for it yet, a
 *   board being set up; its first dispatch maps it, so 503 and the sender tries again;
 * - the board is known by neither roster nor dispatch, such as one SuperExchange carries. This hub
 *   never polls, dispatches for or subscribes to it, so nothing will map it: 200 and ignored, as
 *   SuperExchange answers for a board not opted in to it.
 *
 * The decision deps here carry no `tenantsForBoard`, so the default (the tables) answers.
 *
 * DATABASE_URL must point at the local Docker test-postgres on localhost:5434.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { signDelivery, toBinary } from "@superjackfruitlabs/treaty-cloudevents";

import { db } from "../../src/db/drizzle";
import { bridgeAgents } from "../../src/db/schema/bridge";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { decisionEventType } from "../../src/routes/superpipeline-decisions";
import { createSuperpipelineEventsRoutes } from "../../src/routes/superpipeline-events";
import { tenantForBoard } from "../../src/services/board-chat";
import { createTestUser } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { treatyText } from "../helpers/treaty-data";

const SECRET = "board-not-carried-secret";
const RUN = Date.now().toString(16).padStart(12, "0").slice(-12);
const NODE_ID = `node_not_carried_${RUN}`;
const STATION_ID = `station_not_carried_${RUN}`;
const AGENT_KEY = `not-carried-${RUN}`;
/** Rostered here, never dispatched for. */
const ROSTERED = `brd_a0a0${RUN}`;
/** Known here by nothing at all. */
const ELSEWHERE = `brd_e0e0${RUN}`;

const corpus: { schemas: Record<string, { valid: Record<string, Record<string, unknown>> }> } = JSON.parse(
  treatyText("fixtures/superpipeline-events/examples.json"),
);
const gate = (boardId: string): Record<string, unknown> => {
  const first = Object.values(corpus.schemas["gate.pending.v1"]?.valid ?? {})[0];
  if (!first) throw new Error("treaty publishes no valid gate.pending.v1");
  return { ...first, boardId };
};

async function deliver(boardId: string, seq: number): Promise<Response> {
  const routes = createSuperpipelineEventsRoutes({
    secret: SECRET,
    domain: "id.agentpod.dev",
    tenantIdFor: tenantForBoard,
    boardRoom: async () => null,
    sendText: async () => "$prose",
    sendCustomEvent: async () => "$gate",
  });
  const bytes = new TextEncoder().encode(JSON.stringify(gate(boardId)));
  const id = `${boardId}:${seq}`;
  const wire = toBinary(
    {
      attributes: {
        specversion: "1.0",
        id,
        source: `/superpipeline/boards/${boardId}`,
        type: decisionEventType("gate.pending"),
        datacontenttype: "application/json",
      },
    },
    "http",
  );
  const headers = { ...wire.headers, "x-treaty-signature": await signDelivery(SECRET, id, bytes) };
  return routes.request("/bridge/superpipeline/events", { method: "POST", headers, body: bytes });
}

beforeAll(async () => {
  await ensurePgMigrations();
  const userId = (await createTestUser({ name: "board-not-carried" })).id;
  await db.insert(nodes).values({
    id: NODE_ID,
    tenantId: BOOTSTRAP_TENANT_ID,
    userId,
    name: "not-carried-node",
    hostname: "not-carried.test",
    os: "linux",
    arch: "arm64",
    status: "offline",
    secretHash: "x",
  });
  await db.insert(stations).values({
    id: STATION_ID,
    tenantId: BOOTSTRAP_TENANT_ID,
    userId,
    nodeId: NODE_ID,
    harness: "hermes",
    stationKey: `not-carried-${RUN}`,
    kind: "service",
    displayName: "Not Carried",
  });
  await db.insert(bridgeAgents).values({
    tenantId: BOOTSTRAP_TENANT_ID,
    key: AGENT_KEY,
    boardId: ROSTERED,
    stationId: STATION_ID,
    tokenEncrypted: "not-read-here",
  });
});

afterAll(async () => {
  await db.delete(bridgeAgents).where(eq(bridgeAgents.key, AGENT_KEY));
  await db.delete(stations).where(eq(stations.id, STATION_ID));
  await db.delete(nodes).where(eq(nodes.id, NODE_ID));
});

describe("an unmapped board, by what this hub knows of it", () => {
  test("rostered but never dispatched for: 503, its first dispatch may map it", async () => {
    const res = await deliver(ROSTERED, 1);
    expect(res.status).toBe(503);
  });

  test("known by neither roster nor dispatch: 200 and ignored, so the relay does not retry it", async () => {
    const res = await deliver(ELSEWHERE, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "ignored" });
  });
});
