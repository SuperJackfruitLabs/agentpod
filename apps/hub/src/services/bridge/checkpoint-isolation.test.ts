/**
 * A checkpoint refusal belongs to the checkpoint stage. With the coordinator on and the control
 * pair off, every cycle for the station with the checkpoint profile used to throw
 * `CheckpointRefused: authority` and end the cycle, so its ordinary stages got no claims, and the
 * refusal was logged every backoff forever.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import corpus from "../../../../../packages/contract/src/fixtures/bench-coordinator-v1.json";
import { runOnce } from "./dispatch";
import { CheckpointRefused } from "./checkpoint-profile";
import { checkpointCycle, createCheckpointRefusalLog, CHECKPOINT_REFUSAL_RELOG_MS } from "./checkpoint-isolation";
import { checkpointPrerequisiteError, CHECKPOINT_COORDINATOR_FLAG } from "./checkpoint-profiles";
import { checkpointRuntime } from "./checkpoint-port";
import { reportCheckpointPrerequisite } from "../../validate-config";
import { SuperpipelineClient } from "./superpipeline";
import { BridgeCredentialRefused } from "./plane-credential";
import type { CheckpointDispatchPort } from "./checkpoint-dispatch";
import type { AcpPort, DispatchDeps } from "./dispatch-types";
import type { BridgeAgentConfig } from "./config";

const agent: BridgeAgentConfig = { key: "a", boardId: "brd_x", token: "spa_x", stationId: "station_x", hubUserId: "usr_x", mode: "full-auto" };
const unused = (): never => { throw new Error("not part of a claim cycle"); };
const acp: AcpPort = { stationReady: async () => ({ ready: true }), createSession: unused, promptSession: unused,
  subscribe: unused, endSession: unused, answerPermission: unused };

/** A real client over a fake board: every claim body is recorded, and the queue is empty. */
function ordinaryClient() {
  const claims: Record<string, unknown>[] = [];
  const client = new SuperpipelineClient({ baseUrl: "https://board.test", boardId: agent.boardId, token: agent.token,
    fetch: async (_url, init) => {
      claims.push(JSON.parse(init.body ?? "{}"));
      return { status: 200, ok: true, json: async () => ({ claimed: false }) };
    } });
  return { client, claims };
}
function deps(client: SuperpipelineClient, extra: Partial<DispatchDeps> = {}): DispatchDeps {
  return { client, acp, agent, tenantId: "tnt_x", source: "superpipeline", log: () => {}, ...extra };
}
const refusingPort = (): CheckpointDispatchPort => ({
  ready: async () => { throw new CheckpointRefused("authority"); },
  current: async () => false,
  dispatch: async () => { throw new Error("must not dispatch a refused checkpoint"); },
});

test("a refused checkpoint selection still makes the ordinary claim in the same cycle", async () => {
  const { client, claims } = ordinaryClient();
  const refused: unknown[] = [];
  const result = await runOnce(deps(client, { checkpoint: refusingPort(), checkpointRefused: (e) => refused.push(e) }));
  expect(result.status).toBe("idle");
  expect(claims).toHaveLength(1);
  // Ordinary claim: no checkpoint protocol, so the board cannot hand it a checkpoint stage.
  expect(claims[0]).not.toHaveProperty("checkpointProtocol");
  expect(claims[0]).not.toHaveProperty("checkpointOnly");
  expect(refused).toHaveLength(1);
  expect(refused[0]).toBeInstanceOf(CheckpointRefused);
  expect(refused[0]).toMatchObject({ code: "authority" });
});

test("a refused checkpoint client leaves the cycle on the ordinary client, which still claims", async () => {
  const { client, claims } = ordinaryClient();
  const refused: unknown[] = [];
  const cycle = await checkpointCycle({
    client: async () => { throw new CheckpointRefused("authority"); },
    port: refusingPort(),
  }, client, (e) => refused.push(e));
  expect(cycle.client).toBe(client);
  expect(cycle.checkpoint).toBeUndefined();
  const result = await runOnce(deps(cycle.client));
  expect(result.status).toBe("idle");
  expect(claims).toHaveLength(1);
  expect(refused).toHaveLength(1);
});

