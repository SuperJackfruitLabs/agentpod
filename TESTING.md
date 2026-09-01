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

## Hub Matrix homeserver (membership tests only)

`tests/integration/identity-move.test.ts` asserts things about Matrix room
**membership** — who is in a room, and when. Those assertions are checked
against a real homeserver or they are skipped, never re-pointed at a fake: on
2026-08-31 three defects reached production behind green fakes, including one
that accepted a bare join into an invite-only room where the real server answers
`403 M_FORBIDDEN`. A fake can be written to agree with whatever the code
believes, which is exactly why a passing membership assertion against one is
worth nothing.

The file skips those tests with a loud warning naming what went unproven when
`MATRIX_TEST_HOMESERVER_URL` and `MATRIX_TEST_AS_TOKEN` are unset. **Setting
either one is intent, so a run that asks for a homeserver and cannot reach or
authenticate against it FAILS rather than skipping** — a skip is the right
answer to "nobody asked" and the wrong answer to "somebody asked and it did not
work". To run them,
stand up the same homeserver the fleet runs (`deploy/tuwunel/`):

```sh
mkdir -p hs/data hs/appservices
cat > hs/tuwunel.toml <<'EOF'
[global]
server_name = "hs.test"
database_path = "/var/lib/tuwunel"
port = 6167
address = ["0.0.0.0"]
allow_registration = true
yes_i_am_very_very_sure_i_want_an_open_registration_server_prone_to_abuse = true
allow_federation = false
appservice_dir = "/etc/tuwunel/appservices"
trusted_servers = []
EOF
cat > hs/appservices/agentpod.yaml <<'EOF'
id: agentpod-test
url: null
as_token: agentpod-test-as-token
hs_token: agentpod-test-hs-token
sender_localpart: ai-bridge
namespaces:
  users:
    - exclusive: true
      regex: "@agent_.*"
  aliases:
    - exclusive: true
      regex: "#agentpod_.*"
  rooms: []
rate_limited: false
EOF
docker run -d --name agentpod-test-hs -p 6167:6167 \
  -v "$PWD/hs/data:/var/lib/tuwunel" \
  -v "$PWD/hs/tuwunel.toml:/etc/tuwunel/tuwunel.toml:ro" \
  -v "$PWD/hs/appservices:/etc/tuwunel/appservices:ro" \
  -e TUWUNEL_CONFIG=/etc/tuwunel/tuwunel.toml \
  ghcr.io/matrix-construct/tuwunel:latest

cd apps/hub && MATRIX_TEST_HOMESERVER_URL=http://127.0.0.1:6167 \
  MATRIX_TEST_AS_TOKEN=agentpod-test-as-token \
  DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
```

`url: null` means the homeserver pushes no transactions at the appservice,
which is right for these tests: they drive the client half and never wait to be
called back. The homeserver's own name is read back off a registration by the
test rather than configured twice.

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
