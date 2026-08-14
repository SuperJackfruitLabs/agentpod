/**
 * AgentPod's half of the shared ecosystem-identity fixture corpus.
 *
 * The corpus lives at `fixtures/ecosystem-identity/` — plain JSON, depending on
 * no type from any repo, so kaambaan can check in the *same files* and write the
 * equivalent test in its own runtime. See that directory's README.
 *
 * Why a fixture corpus rather than a shared package: a published package would
 * couple two deploy pipelines with very different cadences. This repo already
 * keeps five hand-written Go mirrors honest the same way
 * (apps/node-agent/internal/contractfix), which is the evidence the approach is
 * enough.
 *
 * The negative cases are the point. kaambaan's `mem_`/`mbr_` drift survived
 * because nothing ever validated a minted id against the schema — and a corpus
 * of only-valid examples would have missed it too, because `mem_abc123` is a
 * perfectly well-formed id of an entity that does not exist.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod";

import {
  KaambaanTenantId,
  KaambaanUserId,
  KaambaanMembershipId,
  KaambaanAgentId,
  KaambaanRunId,
  TenantId,
  NodeId,
  RuntimeId,
  EnrollmentTokenId,
  StationId,
  AcpSessionId,
  AcpRunId,
  UserId,
} from "./ids";
import { Run, RunState, TERMINAL_RUN_STATES, INTERRUPTED_RUN_STATES } from "./run";
import { CARD_PROMPT_VERSION, CardPrompt, renderCardPrompt } from "./card-prompt";

const CORPUS_DIR = join(import.meta.dir, "../../../fixtures/ecosystem-identity");

const readCorpus = <T>(file: string): T =>
  JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8")) as T;

// ─── id_grammar.json ─────────────────────────────────────────────────────────

type IdCase = { value: string; mint?: boolean; note?: string };
type RejectCase = { value: string; reason: string; note?: string };
type Entity = {
  entity: string;
  owner: string;
  prefix: string | null;
  grammar: string;
  mintedAs: string;
  accept: IdCase[];
  reject: RejectCase[];
};
type IdGrammar = {
  entities: Entity[];
  prefixRegistry: {
    claims: Array<{ prefix: string; owner: string; entity: string; status: string }>;
    knownConflicts: Array<{ prefix: string; claimedBy: string[] }>;
    resolvedConflicts: Array<{
      prefix: string;
      wasClaimedBy: string[];
      nowClaimedBy: string;
      resolution: string;
    }>;
  };
};

const grammar = readCorpus<IdGrammar>("id_grammar.json");

/**
 * Corpus entity name → the AgentPod validator that must satisfy it.
 *
 * Every entity in the corpus must appear here or in SKIPPED. An unmapped entity
 * fails the coverage test below, so adding one to the corpus cannot silently go
 * untested — which is the failure mode the corpus exists to prevent.
 */
const VALIDATORS: Record<string, ZodType> = {
  // kaambaan-owned. AgentPod consumes these across the seam and must be neither
  // stricter nor looser than the minter's own declared contract.
  "kaambaan.tenant": KaambaanTenantId,
  "kaambaan.user": KaambaanUserId,
  "kaambaan.membership": KaambaanMembershipId,
  "kaambaan.agent": KaambaanAgentId,
  "kaambaan.run": KaambaanRunId,

  // AgentPod-owned. AgentPod is the only minter, so these are pinned to exactly
  // what the mint sites produce.
  "agentpod.tenant": TenantId,
  "agentpod.node": NodeId,
  "agentpod.runtime": RuntimeId,
  "agentpod.enrollmentToken": EnrollmentTokenId,
  "agentpod.station": StationId,
  "agentpod.acpSession": AcpSessionId,
  "agentpod.acpRun": AcpRunId,
  "agentpod.user": UserId,
};

/** Entities AgentPod deliberately has no validator for. Empty, and a decision each time. */
const SKIPPED: readonly string[] = [];