test("refusals still refuse: a refused selection never reaches checkpoint recovery or dispatch", async () => {
  const { client } = ordinaryClient();
  let touched = false;
  const port: CheckpointDispatchPort = { ...refusingPort(), recover: async () => { touched = true; return undefined; },
    dispatch: async () => { touched = true; return { status: "unreported" }; } };
  await runOnce(deps(client, { checkpoint: port, checkpointRefused: () => {} }));
  expect(touched).toBe(false);
});

test("a refusal repeated every cycle is logged once per reason, then once per interval with a count", () => {
  let now = 0;
  const lines: Record<string, unknown>[] = [];
  const refused = createCheckpointRefusalLog((_m, meta) => lines.push(meta ?? {}), { now: () => now });
  // Eight hours of 30-second backoffs.
  for (let i = 0; i < 960; i++) { refused(new CheckpointRefused("authority")); now += 30_000; }
  const expected = Math.ceil(960 * 30_000 / CHECKPOINT_REFUSAL_RELOG_MS);
  expect(lines).toHaveLength(expected);
  expect(lines[0]).toEqual({ code: "authority" });
  expect(lines[1]?.suppressed).toBe(CHECKPOINT_REFUSAL_RELOG_MS / 30_000 - 1);
  // A different reason is its own line at once.
  refused(new CheckpointRefused("stale"));
  expect(lines.at(-1)).toEqual({ code: "stale" });
  refused(new Error("network"));
  expect(lines.at(-1)).toEqual({ code: "unavailable" });
});

// ─── startup prerequisite ───────────────────────────────────────────────────
const keys = [CHECKPOINT_COORDINATOR_FLAG, "PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE", "ENFORCE_CONTROL_PAIR"] as const;
const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
const roots: string[] = [];
afterEach(() => {
  for (const k of keys) { const v = prior[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function installProfile() {
  const fixtureRequest = corpus.requests.find((item) => item.name === "prepare");
  const request = fixtureRequest?.value;
  if (!request || !("target" in request) || !request.target) throw new Error("fixture target missing");
  const profile = { version: "agentpod.checkpoint-profile.v1", organizationId: "org_" + "a".repeat(20),
    sourceTenantId: "tnt_source", sourceOrigin: "https://pipeline.test", sourceAudience: "https://app.superpipeline.dev",
    reporterPrincipalId: "prn_" + "b".repeat(20), ownerPrincipalId: "prn_" + "c".repeat(20),
    occupantPrincipalId: "prn_" + "d".repeat(20), agentKey: "fixture", profileKey: "fixture", occupancyEpoch: 1,
    target: request.target, checkpointRepository: "api",
    repositories: [{ name: "api", provider: "forge", repository: "example/api", repositorySHA256: "e".repeat(64), objectFormat: "sha1" }] };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "checkpoint-isolation-"))); roots.push(root); chmodSync(root, 0o700);
  const file = join(root, "profiles.json");
  writeFileSync(file, JSON.stringify({ version: "agentpod.checkpoint-profiles.v1", profiles: [profile] }), { mode: 0o600 });
  process.env[CHECKPOINT_COORDINATOR_FLAG] = "true";
  process.env.PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE = file;
  const t = request.target;
  return () => checkpointRuntime(t.tenant_id, t.board_id, t.station_id, profile.agentKey);
}

test("the prerequisite names ENFORCE_CONTROL_PAIR only when the coordinator is on without it", () => {
  expect(checkpointPrerequisiteError({})).toBeUndefined();
  expect(checkpointPrerequisiteError({ [CHECKPOINT_COORDINATOR_FLAG]: "true", ENFORCE_CONTROL_PAIR: "true" })).toBeUndefined();
  expect(checkpointPrerequisiteError({ [CHECKPOINT_COORDINATOR_FLAG]: "true" })).toContain("ENFORCE_CONTROL_PAIR=true");
  expect(checkpointPrerequisiteError({ [CHECKPOINT_COORDINATOR_FLAG]: "true", ENFORCE_CONTROL_PAIR: "1" })).toContain("ENFORCE_CONTROL_PAIR");
  const lines: string[] = [];
  expect(reportCheckpointPrerequisite({ [CHECKPOINT_COORDINATOR_FLAG]: "true" }, (m) => lines.push(m))).toBe(true);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("ENFORCE_CONTROL_PAIR=true");
  expect(reportCheckpointPrerequisite({ [CHECKPOINT_COORDINATOR_FLAG]: "true", ENFORCE_CONTROL_PAIR: "true" }, (m) => lines.push(m))).toBe(false);
  expect(lines).toHaveLength(1);
});

test("without the control pair no checkpoint profile is loaded, with one explicit error", () => {
  const runtime = installProfile();
  delete process.env.ENFORCE_CONTROL_PAIR;
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(runtime()).toBeUndefined();
    expect(runtime()).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    const message = JSON.stringify(error.mock.calls);
    expect(message).toContain("ENFORCE_CONTROL_PAIR");
    expect(message).toContain("dedicated dispatch disabled");
    expect(message).not.toContain(process.env.PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE ?? "unset");
  } finally { error.mockRestore(); }
  // With the prerequisite met, the same installation loads.
  process.env.ENFORCE_CONTROL_PAIR = "true";
  const info = spyOn(console, "log").mockImplementation(() => {});
  try { expect(runtime()).toBeDefined(); } finally { info.mockRestore(); }
});

