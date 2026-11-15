/** Proposed claim discovery: a generic client cannot discard a required execution boundary. */
import { expect, test } from "bun:test";
import fixture from "./checkpoint-contract/claim.fixture.json";
import { SuperpipelineClient, type Fetcher } from "./superpipeline";

function board(body: unknown) {
  const calls: Array<{ body?: string }> = [];
  const fetch: Fetcher = async (_url, init) => {
    calls.push(init);
    return { status: 200, ok: true, json: async () => body };
  };
  return { calls, client: new SuperpipelineClient({ baseUrl: "https://board.test", boardId: fixture.pending.boardId,
    token: "spa_fixture", fetch }) };
}

test.each([fixture.pending, null, false, { version: "unknown" }])(
  "a legacy claimant refuses an unsolicited checkpoint claim: %j", async (checkpointClaim) => {
    const { calls, client } = board({ ...fixture.claimed, checkpointClaim });
    await expect(client.claim()).rejects.toThrow(/checkpoint/i);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({});
  },
);

test.each([fixture.pending.policy, null, false, { version: "unknown" }])(
  "a required or malformed policy cannot silently enter the legacy path: %j", async (checkpointPolicy) => {
    const { client } = board({ ...fixture.claimed, stage: { ...fixture.claimed.stage, checkpointPolicy } });
    await expect(client.claim()).rejects.toThrow(/checkpoint/i);
  },
);

test("an unsolicited checkpoint marker cannot hide behind claimed:false", async () => {
  await expect(board({ claimed: false, checkpointClaim: fixture.pending }).client.claim()).rejects.toThrow(/checkpoint/i);
});

test("legacy context lookup refuses checkpoint-required execution", async () => {
  await expect(board(fixture.context).client.context(fixture.pending.runId)).rejects.toThrow(/checkpoint/i);
});

test("ordinary claim and context keep their legacy shapes", async () => {
  const stage = { key: "plain", name: "Plain" };
  const claimed = { ...fixture.claimed, stage };
  expect(await board(claimed).client.claim()).toMatchObject({ runId: claimed.runId, stage });
  const context = { ...fixture.context, stage };
  expect(await board(context).client.context(fixture.pending.runId)).toEqual(context);
  expect(await board({ claimed: false }).client.claim()).toBeNull();
});

import { CHECKPOINT_CLAIM_PROTOCOL, checkpointPolicyDigest, parsePendingCheckpointClaim } from "./checkpoint-claim";
import goldens from "./checkpoint-contract/canonical.fixture.json";
import policySchema from "./checkpoint-contract/run-checkpoint-policy.v1.json";
import provenance from "./checkpoint-contract/provenance.json";

function checkpointReply() { return { ...structuredClone(fixture.claimed), checkpointClaim: structuredClone(fixture.pending) }; }
const options = { checkpointProtocol: CHECKPOINT_CLAIM_PROTOCOL } as const;

test("requested discovery preserves the exact actual pending claim without changing credential identity", async () => {
  const reply = checkpointReply();
  const { client, calls } = board(reply);
  const work = await client.claim(options);
  expect(work?.checkpointClaim).toMatchObject(fixture.pending);
  expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual(options);
  expect(calls[0]?.body).not.toContain("agentId");
  reply.checkpointClaim.policy.nodeId = "changed-after-return";
  expect(work?.checkpointClaim?.policy.nodeId).toBe(fixture.pending.policy.nodeId);
});

test("opted-in clients still receive ordinary work without fabricating a pending claim", async () => {
  const reply = { ...fixture.claimed, stage: { key: "plain", name: "Plain" } };
  const work = await board(reply).client.claim(options);
  expect(work?.checkpointClaim).toBeUndefined();
  expect(await board({ claimed: false }).client.claim(options)).toBeNull();
});

