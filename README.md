# AgentPod

[![CI](https://github.com/SuperJackfruitLabs/agentpod/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SuperJackfruitLabs/agentpod/actions/workflows/ci.yml)
[![Node-agent release](https://img.shields.io/github/v/release/SuperJackfruitLabs/agentpod?label=node-agent)](https://github.com/SuperJackfruitLabs/agentpod/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**The fleet and facilities console for agent runtimes.** AgentPod manages the machines and
workspaces your agents live in: files, logs, terminals, configuration, health, lifecycle,
cleanup, and provisioning. Attach to runtimes you already run, or provision new ones.

[Documentation](https://docs.agentpod.dev) · [Node-agent downloads](https://github.com/SuperJackfruitLabs/agentpod/releases/latest) · [Self-hosting](docs/DEPLOYMENT.md) · [Operations](docs/OPERATING.md)

![AgentPod console showing the agent roster, fleet status, nodes needing attention, and activity](docs/assets/fleet-demo.png)

*Current console rendered locally with synthetic demo nodes, agents, and activity. No live fleet
or credentials are shown; this image illustrates the UI, not a deployment health check.*

## Highlights

- **Attach across hosts and harnesses.** Detect Hermes, OpenClaw, Claude Code, Codex,
  OpenCode, and Pi using harness-specific descriptors. Capabilities depend on the harness.
- **Reach hosts behind NAT.** Each node dials out to the hub over WSS; nodes need no inbound ports.
- **Operate from one console.** Inspect stations, browse files, tail logs, open terminals,
  and manage supported lifecycle and cleanup actions. The roster and attention lane surface
  offline nodes, unavailable stations, and node version drift.
- **Control agent access.** Principals, station occupancy, and dispatch grants connect runtime
  operations to agent identity. Optional Matrix and Superpipeline integrations connect the
  runtime plane to communication and work orchestration.
- **Roll updates deliberately.** Update a node with `apn update`, or request an individual or
  fleet update from the hub. Node agents do not upgrade on a timer.

AgentPod owns runtime management. [Superpipeline](https://github.com/SuperJackfruitLabs/superpipeline)
owns boards, cards, runs, and approval gates; [Supermessage](https://github.com/SuperJackfruitLabs/supermessage)
is the Matrix client.

## Architecture

```text
Operator → SvelteKit console → Hub (HTTPS + WSS)
                               ↑ outbound WSS connections
                         node-agent on each host
                               ↓
                         harness stations
```

| Component | Technology | Responsibility |
| --- | --- | --- |
| [`apps/node-agent`](apps/node-agent) | Go daemon | Detect harnesses; execute local station capabilities; enroll with and connect to the hub |
| [`apps/hub`](apps/hub) | Bun, Hono, Drizzle, Postgres + pgvector | Registry, broker, authentication, audit, provisioning, integrations |
| [`apps/console`](apps/console) | SvelteKit, Svelte 5, static SPA | Fleet roster, node and station panels, runtime and access management |
| [`packages/contract`](packages/contract) | TypeScript, Zod | Shared node/hub/console schemas |
| [`docs-site`](docs-site) | Astro, Starlight | User and integration documentation; separate npm project |

The descriptor registry is [`registry.go`](apps/node-agent/cmd/agentpod-node/registry.go).
See the [documentation map](docs/README.md) for current runbooks and historical designs.

## Run locally

Requires **Bun**, **Node.js 20+**, the repository-pinned **pnpm 10.18.2**, and a dedicated
**Postgres database with pgvector**. Building the node-agent from source also requires the
Go version in [`go.mod`](apps/node-agent/go.mod). The docs site requires Node.js 22.12+.

```bash
git clone https://github.com/SuperJackfruitLabs/agentpod.git
cd agentpod
corepack enable
pnpm install --frozen-lockfile
cp apps/hub/.env.example apps/hub/.env
```

Set `DATABASE_URL` in `apps/hub/.env` to your local pgvector database. The example's credentials
are for local development; use the [deployment guide](docs/DEPLOYMENT.md) for production secrets,
origins, cookies, and provisioning configuration. Hub migrations run on startup.

Start the hub and console in separate terminals, from the repository root:

```bash
pnpm --filter @agentpod/hub dev
```

```bash
PUBLIC_HUB_URL=http://localhost:3001 pnpm --filter @agentpod/console dev
```

Open `http://localhost:5173`. The first registered account becomes admin and public signup
closes; admins can manage users. AgentPod currently resolves requests to one bootstrap tenant,
not independently managed organizations. Principals and grants are implemented within that boundary.

### Enroll a host

Create an enrollment token in the console, then follow
[Enroll your first node](https://docs.agentpod.dev/start/first-node/). The
[release assets](https://github.com/SuperJackfruitLabs/agentpod/releases/latest) include the installer,
checksums, and node-agent binaries for **Linux and macOS, amd64 and arm64**. These are node-agent
releases; the hub and console run from source or deployed builds.

On an enrolled host, `apn status`, `apn logs`, and `apn restart` manage the service. See
[CLI documentation](https://docs.agentpod.dev/use/cli/) and the [operations guide](docs/OPERATING.md)
for enrollment, adoption, service installation, and updates.

### Deploy your own instance

Follow [Deployment](docs/DEPLOYMENT.md) for the full setup. Build the console with its intended
hub URL; it is embedded at build time:

```bash
PUBLIC_HUB_URL=https://hub.example.com pnpm --filter @agentpod/console build
```

The output is `apps/console/build/`. Serve it on a same-site custom domain such as
`console.example.com` and configure the hub's allowed origins and cookie settings. A raw
`*.pages.dev` preview is not interchangeable with that authenticated deployment.

## Development and validation

Branch from `main` and submit a scoped PR. See [contributing](CONTRIBUTING.md),
[project instructions](CLAUDE.md), and [TESTING.md](TESTING.md) for tier-specific requirements.
Run these commands from the repository root:

```bash
(cd packages/contract && bun test)
(cd apps/node-agent && go test -race ./...)
pnpm --filter @agentpod/console check
pnpm --filter @agentpod/console test
pnpm --filter @agentpod/console build
```

Hub tests need the separate pgvector test database described in [TESTING.md](TESTING.md),
including its migration preparation. Always pass an explicit test URL: Bun otherwise loads
`apps/hub/.env`, which may point to a development database.

```bash
(cd apps/hub && DATABASE_URL=postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod bun test)
```

CI additionally checks contract fixtures and provider wrappers and runs the separate
`cloudflare/worker-v2` suite. The workflow is the [complete check list](.github/workflows/ci.yml).

## Project status

Active development. [Releases](https://github.com/SuperJackfruitLabs/agentpod/releases) describe
node-agent builds; [CHANGELOG.md](CHANGELOG.md) records changes. Source on `main` may be newer
than the latest release. The previous OpenCode-based product is archived under
[`docs/archive`](docs/archive); it is not the current three-tier product.

## License

[MIT](LICENSE).
