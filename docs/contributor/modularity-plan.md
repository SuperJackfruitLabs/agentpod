# Modularity and code-quality plan

Status: **in progress**, one PR for Phases 2–8 (branch `refactor/modularity`). Phase 0
(guardrails) and Phase 1 (hub layers) are merged on `main`. Phases 2–4 are done. The rules this work
leaves behind are described, and enforced, in [code-quality.md](code-quality.md); this page keeps
the plan, the starting measurements and the outcome.

The same work was done for Salaam first (Salaam's `docs/contributor/modularity-plan.md`). This
plan follows its shape: behaviour is held fixed, every structural rule is a test, and a file is
split only behind characterization tests committed first, against the old code.

## Outcome so far

| Measure | Before (main at 1444673d) | After |
|---|---|---|
| Hub `services/` layout | 59 files flat in `services/`, plus 8 folders | 23 modules, each a folder with an `index.ts`; no loose file (Phase 2) |
| Folder cycles in `services/` | 1, across 4 entries (`acp-sessions`, `bridge`, `matrix-as`, `org-plane`) | none (Phase 2) |
| Module rules in `services/` | none | one entry point per module; modules import down 10 tiers; no back-edge (Phase 2) |
| Largest hub file cycle | 3 (`forge-api/{forgejo,github,providers}.ts`) | 3 |
| Hub files over 1,000 lines | 7 (largest `acp-sessions.ts` 3,514) | none; `oversize` empty (Phase 3: `acp/sessions.ts` 3,514 → 21 files, largest `turn.ts` 574; Phase 4: the other six → 58 new files behind six thin surfaces, largest `bridge/salaam-dispatch-drive.ts` 563); largest hub file now `matrix-as/client.ts` 985 |

The rows for Phases 3–8 are added as each one lands.

## Where the code is today

Measured on `main` at 1444673d (2026-11-02), with the frozen lockfile install.

| Measure | Today |
|---|---|
| Hub `services/` | 59 non-test files directly in `services/`, 8 folders (`bridge` 46 files, `matrix-as` 75, `provisioner` 26, `push` 20, `superlibrary` 15, `forge-api` 8, `evidence` 7, `org-plane` 3); `matrix-as/index.ts` (702 lines) and `push/index.ts` (65) held code, so neither folder had an entry point |
| Services folder cycle | `acp-sessions` ↔ `matrix-as` (`promptBlocks` from `matrix-as/attachments`; `subscribe`, `SESSION_BUSY_MESSAGE` the other way), `bridge` ↔ `matrix-as` (two wire types one way; the bridge config, roster and superpipeline client the other), `org-plane` → `matrix-as/names` (`bridgeUserId`) → … → `bridge` → `org-plane` |
| Hub files over 1,000 lines | `acp-sessions.ts` 3,514; `station-forge-api.ts` 2,082; `bridge/salaam-dispatch.ts` 1,583; `bridge/dispatch.ts` 1,338; `runtimes.ts` 1,317; `matrix-as/gates.ts` 1,168; `matrix-as/outbound.ts` 1,147 |
| Console files over 1,000 lines | `routes/nodes/[id]/stations/[stationId]/+page.svelte` 1,009 |
| Go node-agent | `internal/descriptor` 14,200 lines in 62 files; `cmd/agentpod-fleet` 5,103 in 22; `cmd/agentpod-node` 4,101 in 21; `internal/forgeapi` 5,344; files over 1,000: `cmd/agentpod-fleet/reference.go` 1,340, `internal/forgeapi/instances.go` 1,164 |
| TypeScript lint (`pnpm lint:ts`) | 6,861 findings held by the baseline. `no-explicit-any` 287 (6 in shipped source); `no-empty` 7 (3 in shipped source); `no-floating-promises` 122 (0 in shipped source, which `SRC_CLEAN` holds); `no-misused-promises` 3 (2 in shipped source) |
| Go lint (`pnpm lint:go`) | `errcheck` 163, `errorlint` 56, `nilerr` 28, `noctx` 89, `gosec` 73, `bodyclose` 25 (tests and shipped code together) |
| Hub tests | 4,191 pass, 26 skip, 0 fail (Bun 1.4.2, test Postgres) |
| Hub typecheck | `src` 0 errors; tests: 2, both in `tests/integration/identity-move.test.ts` (listed in `typecheck-known-red-tests.txt`) |

## Target structure

**Hub.** The top-level layers stay as Phase 1 left them (`HUB_LAYERS`). Inside `services/`,
feature modules, each a folder whose `index.ts` is its only public entry point, layered in tiers
(`SERVICE_LAYERS` in the architecture test, described in
[code-quality.md](code-quality.md#the-service-modules)):

```
1   audit  broker  control  hub  matrix  speech
2   forge  harness-config  provisioner  salaam
3   forge-api
4   stations
5   nodes  skills  superlibrary
6   evidence  runtimes
7   acp  sweeper
8   org-plane  push
9   bridge
10  matrix-as
```

**Node agent.** `cmd/` holds flag parsing and wiring only; the logic it holds today moves into
`internal/` packages with their own tests. `internal/descriptor` splits into cohesive packages
(per harness family and per concern: detection, config files, skills, profiles), each under the
4,000-line package limit.

**Console.** Route pages compose components and hold no domain logic; the station page splits by
panel.

## Rules

Each is enforced by a test or a lint ratchet, not by review alone:

1. **Behaviour does not change.** Routes, responses, database queries, Matrix, forge and bridge
   traffic, and the order of side effects stay as they are. Moving code and constructor or
   function injection at the composition point (`index.ts`, or the route that builds a
   dependency) are allowed.
2. **Characterization tests first.** Before a file splits, the behaviour it has that no test pins
   gets a test, committed on its own against the old code.
3. **Tests change only import paths**, or how they construct a dependency that is now injected.
   No test is skipped, disabled or weakened.
4. **One entry point per service module**: `index.ts` holds named re-exports only, of what other
   code imports. A dynamic `import()` may name a file, to stay lazy; tests may import any file.
5. **Modules import down their tiers**, never across a tier or up. A back-edge is fixed by moving
   a pure helper or type down, moving a misplaced file, or declaring a narrow interface below and
   injecting it; it is never listed.
6. **Files stay under 1,000 lines**, packages under 4,000 (Go). The `oversize` records only fall.
7. **Lint counts only fall.** `pnpm lint:ts --update` and `pnpm lint:go --update` lock in a lower
   count; neither will raise one.

## Phases

All in one PR, one or more commits per phase, each commit message starting `Phase N:`.

| Phase | What | Done when |
|---|---|---|
| 2 | **Hub service modules.** `services/` into feature folders, each with an `index.ts` of named re-exports computed from what other modules import; every import from outside a module through its index; `SERVICE_LAYERS` and the entry-point rule in the architecture test; the 4-entry folder cycle broken by moving Matrix naming and the attachment helpers down to `matrix`, and the bridge's wire types into `bridge/deliveries.ts`. | **Done.** No folder cycle in `services/`; the four module checks green and each seen to fail on a planted violation |
| 3 | **`acp/sessions.ts`** (3,514 lines) splits by concern (session store and rows, the wire and its streams, turns and permissions, Salaam liveness, boot reconciliation) behind characterization tests: session create/resume/end, the event log, permission answers, busy and idle, boot reconcile. | **Done.** 21 files, none over 600 lines; `sessions.ts` re-exports and registers the node-online hook; `oversize` entry removed; pinned first by `sessions.characterization.test.ts` |
| 4 | **The other hub files over 1,000 lines**: `forge-api/station-forge-api.ts` (2,082), `bridge/salaam-dispatch.ts` (1,583), `bridge/dispatch.ts` (1,338), `runtimes/runtimes.ts` (1,317), `matrix-as/gates.ts` (1,139), `matrix-as/outbound.ts` (1,147). Each behind its own characterization tests. | **Done.** One pin commit and one split commit per file. Each old file is now a surface of re-exports (same export set, compared at runtime): `gates.ts` → 5 `gate-*.ts` (largest 452); `outbound.ts` → 8 `outbound-*.ts` (largest 379); `runtimes.ts` → 10 files (largest `start.ts` 252); `dispatch.ts` → 7 `dispatch-*.ts` (largest 399; the `dispatch` ↔ `salaam-dispatch` type cycle gone); `salaam-dispatch.ts` → 11 `salaam-dispatch-*.ts` (largest 563); `station-forge-api.ts` → 17 `grant-*.ts` (largest 259). Pinned first by six `*.characterization.test.ts` files (99 tests), each test seen red against a change planted in the old code. Hub `oversize` is `{}` |
| 5 | **Go node agent.** `internal/descriptor` into cohesive packages; the logic in `cmd/agentpod-fleet` (5,103) and `cmd/agentpod-node` (4,101) into `internal/` packages; `forgeapi/instances.go` (1,164) and `cmd/agentpod-fleet/reference.go` (1,340) split. | `oversizeFiles` empty; `oversizePackages` has no `cmd/` entry and no `internal/descriptor` entry; `go vet` and `go test -race ./...` green |
| 6 | **Console.** The station page (1,009 lines) splits by panel into components; route pages compose and hold no domain logic. | Console `oversize` empty; `pnpm check`, `pnpm test`, `pnpm build` green |
| 7 | **Lint to targets.** No `any` in shipped source; no empty `catch` without a comment saying why; no floating or misused promises anywhere (tests included); Go `errcheck` and `errorlint` clean in shipped code. Rules that reach zero join `SRC_CLEAN` (or go to zero in the baseline). | Targets met; the baselines lowered with `--update` |
| 8 | **Close.** `docs/contributor/code-quality.md` and this page finished (outcome table); `AGENTS.md`, `CLAUDE.md`, `apps/hub/CLAUDE.md` name the module map; CHANGELOG entry. | PR ready for review |

Not in scope, and listed for the operator rather than changed: the two homeserver-gated gate
tests in `tests/integration/identity-move.test.ts` pass deps without `boardRoom` (gates moved to
the board's room on 2026-09-28). They are red under `typecheck:tests` and skipped without
`MATRIX_TEST_HOMESERVER_URL`. Fixing them means deciding what they should now prove, so no phase
changes what they test.

### How each phase is checked

Before every push, with the counts written in the commit or PR:

- hub: `bun run typecheck` (0 errors), `bun run typecheck:tests` (only the known-red file), the
  full `bun test` with Bun 1.4.2 against the test Postgres, the architecture test;
- `pnpm lint:ts`, and `pnpm lint:go` when Go changed;
- `packages/contract`: `bun test`;
- console, when touched: `pnpm check`, `pnpm test`;
- node agent, when touched: `go vet ./...`, `go test ./...`.

CI runs the same through the required `contract`, `hub`, `node-agent`, `console` and `worker`
jobs; the architecture tests run inside `hub` and `node-agent`.

### Risks

- **Conflicts.** Phase 2 moved every service file. Open hub PRs conflict on import paths; a
  rebase resolves them by pointing each import at the module's `index.ts` (and adding the name
  there). Keep the PR short-lived.
- **Module load order.** Importing through an `index.ts` loads every file of that module, where a
  direct import loaded one. Production loads everything from `index.ts` anyway, and the only
  module-scope side effect in `services/` (`acp/sessions.ts` registering an `onNodeOnline` hook)
  runs at load either way, before any boot hook. Tests import files directly and are unaffected.
  A module-scope side effect added later should be a function the composition root calls.
- **Behaviour slipping during splits** (Phases 3–7). The existing suites drive routes, the
  gateway, the bridge and Matrix from outside; where a phase finds an area no test covers, it adds
  the test first, against the old code.
- **Path-loaded files.** Some tests and scripts name source files by path (a child-process import
  in `runtimes/image.test.ts`, the source walk in `evidence/redact-content.test.ts`, the
  node-agent fixtures the skills tests read). Phase 2 fixed each; a later move must check them
  again (`grep -rn "import.meta" apps/hub/src`).
- **Stale paths outside the hub.** Comments in the node agent (`internal/descriptor/openclaw_config.go`,
  `skills.go`, `openclaw_config_test.go`), the console (`HarnessConfigPanel.svelte` and its test)
  and the `mintSource` notes in `fixtures/ecosystem-identity/id_grammar.json` still name the old
  hub service paths. Phase 2 left them so as not to touch the node agent, the console or a shared
  fixture in a hub-only phase; Phase 8 updates them (Phases 5 and 6 may do so in passing).
