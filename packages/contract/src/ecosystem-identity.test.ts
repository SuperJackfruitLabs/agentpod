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
  NodeId,
  RuntimeId,
  EnrollmentTokenId,
  StationId,
  AcpSessionId,
  UserId,
} from "./ids";
import { Run, RunState, TERMINAL_RUN_STATES, INTERRUPTED_RUN_STATES } from "./run";

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
  "agentpod.node": NodeId,
  "agentpod.runtime": RuntimeId,
  "agentpod.enrollmentToken": EnrollmentTokenId,
  "agentpod.station": StationId,
  "agentpod.acpSession": AcpSessionId,
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
  test("no prefix is claimed by two owners except the recorded conflicts", () => {
    const byPrefix = new Map<string, Set<string>>();
    for (const c of grammar.prefixRegistry.claims) {
      byPrefix.set(c.prefix, (byPrefix.get(c.prefix) ?? new Set()).add(c.owner));
    }
    const contested = [...byPrefix.entries()]
      .filter(([, owners]) => owners.size > 1)
      .map(([prefix]) => prefix)
      .sort();
    const known = grammar.prefixRegistry.knownConflicts.map((c) => c.prefix).sort();

    // A NEW collision must fail here. `run` is already recorded: kaambaan mints
    // it, and AgentPod reserves it for acp_runs.id in a schema comment two lines
    // above "We never mint a rival id". Nothing mints AgentPod's yet, so nothing
    // is broken — but the day one does, a bare `run_…` stops saying which system
    // produced it.
    expect(contested).toEqual(known);
  });

  test("`run` is a known, unresolved conflict rather than a resolved one", () => {
    const conflict = grammar.prefixRegistry.knownConflicts.find((c) => c.prefix === "run");
    expect(conflict?.claimedBy.sort()).toEqual(["agentpod", "kaambaan"]);
  });
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
  test("records that nothing enforces the invariant yet", () => {
    // Honest bookkeeping. `acp_runs.external_run_id` and `Run.externalRunId`
    // exist and are indexed, but nothing inserts into acp_runs, no route accepts
    // an external run id, and the bridge spike correlates a kaambaan run to an
    // AgentPod session in a console.log line and nowhere else. When a write path
    // lands, this string changes and this test is the reminder to change it.
    expect(joinKey.enforcement.status).toBe("carried-in-schema-only");
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
