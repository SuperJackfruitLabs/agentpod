# Modularity and code-quality plan

Status: **done**, one PR for Phases 2–8 (branch `refactor/modularity`, #836). Phase 0
(guardrails) and Phase 1 (hub layers) are merged on `main`; Phases 2–8 are done on the branch.
The rules this work leaves behind are described, and enforced, in [code-quality.md](code-quality.md);
this page keeps the plan, the starting measurements and the outcome.

The same work was done for Salaam first (Salaam's `docs/contributor/modularity-plan.md`). This
plan follows its shape: behaviour is held fixed, every structural rule is a test, and a file is
split only behind characterization tests committed first, against the old code.

## Outcome

| Measure | Before (main at 1444673d) | After |
|---|---|---|
| Hub `services/` layout | 59 files flat in `services/`, plus 8 folders | 23 modules, each a folder with an `index.ts`; no loose file (Phase 2) |
| Folder cycles in `services/` | 1, across 4 entries (`acp-sessions`, `bridge`, `matrix-as`, `org-plane`) | none (Phase 2) |
| Module rules in `services/` | none | one entry point per module; modules import down 10 tiers; no back-edge (Phase 2) |
| Largest hub file cycle | 3 (`forge-api/{forgejo,github,providers}.ts`) | 3 |
| Hub files over 1,000 lines | 7 (largest `acp-sessions.ts` 3,514) | none; `oversize` empty (Phase 3: `acp/sessions.ts` 3,514 → 21 files, largest `turn.ts` 574; Phase 4: the other six → 58 new files behind six thin surfaces, largest `bridge/salaam-dispatch-drive.ts` 563); largest hub file now `matrix-as/client.ts` 985 |
| Node-agent files over 1,000 lines | 2 (`cmd/agentpod-fleet/reference.go` 1,340, `internal/forgeapi/instances.go` 1,164) | none; largest `internal/descriptor/pi/pi.go` 885 (Phase 5) |
| Console files over 1,000 lines | 1 (`routes/nodes/[id]/stations/[stationId]/+page.svelte` 1,009) | none; the page is 635 lines composing five components and a pure `tabs.ts` in `lib/components/stations/station-page/`; largest console file `chat/acp-chat.svelte.ts` 880 (Phase 6) |
| Node-agent packages over 4,000 lines | 4 (`internal/descriptor` 14,200, `cmd/agentpod-fleet` 5,103, `internal/forgeapi` 5,344, `cmd/agentpod-node` 4,101) | 1: `internal/forgeapi` 4,483, kept (below); largest descriptor package `descriptor/hermes` 3,177 (Phase 5) |
| TypeScript lint, all findings | 6,861 | 6,548 (Phases 3–7) |
| Shipped TypeScript (`src/`, not tests) | `SRC_CLEAN` held 9 rules; `no-explicit-any` 6, `no-empty` 3, `consistent-type-imports` 23, `no-unused-vars` 16, `no-unnecessary-type-assertion` 63, `no-unnecessary-type-conversion` 19, `no-misused-promises` 2 | all seven 0, and in `SRC_CLEAN` (16 rules); `no-non-null-assertion` 223 → 203, `no-unsafe-type-assertion` 352 → 342 (Phase 7) |
| Promises, repo-wide | `no-floating-promises` 122, `no-misused-promises` 3 | 0 and 0; both left the baseline (Phase 7) |
| `no-console` in shipped source | 79 | 79, left on purpose (below) |
| Go lint, all findings | `errcheck` 163, `errorlint` 56, `noctx` 89, `bodyclose` 25, `gosec` 73, `nilerr` 28 | `errcheck` 106, `errorlint` 31, `noctx` 50, `bodyclose` 23, `gosec` 70, `nilerr` 28 (Phases 5 and 7) |
| Go lint, shipped code | `errcheck` 57, `errorlint` 41, `noctx` 49, `bodyclose` 2 | `errcheck` 0, `errorlint` 16, `noctx` 10, `bodyclose` 0 (Phase 7) |
| Characterization tests added | none | hub: `acp/sessions` 9, six Phase 4 files 99; node agent: the full-registry golden and the apn and fleet CLI goldens (25 apn commands, 144 fleet paths); console: the station page, 13 tests and 30 DOM snapshots. Each seen red against a change planted in the old code |
| Hub tests (Bun 1.4.2, test Postgres) | 4,191 pass, 26 skip, 0 fail | 4,303 pass, 26 skip, 0 fail |
| Console tests | 1,626 | 1,639 |

**How behaviour was held.** Every split moved code verbatim behind a test committed first against
the old code, and each of those tests was seen to fail against a planted change. Old entry files
stayed as surfaces with the same runtime export set, so no caller changed. Lint fixes were limited
to what emits the same code (erased assertions and type-only imports), what makes an ignored error
explicit (`_ =` with a reason), and what is equivalent by definition (`http.NewRequest` is
`NewRequestWithContext(context.Background(), …)`; `exec.Command` behaves as
`CommandContext(context.Background(), …)`; `errors.Is`/`errors.As` against a sentinel or an
`*exec.ExitError` that the standard library returns unwrapped). Tests changed only imports, types,
`await`/`void`, and their own setup where it leaked into another file.

**Regressions and order dependences found on the way.** None in shipped behaviour. In the tests:
the console page's About-sheet snapshot caught bits-ui's one-frame `data-starting-style` only
when the suite was idle (normalised in Phase 6); `matrix-as/outbound.test.ts` left its session
attached, which `outbound.characterization.test.ts` counted when the filesystem listed it later
(on Linux; GitHub's order hid it); the gates characterization tests depended on file order (gate
numbers and a projection row from the first test); and `org-plane/verify.test.ts` read a request
count before the background refresh reached its server. Each is fixed in its own test.

**Left as they are, for the operator.**
- **`no-console` in shipped source (79).** Every site is a plain stdout line: boot, migrations,
  validate-config's report, the runtime and node sweepers. `runtimes.characterization.test.ts`
  pins those lines, and the hub logger would change their format, their `LOG_LEVEL` filtering and
  their OTel export. Moving them is a behaviour change to decide on its own.
- **Go `errorlint` in shipped code (16).** Fifteen are `fmt.Errorf("%w: …: %v", Sentinel, err)`
  or alike: turning the `%v` into `%w` would make `errors.Is(err, os.ErrNotExist)` (tested in 58
  places) start matching through the wrapper, which can change a caller's branch. The sixteenth is
  `forgeapi/registrylock_unix.go`'s EINTR compare, kept because the `errors` import would put
  `internal/forgeapi` one line over its recorded size.
- **Go `noctx` in shipped code (10).** `net.Listen`, `net.DialTimeout`, `http.Client.Get` and
  `http.Post`; rewriting them is not a one-token change.
- **`internal/forgeapi` (4,483 lines) is not split.** Its files depend on each other in both
  directions: the `instances*` files call `logf`, `clean`, `coded`, `Service` and the lifecycle
  helpers from the rest of the package, and `harness.go`, `service.go`, `bypass.go`, `env.go` and
  `lifecycle.go` call the instance registry's unexported reads and writes. There is no seam that
  would not export a dozen helpers, so `oversizePackages` keeps its record.
- The two homeserver-gated gate tests in `tests/integration/identity-move.test.ts` (below).

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
| 5 | **Go node agent.** `internal/descriptor` into cohesive packages; the logic in `cmd/agentpod-fleet` (5,103) and `cmd/agentpod-node` (4,101) into `internal/` packages; `forgeapi/instances.go` (1,164) and `cmd/agentpod-fleet/reference.go` (1,340) split. | **Done.** `internal/descriptor` (14,200) → the contract, registry and verbs (2,020) importing none of: `hostfs`, `hostproc`, `configdoc`, `acpskills` (shared, 247–754 each), one package per harness (`hermes` 3,177 the largest; `openclaw`, `claudecode`, `codex`, `opencode`, `pi`, `kilo`, `muse`, `salaamharness`), `profilewriter`, and the test-only `harnesses`; moved mechanically, methods with their receivers, only boundary-crossing names exported, 561 test functions before and after. apn's help table and reference → `internal/nodecli` (`cmd/agentpod-node` 3,331); fleet's reference (split by command group, largest 517), usage texts and pure helpers → `internal/fleetcli` (`cmd/agentpod-fleet` 3,127); dispatch, flags, env reads and hub calls stay in `cmd/`, where clidoc and the hub's docs check read them. `instances.go` → seven `instances*.go` (largest 276); the stk policy model → `forgeapi/stkpolicy` (918). Pinned first by a full-registry golden and an apn and a fleet CLI golden (every help path's stdout, stderr and exit code), each seen red against a planted change. `oversizeFiles` empty; `oversizePackages` is `internal/forgeapi` 4,483 alone (its remaining files share unexported helpers throughout) |
| 6 | **Console.** The station page (1,009 lines) splits by panel into components; route pages compose and hold no domain logic. | **Done.** The page (635) composes `StationHeader`, `StationTabBar`, `StationConfigTab`, `StationAboutSheet` and `StationConfigEditorDialog`; which tabs and sections a station has, and which one a URL selects, moved to the pure `station-page/tabs.ts`. Pinned first by `page.characterization.svelte.test.ts` (13 tests, 30 DOM snapshots across every tab, section, width and load state, each child panel stubbed to render the props it is handed), seen red against five planted changes; every snapshot unchanged after the split. Console `oversize` empty |
| 7 | **Lint to targets.** No `any` in shipped source; no empty `catch` without a comment saying why; no floating or misused promises anywhere (tests included); Go `errcheck` and `errorlint` clean in shipped code. Rules that reach zero join `SRC_CLEAN` (or go to zero in the baseline). | **Done**, with the exceptions listed above. Seven TypeScript rules to zero in shipped source and into `SRC_CLEAN`; floating and misused promises zero repo-wide; Go `errcheck` and `bodyclose` zero in shipped code, `errorlint` 41 → 16, `noctx` 49 → 10; both baselines lowered with `--update`. The dead `roomForCard` and `dispatchedStationId` left `matrix-as/gate-projection.ts` |
| 8 | **Close.** `docs/contributor/code-quality.md` and this page finished (outcome table); `AGENTS.md`, `CLAUDE.md`, `apps/hub/CLAUDE.md` name the module map; CHANGELOG entry. | **Done.** code-quality.md holds the module layouts, the console components and the practices; `AGENTS.md` the structure rules; CHANGELOG an Unreleased entry; stale old-path comments fixed |

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
- **Stale paths outside the hub.** Comments in the node agent (`internal/descriptor/openclaw/openclaw_config.go`,
  `internal/descriptor/skills.go`, `openclaw/openclaw_config_test.go` since Phase 5), the console (`HarnessConfigPanel.svelte` and its test)
  and the `mintSource` notes in `fixtures/ecosystem-identity/id_grammar.json` still name the old
  hub service paths. Phase 2 left them so as not to touch the node agent, the console or a shared
  fixture in a hub-only phase; Phase 8 updates them (Phases 5 and 6 may do so in passing).
