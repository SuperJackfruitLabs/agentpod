# AgentPod docs site

The user-facing documentation published at `docs.agentpod.dev`. Astro + Starlight.

```sh
npm install
npm run dev     # local preview
npm run build   # -> dist/
```

## Why this is not a pnpm workspace member

It uses npm, and it lives at the repo root rather than under `apps/`. Both are deliberate.

The site is Astro 7, which brings Vite 8. In a shared pnpm tree that re-resolves the root
`vitest` against that Vite and breaks vitest-based suites elsewhere in the repo. The same
change was made in kaambaan for the same reason, where it took out all 556 `apps/api`
tests on a change that touched no product code.

Excluding it with a `!apps/docs` negation was tried there and rejected: the negation does
remove it from the project list, but a `node_modules` directory inside a globbed path still
perturbs the tree pnpm builds. Living outside the `apps/*` glob removes the whole class of
problem — `pnpm install` and this site's `npm install` cannot interact, in either order.

The site ships nothing any app imports, so it has no claim on their dependency resolution.

## Claims are checked

`apps/hub/tests/unit/docs-claims.test.ts` reads these pages and fails if one names an MCP
tool that is not registered, an `apn` command that is not dispatched, a gated capability
that is not gated, or an internal link that does not resolve — and if a page is missing a
title or description.

`docs/README.md` names the failure mode it exists to prevent: *"a description far from its
code with no check."* Publishing doubles that surface, and these are the pages strangers
read.

Run it with `cd apps/hub && bun test tests/unit/docs-claims.test.ts`.
