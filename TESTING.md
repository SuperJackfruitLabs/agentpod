# Testing Guide

How to run and write tests for AgentPod's three tiers. CI runs five required
jobs on every PR: `contract`, `hub`, `node-agent`, `console`, `worker`
(`.github/workflows/ci.yml`). That list is checked, not remembered —
`apps/hub/tests/unit/docs-claims.test.ts` fails when a CI job is not named here.

## Quick start

```bash
# Contract package (shared zod schemas)
cd packages/contract && bun test

# Hub (Bun + Hono + Drizzle) — needs the test postgres, see below
cd apps/hub && bun test
cd apps/hub && bun run test:unit          # tests/unit only
cd apps/hub && bun run test:integration   # tests/integration only

# Node-agent (Go) — always with the race detector
cd apps/node-agent && go test -race ./...

# Console (Svelte 5 + vitest)
cd apps/console && pnpm check   # svelte-check
cd apps/console && pnpm test    # vitest (jsdom)
```

## Hub test database

Integration tests (and several `src/**/*.test.ts` files) need Postgres **with
pgvector** on `localhost:5434`:

```bash
docker run -d --name agentpod-test-postgres \
  -e POSTGRES_USER=agentpod -e POSTGRES_PASSWORD=agentpod-dev-password \
  -e POSTGRES_DB=agentpod -p 5434:5432 pgvector/pgvector:pg16
```

Two gotchas, both learned the hard way:

- The image must be a **pgvector** image — test setup runs
  `CREATE EXTENSION vector`; plain `postgres:16` fails dozens of tests with
  `extension "vector" is not available`.
- Bun auto-loads `apps/hub/.env`. If yours pins `DATABASE_URL` to a dev
  database, override it explicitly for test runs:

```bash
DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
```

Migrations apply automatically via the test helpers (`ensurePgMigrations`).

Test files open with a `process.env.DATABASE_URL = process.env.DATABASE_URL || ...`
preamble "before any `src/` imports". Treat that as a comment, not a mechanism:
ESM hoists the `import`s above it, so `src/db/drizzle.ts` has already read the
variable by the time the assignment runs (and in a full run it is evaluated once,
for the whole process). **The `DATABASE_URL` on the command line is what actually
points the suite at the test database** — the preamble is a no-op fallback.

## Conventions

- **TDD.** Write the failing test first; watch it fail for the right reason.
  Bug fixes start with a regression test that reproduces the bug.
- **Hub**: unit tests live next to code (`src/**/*.test.ts`) or in
  `tests/unit/`; DB-touching tests in `tests/integration/`, each cleaning up
  its own rows in `afterAll`. Gateway/WS tests build a minimal Hono app rather
  than importing `src/index.ts` (which starts the sweeper and boot hooks).
- **Hub — never sleep for a barrier.** `bun test` runs every hub test file
  sequentially inside **one process with one module registry**: the
  `connectionManager`, the broker and the Postgres pool are shared by every one
  of them, so a file that passes alone runs under much more load in the full
  suite. (This used to say "all 55 files"; it is 75 and climbing, which is
  exactly why the number is gone rather than corrected.) Waiting a fixed number of milliseconds for something to become true is
  therefore a coin toss — the gateway's `onOpen` verifies an argon2id hash
  (~105 ms idle, more under load) before it registers the node, which is what
  turned a 150 ms sleep into issue #64's random reds. Wait on the condition
  with `waitForNodeOnline` / `pollUntil` from `apps/hub/tests/helpers/wait.ts`.
  A plain sleep is only correct when proving something does *not* happen.
- **Node-agent**: standard library only — `httptest` for hub stubs, temp dirs,
  injected command runners (see `selfupdate`'s `RunCommand` seam). Two
  macOS-specific traps: don't leave unreaped child processes named after
  things pgrep-based code searches for (zombies match `pgrep` by comm), and
  don't copy system binaries as test stubs (the trust cache SIGKILLs them —
  re-exec the test binary via a `TestMain` env hook instead, see
  `claudecode_test.go`).
- **Console**: vitest + @testing-library/svelte in jsdom. Global teardown
  lives in `src/vitest-setup.ts` — it flushes bits-ui's 24 ms scroll-lock
  timer after each test so dialog-mounting tests don't crash CI's Node with
  "document is not defined". Mock the API layer (`$lib/api/client`) with
  `vi.spyOn`, not fetch.

## Live verification

Unit suites are necessary, not sufficient — features that touch the fleet get
verified against the real deployment (console at `console.agentpod.dev`, the
live nodes) before an issue is closed. When a release changes the node-agent,
roll one node first and watch `journalctl`/agent logs before rolling the rest.
