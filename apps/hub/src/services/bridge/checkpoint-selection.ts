/**
 * A stage whose cards choose their repositories (treaty v0.0.16, proposed): the stage policy is
 * `run-checkpoint-policy.v2` (`StageDef.cardCheckpointPolicy`), an allowlist a card narrows, and a
 * claim freezes the choice as `run-checkpoint-selection.v1` beside the **narrowed** v1 policy it
 * carries. Settlement, references and receipts compare with that narrowed policy, so their shapes
 * are unchanged.
 *
 * SuperPipeline narrows at claim; the hub never trusts that. It recomputes the narrowing from the
 * stage policy and the claim's selection, and refuses any difference in digest, order or
 * membership (`verifyCheckpointSelection`). The rules are treaty's, and its vectors in
 * `fixtures/superpipeline-run-checkpoint/selection.json` run through `narrowCheckpointPolicy`.
 *
 * Narrowing keeps the allowlist's order and every field but `repositories` and
 * `checkpointRepository`. The start repository is the card's `primaryRepository`; otherwise the
 * stage's `checkpointRepository` when chosen; otherwise the only one chosen; otherwise refused. A
 * card that names none gets the stage default, or the allowlist when it has one repository;
 * otherwise it waits for a person. It never gets the whole allowlist by default.
 */
import { z } from "zod";
import {
  bounded, canonical, canonicalSha256, CheckpointClaimRefused, distinctExecutors, policyFields, policySchema,
  repositoryName, sortedNames, type CheckpointPolicy,
} from "./checkpoint-policy";

export const CHECKPOINT_CLAIM_PROTOCOL_V2 = "superpipeline.checkpoint-claim.v2";
export const CHECKPOINT_SELECTION_VERSION = "superpipeline.checkpoint-selection.v1";

const names = z.array(repositoryName).min(1).max(32);
/** Structural `run-checkpoint-policy.v2`. The relations JSON Schema cannot state are `cardPolicyRefusal`. */
const cardPolicyShape = z.object({
  version: z.literal("superpipeline.checkpoint-policy.v2"),
  repositorySelection: z.literal("card"),
  ...policyFields,
  defaultRepositories: names.optional(),
}).strict();
export type CardCheckpointPolicy = z.infer<typeof cardPolicyShape>;

export const checkpointSelectionSchema = z.object({
  version: z.literal(CHECKPOINT_SELECTION_VERSION),
  stagePolicyDigest: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/),
  source: z.enum(["card", "default", "single"]),
  repositories: names,
  checkpointRepository: repositoryName,
}).strict();
export type CheckpointSelection = z.infer<typeof checkpointSelectionSchema>;

/** A card's choice (`card-repositories.v1`): names only. Absent `repositories`: the card names none. */
export interface CardRepositoryChoice { repositories?: readonly string[]; primaryRepository?: string }

/** Why a v2 stage policy is not one (treaty's `policyRelations` names, plus the hub's executor rule). */
export type CardPolicyRefusal = "policy" | "repositories-not-canonical" | "checkpoint-repository-not-allowed" |
  "default-not-canonical" | "default-not-allowed" | "default-without-start" | "executors-not-distinct";
/** Why a card's choice does not narrow a stage (treaty's `narrowing` refusal names). */
export type NarrowingRefusal = "needs-person" | "repository-not-allowed" | "primary-not-chosen" | "no-primary" |
  "repositories-not-canonical";

/** The structurally valid v2 policy, or why it is not one. */
export function parseCardCheckpointPolicy(value: unknown): { policy: CardCheckpointPolicy } | { refuse: CardPolicyRefusal } {
  try { bounded(value); } catch { return { refuse: "policy" }; }
  const parsed = cardPolicyShape.safeParse(value);
  if (!parsed.success) return { refuse: "policy" };
  const policy = parsed.data;
  const allowed = policy.repositories.map((r) => r.name);
  if (!sortedNames(allowed)) return { refuse: "repositories-not-canonical" };
  if (!allowed.includes(policy.checkpointRepository)) return { refuse: "checkpoint-repository-not-allowed" };
  const defaults = policy.defaultRepositories;
  if (defaults) {
    if (!sortedNames(defaults)) return { refuse: "default-not-canonical" };
    if (!defaults.every((d) => allowed.includes(d))) return { refuse: "default-not-allowed" };
    if (defaults.length !== 1 && !defaults.includes(policy.checkpointRepository)) return { refuse: "default-without-start" };
  }
  if (!distinctExecutors(policy.executors)) return { refuse: "executors-not-distinct" };
  return { policy };
}

