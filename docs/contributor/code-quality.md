# Code quality ratchets

> **Checked.** Every number below is held by a script or a test that fails when it is wrong.
> This page explains them; the numbers themselves live in the files it cites.

Phase 0 of the modularity work (2026-11-02): guardrails, not restructuring. Each check records
how the code looks today and fails if it gets worse. Each one also fails if it gets **better**
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
- **Shipped source stays clean** of the rules listed in `SRC_CLEAN` in `scripts/lint.mjs`
  (floating promises among them), whatever the baseline allows in tests and scripts. "Shipped"
  means under a `src/` folder and not a test file.
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
The ratchet is the same as for TypeScript, per linter, in
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
  of them formed one cycle until Phase 1), and one across 4 entries of `services/`
  (`acp-sessions`, `bridge`, `matrix-as`, `org-plane`; 17 until Phase 1). A cycle may lose
  members or vanish; it may not gain one, and no new cycle may appear;
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
  went to `services/station-registry.ts`; `StationRow` to `db/schema/stations.ts`; the Docker
  daemon's env parser to `config.ts`; `dispatch-span.ts` declares the one field it reads);
- **a misplaced file moves** with `git mv` to where its imports say it belongs (the org plane's
  client and reads into `auth/org-plane/`; boot validation up beside `index.ts`; a database read
  out of `telemetry/`);
- **a genuine upward call becomes a narrow interface** declared in the lower layer and passed in
  as a parameter where the pieces are put together (`index.ts`, or the route that builds the
  call). No service locators and no new global registries. (Phase 1 needed none: every back-edge
  it found was one of the two cases above.)

**Go:** [`apps/node-agent/internal/archtest/size_test.go`](../../apps/node-agent/internal/archtest/size_test.go),
run by `go test ./...`. It holds shipped files over 1,000 lines (`oversizeFiles`) and packages
over 4,000 lines (`oversizePackages`).

When a number falls, the test names it; lower the recorded value in the same change. Never raise
one to make a change fit: split the file or break the edge instead.

## In CI

The `lint-ts` and `lint-go` jobs in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
run the two lint ratchets. They are not required checks yet. The architecture tests run inside
the required `hub` and `node-agent` jobs.
