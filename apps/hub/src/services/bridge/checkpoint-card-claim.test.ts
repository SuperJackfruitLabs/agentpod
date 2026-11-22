/**
 * Claim protocol v2: a stage whose cards choose their repositories, read by the SuperPipeline client
 * against treaty's own claim request and response cases (agent-work.v1, treaty v0.0.16). Only a
 * claimant that sends `checkpointProtocols` may read such a stage; every other claimant's request
 * and reading is unchanged.
 */
import { expect, test } from "bun:test";
import { SuperpipelineClient, type Fetcher } from "./superpipeline";
import {
  CARD_CHOICE_CHECKPOINT_PROTOCOLS, CHECKPOINT_CLAIM_PROTOCOL, CHECKPOINT_CLAIM_PROTOCOL_V2, CheckpointClaimRefused,
  parsePendingCheckpointClaim,
} from "./checkpoint-claim";
import { canonicalSha256 } from "./checkpoint-policy";
import { contractFetch, requestCases, validResponses } from "../../../tests/helpers/superpipeline-contract";

interface Selection { stagePolicyDigest: string; repositories: string[]; checkpointRepository: string; [field: string]: unknown }
interface Reply {
  runId: string; leaseEpoch: number;
  card: { id: string; delegateAgentId: string; [field: string]: unknown };
  stage: { key: string; checkpointPolicy?: unknown; cardCheckpointPolicy: { repositories: Array<{ name: string }>; [field: string]: unknown };
    [field: string]: unknown };
  checkpointClaim: { policy: { repositories: unknown[]; [field: string]: unknown }; policyDigest: string; selection?: Selection;
    [field: string]: unknown };
  [field: string]: unknown;
}
function named(name: string): Reply {
  const found = validResponses("claimCard").find(([n]) => n === name);
  if (!found) throw new Error(`treaty has no claimCard case "${name}"`);
  const copy: Reply = JSON.parse(JSON.stringify(found[1]));
  return copy;
}
const CARD_STAGE = "claimed on a stage whose cards choose repositories";

function board(body: Reply, boardId = "brd_134a0ddb6d434478") {
  const calls: Array<{ body?: string; method: string }> = [];
  const fetch: Fetcher = contractFetch(async (url, init) => {
    calls.push(init);
    // A run read for the context check: the same card, stage and run, still working.
    if (init.method === "GET") return { status: 200, ok: true, json: async () => contextOf(body) };
    return { status: 200, ok: true, json: async () => body };
  });
  return { calls, client: new SuperpipelineClient({ baseUrl: "https://board.test", boardId, token: "spa_fixture", fetch }) };
}
function contextOf(c: Reply) {
  return { run: { runId: c.runId, cardId: c.card.id, stageKey: c.stage.key, leaseEpoch: c.leaseEpoch, status: "working", endedAt: null,
    agentId: c.card.delegateAgentId }, card: c.card, stage: c.stage, handoff: null, references: [] };
}
const v2 = { checkpointProtocol: CHECKPOINT_CLAIM_PROTOCOL, checkpointProtocols: CARD_CHOICE_CHECKPOINT_PROTOCOLS, checkpointOnly: true } as const;

test("a card-choice claimant sends treaty's request: v1 beside checkpointProtocols [v1, v2]", async () => {
  const { calls, client } = board(named(CARD_STAGE));
  await client.claim(v2);
  const sent: unknown = JSON.parse(calls[0]?.body ?? "{}");
  expect(sent).toEqual(requestCases("claimCard").valid["cards choose repositories"]);
});

test("it reads a narrowed claim, and its selection, exactly as treaty's case holds them", async () => {
  const reply = named(CARD_STAGE);
  const work = await board(reply).client.claim(v2);
  const read: unknown = work?.checkpointClaim;
  expect(read).toEqual(reply.checkpointClaim);
  expect(work?.checkpointClaim?.selection?.repositories).toEqual(["api", "app"]);
  expect(work?.checkpointClaim?.policy.repositories.map((r) => r.name)).toEqual(["api", "app"]);
});

test("its context read re-checks the same narrowing", async () => {
  const reply = named(CARD_STAGE);
  const { client } = board(reply);
  const work = await client.claim(v2);
  if (!work?.checkpointClaim) throw new Error("no claim");
  await expect(client.context(work.runId, work.checkpointClaim)).resolves.toBeDefined();
  // The stage's allowlist changed between claim and context: refused.
  const changed = board({ ...reply, stage: { ...reply.stage, cardCheckpointPolicy: { ...reply.stage.cardCheckpointPolicy, allowUnchanged: true } } });
  await expect(changed.client.context(work.runId, work.checkpointClaim)).rejects.toThrow(CheckpointClaimRefused);
});

