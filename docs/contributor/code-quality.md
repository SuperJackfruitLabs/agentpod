# Code quality ratchets

> **Checked.** Every number below is held by a script or a test that fails when it is wrong.
> This page explains them; the numbers themselves live in the files it cites.

Phase 0 of the modularity work (2026-11-02) put these guardrails in; Phases 1–7 restructured the
code under them ([modularity-plan.md](modularity-plan.md) has the outcome). Each check records
how the code looks and fails if it gets worse. Each one also fails if it gets **better**
without the record being lowered, so a stale record cannot let the next regression through.

## TypeScript lint: `pnpm lint:ts`

[oxlint](https://oxc.rs) `1.88.0` with `oxlint-tsgolint` `7.0.2004`, both pinned exactly in the
root `package.json`. tsgolint type-checks with its own TypeScript-Go, so it does not depend on
the repo's TypeScript 5.9. Configuration: [`.oxlintrc.json`](../../.oxlintrc.json). Script:
[`scripts/lint.mjs`](../../scripts/lint.mjs).

- **Covers** `apps/hub`, `apps/console` (`.ts`, and the script blocks of `.svelte` files; the
  typed rules see `.ts` only), `packages/*`, `cloudflare/worker-v2` and `scripts/`. Left out:
  the landing site, docs and docs-site, the vendored vibekit (`apps/console/vendor`), generated
  code, build config files, and `cloudflare/worker` (dead, see its `DEAD.md`).
- **Rules:** the `correctness` and `suspicious` categories, plus floating and misused promises,
  `await` of a non-promise, exhaustive `switch` (a `default` counts), type-only imports, no
  `any`, no `!` non-null assertion, no empty block (an empty `catch` included), no `console`
  outside scripts, tests, the e2e harness, the hub's logger and the worker (where `console` is
  how a Worker logs). Off, because every finding was deliberate (measured 2026-11-02):
  `no-control-regex` (16 findings, all validators that reject or strip control characters on
  purpose, such as `/^[^\u0000-\u001f\u007f]+$/` in the contract) and
  `no-unmodified-loop-condition` (1 finding, a test loop whose condition a closure changes
  across an `await`).
- **The ratchet.** Findings are counted per rule in
  [`scripts/lint-baseline.json`](../../scripts/lint-baseline.json). A count may fall but never
  rise; a rule not in the baseline must be clean. After a cleanup, `pnpm lint:ts --update`
  writes the lower counts (it refuses to raise one); lint fails until you do.
- **Shipped source stays clean** of the rules listed in `SRC_CLEAN` in `scripts/lint.mjs`,
  whatever the baseline allows in tests and scripts. "Shipped" means under a `src/` folder and
  not a test file. Since Phase 7 that is 16 rules, among them `any`, an empty block without a
  comment, floating and misused promises, unused code, type-only imports written as values, and
  unnecessary assertions and conversions. `no-console` is not among them: the hub's 79 plain
  stdout lines are deliberate (modularity-plan.md says why).
- **Before running it:** `pnpm install --frozen-lockfile`, then
  `(cd apps/console && pnpm exec svelte-kit sync)` and `(cd cloudflare/worker-v2 && npm ci)`.
  Without them the typed rules cannot load those projects and report `tsconfig-error`.

The bulk of the baseline is `!` assertions and unchecked type assertions, and most findings are
in tests. They are held, not cleared: rewriting them wholesale risks changing behaviour. Lower
them in code you touch.

## Go lint: `pnpm lint:go`

