import { expect, test } from "bun:test";
import { selectCheckpointDispatch, type CheckpointDispatchPort, type CheckpointTarget } from "./checkpoint-dispatch";
import { parsePendingCheckpointClaim } from "./checkpoint-claim";
import fixture from "./checkpoint-contract/claim.fixture.json";
import { SuperpipelineClient } from "./superpipeline";

const identity = { tenantId: "fleet_hub_fixture", boardId: fixture.pending.boardId, stationId: "station_pilot01" };
function target(): CheckpointTarget { return { ...identity, sourceTenantId: fixture.pending.tenantId, agentId: fixture.pending.agentId, nodeId: "node_pilot01",
  hostId: "host_fixture", registryRevision: "registry_fixture", benchProtocol: "superbench.v2", coordinatorImplementationSHA256: "b".repeat(64), executionMode: "linux-cgroup-v2",
  workerVersion: "agentpod.superbench-worker.v2", workerSHA256: "a".repeat(64) }; }
function harness() {
  const observed = target();
  const checks: CheckpointTarget[] = [];
  const calls: string[] = [];
  let valid = true;
  let context: unknown = fixture.context;
  const dispatched: Parameters<CheckpointDispatchPort["dispatch"]>[0][] = [];
  const port: CheckpointDispatchPort = {
    ready: async () => observed,
    current: async (value) => { checks.push(value); return valid; },
    dispatch: async (value) => { dispatched.push(value); return { status: "unreported" }; },
  };
  const client = new SuperpipelineClient({ baseUrl: "https://board.test", boardId: identity.boardId, token: "spa_fixture",
    fetch: async (url) => { calls.push(new URL(url).pathname); return { status: 200, ok: true, json: async () => context }; },
  });
  return { observed, checks, calls, dispatched, port, client, invalidate() { valid = false; },
    context(value: unknown) { context = value; } };
}

test("there is no opt-in without the dedicated trusted port or real readiness", async () => {
  expect(await selectCheckpointDispatch(undefined, identity)).toBeUndefined();
  const h = harness();
  h.port.ready = async () => undefined;
  expect(await selectCheckpointDispatch(h.port, identity)).toBeUndefined();
  expect(h.checks).toHaveLength(0);
});

test.each(["tenantId", "boardId", "stationId", "workerVersion", "benchProtocol", "workerSHA256", "coordinatorImplementationSHA256", "executionMode"] as const)(
  "readiness refuses foreign or unsupported %s before any claim", async (field) => {
    const h = harness();
    Object.assign(h.observed, { [field]: "foreign" });
    await expect(selectCheckpointDispatch(h.port, identity)).rejects.toThrow("Checkpoint target unavailable");
    expect(h.calls).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
  },
);

test("target is an immutable copy and readiness is freshly checked after current context", async () => {
  const h = harness();
  const selection = await selectCheckpointDispatch(h.port, identity);
  Object.assign(h.observed, { workerSHA256: "b".repeat(64) });
  expect(await selection?.dispatch(h.client, parsePendingCheckpointClaim(fixture.pending))).toEqual({ status: "unreported" });
  expect(h.checks).toHaveLength(3);
  expect(h.checks.every((value) => Object.isFrozen(value) && value.workerSHA256 === "a".repeat(64))).toBe(true);
  expect(h.dispatched).toHaveLength(1);
  expect(h.dispatched[0]?.claim).toMatchObject(fixture.pending);
  expect(h.calls).toEqual([`/v1/boards/${identity.boardId}/runs/${fixture.pending.runId}`]);
  expect(JSON.stringify(h.dispatched)).not.toMatch(/spa_fixture|lease_token|mcpToken|requestURL/);
});

