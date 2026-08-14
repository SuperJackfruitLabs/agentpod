# @agentpod/landing

The public marketing site — Astro + MDX + Tailwind. Not part of the fleet console; it ships
nothing the hub, console or node-agent depend on.

Until 2026-08-14 this file was the unmodified `create astro --template minimal` boilerplate,
which documented a project structure this app does not have.

## Pages

`src/pages/` — `index.astro`, `features.astro`, `developers.astro`, `download.astro`, plus a
`blog/` collection rendered from MDX.

## Commands

Run from `apps/landing/`, or from the repo root with `pnpm --filter @agentpod/landing <cmd>`:

```bash
pnpm dev       # astro dev --port 4321
pnpm build     # astro build → dist/
pnpm preview   # serve the build
pnpm check     # astro check
```

## Note

Its outbound links point at this repo's docs. They are ordinary links with no test behind
them, so they rot the way any link does — both of the two that existed on 2026-08-14 were
404s (`#quick-start` against a heading called Quickstart, and `docs/production-readiness/`,
which moved into `docs/archive/pre-pivot/operations/` at the pivot).