test("a refused plane grant on the dedicated path is a named refusal, and the ordinary claim still runs", async () => {
  // The dedicated checkpoint claim's grant is refused before any request (here: no `claim` scope);
  // the ordinary claim's exchange then succeeds. Nothing reaches the board for the refused one.
  const claims: Record<string, unknown>[] = [];
  let exchanges = 0;
  const client = new SuperpipelineClient({ baseUrl: "https://board.test", boardId: agent.boardId, token: "",
    credential: async () => {
      if (++exchanges === 1) throw new BridgeCredentialRefused("claims.scope");
      return "grant";
    },
    fetch: async (_url, init) => {
      claims.push(JSON.parse(init.body ?? "{}"));
      return { status: 200, ok: true, json: async () => ({ claimed: false }) };
    } });
  const target = { tenantId: "tnt_x", sourceTenantId: "tnt_x", boardId: agent.boardId, stationId: agent.stationId,
    agentId: "agt_x", nodeId: "node_x", hostId: "host_x", registryRevision: "r", benchProtocol: "superbench.v2",
    coordinatorImplementationSHA256: "b".repeat(64), executionMode: "linux-cgroup-v2",
    workerVersion: "agentpod.superbench-worker.v2", workerSHA256: "a".repeat(64) } as const;
  const port: CheckpointDispatchPort = { ready: async () => target, current: async () => true,
    dispatch: async () => { throw new Error("must not dispatch"); } };
  const refused: unknown[] = [];
  const result = await runOnce(deps(client, { checkpoint: port, checkpointRefused: (e) => refused.push(e) }));
  expect(result.status).toBe("idle");
  expect(refused).toHaveLength(1);
  expect(refused[0]).toBeInstanceOf(CheckpointRefused);
  expect(refused[0]).toMatchObject({ code: "authority", reason: "credential.claims.scope" });
  // Exactly one request reached the board: the ordinary claim, with no checkpoint protocol.
  expect(claims).toHaveLength(1);
  expect(claims[0]).not.toHaveProperty("checkpointOnly");
  expect(claims[0]).not.toHaveProperty("checkpointProtocol");
});