[golangci-lint](https://golangci-lint.run) `v2.15.0`, pinned in
[`scripts/lint-go.mjs`](../../scripts/lint-go.mjs) and in CI; the script refuses any other
version. Configuration: [`apps/node-agent/.golangci.yml`](../../apps/node-agent/.golangci.yml).
Install it once into the repo's ignored `.bin/`:

```bash
GOBIN="$PWD/.bin" go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0
```

Linters: `errcheck`, `govet`, `staticcheck`, `ineffassign`, `unused`, `gosec`, `errorlint`,
`bodyclose`, `nilerr`, `noctx`, `misspell`, `unconvert`, `copyloopvar`. `revive` and `gocritic`
were measured and left off (mostly style). gosec's file-permission, variable-path and
subprocess checks are off because they fire on the node-agent's purpose; the config says why
for each. The script always analyses the linux/amd64 build, so a Mac and CI count the same.
In shipped code `errcheck` and `bodyclose` are at zero since Phase 7: an error the code means
to drop is dropped with `_ =` and a comment saying why. The ratchet is the same as for
TypeScript, per linter, in
[`scripts/lint-go-baseline.json`](../../scripts/lint-go-baseline.json); `pnpm lint:go --update`
locks in an improvement.

## Architecture ratchets

**TypeScript:** [`apps/hub/tests/unit/architecture.test.ts`](../../apps/hub/tests/unit/architecture.test.ts),
run by the hub's `bun test` (it reads the console and the packages too). It holds:

- the largest file-level import cycle in each source tree (`largestCycle`);
- the hub's layer order (`HUB_LAYERS`, below): every import between the hub's top-level folders
  and files points down it. Back-edges still allowed are listed in `KNOWN_BACK_EDGES`, which may
  only shrink; it has been empty since Phase 1. A new top-level folder or file fails the test
  until it is given a place in the order;
- the folder-level cycles in the hub (`FOLDER_CYCLES`): none across its top-level folders (eight
  of them formed one cycle until Phase 1), and none across the modules of `services/` (17
  entries formed one until Phase 1, 4 until Phase 2). A cycle may lose members or vanish; it may
  not gain one, and no new cycle may appear;
- the service modules (`SERVICE_LAYERS`, below): every folder under `services/` is a module with
  an `index.ts`, an import from outside a module goes through that `index.ts`, and the modules
  import each other down their tiers;
- shipped files over 1,000 lines, each held at its current size (`oversize`).

### The hub's layers

Lowest first. An import may point at its own layer or a lower one, never a higher one.

| Layer | Holds | May import |
|---|---|---|
| `config.ts` | the environment, read once into `config` (the Docker daemon's env contract included) | nothing |
| `ws.ts` | the one shared Bun WebSocket helper | nothing |
| `telemetry/` | OpenTelemetry setup, spans, trace propagation | nothing in the hub |
| `utils/` | logger, ids, encryption, redaction helpers: no domain | `config`, `telemetry` |
| `db/` | the Drizzle client, schema, migrations | the above |
| `models/` | one table's reads and writes | the above |
| `auth/` | token verification, the caller's authority, and the org plane it reads (`auth/org-plane/`: its config, client, directory, grants, principals, the hub's home org) | the above |
| `services/` | the domain | the above |
| `mcp/`, `middleware/`, `routes/` | the hub's MCP server, HTTP middleware, HTTP and WebSocket routes | the above |
| `validate-config.ts` | boot validation, which reads every subsystem's settings | the above |
| `index.ts` | the composition root: wires listeners and dependencies, serves | everything |

When a lower layer needs something from a higher one, do not list a back-edge. Phase 1 removed
each of them one of three ways, and the next one should be removed the same way:

- **a pure helper, type or constant moves down** to the layer that needs it (`gateCapability`
  went to `services/stations/registry.ts`; `StationRow` to `db/schema/stations.ts`; the Docker
  daemon's env parser to `config.ts`; `dispatch-span.ts` declares the one field it reads);
- **a misplaced file moves** with `git mv` to where its imports say it belongs (the org plane's
  client and reads into `auth/org-plane/`; boot validation up beside `index.ts`; a database read
  out of `telemetry/`);
- **a genuine upward call becomes a narrow interface** declared in the lower layer and passed in
  as a parameter where the pieces are put together (`index.ts`, or the route that builds the
  call). No service locators and no new global registries. (Phase 1 needed none: every back-edge
  it found was one of the two cases above.)

### The service modules

Phase 2 (2026-11-02) turned `services/` from 59 flat files and 8 folders into 23 modules. Each
module is a folder whose `index.ts` is its public entry point:

- **`index.ts` holds named re-exports and nothing else** (`export { a } from "./file"`,
  `export type { T } from "./file"`). It exports what other code imports and no more: when a
  file outside the module needs a new name, add it to the index; when nothing imports a name any
  longer, take it out. Code never lives in an `index.ts`.
- **An import from outside a module goes through its `index.ts`**, whether it comes from another
  module, a route, the MCP server or `index.ts`. Inside a module, files import each other
  directly and never through their own `index.ts`. Two exceptions: a dynamic `import("…")` may
  name a file, since it is there to load that file lazily; and tests may import any file, so
  they can reach what a module does not export.
- **Modules import only from a tier below their own** (`SERVICE_LAYERS`, lowest first). Two
  modules in one tier are independent of each other. Back-edges are listed in
  `KNOWN_SERVICE_BACK_EDGES`, which is empty and may only shrink; fix one the ways listed for the
  hub's layers below, never by listing it.

| Tier | Modules | Holds |
|---|---|---|
| 1 | `audit` | the station audit log |
| | `broker` | the broker (request/stream correlation) and the connection manager of the node gateway |
| | `control` | the control pair's switch, and who may change what an agent is (grant reach) |
| | `hub` | the hub process itself: hub operators and their config, admin counts, graceful shutdown |
| | `matrix` | Matrix shared below the appservice: the homeserver client, station Matrix names, a principal's Matrix id, Matrix identity, Matrix credentials, attachment helpers |
| | `speech` | speech-to-text and text-to-speech clients and per-station settings |
| 2 | `forge` | an agent's forge account and the key a station pushes with |
| | `harness-config` | declared harness settings and applying them to a station |
| | `provisioner` | runtime drivers (Docker, Fly, Modal, Cloudflare) and their registry |
| | `salaam` | what the hub tells Salaam: authority, approval rules, prompts, cancellations, work |
| 3 | `forge-api` | forge API access: providers, the station lifecycle, the reconcile sweep, sealing |
| 4 | `stations` | the station registry, adoption hooks, failure answers, the self-station, the MCP proxy |
| 5 | `nodes` | enrollment, the node registry, removal, the health cache, agent versions, rollout, the fleet read |
| | `skills` | skill artifacts, operations, release cohorts and canaries, the trusted catalog |
| | `superlibrary` | the SuperLibrary client, links and execution exports |
| 6 | `evidence` | execution evidence, fingerprints, transcripts, redaction |
| | `runtimes` | runtime provisioning, images, auto-adopt |
| 7 | `acp` | ACP sessions, the hub as an ACP agent, the transport, turn errors |
| | `sweeper` | the node sweeper's tick (nodes, then the runtime sweeps) |
| 8 | `org-plane` | agent placement on the organization plane |
| | `push` | the Matrix push gateway and the fleet Live Activity |
| 9 | `bridge` | the superpipeline bridge |
| 10 | `board-chat` | board work in chat: gates, questions, deliveries, attention and checks projected into board rooms, the answers back to superpipeline, and their sweeps |
| 11 | `matrix-as` | the Matrix appservice: agents puppeted into Matrix, station rooms, inbound and outbound turns, identity moves |

The four-entry cycle Phase 1 left (`acp-sessions`, `bridge`, `matrix-as`, `org-plane`) went the
first of the three ways listed for the hub's layers: pure code moved down. Matrix naming and the
attachment helpers left the appservice for `matrix`, so `org-plane` and `acp` no longer reach up
into `matrix-as`; the two wire shapes the bridge reads off a board (`GatePendingDelivery`,
`ElicitationPendingDelivery`) moved into `bridge/deliveries.ts`, so the bridge no longer imports
the appservice at all.

`board-chat` sits below `matrix-as` so it can leave the hub. It is the part of the Matrix
appservice that serves boards rather than agents, and it is planned to move into a service of
its own beside the homeserver. Agent puppeting stays in `matrix-as` and calls down into it.
`board-chat` never imports `matrix-as`, and the tier order above makes that a failing test
rather than a rule to remember. What it needs from the running bridge is the `BoardChatBridge`
interface it declares.

**Go:** [`apps/node-agent/internal/archtest/size_test.go`](../../apps/node-agent/internal/archtest/size_test.go),
run by `go test ./...`. It holds shipped files over 1,000 lines (`oversizeFiles`) and packages
over 4,000 lines (`oversizePackages`). Since Phase 5 `oversizeFiles` is empty and
`oversizePackages` holds `internal/forgeapi` alone.

The harness descriptors are a family of packages with one direction. `internal/descriptor` is the
contract (station types, `Descriptor` and its optional interfaces), the `Registry` and the verb
handler, and imports none of its subpackages; the shared helpers (`descriptor/hostfs`, `hostproc`,
`configdoc`, `acpskills`) import only it; each harness is its own package (`descriptor/hermes`,
`openclaw`, `claudecode`, `codex`, `opencode`, `pi`, `kilo`, `muse`, `salaamharness`) over those;
`descriptor/profilewriter` and the test-only `descriptor/harnesses` sit on top. Go refuses an
import cycle, so the direction holds by construction. The binaries keep dispatch, flag parsing and
wiring in `cmd/`; their command tables and references live in `internal/nodecli` and
`internal/fleetcli`.

When a number falls, the test names it; lower the recorded value in the same change. Never raise
one to make a change fit: split the file or break the edge instead.

## Inside the large modules

Phases 3 and 4 split the hub's seven files over 1,000 lines. Each old file that other code
imported stayed as a **surface**: a file of re-exports with the same export set as before
(compared at runtime by its characterization test), so no caller changed. The pieces are flat
files in the module, named by the surface they came from:

| Module | Surface | Pieces |
|---|---|---|
| `acp` | `sessions.ts` (re-exports, and registers the node-online hook) | the session store and rows (`session-state`, `rows`), opening and ending (`open`, `end`, `ending`, `cancel`), the wire and its streams (`transport`, `ws-stream`, `handshake`, `updates`, `events`), turns and permissions (`turn`, `prompt`, `permissions`, `gates`, `busy`, `timing`), Salaam liveness (`salaam-authority`, `recovery`), boot reconciliation (`boot`) |
| `bridge` | `dispatch.ts`, `salaam-dispatch.ts` | `dispatch-*` (types, grant, readiness, prompt, run, turn, work, exits) and `salaam-dispatch-*` (plan, start, drive, drivers, settle, release, resume, expired, stopped, proofs, log) |
| `forge-api` | `station-forge-api.ts` | `grant-*`, one file per step of a grant's life (create, claim, mint, deliver, verify, rotate, revoke, policy, transition) and its shared types and rows |
| `runtimes` | `runtimes.ts` | one file per lifecycle verb (`create`, `start`, `stop`, `destroy`, `reprovision`, `rotation`, `probe`), the reads, the rows, the unobserved and auto-adopt sweeps |
| `board-chat` | `gates.ts` | `gate-*` (wire, projection, decision, resolve, reads, sweep) |
| `matrix-as` | `outbound.ts` | `outbound-*` (state, send, streams, flush, handle, marks, payloads, log) |

A new file in one of these modules goes beside its siblings with the same prefix. Import a
piece from inside the module; from outside, import the module's `index.ts`.

## The console

Route pages compose components and hold no domain logic. The station page
(`routes/nodes/[id]/stations/[stationId]/+page.svelte`) loads the station, derives what the
caller may do, and composes `lib/components/stations/station-page/`: `StationHeader`,
`StationTabBar` (the roving tabindex), `StationConfigTab`, `StationAboutSheet` and
`StationConfigEditorDialog`. Which tabs and configuration sections a station has, and which
one a URL selects, is the pure `station-page/tabs.ts`. The panels it hosts are the components
beside it in `lib/components/stations/`. The console's files are held to the same 1,000-line
limit by the hub's architecture test (its `oversize` record is empty).

## Practices

- **Characterize before restructuring.** Before a file splits, pin what it does that no test
  pins: its exports, its calls in order, its output. Commit the pin on its own against the old
  code, and see each new test fail against a change planted in the old code. A test that cannot
  fail proves nothing.
- **Move, then fix.** A split moves code verbatim (methods with their receivers, comments with
  their code) and exports only what crosses the new boundary. Behaviour changes, even obvious
  improvements, go in their own change.
- **Snapshots must hold in a bare environment and on Linux.** Fix the clock, the viewport, ids
  and anything else the machine supplies; normalise what a framework only marks for a frame
  (bits-ui's `data-starting-style`), never the content. Run the test with `env -i` and with
  `CI=true` (where a missing snapshot fails instead of being written), and on its own with `-t`.
  A golden written on macOS must not depend on the platform.
- **A lint finding is fixed, not hidden.** Where a rule is wrong about a line (a defensive
  conversion of a value TypeScript cannot see, or tsgolint reading a file under a different
  tsconfig than the one that compiles it), disable it for that line only, with
  `// oxlint-disable-next-line <rule> -- <why>`.

## In CI

The `lint-ts` and `lint-go` jobs in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
run the two lint ratchets. They are not required checks yet. The architecture tests run inside
the required `hub` and `node-agent` jobs.