export interface NarrowedCheckpointPolicy {
  policy: CheckpointPolicy;
  policyDigest: string;
  /** Present only for a stage whose cards choose. */
  selection?: CheckpointSelection;
}

function narrowed(stage: CardCheckpointPolicy, chosen: readonly string[], start: string,
  source: CheckpointSelection["source"]): NarrowedCheckpointPolicy {
  const policy = policySchema.parse({ version: "superpipeline.checkpoint-policy.v1", kind: stage.kind,
    allowUnchanged: stage.allowUnchanged, repositories: stage.repositories.filter((r) => chosen.includes(r.name)),
    checkpointRepository: start, reporterPrincipalId: stage.reporterPrincipalId, nodeId: stage.nodeId,
    executors: stage.executors });
  return { policy, policyDigest: canonicalSha256(policy), selection: { version: CHECKPOINT_SELECTION_VERSION,
    stagePolicyDigest: canonicalSha256(stage), source, repositories: [...chosen], checkpointRepository: start } };
}

/**
 * The policy a claim of this card on this stage carries: the stage's own for a v1 policy (a fixed
 * stage ignores the card), or the narrowing of a v2 allowlist with its frozen selection.
 */
export function narrowCheckpointPolicy(stage: unknown, card: CardRepositoryChoice):
  NarrowedCheckpointPolicy | { refuse: CardPolicyRefusal | NarrowingRefusal } {
  const fixed = policySchema.safeParse(stage);
  if (fixed.success) {
    try { bounded(stage); } catch { return { refuse: "policy" }; }
    return { policy: fixed.data, policyDigest: canonicalSha256(fixed.data) };
  }
  const parsed = parseCardCheckpointPolicy(stage);
  if ("refuse" in parsed) return parsed;
  const policy = parsed.policy;
  const allowed = policy.repositories.map((r) => r.name);
  if (card.repositories === undefined) {
    if (card.primaryRepository !== undefined) return { refuse: "primary-not-chosen" };
    if (policy.defaultRepositories) {
      const defaults = policy.defaultRepositories;
      const start = defaults.includes(policy.checkpointRepository) ? policy.checkpointRepository : defaults[0];
      return start === undefined ? { refuse: "needs-person" } : narrowed(policy, defaults, start, "default");
    }
    const only = allowed.length === 1 ? allowed[0] : undefined;
    return only === undefined ? { refuse: "needs-person" } : narrowed(policy, [only], only, "single");
  }
  const chosen = card.repositories;
  if (chosen.length === 0 || chosen.length > 32 || !sortedNames(chosen)) return { refuse: "repositories-not-canonical" };
  if (!chosen.every((name) => allowed.includes(name))) return { refuse: "repository-not-allowed" };
  let start: string | undefined;
  if (card.primaryRepository !== undefined) {
    if (!chosen.includes(card.primaryRepository)) return { refuse: "primary-not-chosen" };
    start = card.primaryRepository;
  } else if (chosen.includes(policy.checkpointRepository)) start = policy.checkpointRepository;
  else if (chosen.length === 1) start = chosen[0];
  if (start === undefined) return { refuse: "no-primary" };
  return narrowed(policy, chosen, start, "card");
}

/** A claim's own selection agrees with the narrowed policy it carries: same names, same start. */
export function selectionMatchesPolicy(selection: CheckpointSelection, policy: CheckpointPolicy): boolean {
  return canonical(selection.repositories) === canonical(policy.repositories.map((r) => r.name)) &&
    selection.checkpointRepository === policy.checkpointRepository;
}

/**
 * Recompute a claim's narrowing from the stage's `cardCheckpointPolicy` and its frozen selection,
 * and refuse any difference: the stage policy's digest, the selection itself (order, membership,
 * source, start), the narrowed policy and its digest. A `card` selection is re-narrowed as the card
 * naming exactly those repositories with that start; `default` and `single` as the card naming none.
 */
export function verifyCheckpointSelection(stage: unknown,
  claim: { policy: unknown; policyDigest: unknown; selection?: unknown }): void {
  const parsed = checkpointSelectionSchema.safeParse(claim.selection);
  if (!parsed.success) throw new CheckpointClaimRefused("policy");
  const selection = parsed.data;
  const choice: CardRepositoryChoice = selection.source === "card"
    ? { repositories: selection.repositories, primaryRepository: selection.checkpointRepository } : {};
  const expected = narrowCheckpointPolicy(stage, choice);
  if ("refuse" in expected || !expected.selection || canonical(expected.selection) !== canonical(selection) ||
    canonical(expected.policy) !== canonical(claim.policy) || expected.policyDigest !== claim.policyDigest)
    throw new CheckpointClaimRefused("policy");
}
