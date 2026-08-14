# AGENTS.md

**The project instructions live in [`CLAUDE.md`](./CLAUDE.md). Read that file.**

This one exists because `AGENTS.md` is the convention some agents look for. It deliberately
holds no second copy of the tiers, the commands or the workflow: until 2026-08-14 it held a
stale copy, and that copy described a **Tauri desktop app with a Rust backend, a `docker/`
directory, and `pnpm dev:frontend` / `pnpm dev:api` / `pnpm tauri build`** — none of which
have existed in this repo since the pivot. Every line an agent acted on was wrong.

Per-area notes that are worth reading before touching that area:

| File | Covers |
|---|---|
| [`CLAUDE.md`](./CLAUDE.md) | The tiers, the test commands, the branch and release workflow, the gotchas |
| [`apps/hub/CLAUDE.md`](./apps/hub/CLAUDE.md) | Hub internals: gateway, sweeper, runtime lifecycle rules, bridge, test conventions |
| [`TESTING.md`](./TESTING.md) | How to run and write tests per tier, and the test-postgres requirement |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Branch flow, commit style, what to run before pushing |
| [`docs/README.md`](./docs/README.md) | What every document in `docs/` is for, and which kind it is |

## MCP servers

Use `context7` when you need documentation for a library (Svelte, Hono, Drizzle, Bun) rather
than answering from memory.
