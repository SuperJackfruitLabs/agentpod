/** Dedicated selection reaches the actual claim cycle without entering ACP or replay. */
process.env.DATABASE_URL ||= "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";
import { beforeAll, expect, test } from "bun:test";
import { runOnce } from "../../src/services/bridge/dispatch-run";
import type { AcpPort, DispatchDeps } from "../../src/services/bridge/dispatch-types";
import type { CheckpointDispatchPort, CheckpointTarget } from "../../src/services/bridge/checkpoint-dispatch";
import fixture from "../../src/services/bridge/checkpoint-contract/claim.fixture.json";
import { SuperpipelineClient, SuperpipelineApiError } from "../../src/services/bridge/superpipeline";
import { ensurePgMigrations } from "../helpers/pg-migrations";

beforeAll(ensurePgMigrations);
const noop = () => undefined;
function harness() {
  const acpCalls: string[] = [];
  const forbidden = (name: string) => { acpCalls.push(name); throw new Error("Dedicated work entered ACP"); };
  const acp: AcpPort = {
    strictWork: async () => forbidden("strictWork"), stationReady: async () => forbidden("stationReady"),
    createSession: async () => forbidden("createSession"), promptSession: async () => forbidden("promptSession"),
    subscribe: () => forbidden("subscribe"), endSession: async () => forbidden("endSession"),
    answerPermission: async () => forbidden("answerPermission"),
  };
  const agent = { key: "checkpoint-selection-fixture", boardId: fixture.pending.boardId,
    stationId: "station_pilot01", token: "spa_fixture-not-for-worker", hubUserId: "user_fixture", mode: "full-auto" as const };
  const target: CheckpointTarget = { tenantId: fixture.pending.tenantId, sourceTenantId: fixture.pending.tenantId, boardId: agent.boardId, stationId: agent.stationId,
    agentId: fixture.pending.agentId, nodeId: "node_pilot01", hostId: "host_fixture", registryRevision: "registry_fixture",
    coordinatorVersion: "superbench.v2", workerVersion: "agentpod.superbench-worker.v2", workerSHA256: "a".repeat(64) };
  const calls: Array<{ path: string; body: unknown }> = [];
  const dispatched: Parameters<CheckpointDispatchPort["dispatch"]>[0][] = [];
  let valid = true;
  let claimStatus = 200;
  let reply: unknown = { ...fixture.claimed, checkpointClaim: fixture.pending };
  let context: unknown = fixture.context;
  let afterClaim: () => void = noop;
  let afterContext: () => void = noop;
  const port: CheckpointDispatchPort = {
    ready: async () => target, current: async () => valid,
    dispatch: async (input) => { dispatched.push(input); return { status: "unreported" }; },
  };
  const client = new SuperpipelineClient({ baseUrl: "https://board.test", boardId: agent.boardId, token: agent.token,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
      if (path.endsWith("/claims")) { afterClaim(); return { status: claimStatus, ok: claimStatus === 200, json: async () => reply }; }
      if (path.endsWith(`/runs/${fixture.pending.runId}`)) { afterContext(); return { status: 200, ok: true, json: async () => context }; }
      throw new Error("Unexpected board mutation");
    },
  });
  const deps: DispatchDeps = { client, acp, agent, tenantId: fixture.pending.tenantId,
    source: "superpipeline", checkpoint: port, mcpUrl: "https://private-fixture.invalid/mcp" };
  return { deps, calls, dispatched, acpCalls, port, setReply(value: unknown) { reply = value; }, setClaimStatus(value: number) { claimStatus = value; },
    setContext(value: unknown) { context = value; }, invalidate() { valid = false; },
    afterClaim(fn: () => void) { afterClaim = fn; }, afterContext(fn: () => void) { afterContext = fn; } };
}

test("dedicated-only selection runs with unavailable ACP and never exposes board credentials", async () => {
  const h = harness();
  expect(await runOnce(h.deps)).toEqual({ status: "unreported" });
  expect(h.acpCalls).toHaveLength(0);
  expect(h.calls).toHaveLength(2);
  expect(h.calls[0]?.body).toEqual({ checkpointProtocol: "superpipeline.checkpoint-claim.v1", checkpointOnly: true });
  expect(h.dispatched).toHaveLength(1);
  expect(JSON.stringify(h.dispatched)).not.toMatch(/spa_fixture|private-fixture|mcpUrl|token|root/);
});

test.each(["claim", "context"] as const)("trusted target replaced during %s never launches or falls back", async (boundary) => {
  const h = harness();
  if (boundary === "claim") h.afterClaim(() => h.invalidate()); else h.afterContext(() => h.invalidate());
  expect((await runOnce(h.deps)).status).toBe("unreported");
  expect(h.dispatched).toHaveLength(0);
  expect(h.acpCalls).toHaveLength(0);
  expect(h.calls.every((call) => call.path.endsWith("/claims") || call.path.endsWith(`/runs/${fixture.pending.runId}`))).toBe(true);
});

test.each(["missing", "unknown", "ordinary"] as const)("required %s claim is parked before any generic execution", async (kind) => {
  const h = harness();
  h.setReply(kind === "ordinary" ? { ...fixture.claimed, stage: { key: "plain", name: "Plain" } } :
    kind === "missing" ? fixture.claimed : { ...fixture.claimed, checkpointClaim: { ...fixture.pending, version: "unknown" } });
  expect((await runOnce(h.deps)).status).toBe("unreported");
  expect(h.calls).toHaveLength(1);
  expect(h.dispatched).toHaveLength(0);
  expect(h.acpCalls).toHaveLength(0);
});

test("changed current policy never reaches the dedicated executor or generic fallback", async () => {
  const h = harness();
  h.setContext({ ...fixture.context, stage: { ...fixture.context.stage,
    checkpointPolicy: { ...fixture.pending.policy, allowUnchanged: true } } });
  expect((await runOnce(h.deps)).status).toBe("unreported");
  expect(h.dispatched).toHaveLength(0);
  expect(h.acpCalls).toHaveLength(0);
});

test("uncertain dedicated dispatch remains parked and does not settle or redispatch", async () => {
  const h = harness();
  h.port.dispatch = async () => { throw new Error("private-fixture-secret"); };
  expect(await runOnce(h.deps)).toEqual({ status: "unreported", reason: "Checkpoint dispatch requires reconciliation" });
  expect(h.calls).toHaveLength(2);
  expect(h.acpCalls).toHaveLength(0);
});


test.each([401, 403])("definitive claim refusal %i preserves the existing credential halt", async (status) => {
  const h = harness();
  h.setClaimStatus(status);
  h.setReply({ error: { code: "FORBIDDEN", message: "Fixture refusal" } });
  await expect(runOnce(h.deps)).rejects.toBeInstanceOf(SuperpipelineApiError);
  expect(h.calls).toHaveLength(1);
  expect(h.dispatched).toHaveLength(0);
  expect(h.acpCalls).toHaveLength(0);
});
