/**
 * The hub's own records behind agentpod_link_artifact: which capability list, which tenant, and
 * the server.ts wiring end to end (real station lookup, real broker module, real provenance).
 *
 * The node row carries the NODE-level capability list (posture, frames.large). `fs.walk` lives
 * only in the STATION-level list, so a fixture that blurs the two would hide the defect where
 * every real link is refused as too old.
 *
 * DATABASE_URL must point at a pgvector test Postgres (root CLAUDE.md).
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { db } from "../../src/db/drizzle";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { handleMcpRequest } from "../../src/mcp/server";
import { stationForPrincipal } from "../../src/services/self-station";
import { setSuperlibraryClientForTests } from "../../src/services/superlibrary/client";
import { createTestUser } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const NODE = "node_link_own_station";
const WITH = "station_link_own_with";
const WITHOUT = "station_link_own_without";
const P_WITH = "prn_000000000000000000b1";
const P_WITHOUT = "prn_000000000000000000b2";
const P_NONE = "prn_000000000000000000b3";

beforeAll(async () => {
  await ensurePgMigrations();
  const userId = (await createTestUser({ name: "link-own-station" })).id;
  await db.insert(nodes).values({
    id: NODE, tenantId: BOOTSTRAP_TENANT_ID, userId, name: "link-own-node", hostname: "link-own.test",
    os: "linux", arch: "arm64", status: "online", secretHash: "x", capabilities: ["posture", "frames.large"],
  }).onConflictDoNothing();
  for (const [id, key, principalId, capabilities] of [
    [WITH, "own-with", P_WITH, ["acp", "fs.walk"]],
    [WITHOUT, "own-without", P_WITHOUT, ["acp", "fs.read"]],
  ] as const) {
    await db.insert(stations).values({
      id, tenantId: BOOTSTRAP_TENANT_ID, userId, nodeId: NODE, harness: "hermes", stationKey: key, kind: "service",
      displayName: key, principalId, capabilities: [...capabilities],
    }).onConflictDoNothing();
  }
});

let restore: (() => void) | undefined;
afterEach(() => restore?.());
afterAll(async () => {
  await db.delete(stations).where(inArray(stations.id, [WITH, WITHOUT]));
  await db.delete(nodes).where(eq(nodes.id, NODE));
});

test("stationForPrincipal gives the station's own capabilities, never the node's list", async () => {
  const a = await stationForPrincipal(P_WITH);
  expect(a?.capabilities).toEqual(["acp", "fs.walk"]);
  expect(a?.tenantId).toBe(BOOTSTRAP_TENANT_ID);
  const b = await stationForPrincipal(P_WITHOUT);
  expect(b?.capabilities).toEqual(["acp", "fs.read"]);
  expect(b?.capabilities).not.toContain("posture");
});

async function callTool(principalId: string, args: Record<string, unknown>): Promise<string> {
  const res = await handleMcpRequest(
    new Request("http://hub.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agentpod_link_artifact", arguments: args } }),
    }),
    { principalId, kind: "agent" },
  );
  const raw = await res.text();
  const data = raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? raw;
  return JSON.parse(data).result.content.map((c: { text: string }) => c.text).join("\n");
}

test("server wiring: a station without fs.walk is refused as too old (real lookup, real link)", async () => {
  restore = setSuperlibraryClientForTests({} as never);
  expect(await callTool(P_WITHOUT, { path: "out/a.md" })).toBe("This node is too old to link files; update it and try again.");
});

test("server wiring: a station with fs.walk goes on to the real provenance lookup", async () => {
  restore = setSuperlibraryClientForTests({} as never);
  expect(await callTool(P_WITH, { path: "out/a.md", station: WITHOUT })).toContain("not on exactly one board");
});

test("server wiring: an agent with no station is told so", async () => {
  restore = setSuperlibraryClientForTests({} as never);
  expect(await callTool(P_NONE, { path: "out/a.md" })).toBe("You are not currently placed in a station.");
});
