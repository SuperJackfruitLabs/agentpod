# Ecosystem identity — shared fixture corpus

Three products need the same identifiers to mean the same thing across a Bun/Postgres hub
(AgentPod), a Cloudflare Workers/D1 board (kaambaan), and eventually a Rust client. No auth
or contract *library* can be shared across those runtimes, and a published npm package would
couple two deploy pipelines with very different cadences — kaambaan deploys on every merge to
main, AgentPod deploys by hand.

So: **each repo owns its own types; this corpus proves they agree.**

That is not a new bet. This repo already keeps five hand-written Go mirrors of zod schemas
honest with golden-fixture round-trip tests and no drift
(`apps/node-agent/internal/contractfix/`). This corpus is the same mechanism aimed across a
repo boundary instead of a language boundary.

## Files

| File | What it pins |
|---|---|
| `id_grammar.json` | What each repo mints and validates for every entity id, plus the full prefix registry and the collisions in it — open (`knownConflicts`) and settled (`resolvedConflicts`). |
| `run_join_key.json` | The run join key: *kaambaan mints the work run; AgentPod executes it; no competing run id for dispatched work.* |

Both are plain JSON and depend on no type from any repo. That is deliberate — a corpus that
needed AgentPod's schemas to be readable could not be checked into kaambaan.

## The negative cases are the point

A corpus of only-valid examples proves almost nothing. The `mem_` vs `mbr_` drift in kaambaan
survived for as long as both halves existed **precisely because nothing ever validated a
minted id against the schema** — and a valid-examples-only corpus would have missed it too,
since `mem_abc123` is a perfectly well-formed id of a nonexistent entity.

So every entity carries a `reject` list: wrong prefix, too short, wrong alphabet, empty,
prefix-only, unanchored prefix, and **a valid id of a different entity type** — the failure a
bare `z.string()` cannot catch and the one most likely to reach production.

## How AgentPod consumes it

`packages/contract/src/ids.ts` holds the validators; `packages/contract/src/ecosystem-identity.test.ts`
drives them from these files. It runs under the `contract` CI job with everything else:

```bash
cd packages/contract && bun test
```

The test fails if a corpus entity has no validator mapped to it, so adding an entity here
cannot silently go untested. It also shows every validator every *other* entity's canonical
minted id and requires all of them to be rejected — the general form of the `run_` collision
below, so a new one fails without anyone remembering to write a test for it.

## Resolving a collision

`prefixRegistry.knownConflicts` is for prefixes two owners genuinely both claim. It is not a
parking space: an entry there means the corpus can prove a name is ambiguous and cannot prove
which system a value came from.

When a collision is settled, the entry moves to `resolvedConflicts`, which records who gave
the claim up and what they moved to. The move is checked, not taken on trust — a resolved
prefix must have exactly one owner left in `claims`, so declaring a conflict resolved while
still claiming the prefix fails the suite.

`run` is the worked example. kaambaan mints `run_<16 hex>` for a work run and has production
data; AgentPod had reserved the same prefix for `acp_runs.id` in a schema comment that sat six
lines above another comment promising it never minted a rival id. AgentPod moved to `attempt_`
on 2026-08-14 — it is the executor, not the minter, and had never written an `acp_runs` row.
The kaambaan-side change is nil: the corpus asks kaambaan to keep minting exactly what it
already mints.

## How kaambaan (or any peer) consumes it

1. Copy `id_grammar.json` and `run_join_key.json` into the peer repo. Copy, do not symlink or
   submodule — decoupled release cadence is the whole reason this is a file corpus rather
   than a package.
2. Write the equivalent test in that repo's own language and test runner: for each entity the
   repo owns or consumes, map it to that repo's own validator and assert every `accept` value
   parses and every `reject` value does not.
3. Skip entities the repo has no validator for, but make the skip list explicit so a new
   entity is a visible decision rather than silent coverage loss.

A peer that disagrees then fails its own test suite instead of failing in production, which is
the entire mechanism.

## Changing the corpus

These files are **hand-authored from code**, not generated. Every `grammarSource` and
`mintSource` is a `file:line` that was read; if you cannot cite one, you are inventing a shape
rather than recording one, and it does not belong here.

When you change a grammar, expect both repos to fail until both are updated. That is the
corpus working. The failure is cheap; the silent disagreement it replaces is not.

## Deliberately out of scope

**Matrix event envelopes.** The Application Service does not exist, so fixtures for it would
be invented rather than observed. The seam is real and empty on both sides (supermessage's
`customEvents.ts` is a renderer registry with zero renderers, whose own comment says it *"does
not — and must not — invent those schemas"*), and this corpus takes the same position.

## Background

`docs/strategy/2026-08-13-ecosystem-identity-decisions.md` — the four decisions this serves,
and the "how two repos share one contract" question left open there that this answers.
