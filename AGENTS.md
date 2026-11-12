# AGENTS.md

**The project instructions live in [`CLAUDE.md`](./CLAUDE.md). Read that file.**

This one exists because `AGENTS.md` is the convention some agents look for. It deliberately
holds no second copy of the tiers, the commands or the workflow: until 2026-08-14 it held a
stale copy, and that copy described a **Tauri desktop app with a Rust backend, a `docker/`
directory, and `pnpm dev:frontend` / `pnpm dev:api` / `pnpm tauri build`** — none of which
have existed in this repo since the pivot. Every line an agent acted on was wrong.

Per-area notes that are worth reading before touching that area:

| File | Covers |
|---|---|
| [`CLAUDE.md`](./CLAUDE.md) | The tiers, the test commands, the branch and release workflow, the gotchas |
| [`apps/hub/CLAUDE.md`](./apps/hub/CLAUDE.md) | Hub internals: gateway, sweeper, runtime lifecycle rules, bridge, test conventions |
| [`TESTING.md`](./TESTING.md) | How to run and write tests per tier, and the test-postgres requirement |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Branch flow, commit style, what to run before pushing |
| [`docs/README.md`](./docs/README.md) | What every document in `docs/` is for, and which kind it is |
| [`docs/contributor/code-quality.md`](./docs/contributor/code-quality.md) | The lint and architecture ratchets (`pnpm lint:ts`, `pnpm lint:go`, the architecture tests): counts may fall, never rise |

## Structure rules

The code's shape is held by tests, not by review (`docs/contributor/code-quality.md`). In the
hub, top-level folders import down `HUB_LAYERS`, and every folder under `services/` is a module
imported from outside only through its `index.ts` (named re-exports, nothing else), importing
only modules in a lower `SERVICE_LAYERS` tier. No shipped file over 1,000 lines (TypeScript or
Go), no Go package over 4,000 (`internal/forgeapi` is the one held exception), and lint counts
only fall (`pnpm lint:ts`, `pnpm lint:go`; shipped source stays clean of the `SRC_CLEAN` rules).
Before splitting a file, pin its behaviour with characterization tests committed against the
old code; a split moves code and changes no behaviour.

## MCP servers

Use `context7` when you need documentation for a library (Svelte, Hono, Drizzle, Bun) rather
than answering from memory.

## Things agents get wrong

- **Run what CI runs before pushing.** Read `.github/workflows/ci.yml` (jobs `contract`, `hub`, `node-agent`, `console`, `worker`, `lint-ts`, `lint-go`); the commands are in [`CLAUDE.md`](CLAUDE.md) rather than guessing; the commands are there.
- **Snapshots and goldens pass in a bare environment and on Linux.** Run them under `env -i PATH="$PATH" HOME="$HOME" CI=true bun test <file>`. Normalise platform strings (OS, arch) and `COLORTERM` in the test instead of recording your machine's.
- **Count lint baselines on a clean install** (`pnpm install --frozen-lockfile`), never on a tree with stray packages or a stale build.
- **No skipped tests.** Never `.skip`, `.only` or delete a red test to get green; fix it, or say in the PR why it is red.
- **Characterization test first.** Before a refactor that touches behaviour, commit a test against the old code and prove it can fail (revert the code, watch it go red).
- **Check the PR is still open before pushing to its branch.** PRs are often merged within minutes, and a push to a merged branch strands the work.
- **CI runs only for PRs into `main`** (and two dead branches). A PR stacked on another branch gets no checks: target `main`.
- **`gh pr edit` fails here** with a classic-Projects GraphQL error. Edit a PR with `gh api -X PATCH repos/SuperJackfruitLabs/agentpod/pulls/N -f body=...`.
- **Hub DB tests need Postgres:** the pgvector container on `:5434` and the explicit `DATABASE_URL` in [`CLAUDE.md`](CLAUDE.md). A run without it is not a pass.
- **CI pins Bun** (`bun-version` in `ci.yml`). Local Bun may differ and behave differently (exit listeners, for one); check `bun --version` before trusting a local result.
- **`apps/hub/typecheck-known-red-tests.txt`** holds the known-red test typecheck errors with exact counts. A rise fails, and so does an unrecorded fall: update the file when you fix one.
- **A `v*` tag deploys the hub and console to production and publishes the node-agent binaries** through the suite's shared release workflow (`.github/workflows/release.yml` and `.github/release/`, synced byte-identical from the suite's release kit: change them there, never here; settings in `.github/release-config.json`, scripts in `deploy/release/`). It needs main's `ci.yml` run to have passed for the tag's commit. Only the operator tags.
- **The Claude CI files are synced copies.** `.github/claude/claude-ci.mjs` and the `claude-review`/`claude-triage` workflows come from the suite's shared kit; change them there, not here. The advisory PR review follows [`REVIEW.md`](REVIEW.md).

