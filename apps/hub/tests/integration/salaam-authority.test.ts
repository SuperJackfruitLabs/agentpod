/** Checked: fresh identity, generation and pending-stop fences in the real test database. */
import { beforeAll, afterAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/drizzle";
import { tenants } from "../../src/db/schema/tenants";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import {
  acpSessions,
  type StoredSalaamExecution,
} from "../../src/db/schema/acp";
import { bridgeDispatches } from "../../src/db/schema/bridge";
import {
  makeSalaamExecution,
  validateSalaamAuthority,
  salaamStationStopped,
} from "../../src/services/salaam-authority";
import { fakePlane } from "../helpers/fake-plane";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 20);
const tenantId = "fleet_" + hex(),
  org = "org_" + hex(),
  owner = "prn_" + hex(),
  principal = "prn_" + hex(),
  other = "prn_" + hex();
const nodeId = "node_" + hex(),
  stationId = "station_" + hex(),
  otherStation = "station_" + hex();
async function save(
  execution: StoredSalaamExecution,
  id = execution.binding.hub_session_id,
) {
  await db.insert(acpSessions).values({
    id,
    tenantId,
    stationId: execution.binding.station_id,
    userId: owner,
    mode: "ask",
    status: "ended",
    executionAuthority: execution,
    createdAt: new Date(),
    lastEventAt: new Date(),
  });
}
async function constrained(promise: Promise<void>, constraint: string) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(
    (caught as { cause?: { constraint_name?: string } })?.cause
      ?.constraint_name,
  ).toBe(constraint);
}

