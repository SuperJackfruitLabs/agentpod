# Archive — historical only. Do not act on anything in here.

**Everything below this directory describes software that no longer exists in this
repository.** It is the documentation of the **pre-pivot OpenCode product** — a desktop
sandbox app with a management API, projects, workflows, Coolify/Forgejo/Keycloak
integrations and a Tauri shell. That product is frozen at the tag **`v0.0.4-opencode`**.

None of it is guidance. Every command, path, environment variable, table name, API route and
architectural claim in these 123 files should be assumed **wrong for the current codebase**
until proven otherwise against the code. Several of them are actively misleading — they use
the same words the fleet console uses (`stations`, `projects`, `API_TOKEN`, "Management API")
for different things.

If you are looking for how something works **today**, start at [`docs/README.md`](../README.md).

## Why it is kept

Because deleting it would lose the reasoning, not because it is still true. Two things in
here are genuinely useful as history: why the pivot happened, and what was already tried.

| Directory | Files | What it was |
|---|---|---|
| [`implementation/`](./implementation/) | 49 | Phase plans and feature inventories for the OpenCode product |
| [`pre-pivot/`](./pre-pivot/) | 30 | The product vision, technical architecture, user journey, getting-started, and the production-readiness phases (`pre-pivot/operations/`) |
| [`onboarding-system/`](./onboarding-system/) | 16 | A planned project-onboarding system with an agent knowledge base |
| [`architecture/`](./architecture/) | 11 | v2 architecture, auth, containers, session persistence, config system |
| [`features/`](./features/) | 9 | Admin panel, agent management, workflow builder, voice input, git features |
| [`agents/`](./agents/) | 8 | The personality-driven agent framework and catalogue |

## If a link brought you here

Some live files still point at pre-pivot paths. Known redirects:

| Old path | Now |
|---|---|
| `docs/production-readiness/` | [`pre-pivot/operations/`](./pre-pivot/operations/) — and for a real deployment, [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md) |
| `docs/ideas/` | [`pre-pivot/ideas/`](./pre-pivot/ideas/) |
| `docs/technical-architecture.md` | [`pre-pivot/technical-architecture.md`](./pre-pivot/technical-architecture.md) |
| `docs/getting-started/` | [`pre-pivot/getting-started/`](./pre-pivot/getting-started/) — superseded by the root [README](../../README.md) quickstart |
