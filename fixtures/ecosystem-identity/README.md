# Ecosystem identity — shared fixture corpus

Three products need the same identifiers to mean the same thing across a Bun/Postgres hub
(AgentPod), a Cloudflare Workers/D1 board (superpipeline), and eventually a Rust client. No auth
or contract *library* can be shared across those runtimes, and a published npm package would
couple two deploy pipelines with very different cadences — superpipeline deploys on every merge to
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
| `run_join_key.json` | The run join key: *superpipeline mints the work run; AgentPod executes it; no competing run id for dispatched work.* |
| `matrix_gate_events.json` | The two events a superpipeline approval gate crosses Matrix on: the gate the board asks, and the decision a human sends back. Pins the v1 option ids against superpipeline's `GateDecision`, and records the four fields superpipeline#34 proposed that do not exist. Since version 3 it also pins gate.v2 and decision.v2 (charter `decisions/2026-11-07-gate-v2-is-the-decision-envelope.md`): options as the gate offers them, a subject-bound gate's subject and preview, and the answer's subject binding. The hub validates them in `apps/hub/src/services/board-chat/gates.test.ts`. Since version 4 it also pins question.v2, question.answer.v2, delivery.v2 and delivery.answer.v2 (charter: the decision envelope covers questions and follow-ups): a question's options with their meaning and input, free text, the follow-up a manual delivery owes, and gate.outcome.v1, the receipt that closes a gate's or a follow-up's card. The hub validates them in `question.test.ts` and `delivery.test.ts` beside it. Since version 5 (charter: strict decisions and harness permissions bind their subject) it also pins a subject-bound question.v2 and its answer (entries with `variant: "subject-bound"`: the subject, option `scope` / `requires`, the answer's binding), and AgentPod's own `dev.agentpod.permission.v2`, `dev.agentpod.permission.answer.v2` and `dev.agentpod.permission.outcome.v1`. The hub validates them in `question-subject.test.ts` and `permission-v2.test.ts`. Since version 6 (charter: waiting cards and broker approvals reach chat) it also pins `dev.superpipeline.attention.v2` (a card waiting on a person: its wait id, reason and the resume / archive options), `dev.superpipeline.attention.answer.v2` and `dev.superpipeline.attention.outcome.v1`, and a SuperToolkit approval request as a board-less, `stk-capability/v1` subject-bound question.v2 and its answer (entries with `variant: "approval-request"`). The hub validates them in `attention.test.ts` and `approval-request.test.ts`. Since version 7 (charter: unanswered decisions remind, then escalate) it also pins `deadline { remind_at?, escalate_at? }` on gate.v2, question.v2, delivery.v2 and attention.v2 (entries with `variant: "deadline"`), a gate closed as `expired` (`gate.outcome.v1`, `variant: "expired"`), and the two notices posted in reply to a waiting card, `dev.superpipeline.decision.reminded.v1` and `dev.superpipeline.decision.escalated.v1`. The hub validates them in `decision-timeout-wire.test.ts`. Since version 8 (charter: a gate may offer a choice of variants) it also pins a variant gate (entries with `variant: "choice"`): its gate.v2 carrying `subject { variants: [{ id, label, subject }] }` with no identity of its own, each variant bounded and withheld on its own, its v1 fallback that offers no approval, the decision.v2 whose binding is the variant chosen, and the receipt naming it (`chosen_variant`). The hub validates them in `gate-variants.test.ts`. Since version 9 (charter: a gate may need more than one approver) it also pins a quorum gate (entries with `variant: "quorum"`): its gate.v2 carrying `quorum { required, from, approvals: [{ principal_id, at, variant_id? }] }` beside the options, the quorums that must not be carried, `dev.agentpod.gate.progress.v2` (the progress posted for an approval short of the quorum), and the decision.v2 with the two board refusals of a quorum approval (`QUORUM_ALREADY_APPROVED`, `APPROVAL_DECIDER_NOT_ALLOWED`) and what is said for each. The hub validates them in `gate-quorum.test.ts`. Since version 10 (charter: an approval may wait for its release time) it also pins a held gate (entries with `variant: "release"`): its gate.v2 carrying `release { hold_for_minutes?, not_before? }` and the releases that must not be carried, the held approval's `gate.outcome.v1` with `held_until`, `dev.agentpod.decision.released.v2` (released and blocked) and `dev.agentpod.decision.pulled_back.v2` posted in reply to the gate's card, `dev.superpipeline.gate.pull_back.v2` (the pull-back a person sends, and one refused without a comment) with the board's refusals of it, and the decision.v2 refusal `APPROVAL_RELEASE_AFTER_EXPIRY`, each with what is said. The hub validates them in `gate-release.test.ts`. Since version 11 (charter: a gate may be decided by checks) it also pins a gate decided by checks (entries with `variant: "checks"`): its gate.v2 carrying `checks [{ name, provider, status, url? }]` and the lists that must not be carried, `dev.agentpod.check.failed.v2` (returned, and parked replying to the open checks.waiting card) and `dev.agentpod.check.overridden.v2` with what is said for each, the reminder (standalone) and escalation of overdue checks (`decision_kind: "checks"`), `dev.agentpod.checks.waiting.v2` (the card an escalation posts, which an override references), and `dev.superpipeline.check.override.v2` (the override a person sends, and one refused without a comment) with the board's refusals of it and what is said. The hub validates them in `gate-checks.test.ts`. |
| `card_prompt.json` | The prompt contract: what a card becomes when it is handed to a harness, assembled from the card, the previous stage's handoff, the card's references and (since `card-prompt/4`) its comment thread. Pins the **rendered text**, not only the shape. |
| `token_claims.json` | The access-token claims every product verifies — **v8**, the organization plane's shape (`org`, `ent`, `jti`; `aud` a string or an array; no `tenant`). Pinned by `packages/contract/src/token-claims.ts`. AgentPod's hub keeps minting the v7 shape until its issuer is removed; that copy is frozen at `apps/hub/src/auth/testdata/token_claims.v7.json`. |

All of them are plain JSON and depend on no type from any repo. That is deliberate — a corpus that
needed AgentPod's schemas to be readable could not be checked into superpipeline.

## The negative cases are the point

A corpus of only-valid examples proves almost nothing. The `mem_` vs `mbr_` drift in superpipeline
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

`run` is the worked example. superpipeline mints `run_<16 hex>` for a work run and has production
data; AgentPod had reserved the same prefix for `acp_runs.id` in a schema comment that sat six
lines above another comment promising it never minted a rival id. AgentPod moved to `attempt_`
on 2026-08-14 — it is the executor, not the minter, and had never written an `acp_runs` row.
The superpipeline-side change is nil: the corpus asks superpipeline to keep minting exactly what it
already mints.

## How superpipeline (or any peer) consumes it

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
