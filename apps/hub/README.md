# Hub

The AgentPod fleet-console backend. Nodes dial *in* to it over WSS; the console talks to it
over HTTPS; it owns the node/station registry, the connection broker, enrollment, auth, the
audit log, and the provisioning drivers.

Until 2026-08-14 this file described the pre-pivot "Management API": projects, Coolify,
Forgejo, GitHub sync, and a `/api/projects` surface. None of that exists. The routes are
mounted in `src/index.ts` and that file is the list.

- **Runtime**: [Bun](https://bun.sh)
- **Framework**: [Hono](https://hono.dev) — chained routes, `AppType` export
- **Validation**: [Zod](https://zod.dev) via `@hono/zod-validator`, sharing `@agentpod/contract`
- **Database**: PostgreSQL (pgvector) via Drizzle ORM; migrations auto-apply on boot

## Quick start

```bash
bun install
cp .env.example .env    # local development values; production is docs/DEPLOYMENT.md
bun run dev             # :3001, hot reload
bun run start           # no reload
```

## Commands

```bash
DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
bun run typecheck       # KNOWN RED — see typecheck-known-red.txt
bun run db:migrate      # migrations also run automatically at boot
```

The test database is **pgvector** on `:5434` with the `DATABASE_URL` override — see
[`TESTING.md`](../../TESTING.md).

## Where to look

| For | Read |
|---|---|
| Architecture facts that bite (gateway, sweeper, lifecycle-write rules, bridge) | [`CLAUDE.md`](./CLAUDE.md) |
| The endpoint list | `src/index.ts` — it prints the routes at boot, and mounts them right above |
| Deploying this | [`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md) |
| Operating it | [`docs/OPERATING.md`](../../docs/OPERATING.md) |

## Authentication

Two mechanisms, and they are not interchangeable:

- **Console** — Better Auth **session cookies**. First signup becomes admin, then signup closes.
- **Nodes** — `Authorization: Bearer <nodeId>:<nodeSecret>` on the gateway WebSocket only.

`API_TOKEN` also works as a bearer on `/api/*`, authenticating as `DEFAULT_USER_ID`. It is a
full console-equivalent credential, not a read-only probe token — treat it accordingly.