test.each(["tenantId", "boardId", "agentId"] as const)("claim with foreign %s never reaches context or execution", async (key) => {
  const h = harness();
  const selection = await selectCheckpointDispatch(h.port, identity);
  const claim = { ...parsePendingCheckpointClaim(fixture.pending), [key]: "foreign" };
  expect((await selection?.dispatch(h.client, claim))?.status).toBe("unreported");
  expect(h.calls).toHaveLength(0);
  expect(h.dispatched).toHaveLength(0);
});

test("readiness lost during claim parks without observing or clearing another owner", async () => {
  const h = harness();
  const selection = await selectCheckpointDispatch(h.port, identity);
  h.invalidate();
  expect((await selection?.dispatch(h.client, parsePendingCheckpointClaim(fixture.pending)))?.status).toBe("unreported");
  expect(h.calls).toHaveLength(0);
  expect(h.dispatched).toHaveLength(0);
});

test("readiness lost while context is awaited prevents dispatch", async () => {
  const h = harness();
  const selection = await selectCheckpointDispatch(h.port, identity);
  h.client.context = async () => { h.invalidate(); return structuredClone(fixture.context); };
  expect((await selection?.dispatch(h.client, parsePendingCheckpointClaim(fixture.pending)))?.status).toBe("unreported");
  expect(h.dispatched).toHaveLength(0);
});

test("changed current run/policy and uncertain dispatch never become generic replay or board settlement", async () => {
  const h = harness();
  const selection = await selectCheckpointDispatch(h.port, identity);
  h.context({ ...fixture.context, run: { ...fixture.context.run, leaseEpoch: 2 } });
  expect((await selection?.dispatch(h.client, parsePendingCheckpointClaim(fixture.pending)))?.status).toBe("unreported");
  expect(h.dispatched).toHaveLength(0);
  h.context(fixture.context);
  h.port.dispatch = async () => { throw new Error("private fixture capability"); };
  expect(await selection?.dispatch(h.client, parsePendingCheckpointClaim(fixture.pending))).toEqual({
    status: "unreported", reason: "Checkpoint dispatch requires reconciliation",
  });
  expect(h.calls.every((path) => path.endsWith(`/runs/${fixture.pending.runId}`))).toBe(true);
});


test("distinct Hub and source tenant IDs are retained through context and dispatch", async () => {
  const h = harness();
  const selection = await selectCheckpointDispatch(h.port, identity);
  await selection?.dispatch(h.client, parsePendingCheckpointClaim(fixture.pending));
  expect(h.dispatched).toHaveLength(1);
  expect(h.dispatched[0]?.target.tenantId).toBe("fleet_hub_fixture");
  expect(h.dispatched[0]?.target.sourceTenantId).toBe(fixture.pending.tenantId);
  expect(h.dispatched[0]?.claim.tenantId).toBe(fixture.pending.tenantId);
  expect(h.checks.every((value) => value.sourceTenantId === fixture.pending.tenantId)).toBe(true);
});

test("a changed trusted source tenant pin refuses the claim before any context fetch", async () => {
  const h = harness();
  Object.assign(h.observed, { sourceTenantId: "tnt_wrong_source" });
  const selection = await selectCheckpointDispatch(h.port, identity);
  expect((await selection?.dispatch(h.client, parsePendingCheckpointClaim(fixture.pending)))?.status).toBe("unreported");
  expect(h.calls).toHaveLength(0);
  expect(h.dispatched).toHaveLength(0);
});

test("a named capacity refusal from the port reaches the caller unchanged", async () => {
  const h = harness();
  const refusal = { status: "unreported" as const, externalRunId: fixture.pending.runId, attemptId: "attempt-fixture",
    reason: "SuperBench capacity exhausted; the attempt stays parked and is not retried" };
  h.port.dispatch = async (value) => { h.dispatched.push(value); return refusal; };
  const selection = await selectCheckpointDispatch(h.port, identity);
  expect(await selection?.dispatch(h.client, parsePendingCheckpointClaim(fixture.pending))).toEqual(refusal);
  expect(h.dispatched).toHaveLength(1);
});