const invalidPending: Array<[string, (value: Record<string, unknown>) => void]> = [
  ["unknown version", (value) => { value.version = "superpipeline.checkpoint-claim.v2"; }],
  ["missing tenant", (value) => { delete value.tenantId; }],
  ["already admitted", (value) => { value.admissionState = "admitted"; }],
  ["zero epoch", (value) => { value.leaseEpoch = 0; }],
  ["fractional epoch", (value) => { value.leaseEpoch = 1.5; }],
  ["unsafe epoch", (value) => { value.leaseEpoch = Number.MAX_SAFE_INTEGER + 1; }],
  ["digest mismatch", (value) => { value.policyDigest = "0".repeat(64); }],
  ["digest newline", (value) => { value.policyDigest = fixture.pending.policyDigest + "\n"; }],
  ["unknown capability", (value) => { value.lease_token = "private-fixture-capability"; }],
  ["root path", (value) => { value.root = "/private-fixture-root"; }],
  ["oversized identity", (value) => { value.runId = "x".repeat(129); }],
  ["invalid scalar", (value) => { value.tenantId = "\ud800"; }],
];
test.each(invalidPending)("requested DTO refuses %s with bounded errors", async (_name, change) => {
  const reply = checkpointReply();
  change(reply.checkpointClaim);
  let caught: unknown;
  try { await board(reply).client.claim(options); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).toMatch(/^CheckpointClaimRefused: Checkpoint claim refused: [a-z]+$/);
  expect(String(caught)).not.toContain("private-fixture");
});

test.each(["boardId", "cardId", "stageKey", "agentId", "runId"] as const)("claim binding rejects foreign %s", async (key) => {
  const reply = checkpointReply();
  reply.checkpointClaim[key] = "foreign";
  await expect(board(reply).client.claim(options)).rejects.toThrow(/Checkpoint/);
});

test.each(["currentRunId", "currentStageKey", "delegateAgentId", "state"] as const)("actual claimed card must match %s", async (key) => {
  const reply = checkpointReply();
  reply.card[key] = "foreign";
  await expect(board(reply).client.claim(options)).rejects.toThrow(/Checkpoint/);
});

test("actual stage policy, epoch and required DTO cannot be substituted", async () => {
  const changedPolicy = checkpointReply();
  changedPolicy.stage.checkpointPolicy.allowUnchanged = true;
  await expect(board(changedPolicy).client.claim(options)).rejects.toThrow(/policy/);
  const changedEpoch = checkpointReply();
  changedEpoch.leaseEpoch++;
  await expect(board(changedEpoch).client.claim(options)).rejects.toThrow(/binding/);
  await expect(board(fixture.claimed).client.claim(options)).rejects.toThrow(/required/);
  await expect(board({ ...checkpointReply(), claimed: false }).client.claim(options)).rejects.toThrow(/binding/);
});

test.each(goldens.cases)("owner-canonical policy digest matches shared golden %j", ({ policy, sha256 }) => {
  expect(checkpointPolicyDigest(policy)).toBe(sha256);
  const reordered = Object.fromEntries(Object.entries(policy).toReversed());
  expect(checkpointPolicyDigest(reordered)).toBe(sha256);
});

test("pinned policy schema and source status remain explicit", async () => {
  const raw = await Bun.file(new URL("./checkpoint-contract/run-checkpoint-policy.v1.json", import.meta.url)).arrayBuffer();
  expect(Bun.CryptoHasher.hash("sha256", raw, "hex")).toBe(provenance.policy_schema_sha256);
  expect(policySchema.$id).toContain("SuperJackfruitLabs/treaty");
  expect(provenance.charter_status).toBe("Proposed. Not accepted.");
  expect(parsePendingCheckpointClaim(fixture.pending)).toMatchObject(fixture.pending);
});

test("requested context validates the original live run and actual current policy", async () => {
  const pending = parsePendingCheckpointClaim(fixture.pending);
  expect(await board(fixture.context).client.context(pending.runId, pending)).toEqual(fixture.context);
});

test.each(["runId", "cardId", "stageKey", "status", "endedAt"] as const)("current run cannot substitute %s", async (key) => {
  const context = structuredClone(fixture.context);
  const changed: Record<string, unknown> = context.run;
  changed[key] = "foreign";
  await expect(board(context).client.context(fixture.pending.runId, parsePendingCheckpointClaim(fixture.pending)))
    .rejects.toThrow(/context/);
});

