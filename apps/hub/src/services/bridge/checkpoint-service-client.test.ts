import { expect, test } from "bun:test";
import { createCheckpointServiceClient } from "./checkpoint-service-client";
import { parseCheckpointProfile, requireCheckpointProfileClaim } from "./checkpoint-profile";
import { checkpointPolicyDigest, parsePendingCheckpointClaim } from "./checkpoint-claim";
import { checkpointDigest, canonicalCheckpoint } from "./checkpoint-json";
import { requireActiveSource, type CheckpointSource } from "./checkpoint-source";
import fixture from "./checkpoint-contract/claim.fixture.json";
import canonicals from "./checkpoint-contract/settlement-canonical.fixture.json";
import { fakePlaneJwks, signPlaneToken, TEST_ORG } from "../../../tests/helpers/fake-plane";
import { TEST_PLANE } from "../../auth/org-plane/config";

function inputs() {
  const policy = { ...fixture.pending.policy, reporterPrincipalId: "prn_" + "a".repeat(20) };
  const claim = parsePendingCheckpointClaim({ ...fixture.pending, policy, policyDigest: checkpointPolicyDigest(policy) });
  const profile = parseCheckpointProfile({ version: "agentpod.checkpoint-profile.v1", organizationId: TEST_ORG,
    sourceTenantId: claim.tenantId, sourceOrigin: "https://pipeline.test", sourceAudience: "https://pipeline.test",
    reporterPrincipalId: policy.reporterPrincipalId, ownerPrincipalId: "prn_" + "b".repeat(20),
    occupantPrincipalId: "prn_" + "c".repeat(20), agentKey: "fixture", profileKey: "fixture", occupancyEpoch: 1,
    target: { tenant_id: "fleet_local_fixture", board_id: claim.boardId, agent_id: claim.agentId,
      station_id: "station_pilot01", node_id: policy.nodeId, host_id: "host_fixture", registry_sha256: "a".repeat(64),
      coordinator_implementation_sha256: "b".repeat(64), execution_mode: "linux-cgroup-v2", bench_protocol: "superbench.v2",
      worker_version: "agentpod.superbench-worker.v2", worker_sha256: "c".repeat(64) },
    repositories: [{ ...policy.repositories[0], repositorySHA256: "d".repeat(64), objectFormat: "sha1" }],
    checkpointRepository: "app" });
  const source: CheckpointSource = { binding: { boardId: claim.boardId, cardId: claim.cardId, stageKey: claim.stageKey,
    runId: claim.runId, leaseEpoch: claim.leaseEpoch, agentId: claim.agentId, stationId: profile.target.station_id,
    nodeId: profile.target.node_id, attemptId: "attempt_fixture" }, start: [{ name: "app", commit: "a".repeat(40) }],
    benchKey: "fixture", benchId: "b".repeat(32), requestId: "run_fixture", sourceRequestSha256: "c".repeat(64),
    workerContextSha256: "d".repeat(64) };
  const snapshot = { ...source, tenantId: claim.tenantId, policy, policyDigest: claim.policyDigest,
    status: "working", lastHeartbeatMs: Date.now() };
  return { profile, claim, source, snapshot };
}
async function harness(claims: Record<string, unknown> = {}) {
  const input = inputs(); const calls: Array<{ url: string; init?: RequestInit }> = [];
  const token = await signPlaneToken({ sub: input.profile.reporterPrincipalId, principalKind: "service",
    org: TEST_ORG, aud: input.profile.sourceAudience, ent: ["superpipeline"],
    scope: "checkpoints:read checkpoints:submit", ...claims });
  let response: () => Promise<Response> = async () => Response.json(input.snapshot);
  const client = createCheckpointServiceClient(input.profile, { plane: TEST_PLANE,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url === TEST_PLANE.url + "/api/token/service") return Response.json({ access_token: token, expires_in: 300 });
      if (url === TEST_PLANE.jwksUrl) return Response.json(await fakePlaneJwks());
      return response();
    } });
  return { ...input, client, calls, token, response(fn: () => Promise<Response>) { response = fn; } };
}

test("canonical whole reports and submissions match the proposed owner plain-data goldens", async () => {
  for (const vector of canonicals.cases) {
    expect(canonicalCheckpoint(vector.value)).toBe(vector.canonical);
    expect(await checkpointDigest(vector.value)).toBe(vector.sha256);
  }
});