describe("ecosystem identity corpus — coverage", () => {
  test("every corpus entity is either validated or explicitly skipped", () => {
    const unmapped = grammar.entities
      .map((e) => e.entity)
      .filter((name) => !(name in VALIDATORS) && !SKIPPED.includes(name));

    // A new entity landing in the corpus with no validator is silent coverage
    // loss — exactly how `mem_`/`mbr_` stayed wrong. Map it or skip it on purpose.
    expect(unmapped).toEqual([]);
  });

  test("the corpus is not empty and covers both repos", () => {
    const owners = new Set(grammar.entities.map((e) => e.owner));
    expect(owners).toEqual(new Set(["kaambaan", "agentpod"]));
  });
});

describe("ecosystem identity corpus — id grammar", () => {
  for (const entity of grammar.entities) {
    const schema = VALIDATORS[entity.entity];
    if (!schema) continue;

    describe(entity.entity, () => {
      test("accepts every id the corpus says it must", () => {
        for (const c of entity.accept) {
          expect(
            { value: c.value, accepted: schema.safeParse(c.value).success },
            // Rejecting a peer's legitimate id is as much a break as accepting a
            // bad one: it makes the seam unusable in one direction.
            `${entity.entity} must accept ${JSON.stringify(c.value)}${c.note ? ` — ${c.note}` : ""}`,
          ).toEqual({ value: c.value, accepted: true });
        }
      });

      test("rejects every id the corpus says it must", () => {
        for (const c of entity.reject) {
          expect(
            { value: c.value, accepted: schema.safeParse(c.value).success },
            `${entity.entity} must reject ${JSON.stringify(c.value)} (${c.reason})${c.note ? ` — ${c.note}` : ""}`,
          ).toEqual({ value: c.value, accepted: false });
        }
      });

      test("the corpus carries negative cases at all", () => {
        // A valid-examples-only entry would pass every test above while proving
        // nothing. Guard the guard.
        expect(entity.accept.length).toBeGreaterThan(0);
        expect(entity.reject.length).toBeGreaterThan(0);
      });

      test("every canonical mint value satisfies the declared mint grammar", () => {
        // Keeps `mintedAs` honest against the example values, so the recorded
        // shape cannot drift from the recorded evidence.
        const mintRe = new RegExp(entity.mintedAs);
        for (const c of entity.accept.filter((x) => x.mint)) {
          expect(mintRe.test(c.value), `${c.value} must match ${entity.mintedAs}`).toBe(true);
        }
      });
    });
  }
});

describe("ecosystem identity corpus — prefix registry", () => {
  const contestedPrefixes = (): string[] => {
    const byPrefix = new Map<string, Set<string>>();
    for (const c of grammar.prefixRegistry.claims) {
      byPrefix.set(c.prefix, (byPrefix.get(c.prefix) ?? new Set()).add(c.owner));
    }
    return [...byPrefix.entries()]
      .filter(([, owners]) => owners.size > 1)
      .map(([prefix]) => prefix)
      .sort();
  };

  test("no prefix is claimed by two owners except the recorded conflicts", () => {
    const known = grammar.prefixRegistry.knownConflicts.map((c) => c.prefix).sort();

    // A NEW collision must fail here, and `knownConflicts` is now empty — so any
    // second owner appearing against any prefix fails this test outright. This
    // is the guard that catches `run_` coming back: re-pointing acp_runs.id at
    // `run` means re-adding an agentpod claim on a prefix kaambaan already owns.
    expect(contestedPrefixes()).toEqual(known);
  });

  test("`run` is resolved: kaambaan alone claims it", () => {
    // Was a knownConflict. AgentPod's acp_runs.id moved to `attempt_` — an id
    // space kaambaan does not claim — so the prefix has exactly one owner again.
    expect(grammar.prefixRegistry.knownConflicts.map((c) => c.prefix)).not.toContain("run");

    const owners = grammar.prefixRegistry.claims
      .filter((c) => c.prefix === "run")
      .map((c) => c.owner);
    expect(owners).toEqual(["kaambaan"]);
  });

  test("a resolved conflict is resolved in the claims, not merely declared resolved", () => {
    // Moving an entry from knownConflicts to resolvedConflicts without actually
    // giving up the claim would be exactly the kind of paper fix this corpus is
    // meant to catch. Every resolved prefix must now have one owner, and that
    // owner must be the one the resolution names.
    for (const r of grammar.prefixRegistry.resolvedConflicts) {
      const owners = [
        ...new Set(
          grammar.prefixRegistry.claims.filter((c) => c.prefix === r.prefix).map((c) => c.owner),
        ),
      ];
      expect(owners, `${r.prefix} must have exactly one owner after resolution`).toEqual([
        r.nowClaimedBy,
      ]);
      expect(contestedPrefixes()).not.toContain(r.prefix);
    }
  });

  test("AgentPod's acp run prefix collides with nothing either repo claims", () => {
    const acpRun = grammar.entities.find((e) => e.entity === "agentpod.acpRun")!;
    const others = grammar.prefixRegistry.claims.filter(
      (c) => c.prefix === acpRun.prefix && c.entity !== "acpRun",
    );
    expect(others).toEqual([]);
  });
});

