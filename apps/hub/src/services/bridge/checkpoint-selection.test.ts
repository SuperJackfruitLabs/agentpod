/**
 * Per-card repositories against treaty's own vectors (treaty v0.0.16,
 * `fixtures/superpipeline-run-checkpoint/selection.json`, read from the pinned
 * `@superjackfruitlabs/treaty-contracts`): every narrowing vector, every policy relation and the
 * structural cases of the v2 policy and the selection, through the hub's code. Then the hub's own
 * re-check of a claim's selection, which refuses any difference in digest, order or membership.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkpointPolicyDigest } from "./checkpoint-claim";
import { canonicalSha256 } from "./checkpoint-policy";
import { checkpointSelectionSchema, narrowCheckpointPolicy, parseCardCheckpointPolicy, verifyCheckpointSelection } from "./checkpoint-selection";

interface Stage { repositories: Array<{ name: string; provider: string; repository: string }>; [field: string]: unknown }
interface Expected { policy: Record<string, unknown>; policyDigest: string; selection?: Record<string, unknown> }
interface Narrowing {
  name: string; stage: string; card: { repositories?: string[]; primaryRepository?: string };
  expect?: Expected; refuse?: string;
}
interface Cases { accept: Array<{ name: string; body: unknown }>; reject: Array<{ name: string; body: unknown }> }
interface Vectors {
  stages: Record<string, Stage>;
  narrowing: Narrowing[];
  policyRelations: Array<{ name: string; policy: unknown; refuse: string }>;
  structural: { policy: Cases; selection: Cases };
}
const vectors: Vectors = JSON.parse(readFileSync(Bun.resolveSync(
  "@superjackfruitlabs/treaty-contracts/data/fixtures/superpipeline-run-checkpoint/selection.json", import.meta.dir), "utf8"));
function stage(name: string): Stage {
  const found = vectors.stages[name];
  if (!found) throw new Error(`treaty has no stage "${name}"`);
  return found;
}
const REFUSED = "Checkpoint claim refused: policy";

describe("treaty's narrowing vectors", () => {
  test("all thirteen are here", () => expect(vectors.narrowing).toHaveLength(13));

  for (const v of vectors.narrowing) {
    test(v.name, () => {
      const got: unknown = narrowCheckpointPolicy(stage(v.stage), v.card);
      const want = v.refuse === undefined
        ? { policy: v.expect?.policy, policyDigest: v.expect?.policyDigest, ...(v.expect?.selection ? { selection: v.expect.selection } : {}) }
        : { refuse: v.refuse };
      expect(got).toEqual(want);
    });
  }

  test("the claim reader's digest of each narrowed policy is the vector's", () => {
    for (const v of vectors.narrowing.filter((n) => n.expect))
      expect(checkpointPolicyDigest(v.expect?.policy)).toBe(v.expect?.policyDigest ?? "");
  });
});

describe("treaty's policy relations", () => {
  for (const v of vectors.policyRelations) {
    test(v.name, () => {
      const parsed: unknown = parseCardCheckpointPolicy(v.policy);
      const narrowed: unknown = narrowCheckpointPolicy(v.policy, {});
      expect(parsed).toEqual({ refuse: v.refuse });
      expect(narrowed).toEqual({ refuse: v.refuse });
    });
  }
});

describe("treaty's structural cases", () => {
  for (const c of vectors.structural.policy.accept)
    test(`policy accepts: ${c.name}`, () => expect("policy" in parseCardCheckpointPolicy(c.body)).toBe(true));
  for (const c of vectors.structural.policy.reject)
    test(`policy rejects: ${c.name}`, () => expect("refuse" in parseCardCheckpointPolicy(c.body)).toBe(true));
  for (const c of vectors.structural.selection.accept)
    test(`selection accepts: ${c.name}`, () => expect(checkpointSelectionSchema.safeParse(c.body).success).toBe(true));
  for (const c of vectors.structural.selection.reject)
    test(`selection rejects: ${c.name}`, () => expect(checkpointSelectionSchema.safeParse(c.body).success).toBe(false));
});

const accepted = vectors.narrowing.filter((v) => v.expect?.selection);
const base = vectors.narrowing.find((v) => v.name === "card-chooses-a-subset")?.expect;
if (!base?.selection) throw new Error("vector card-chooses-a-subset is missing");
const good = base;
const chooses = stage("chooses");
type Claim = { policy: Record<string, unknown>; policyDigest: string; selection?: Record<string, unknown> };
const claimOf = (e: Expected): Claim => structuredClone({ policy: e.policy, policyDigest: e.policyDigest, selection: e.selection });

const mutations: Array<[string, (c: Claim) => void, Stage?]> = [
  ["the stage policy digest is another stage's", (c) => { if (c.selection) c.selection.stagePolicyDigest = "0".repeat(64); }],
  ["the stage changed after the claim (the allowlist grew)", () => {},
    { ...chooses, repositories: [...chooses.repositories, { name: "web", provider: "forge", repository: "example/web" }] }],
  ["the stage changed after the claim (it lost a chosen repository)", () => {},
    { ...chooses, repositories: chooses.repositories.filter((r) => r.name !== "api") }],
  ["the narrowed policy's digest is not its own", (c) => { c.policyDigest = "f".repeat(64); }],
  ["the selection is out of order", (c) => { if (c.selection) c.selection.repositories = ["app", "api"]; }],
  ["the policy holds a repository the selection does not", (c) => { if (c.selection) c.selection.repositories = ["app"]; }],
  // The selection still names two. (A selection that also named all three would be a different,
  // valid claim: treaty's card-chooses-the-whole-allowlist-explicitly.)
  ["the policy is the whole allowlist, not the narrowing", (c) => {
    c.policy = { ...c.policy, repositories: chooses.repositories };
    c.policyDigest = canonicalSha256(c.policy);
  }],
  ["the selection names a repository outside the allowlist", (c) => { if (c.selection) c.selection.repositories = ["api", "mobile"]; }],
  ["the source claims a default the stage does not have", (c) => { if (c.selection) c.selection.source = "default"; }],
  ["the start repository is not the policy's", (c) => { if (c.selection) c.selection.checkpointRepository = "api"; }],
  ["there is no selection", (c) => { delete c.selection; }],
];

describe("the hub re-checks a claim's selection against the stage policy", () => {
  test("every vector's claim is accepted as treaty narrowed it", () => {
    expect(accepted.length).toBe(7);
    for (const v of accepted) {
      const e = v.expect;
      if (!e) throw new Error("unreachable");
      expect(() => verifyCheckpointSelection(stage(v.stage), claimOf(e))).not.toThrow();
      expect(e.selection?.stagePolicyDigest).toBe(canonicalSha256(stage(v.stage)));
    }
  });

  for (const [why, mutate, stagePolicy] of mutations) {
    test(`refused: ${why}`, () => {
      const claim = claimOf(good);
      mutate(claim);
      expect(() => verifyCheckpointSelection(stagePolicy ?? chooses, claim)).toThrow(REFUSED);
    });
  }

  test("a fixed stage's policy is never a narrowing", () => {
    expect(() => verifyCheckpointSelection(stage("fixed"), claimOf(good))).toThrow(REFUSED);
  });
});
