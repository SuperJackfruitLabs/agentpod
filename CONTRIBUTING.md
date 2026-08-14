# Contributing

AgentPod lives on GitHub: https://github.com/SuperJackfruitLabs/agentpod

> The repository moved owner on 2026-08-14. Roughly forty
> `github.com/rakeshgangwar/agentpod` URLs remain in the docs, the console, the landing site
> and — load-bearingly — the node-agent's self-update and install paths. They all still
> resolve today (GitHub redirects a transfer permanently; the release-asset download was
> verified at HTTP 200 on 2026-08-14), so nothing is broken. Sweeping them is its own change:
> the self-update path verifies downloads against `SHA256SUMS`, so it must be re-verified on
> a real host, not just find-and-replaced.

## Branch flow

Single maintainer, trunk-based. Work lands on **`main`**, gated by the required checks
(`contract`, `hub`, `node-agent`, `console`, `worker`) rather than by review — one per job in
`.github/workflows/ci.yml`, and `apps/hub/tests/unit/docs-claims.test.ts` fails if a job here
is missing from that list.

- Self-contained changes go straight to `main` once the suites for whatever you touched pass locally.
- Anything you want CI to prove *before* it lands — or that deserves a second look — goes on a short-lived branch and a PR. Dependabot updates land this way by default. Branch protection requires the head to be up to date with `main`, so rebase before merging.
- `develop` is no longer the integration branch. It remains as a historical ref; don't branch from it.
- Tagging `v*` on `main` triggers `release-node-agent.yml`, which publishes the node-agent binaries, `install.sh`, the systemd unit, and `SHA256SUMS` as release assets. A release missing any asset breaks node-agent self-update, which verifies against `SHA256SUMS` — check the release is complete before announcing it.

> **If a second contributor appears, go back to `develop` → PR → `main`.** The required checks are already configured for it; only this section changes.

## Commit style

Conventional-commit prefixes, scoped by area — match `git log`:

```
feat(node-agent): …
fix(hub): …
fix(console): …
ci(release-node-agent): …
docs: …
test(console): …
```

## Before you push

Run the suites for whatever you touched (see [TESTING.md](TESTING.md) for details and environment requirements):

```bash
cd apps/hub && bun test          # needs the test postgres — see TESTING.md
cd apps/node-agent && go test -race ./...
cd apps/console && pnpm check && pnpm test
```

## Deployment

Operators: see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (hub/VPS + console/Cloudflare Pages) and [docs/OPERATING.md](docs/OPERATING.md) (day-2 operations).
