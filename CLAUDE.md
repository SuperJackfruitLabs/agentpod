# AgentPod

Fleet/facilities console for agent runtimes. Three tiers:

- `apps/node-agent` — Go daemon on each host; detects harnesses (hermes, openclaw, claude-code, codex, opencode), dials the hub over WSS, serves station capabilities (health/logs/fs/terminal/lifecycle/cleanup), self-updates from GitHub releases.
- `apps/hub` — Bun + Hono + Drizzle/Postgres backend; node gateway, broker, station registry, Better Auth. See `apps/hub/CLAUDE.md`.
- `apps/console` — Svelte 5 SPA (vite, bits-ui, Tailwind); deployed to Cloudflare Pages.
- `packages/contract` — zod schemas shared by hub ↔ agent ↔ console. Change here first when a frame/API shape changes.

## Commands

```bash
cd packages/contract && bun test
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
cd apps/node-agent && go test -race ./...
cd apps/console && pnpm check && pnpm test && pnpm build
```

Hub tests REQUIRE both: a **pgvector** postgres on `:5434` (`docker run -d --name agentpod-test-postgres -e POSTGRES_USER=agentpod -e POSTGRES_PASSWORD=agentpod-dev-password -e POSTGRES_DB=agentpod -p 5434:5432 pgvector/pgvector:pg16`) and the explicit `DATABASE_URL` override — bun auto-loads `apps/hub/.env`, which may pin a dev DB. Details: `TESTING.md`.

On an enrolled node, `apn status|stop|start|restart|logs [-f]` and `apn service install|uninstall` manage the node-agent service (systemd on Linux, LaunchAgent on macOS) — see `docs/OPERATING.md`.

## Workflow

- TDD: failing test first, including a regression test for every bug fix.
- Branches: work on `develop`; release via PR → `main` (required checks: `contract`, `hub`, `node-agent`, `console`, `worker`; `strict`, so a branch must be up to date before it merges — and nothing, including a workflow, can push straight to `main`).
- Releases: tag `v*` on `main` → `release-node-agent.yml` publishes binaries + `install.sh` + `SHA256SUMS` (self-update verifies against SHA256SUMS — an incomplete release bricks fleet updates), then opens a `chore/fly-pin-<tag>` PR moving the Fly images' `ARG AGENTPOD_VERSION` onto it. Merge that PR before publishing Fly images; `fly/node-image/check-version-pin.sh` fails CI until you do.
- Console production builds need `PUBLIC_HUB_URL=https://hub.agentpod.dev` baked in at build time (a plain build points the deployed console at localhost).

## Gotchas

- Go tests: never leave unreaped children named like pgrep targets (zombies match by comm); macOS SIGKILLs copied system binaries — re-exec the test binary via a `TestMain` env hook for named process stubs.
- Console tests: global teardown in `apps/console/src/vitest-setup.ts` flushes bits-ui's scroll-lock timer — don't remove it, and don't add per-file workarounds.
- Features touching the live fleet get verified against the real deployment before their issue closes; deploy/ops runbooks are `docs/DEPLOYMENT.md` and `docs/OPERATING.md`.