describe("ecosystem identity corpus — id spaces are mutually exclusive", () => {
  // The general form of the `run_` collision. A comment saying "we never mint a
  // rival id" did not prevent it; this does: every validator is shown every
  // other entity's canonical minted id and must reject all of them. A new
  // collision between any two entities fails here without anyone remembering to
  // write a test for it.
  for (const entity of grammar.entities) {
    const schema = VALIDATORS[entity.entity];
    if (!schema) continue;

    test(`${entity.entity} rejects every other entity's minted id`, () => {
      const foreign = grammar.entities
        .filter((e) => e.entity !== entity.entity)
        .flatMap((e) => e.accept.filter((c) => c.mint).map((c) => ({ entity: e.entity, ...c })));

      const wronglyAccepted = foreign.filter((c) => schema.safeParse(c.value).success);
      expect(
        wronglyAccepted.map((c) => `${c.entity}:${c.value}`),
        `${entity.entity}'s validator accepts an id minted for another entity`,
      ).toEqual([]);
    });
  }
});

// ─── run_join_key.json ───────────────────────────────────────────────────────

type RunCase = { name: string; mustParse: boolean; why: string; value: unknown };
type RunJoinKey = {
  invariant: string;
  enforcement: { status: string };
  cases: RunCase[];
  runStates: { all: string[]; terminal: string[]; interrupted: string[] };
};

const joinKey = readCorpus<RunJoinKey>("run_join_key.json");

describe("ecosystem identity corpus — run join key", () => {
  test("records how far enforcement has actually got", () => {
    // Honest bookkeeping. Half the invariant is now executable: the two id
    // spaces are disjoint, `Run.id` is validated against AgentPod's, and
    // acp_runs carries CHECK constraints saying the same thing in the database.
    // The other half is still absent — nothing inserts into acp_runs, no route
    // accepts an external run id, and the bridge spike correlates a kaambaan run
    // to an AgentPod session in a console.log line and nowhere else. When a
    // write path lands, this string changes and this test is the reminder.
    expect(joinKey.enforcement.status).toBe("id-spaces-disjoint-no-write-path");
  });

  for (const c of joinKey.cases) {
    test(`${c.mustParse ? "accepts" : "rejects"}: ${c.name}`, () => {
      expect(Run.safeParse(c.value).success, c.why).toBe(c.mustParse);
    });
  }

  test("the corpus carries both directions", () => {
    expect(joinKey.cases.some((c) => c.mustParse)).toBe(true);
    expect(joinKey.cases.some((c) => !c.mustParse)).toBe(true);
  });

  test("a dispatched run keeps kaambaan's id verbatim through a parse", () => {
    // The invariant in one assertion: the board's id survives, and AgentPod's own
    // `id` is a separate local key rather than a restatement of it.
    const dispatched = joinKey.cases.find((c) => c.name === "dispatched_run")!;
    const parsed = Run.parse(dispatched.value);
    expect(parsed.externalRunId).toBe("run_e074a2160c4b4f28");
    expect(parsed.externalSource).toBe("kaambaan");
    expect(parsed.id).not.toBe(parsed.externalRunId);
  });

  test("the two ids on a dispatched run are told apart by shape, not by column", () => {
    // What replaces the comment. Before the rename both fields held `run_…` and
    // only the column name said which system a value came from; a row read out
    // of context was ambiguous. Now each id parses under exactly one grammar.
    const dispatched = joinKey.cases.find((c) => c.name === "dispatched_run")!;
    const parsed = Run.parse(dispatched.value);

    expect(AcpRunId.safeParse(parsed.id).success).toBe(true);
    expect(KaambaanRunId.safeParse(parsed.id).success).toBe(false);

    expect(KaambaanRunId.safeParse(parsed.externalRunId).success).toBe(true);
    expect(AcpRunId.safeParse(parsed.externalRunId).success).toBe(false);
  });

  test("kaambaan's run id in the fixture is valid by kaambaan's own grammar", () => {
    // The cross-repo half: the value AgentPod carries must be one kaambaan would
    // have minted and would accept back.
    const dispatched = joinKey.cases.find((c) => c.name === "dispatched_run")!;
    const parsed = Run.parse(dispatched.value);
    expect(KaambaanRunId.safeParse(parsed.externalRunId).success).toBe(true);
  });

  test("RunState matches the corpus's A2A vocabulary exactly", () => {
    // Both repos adopt A2A verbatim so no translation table is needed. A rename
    // in either is a failing test in both.
    expect(RunState.options).toEqual(joinKey.runStates.all as never);
    expect([...TERMINAL_RUN_STATES]).toEqual(joinKey.runStates.terminal as never);
    expect([...INTERRUPTED_RUN_STATES]).toEqual(joinKey.runStates.interrupted as never);
  });
});

