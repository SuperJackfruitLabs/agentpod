# Contributing

AgentPod lives on GitHub: https://github.com/rakeshgangwar/agentpod

## Branch flow

- Day-to-day work lands on **`develop`**.
- Releases go `develop` → PR → **`main`** (required checks: `contract`, `hub`, `node-agent`, `console`).
- Tagging `v*` on `main` triggers `release-node-agent.yml`, which publishes the node-agent binaries, `install.sh`, the systemd unit, and `SHA256SUMS` as release assets.

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