test("a claimant that did not ask for v2 refuses a stage whose cards choose", async () => {
  const reply = named(CARD_STAGE);
  for (const opts of [{ checkpointProtocol: CHECKPOINT_CLAIM_PROTOCOL }, { checkpointProtocol: CHECKPOINT_CLAIM_PROTOCOL, checkpointOnly: true }] as const)
    await expect(board(reply).client.claim(opts)).rejects.toThrow("Checkpoint claim refused: unrequested");
  await expect(board(reply).client.claim()).rejects.toThrow("Checkpoint claim refused: unrequested");
});

test("old v1 claims are unchanged: same request body, same reading, with or without v2", async () => {
  const fixed = named("claimed with a checkpoint policy");
  const v1 = { checkpointProtocol: CHECKPOINT_CLAIM_PROTOCOL, checkpointOnly: true } as const;
  const old = board(fixed);
  const work = await old.client.claim(v1);
  expect(JSON.parse(old.calls[0]?.body ?? "{}")).toEqual(v1);
  const read: unknown = work?.checkpointClaim;
  expect(read).toEqual(fixed.checkpointClaim);
  expect(work?.checkpointClaim?.selection).toBeUndefined();
  // A v2 claimant still reads a fixed stage the board offers it.
  const readByV2: unknown = (await board(fixed).client.claim(v2))?.checkpointClaim;
  expect(readByV2).toEqual(fixed.checkpointClaim);
  // A selection on a fixed stage's claim is refused.
  const selected = { ...fixed, checkpointClaim: { ...fixed.checkpointClaim, selection: named(CARD_STAGE).checkpointClaim.selection } };
  await expect(board(selected).client.claim(v2)).rejects.toThrow(CheckpointClaimRefused);
});

const tamper: Array<[string, (reply: Reply) => void]> = [
  ["the claim carries no selection", (r) => { delete r.checkpointClaim.selection; }],
  ["the selection's stage digest is not the stage policy's", (r) => { if (r.checkpointClaim.selection) r.checkpointClaim.selection.stagePolicyDigest = "0".repeat(64); }],
  ["the claim's policy is the whole allowlist", (r) => {
    r.checkpointClaim.policy.repositories = r.stage.cardCheckpointPolicy.repositories;
    r.checkpointClaim.policyDigest = canonicalSha256(r.checkpointClaim.policy);
  }],
  ["the selection names another start", (r) => { if (r.checkpointClaim.selection) r.checkpointClaim.selection.checkpointRepository = "api"; }],
  ["the stage has both policies", (r) => { r.stage.checkpointPolicy = r.checkpointClaim.policy; }],
  ["the stage's allowlist lost a chosen repository", (r) => {
    r.stage.cardCheckpointPolicy.repositories = r.stage.cardCheckpointPolicy.repositories.filter((x) => x.name !== "api");
  }],
];
for (const [why, mutate] of tamper) {
  test(`refused: ${why}`, async () => {
    const reply = named(CARD_STAGE);
    mutate(reply);
    await expect(board(reply).client.claim(v2)).rejects.toThrow(CheckpointClaimRefused);
  });
}

test("checkpointProtocols is exactly [v1, v2], or the claim is refused before any request", async () => {
  const wrong: unknown[] = [[CHECKPOINT_CLAIM_PROTOCOL], [CHECKPOINT_CLAIM_PROTOCOL_V2, CHECKPOINT_CLAIM_PROTOCOL], []];
  for (const protocols of wrong) {
    const { calls, client } = board(named(CARD_STAGE));
    // As a caller outside the type system would send it.
    const opts: Parameters<typeof client.claim>[0] = JSON.parse(JSON.stringify({ checkpointProtocol: CHECKPOINT_CLAIM_PROTOCOL, checkpointProtocols: protocols }));
    await expect(client.claim(opts)).rejects.toThrow("unsupported");
    expect(calls).toEqual([]);
  }
  const { calls, client } = board(named(CARD_STAGE));
  await expect(client.claim({ checkpointProtocols: CARD_CHOICE_CHECKPOINT_PROTOCOLS })).rejects.toThrow("unsupported");
  expect(calls).toEqual([]);
});

test("a pending claim's selection must name exactly its policy's repositories and start", () => {
  const claim = named(CARD_STAGE).checkpointClaim;
  if (!claim.selection) throw new Error("treaty's case has no selection");
  const parsed: unknown = parsePendingCheckpointClaim(claim).selection;
  expect(parsed).toEqual(claim.selection);
  expect(() => parsePendingCheckpointClaim({ ...claim, selection: { ...claim.selection, repositories: ["app"] } })).toThrow("policy");
  expect(() => parsePendingCheckpointClaim({ ...claim, selection: { ...claim.selection, checkpointRepository: "api" } })).toThrow("policy");
});
