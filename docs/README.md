# AgentPod Documentation

AgentPod is a **fleet/facilities console for agent runtimes** — see the root
[README](../README.md) for the product overview and architecture (node-agent →
hub → console).

## Living documents

| Document | What it covers |
|----------|----------------|
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Deploying from scratch: VPS hub (systemd + Postgres/pgvector + nginx), console on Cloudflare Pages, node-agent installs (linux systemd, macOS launchd, Docker provisioning) |
| [OPERATING.md](./OPERATING.md) | Day-2 operations: enrolling nodes, updates/self-update, service management per platform, logs |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Branch flow (`develop` → PR → `main`), commit style, release tagging |
| [../TESTING.md](../TESTING.md) | Running/writing tests per tier, the test-postgres requirements, conventions |
| [../CHANGELOG.md](../CHANGELOG.md) | Release history (`v0.1.x`) |

## Design history

The fleet console was designed and built through written specs and plans, kept
as records under [`superpowers/`](./superpowers/):

- [`superpowers/specs/`](./superpowers/specs/) — design specs, starting with
  the founding [fleet-console design](./superpowers/specs/2026-06-21-agentpod-fleet-console-design.md)
- [`superpowers/plans/`](./superpowers/plans/) — implementation plans
- [RELEASE-v0.1.0.md](./RELEASE-v0.1.0.md), [UI-UX-AUDIT-2026-06-29.md](./UI-UX-AUDIT-2026-06-29.md) — point-in-time records

## Research

[`research/`](./research/) — era-independent reference material, notably the
[multi-agent ecosystem survey](./research/multi-agent-ecosystem/) (protocols,
frameworks, governance).

## Archive

[`archive/`](./archive/) — documentation for the **pre-pivot OpenCode product**
(desktop sandbox app, management API, workflows). The OpenCode era is tagged
`v0.0.4-opencode`. Everything under [`archive/pre-pivot/`](./archive/pre-pivot/)
describes software that no longer exists in this repo; it is kept for history,
not guidance.
