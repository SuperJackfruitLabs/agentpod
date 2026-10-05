# Declared Harness Configuration 3b — the node write path and the fold-in

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The four harness settings that today only existing `apn` verbs can write become declarable through the registry — producing **byte-identical** output to those verbs — and a write that loses a race preserves both edits instead of discarding one.

**Architecture:** Declared harness configuration is live: a fleet declares a setting, plans the edit, reviews its digest, applies it, and sees drift. Three Hermes `approvals.*` settings are registered. This plan adds the node-side write safety D10 decided, teaches the hub to see a harness's *own* opt-out, and folds in four settings that already have reviewed writers — by **calling those writers**, never reimplementing them.

**Tech Stack:** Go (node-agent), zod (contract), Bun/Hono/Drizzle (hub, lightly).

**Spec:** `docs/superpowers/specs/2026-10-05-declared-harness-config-phase-3-design.md`, and its parent `2026-10-04-declared-harness-config-design.md`.

**Shipped before this:** #663 (observe), #666 (apply), #667 (opt-out surface), #668 (the `Capability` enum fix that made any of it reachable), #669 (guards). `v0.1.88` is released; the fleet runs it; `configManagement` is enabled on the workspace node.

---

## Global Constraints

- **D12 — folding in delegates, and is byte-identical or it does not happen.** Each registry entry calls the same function the `apn` verb calls. It does not reimplement the edit, and it does not become the new home of the logic while the verb becomes a wrapper. Both callers stay. A fold-in whose output differs by one byte is **abandoned, not reconciled**.
- **F2 — an `additive-only` write must never remove an entry the operator already had.** Sixteen attack shapes assert this today (`configedit`'s tests). If you touch containment, re-run them and report every verdict.
- **D5 — parse to decide, edit as lines.** Comments, key order and indentation are the operator's. Nothing re-encodes a document. JSON having no comments does not make key order free.
- **D4 — nothing restarts a harness, ever.**
- **D1 — only registered settings are written**; an unregistered id is refused by name.
- **`ErrDisabledByOperator` surfaces as `opted-out`; `ErrConflict` as a refused plan.** Those meanings are `hermeslive/config.go`'s and must not change.
- **No upstream changes.** You read harness file formats; you never modify a harness.
- **No workspace-local host names or agent names** in code, tests, docs or help text. The product word is *workspace*.
- **`bun run typecheck` is KNOWN RED at exactly 15 for `src`**, and the hub's **tests** now have their own per-file baseline (`typecheck-known-red-tests.txt`, 224). Do not let either rise.
- **Every predicate test is revert-proofed.** Nine tests across this feature turned out unable to fail — one asserted a property the validator strips anyway, one passed with its predicate stubbed to nil, one passed while the code under test was actively broken, two had fixtures placing the interesting shape where the code never looked, and two passed because a correct assertion was satisfied by an entirely different code path. For every test guarding a decision here: revert the production change, watch it fail, restore it, and record what you saw.

### Structural facts, established by reading — do not re-derive

- **F5 was WRONG and is withdrawn.** The writer already lived in `internal/skills/hermes_external_dirs.go` (#533), already importable, and `internal/descriptor` already imported that package. Task 2's extraction was optional polish — it happened anyway, so the writer now lives in `internal/hermesskills` with a `hermeslive`-shaped API, but no import blocker ever existed.
- **F6 — OpenClaw's document is JSON**, written by `internal/openclawerrors/config.go`. `configedit` is a YAML line editor and does not serve it. Delegate; do not teach `configedit` a second format.
- **Delegation is cycle-free and already proven.** Neither `hermeslive` nor `openclawerrors` imports `descriptor`, and `descriptor` **already imports `hermeslive`** at `config_plan.go:10`. So importing either from `descriptor` is established practice, not a new coupling.
- **All three target writers are unexported** (`planEnableConfig`, `planDisableConfig`, openclawerrors' writers). Folding in requires exporting them — a deliberate API widening, so each export needs a doc comment saying who the second caller is and why.

### Running the suites

```bash
cd packages/contract && bun test
cd apps/node-agent && go test -race -count=1 ./...        # ALWAYS -count=1; Go caches
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test > /tmp/t.log 2>&1; echo "EXIT=$?"; grep -E "^ *[0-9]+ (pass|fail|skip)" /tmp/t.log
```

**Never pipe a long test run through `tail`/`head`** — write to a file and read the file. **If you abort a run partway, reset the test database first**, or leftover rows produce dozens of failures in unrelated files that look exactly like your bug:

```bash
docker exec agentpod-test-postgres psql -U agentpod -d postgres -c 'DROP DATABASE IF EXISTS agentpod WITH (FORCE);' -c 'CREATE DATABASE agentpod OWNER agentpod;'
```

Baselines: contract 415 / 0, hub ~3044 / 12 skip, node 29 packages ok. **Four known intermittents, none yours**, all in files byte-identical to `origin/main`: `acp-sessions.test.ts` ("a disconnected harness is re-attached"), two in `routes/evidence.test.ts`, `oauth-codes.test.ts` ("an expired code returns null"), and `harness-config-routes.test.ts` ("tries every reachable candidate"). All are broker-timeout sensitive in a shared-process suite. Run a suspected flake in isolation before chasing it.

Run `gofmt -l` on every `.go` file you touch. Note `internal/descriptor/descriptor.go` is unformatted on `main` too — not yours.

---

## Task 1: A lost race preserves both edits

**D10.** When a write succeeds and the post-write `SameOutsideKeys` check then fails, the document changed under us mid-write. Reverting would discard whatever arrived in that window — possibly an operator's own "Allow always" from seconds earlier, which is the exact loss **F2** exists to prevent. Recording and walking away loses our intended content instead.

**Files:**
- Modify: `apps/node-agent/internal/descriptor/hermes_config.go` (`ApplyConfig`'s post-write path)
- Modify: `apps/node-agent/internal/descriptor/config_plan.go` if the receipt needs a field for the sidecar path
- Test: `apps/node-agent/internal/descriptor/hermes_config_apply_test.go`

**Behaviour:**
- the file on disk is left **exactly as found** — byte-identical to what the apply read back;
- our intended version is written beside it as `<name>.agentpod-rejected`;
- the refusal names **both** paths and says plainly that neither edit has been lost.

The sidecar is overwritten by a later rejection for the same document and is **never read back by this system** — it exists for a human, not for a retry. This is the only place in the design that writes a file the harness does not own; the doc comment must say so and say why.

- [ ] **Step 1: Write the failing test.** Simulating the race needs the document to change between the apply's own re-derivation and its post-write verification. Read `ApplyConfig` and find the honest seam — if that means extracting the verification into a function a test can wedge, do that rather than contriving a filesystem race. Assert three things: the document equals its pre-write bytes, the sidecar holds the intended content, and the refusal names both paths.
- [ ] **Step 2: Run it and watch it fail.** Report what it said.
- [ ] **Step 3: Implement.** Reuse the existing atomic temp-file-plus-rename writer; do not add a second way to write a file.
- [ ] **Step 4: Prove the guard.** Remove the sidecar write; the test must fail. Remove the "leave the original alone" behaviour; the test must fail differently. Report both.
- [ ] **Step 5: Node suite, `gofmt`, commit.**

---

## Task 2: Extract the `skills.external_dirs` writer into `internal/`

**F5.** This is a refactor with **no behaviour change**, done first and separately so the fold-in in Task 4 is a delegation rather than a rewrite.

**Files:**
- Create: `apps/node-agent/internal/hermesskills/register.go`
- Modify: `apps/node-agent/cmd/agentpod-node/hermes_skills.go` — becomes a thin CLI shell over it
- Test: `apps/node-agent/internal/hermesskills/register_test.go`, plus the existing `cmd/agentpod-node/hermes_skills_test.go` which must keep passing **unchanged**

**Interfaces produced**, consumed by Task 4 — name them for what they do, and mirror `hermeslive`'s shape so there is one idiom:
```go
// Register adds dir to a profile's skills.external_dirs, additively: an entry
// the operator already has is kept, and a dir already present is a no-op.
func Register(configPath, dir string) (edited []byte, change Change, err error)
func Unregister(configPath, dir string) (edited []byte, err error)
```

- [ ] **Step 1: Capture today's behaviour as a fixture test** against the *current* CLI, before moving anything. Byte-level: given this profile and this dir, the file becomes exactly these bytes. This is the oracle Task 4's byte-identical test compares against, so it must be recorded before the refactor, not after.
- [ ] **Step 2: Run it green against the unmoved code.**
- [ ] **Step 3: Move the logic** into `internal/hermesskills`, leaving `hermesSkillsCmd` as argument parsing, output formatting and exit codes only.
- [ ] **Step 4: The existing `cmd` tests must pass unmodified.** If one needs changing, the extraction changed behaviour — stop and report rather than editing the test.
- [ ] **Step 5: The fixture test from Step 1 must still produce identical bytes.**
- [ ] **Step 6: Node suite, `gofmt`, commit.**

---

## Task 3: A harness's own opt-out reaches the hub

**D11.** `compare()` is pure and `ConfigValue` carries no opt-out signal, so a `plugins.disabled` entry is structurally invisible to the hub. Phase 3 is where that stops being speculative: the only native opt-out any harness has is `plugins.disabled`, and it governs exactly the plugin settings Task 4 folds in.

**Files:**
- Modify: `packages/contract/src/harness-config.ts` — `ConfigValue` gains `optedOutByHarness`
- Modify: `apps/node-agent/internal/descriptor/config_manage.go` (the Go mirror), `hermes_config.go` (`ObserveConfig` sets it)
- Modify: `apps/hub/src/services/harness-config.ts` — `compare()` honours it
- Test: contract test, `hermes_config_test.go`, `apps/hub/tests/unit/harness-config-compare.test.ts`

```ts
/**
 * The HARNESS's own record that an operator disabled this — Hermes'
 * `plugins.disabled`. Distinct from the hub's opt-out register: this one is the
 * operator speaking through the harness's own UI, and agentpod never writes it.
 */
optedOutByHarness: z.boolean().optional(),
```

A station reporting it reads as `opted-out` with a reason **naming the harness as the source**, so an operator can tell "I exempted this in agentpod" from "I disabled this in Hermes". Both refuse a write; only the second is invisible until you look at the document.

**Precedence:** it joins step 3 of `compare()`'s ordered list, beside the hub register. Either source means `opted-out`.

- [ ] **Step 1: Write the failing tests** — a document with the setting's plugin in `plugins.disabled` reads `optedOutByHarness: true`; `compare()` reports `opted-out` with a reason naming the harness; a hub-register opt-out still reports its own reason; the two are distinguishable in the reason text.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** The Go struct's JSON tag must match the zod field byte-for-byte — read the contract file, do not assume.
- [ ] **Step 4: Prove it.** Make `ObserveConfig` always report `false`; the harness-opt-out tests must fail while the hub-register ones stay green. That separation is the point.
- [ ] **Step 5: contract + node + hub suites, commit.**

---

## Task 4: Fold in the three Hermes settings

**Files:**
- Modify: `apps/node-agent/internal/hermeslive/config.go` — export `planEnableConfig`/`planDisableConfig` (or thin exported wrappers), each with a doc comment naming the registry as the second caller
- Modify: `apps/node-agent/internal/descriptor/hermes_config.go` — three registry entries delegating to those and to `hermesskills.Register`
- Test: `apps/node-agent/internal/descriptor/hermes_config_foldin_test.go`

| id | scope | policy |
|---|---|---|
| `hermes.plugins.enabled` | profile | `additive-only` |
| `hermes.plugins.stream_reasoning_deltas` | profile | `reconcilable` |
| `hermes.skills.external_dirs` | profile | `additive-only` |

**The acceptance test is byte-identical output (spec §10.9), asserted per setting.** For each: run the `apn` verb against a fixture profile, record the bytes; run the registry path against an identical fixture; the two must be **identical bytes**, not equivalent YAML. D5's whole claim is that formatting survives, so equivalence is not the bar.

- [ ] **Step 1: Write the three byte-identical tests first.** They will fail because the registry entries do not exist. Report what they said.
- [ ] **Step 2: Export the writers**, with doc comments.
- [ ] **Step 3: Add the registry entries**, delegating. **If a delegation cannot produce identical bytes, stop and report** — D12 says such a fold-in is abandoned, not reconciled. Do not adjust the expected bytes to match what you produced.
- [ ] **Step 4: `ErrDisabledByOperator` → `opted-out`** (via Task 3) and **`ErrConflict` → a refused plan**, each with a test.
- [ ] **Step 5: Re-run F2's sixteen attack shapes** and report every verdict. `plugins.enabled` and `skills.external_dirs` are `additive-only`, so this is exactly the guarantee at risk.
- [ ] **Step 6: Prove the byte-identical tests can fail** — perturb one expected byte and watch; restore.
- [ ] **Step 7: Node suite, `gofmt`, commit.**

---

## Task 5: `ConfigManager` on the OpenClaw descriptor

**F6.** OpenClaw's config is JSON and `user`-scoped, so a station-scoped declaration is already refused `out-of-scope` by the existing scope rules — no new refusal needed.

**Files:**
- Modify: `apps/node-agent/internal/openclawerrors/config.go` — export the `hooks.allowConversationAccess` writer
- Modify: `apps/node-agent/internal/descriptor/openclaw.go` (or a new `openclaw_config.go`) — implement `ConfigManager`
- Test: `apps/node-agent/internal/descriptor/openclaw_config_test.go`

| id | scope | policy |
|---|---|---|
| `openclaw.hooks.allowConversationAccess` | user | `reconcilable` |

**Note the interface-satisfaction trap.** `config.manage` is advertised behind `_, ok := d.(ConfigManager)`, which compiles whether or not the type conforms — so a missing or mis-signed method makes the capability silently never appear. **Add an explicit test that the OpenClaw descriptor satisfies `ConfigManager`**, and one asserting Hermes still does. A capability that silently fails to appear is precisely the bug that made this whole feature inert for three PRs.

- [ ] **Step 1: Write the failing tests**, including the interface-satisfaction one and a byte-identical test against the `apn openclaw-errors` verb.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement**, delegating to the exported writer. JSON key order is still the operator's.
- [ ] **Step 4: A station-scoped declaration reports `out-of-scope`**, with a test.
- [ ] **Step 5: Prove the interface test can fail** — rename a method and watch it fail rather than silently disabling the capability. Restore.
- [ ] **Step 6: Node suite, `gofmt`, commit.**

---

## Task 6: A bare section header

Residual. A document with `approvals:` present but holding **nothing** refuses by name today, and `derivePlanConfig` turns that into a refusal of the **whole plan** — the same amplification an earlier round fixed for an absent section. The precedent is `hermeslive`'s own handling of a bare `plugins:` key, which it extends **in place** at the key's own line.

**Files:** `apps/node-agent/internal/descriptor/configedit/edit.go`, `edit_test.go`

- [ ] **Step 1: Failing tests** — a bare `approvals:` gains the declared scalar; a bare key with an additive list gains the list; a key present as a scalar / sequence / flow mapping is **still refused by name**; the result passes `SameOutsideKeys`.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement**, following `hermeslive`'s in-place extension.
- [ ] **Step 4: Re-run F2's sixteen shapes**, report verdicts.
- [ ] **Step 5: Prove the wrong-shape refusals** by making each creatable and watching the guard fail. Restore.
- [ ] **Step 6: Node suite, `gofmt`, commit.**

---

## Task 7: Docs

**Files:** `docs-site/src/content/docs/use/config.md`, `apps/hub/tests/unit/docs-claims.test.ts` (run only)

The page is live. **Check every claim against the code, not against this plan.** This estate has shipped docs that overstated reality more than once, and this work alone caught three.

Must be true when you finish: the four folded-in settings are listed with their scopes and policies; the page says the existing `apn` verbs still work and are not replaced; a harness's own opt-out is distinguished from an agentpod exemption; and the sidecar is explained — what it is called, that the original is untouched, and that nothing reads it back.

Delete any claim that the four settings are *not* folded in. `docs-claims.test.ts` now checks subcommands against the CLI's Go source — if you name a verb, it must exist.

- [ ] **Step 1: List what the page currently claims about these four settings and the fold-in.**
- [ ] **Step 2: Rewrite.**
- [ ] **Step 3: `docs-claims.test.ts` + the hub suite.**
- [ ] **Step 4: Commit.**

---

## Self-review notes

**Spec coverage.** D10 → Task 1. D11 → Task 3. D12 → Tasks 4 and 5, with the byte-identical bar as their acceptance. F5 → Task 2. F6 → Task 5. The bare-header residual → Task 6. Docs → Task 7.

**Ordering is load-bearing.** Task 2 before 4 (the writer must be importable). Task 3 before 4 (`ErrDisabledByOperator` needs somewhere to surface). Task 1 first because it is the only one that changes how a write behaves, and doing it while the write path is otherwise untouched keeps its blame radius small.

**The most likely way this goes wrong** is Task 4 producing *nearly* identical bytes — a trailing newline, a quoting difference, a reordered list — and someone adjusting the expected bytes to match. That is exactly what D12 forbids. The expected bytes come from running the shipped verb (Task 2 Step 1 records them); they are an oracle, not a guess.

**Live verification.** `configManagement` is enabled on the workspace node and `config.manage` resolves there, so after merge these settings can be observed against real profiles — which is what §10.9 actually asks for. The four folded-in settings are ones live stations already hold values for, so **observe before you apply**, and restore anything you change.
