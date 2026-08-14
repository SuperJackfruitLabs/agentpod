# AgentPod

AgentPod is a **fleet/facilities console for agent runtimes** — a single place to manage the environments that AI agents live in, wherever they run. For each runtime it manages the **filesystem, logs, terminal, config, health, lifecycle, cleanup, and provisioning**, across machines, harnesses, and network boundaries. It is **attach-first**: you point it at runtimes you already run, or let it provision new ones.

## Architecture — three tiers

```
   Operator (Svelte web console)
            │  HTTPS + WSS
            ▼
   ┌──────────────────────────┐     outbound WSS tunnels (NAT-friendly)
   │      AgentPod Hub         │◄──────────┬──────────────┬───────────────┐
   │   (Bun + Hono + Postgres) │           │              │               │
   │ • node/station registry   │       node-agent     node-agent      node-agent
   │ • connection broker       │       (VPS/server)  (laptop)       (provisioned)
   │ • enrollment + auth       │       ├ Hermes          ├ Claude Code
   │ • provisioning drivers    │       │  ├ coder-kai     └ Codex
   │ • audit + activity log    │       └ OpenClaw
   └──────────────────────────┘          ├ hanuman
                                         └ kubera
```

| Tier | Technology | Role |
|------|-----------|------|
| **node-agent** | Go (static binary) | Installed per host; dials *out* to the hub over WSS. Runs harness descriptors, executes contract verbs locally. No inbound ports — works behind NAT/CGNAT. |
| **hub** | Bun + Hono, Drizzle + Postgres | Registry, connection broker, enrollment, auth (Better Auth), audit, provisioning drivers. Self-hostable. |
| **console** | SvelteKit (adapter-static SPA) | Fleet-first UI: node list → station tree → capability panels (filesystem, logs, terminal, config, health, lifecycle, cleanup). |

## Harnesses detected

AgentPod ships descriptors for: **Hermes**, **OpenClaw**, **Claude Code**, **Codex**, **OpenCode**, **Pi**.
The list is `registerDescriptors` in `apps/node-agent/cmd/agentpod-node/registry.go`.

Each descriptor wraps the harness's native CLI/API to enumerate runtimes, locate config/logs/workspace, and implement lifecycle — without reinventing each harness's introspection.

## Quickstart

> Full instructions: [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) (production) · [docs/OPERATING.md](./docs/OPERATING.md) (day-2 ops)

**1. Run the hub**

```bash
# Prereqs: Postgres + bun
cd apps/hub
cp .env.example .env   # fill in DATABASE_URL, BETTER_AUTH_SECRET, ENCRYPTION_KEY, API_TOKEN
bun run src/index.ts   # auto-migrates on first start
```

**2. Build + deploy the console**

```bash
cd apps/console
PUBLIC_HUB_URL=https://<your-hub> pnpm build   # emits apps/console/build/
# Deploy build/ to Cloudflare Pages at console.<your-domain>
# (wrangler pages deploy ../console/build, or Git-integrated Pages project)
```

> The console must be served from a subdomain of the hub's registrable domain (e.g. `console.<your-domain>` when the hub is `hub.<your-domain>`). This keeps them **same-site** so the Better Auth session cookie is sent. Opening a raw `*.pages.dev` URL breaks auth — always use the custom domain. For local development any static server works (`npx serve build`).


**3. Enroll a node-agent**

```bash
# On the target host — downloads the prebuilt binary and installs a systemd service:
curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh \
  | sudo bash -s -- https://<your-hub> <token-from-console>
systemctl status agentpod-node   # node appears online in the console
```

> Binaries are published for linux/darwin × amd64/arm64 on every `v*` tag by `.github/workflows/release-node-agent.yml`.
>
> **From source (repo checkout):** `cd apps/node-agent && go build -o agentpod-node ./cmd/agentpod-node`, then `sudo bash scripts/install-node-agent.sh https://<your-hub> <token>`.

See [docs/OPERATING.md](./docs/OPERATING.md) for enrolling nodes, adopting stations, driving terminals/files/logs, and provisioning runtimes.

## Status

**Single-operator** — one admin account; signup closes after the first user. Releases are
tagged `v0.1.x`; see [CHANGELOG.md](./CHANGELOG.md) and `git tag` for where that has got to
(this line used to name a version and was 26 releases stale).

The **tenant-isolation boundary has landed** — a `tenants` table, a `tenant_id` on every
scoped table, and a `tenantScope()` helper that refuses to build a query without one
(`apps/hub/src/db/tenant-scope.ts`, pinned by `tests/unit/tenant-scope.test.ts`). Everything
today runs under the single bootstrap tenant `fleet_00000000000000000000`. What is still
ahead is what *uses* the boundary: orgs, principals, billing.

## Legacy / OpenCode era

The previous OpenCode-based product is frozen at tag **`v0.0.4-opencode`**. Archived docs are under [`docs/archive/`](./docs/archive/).

## License

MIT