// ─── card_prompt.json ────────────────────────────────────────────────────────

type PromptCase = {
  name: string;
  mustParse: boolean;
  why: string;
  value: unknown;
  rendered?: string;
};
type CardPromptCorpus = {
  contract: string;
  invariant: string;
  renderingRules: string[];
  cases: PromptCase[];
};

const prompts = readCorpus<CardPromptCorpus>("card_prompt.json");

describe("ecosystem identity corpus — card prompt", () => {
  test("the corpus pins the version this repo renders", () => {
    // A renderer and a corpus that disagree about the version are two
    // contracts, which is the thing having a version was supposed to prevent.
    expect(prompts.contract).toBe(CARD_PROMPT_VERSION);
  });

  for (const c of prompts.cases) {
    test(`${c.mustParse ? "accepts" : "rejects"}: ${c.name}`, () => {
      expect(CardPrompt.safeParse(c.value).success, c.why).toBe(c.mustParse);
    });
  }

  for (const c of prompts.cases.filter((x) => x.rendered !== undefined)) {
    test(`renders: ${c.name}`, () => {
      // The rendered text IS the contract. A repo that assembles a card
      // differently fails here rather than in an agent's behaviour, which is
      // where the difference would otherwise surface — confidently, and late.
      expect(renderCardPrompt(CardPrompt.parse(c.value))).toBe(c.rendered!);
    });
  }

  test("every accepted case pins its rendered text", () => {
    // A shape cannot enter the corpus without saying what it reads like.
    for (const c of prompts.cases.filter((x) => x.mustParse)) {
      expect(typeof c.rendered, `${c.name} parses but pins no rendered text`).toBe("string");
    }
  });

  test("the corpus carries both directions", () => {
    expect(prompts.cases.some((c) => c.mustParse)).toBe(true);
    expect(prompts.cases.some((c) => !c.mustParse)).toBe(true);
  });

  test("no rendered prompt leaks a credential, a lease epoch or an AgentPod id", () => {
    // The prompt crosses into a harness process. Everything in this list is
    // either a secret or an id the harness cannot act on and could echo back
    // into a transcript the board then renders.
    for (const c of prompts.cases.filter((x) => x.rendered !== undefined)) {
      expect(c.rendered!).not.toContain("kbn_");
      expect(c.rendered!).not.toContain("attempt_");
      expect(c.rendered!).not.toContain("acps_");
      expect(c.rendered!.toLowerCase()).not.toContain("leaseepoch");
    }
  });
});