test("stale epoch, changed policy, moved card and removed policy all refuse context", async () => {
  const pending = parsePendingCheckpointClaim(fixture.pending);
  const stale = structuredClone(fixture.context);
  stale.run.leaseEpoch++;
  await expect(board(stale).client.context(pending.runId, pending)).rejects.toThrow(/context/);
  const policy = structuredClone(fixture.context);
  policy.stage.checkpointPolicy.allowUnchanged = true;
  await expect(board(policy).client.context(pending.runId, pending)).rejects.toThrow(/policy/);
  const moved = structuredClone(fixture.context);
  moved.card.currentRunId = "foreign";
  await expect(board(moved).client.context(pending.runId, pending)).rejects.toThrow(/context/);
  const absent = { ...fixture.context, stage: { key: fixture.pending.stageKey, name: "Test" } };
  await expect(board(absent).client.context(pending.runId, pending)).rejects.toThrow(/context/);
  await expect(board(fixture.context).client.context("foreign", pending)).rejects.toThrow(/context/);
});

test("policy structural and semantic corruption is refused before it becomes a digest", () => {
  for (const patch of [
    { allowUnchanged: null }, { repositories: [] }, { executors: [] }, { checkpointRepository: "missing" },
    { executors: [...fixture.pending.policy.executors, ...fixture.pending.policy.executors] },
    { repositories: [fixture.pending.policy.repositories[0], fixture.pending.policy.repositories[0]] },
    { nodeId: "\ud800" }, { lease_token: "private-fixture-capability" },
    { repositories: [{ name: "app", provider: "unknown", repository: "example/app" }] },
    { repositories: [{ name: "app\n", provider: "forge", repository: "example/app" }] },
    { repositories: [{ name: "app", provider: "forge", repository: "example/app\n" }] },
  ]) expect(() => checkpointPolicyDigest({ ...fixture.pending.policy, ...patch })).toThrow(/Checkpoint/);
});


test.each([2, 32])("multi-repository policies retain all %i sorted member identities", (count) => {
  const policy = { ...structuredClone(fixture.pending.policy), repositories: Array.from({ length: count }, (_, i) => ({
    name: `repo_${String(i).padStart(2, "0")}`, provider: "forge" as const, repository: `example/repo_${i}`,
  })), checkpointRepository: "repo_00" };
  const pending = { ...fixture.pending, policy, policyDigest: checkpointPolicyDigest(policy) };
  expect(parsePendingCheckpointClaim(pending).policy.repositories).toEqual(policy.repositories);
  expect(() => checkpointPolicyDigest({ ...policy, repositories: policy.repositories.toReversed() })).toThrow(/Checkpoint/);
});

test("more than 32 repositories refuse before dedicated execution", () => {
  const policy = { ...fixture.pending.policy, repositories: Array.from({ length: 33 }, (_, i) => ({
    name: `repo_${String(i).padStart(2, "0")}`, provider: "forge" as const, repository: `example/repo_${i}`,
  })), checkpointRepository: "repo_00" };
  expect(() => checkpointPolicyDigest(policy)).toThrow(/Checkpoint/);
});


test("dedicated checkpoint-only request cannot project an ordinary claim into execution", async () => {
  const { client, calls } = board(checkpointReply());
  expect((await client.claim({ ...options, checkpointOnly: true }))?.checkpointClaim).toBeDefined();
  expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ ...options, checkpointOnly: true });
  const ordinary = { ...fixture.claimed, stage: { key: "plain", name: "Plain" } };
  await expect(board(ordinary).client.claim({ ...options, checkpointOnly: true })).rejects.toThrow(/required/);
  expect(await board({ claimed: false }).client.claim({ ...options, checkpointOnly: true })).toBeNull();
});

test.each([null, "true", 1, {}, []])("checkpointOnly must be a strict boolean: %j", async (checkpointOnly) => {
  const { client, calls } = board(checkpointReply());
  await expect(Reflect.apply(client.claim.bind(client), client, [{ ...options, checkpointOnly }])).rejects.toThrow(/unsupported/);
  expect(calls).toHaveLength(0);
});

test("checkpointOnly true requires the exact protocol before any request", async () => {
  const { client, calls } = board(checkpointReply());
  await expect(client.claim({ checkpointOnly: true })).rejects.toThrow(/unsupported/);
  expect(calls).toHaveLength(0);
});