test("server profile retains distinct local tenant IDs and joins exact policy repository pins", () => {
  const h = inputs(); requireCheckpointProfileClaim(h.profile, h.claim);
  expect(h.profile.target.tenant_id).not.toBe(h.profile.sourceTenantId);
  expect(Object.isFrozen(h.profile.repositories[0])).toBe(true);
  for (const changed of [{ sourceTenantId: "tnt_foreign" }, { organizationId: "org_bad" },
    { sourceOrigin: "https://pipeline.test/path" }, { sourceOrigin: "https://user:secret@pipeline.test" }]) {
    if ("sourceTenantId" in changed) expect(() => requireCheckpointProfileClaim(parseCheckpointProfile({ ...h.profile, ...changed }), h.claim)).toThrow();
    else expect(() => parseCheckpointProfile({ ...h.profile, ...changed })).toThrow();
  }
  const wrong = parseCheckpointProfile({ ...h.profile,
    repositories: [{ ...h.profile.repositories[0], repository: "foreign/repository" }] });
  expect(() => requireCheckpointProfileClaim(wrong, h.claim)).toThrow("authority");
});

test("real issuer signature and exact audience authorize a Hub-only source read", async () => {
  const h = await harness(); const result = await h.client.source(h.claim);
  requireActiveSource(result, h.source);
  const call = h.calls.find((value) => value.url.startsWith(h.profile.sourceOrigin));
  expect(call?.url).toBe(`${h.profile.sourceOrigin}/v1/boards/${h.claim.boardId}/runs/${h.claim.runId}/checkpoint-source`);
  expect(call?.init).toMatchObject({ redirect: "error", credentials: "omit", method: "GET" });
  expect(call?.init?.headers).toMatchObject({ authorization: `Bearer ${h.token}` });
  expect(JSON.stringify(result)).not.toContain(h.token);
  expect(JSON.stringify(result)).not.toContain(TEST_PLANE.serviceCredential.secret);
});

test.each([
  { principalKind: "agent" }, { sub: "prn_" + "f".repeat(20) }, { org: "org_" + "f".repeat(20) },
  { aud: "https://foreign.test" }, { scope: "runs:write" }, { ent: ["agentpod"] },
  { exp: 1 }, { act: { sub: "prn_" + "f".repeat(20) } },
])("foreign or insufficient verified reporter never reaches SuperPipeline: %j", async (claims) => {
  const h = await harness(claims);
  await expect(h.client.source(h.claim)).rejects.toThrow("authority");
  expect(h.calls.some((call) => call.url.startsWith(h.profile.sourceOrigin))).toBe(false);
});

test("admission checks the exact source digest and never returns a replaced receipt", async () => {
  const h = await harness();
  const receipt = { runId: h.claim.runId, leaseEpoch: h.claim.leaseEpoch,
    sourceDigest: await checkpointDigest(h.source), admittedAt: Date.now() };
  h.response(async () => Response.json(receipt));
  expect(await h.client.admit(h.claim, h.source)).toEqual(receipt);
  const sent = h.calls.find((call) => call.init?.method === "POST" && call.url.startsWith(h.profile.sourceOrigin));
  expect(sent?.init?.body).toBe(canonicalCheckpoint(h.source));
  h.response(async () => Response.json({ ...receipt, sourceDigest: "0".repeat(64) }));
  await expect(h.client.admit(h.claim, h.source)).rejects.toThrow("source");
});

test("an ended, stale or replaced source snapshot cannot authorize a new report", async () => {
  const h = await harness();
  expect(() => requireActiveSource({ ...h.snapshot, status: "ended" }, h.source)).toThrow("stale");
  expect(() => requireActiveSource({ ...h.snapshot, lastHeartbeatMs: 0 }, h.source)).toThrow("stale");
  expect(() => requireActiveSource({ ...h.snapshot, benchId: "f".repeat(32) }, h.source)).toThrow("stale");
  h.response(async () => Response.json({ ...h.snapshot, tenantId: "tnt_foreign" }));
  await expect(h.client.source(h.claim)).rejects.toThrow();
});

test("malformed, oversized and compressed source responses are closed refusals", async () => {
  const h = await harness();
  for (const reply of [new Response('{"status":"working","status":"ended"}'),
    new Response(" ".repeat(65537)), new Response("{}", { headers: { "content-encoding": "gzip" } }),
    Response.json({ ...h.snapshot, grant: "must-not-leak" })]) {
    h.response(async () => reply);
    await expect(h.client.source(h.claim)).rejects.toThrow();
  }
});

test("lost admission response is uncertain and never retried with a fresh request", async () => {
  const h = await harness(); h.response(async () => { throw new Error("private response capability"); });
  await expect(h.client.admit(h.claim, h.source)).rejects.toThrow("Checkpoint refused: uncertain");
  expect(h.calls.filter((call) => call.url.startsWith(h.profile.sourceOrigin))).toHaveLength(1);
});