beforeAll(async () => {
  await ensurePgMigrations();
  fakePlane.addHuman({ id: owner, grant: { mayDispatch: [principal, other] } });
  fakePlane.addAgent({ id: principal });
  fakePlane.addAgent({ id: other });
  for (const id of [owner, principal, other])
    fakePlane.principals.get(id)!.organizationId = org;
  await db.insert(tenants).values({
    id: tenantId,
    name: "Salaam boundary proof",
    externalSource: "org-plane",
    externalId: org,
  });
  await db.insert(nodes).values({
    id: nodeId,
    tenantId,
    userId: owner,
    name: "proof",
    hostname: "fixture",
    os: "test",
    arch: "test",
    secretHash: "not-a-live-secret",
  });
  await db.insert(stations).values({
    id: stationId,
    tenantId,
    userId: owner,
    nodeId,
    harness: "salaam",
    stationKey: "salaam:c52ddf65534b7b46",
    kind: "leaf",
    displayName: "proof",
    workspacePath: "/workspace",
    capabilities: ["acp"],
    principalId: principal,
  });
  await db.insert(stations).values({
    id: otherStation,
    tenantId,
    userId: owner,
    nodeId,
    harness: "salaam",
    stationKey: "salaam:1111111111111111",
    kind: "leaf",
    displayName: "other",
    workspacePath: "/other-workspace",
    capabilities: ["acp"],
    principalId: null,
  });
});
beforeEach(async () => {
  await db
    .update(stations)
    .set({ principalId: null })
    .where(eq(stations.id, otherStation));
  await db.delete(acpSessions).where(eq(acpSessions.tenantId, tenantId));
  await db
    .delete(bridgeDispatches)
    .where(eq(bridgeDispatches.tenantId, tenantId));
  await db
    .update(stations)
    .set({ principalId: principal })
    .where(eq(stations.id, stationId));
  await fakePlane.unsuspend(principal);
  await fakePlane.putGrant(owner, {
    mayDispatch: [principal, other],
    mayGrantReach: false,
    scopes: [],
  });
});
afterAll(async () => {
  await db.delete(acpSessions).where(eq(acpSessions.tenantId, tenantId));
  await db
    .delete(bridgeDispatches)
    .where(eq(bridgeDispatches.tenantId, tenantId));
  await db.delete(stations).where(eq(stations.tenantId, tenantId));
  await db.delete(nodes).where(eq(nodes.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  for (const id of [owner, principal, other]) fakePlane.remove(id);
});
test("admission uses the owner grant and current station facts; suspension and withdrawal deny renewal", async () => {
  const execution = await makeSalaamExecution(
    stationId,
    owner,
    "acps_" + hex(),
  );
  expect(execution.binding.principal_id).toBe(principal);
  for (const changed of [
    { organization_id: "org_" + hex() },
    { node_id: "another-node" },
    { workspace: "/foreign" },
    { occupancy_epoch: 0 },
    { principal_id: other },
  ])
    await expect(
      validateSalaamAuthority({ ...execution.binding, ...changed }, owner),
    ).rejects.toThrow(/authority/i);
  await fakePlane.suspend(principal);
  await expect(
    validateSalaamAuthority(execution.binding, owner),
  ).rejects.toThrow(/suspended/i);
  await fakePlane.unsuspend(principal);
  await fakePlane.putGrant(owner, {
    mayDispatch: [],
    mayGrantReach: false,
    scopes: [],
  });
  await expect(
    validateSalaamAuthority(execution.binding, owner),
  ).rejects.toThrow(/withdrawn/i);
});

test("MCP reconnect intent is durable session configuration and defaults off for old rows", async () => {
  const execution = await makeSalaamExecution(stationId, owner, "acps_" + hex());
  await save(execution);
  const [legacy] = await db.select().from(acpSessions).where(eq(acpSessions.id, execution.binding.hub_session_id));
  expect(legacy!.mcpProxyRequested).toBe(false);
  await db.update(acpSessions).set({ mcpProxyRequested: true }).where(eq(acpSessions.id, execution.binding.hub_session_id));
  const [restored] = await db.select().from(acpSessions).where(eq(acpSessions.id, execution.binding.hub_session_id));
  expect(restored!.mcpProxyRequested).toBe(true);
  expect(restored!.executionAuthority!.binding).toEqual(execution.binding);
});
test("database writers cannot hide an A to B to A occupancy change or invent the generation", async () => {
  const initial = await makeSalaamExecution(stationId, owner, "acps_" + hex());
  await db
    .update(stations)
    .set({
      principalId: other,
      occupancyEpoch: initial.binding.occupancy_epoch,
    })
    .where(eq(stations.id, stationId));
  await db
    .update(stations)
    .set({
      principalId: principal,
      occupancyEpoch: initial.binding.occupancy_epoch,
    })
    .where(eq(stations.id, stationId));
  const current = await makeSalaamExecution(stationId, owner, "acps_" + hex());
  expect(current.binding.occupancy_epoch).toBe(
    initial.binding.occupancy_epoch + 2,
  );
  await expect(validateSalaamAuthority(initial.binding, owner)).rejects.toThrow(
    /generation/i,
  );
});
test("ended transport with pending revocation still blocks the station, moved principal and old run epoch", async () => {
  const old = await makeSalaamExecution(stationId, owner, "acps_" + hex());
  old.state = "revocation_pending";
  await save(old);
  expect(await salaamStationStopped(stationId)).toBe(false); // offline node is not stop evidence
  const sameStation = await makeSalaamExecution(
    stationId,
    owner,
    "acps_" + hex(),
  );
  await constrained(save(sameStation), "acp_salaam_station_execution");
  const moved = {
    ...sameStation,
    binding: { ...sameStation.binding, station_id: "different-station" },
  };
  await constrained(save(moved), "acp_salaam_principal_execution");
  await db
    .update(acpSessions)
    .set({ executionAuthority: { ...old, state: "revoked" } })
    .where(eq(acpSessions.id, old.binding.hub_session_id));
  await save(sameStation);
  await constrained(
    save({ ...old, state: "revoked" }, "acps_" + hex()),
    "acp_salaam_work_run_epoch",
  );
});
test("a replacement card run on another station cannot bypass an unconfirmed prior execution", async () => {
  const runId = "run_" + hex();
  await db.insert(bridgeDispatches).values({
    externalSource: "superpipeline",
    externalRunId: runId,
    tenantId,
    boardId: "board",
    externalCardId: "card",
    agentKey: owner,
    stationId,
    leaseEpoch: 1,
    outcome: "working",
    startedAt: new Date(),
    updatedAt: new Date(),
  });
  const old = await makeSalaamExecution(stationId, owner, "acps_" + hex(), {
    source: "superpipeline",
    id: runId,
    epoch: 1,
  });
  await save(old);
  await db
    .update(stations)
    .set({ principalId: other })
    .where(eq(stations.id, otherStation));
  const next = "run_" + hex();
  await db.insert(bridgeDispatches).values({
    externalSource: "superpipeline",
    externalRunId: next,
    tenantId,
    boardId: "board",
    externalCardId: "card",
    agentKey: owner,
    stationId: otherStation,
    leaseEpoch: 2,
    outcome: "working",
    startedAt: new Date(),
    updatedAt: new Date(),
  });
  await expect(
    makeSalaamExecution(otherStation, owner, "acps_" + hex(), {
      source: "superpipeline",
      id: next,
      epoch: 2,
    }),
  ).rejects.toThrow(/not been confirmed stopped/i);
  const [saved] = await db
    .select()
    .from(acpSessions)
    .where(eq(acpSessions.id, old.binding.hub_session_id));
  expect(saved!.executionAuthority!.state).toBe("revocation_pending");
});
