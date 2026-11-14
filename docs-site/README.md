# AgentPod docs site

The user-facing documentation published at `docs.agentpod.dev`. Astro + Starlight.

```sh
npm install
npm run dev     # local preview
npm run build   # -> dist/
npm run check   # astro check; needs `npm i --no-save @astrojs/check typescript` first
```

## Why this is not a pnpm workspace member

It uses npm, and it lives at the repo root rather than under `apps/`. Both are deliberate.

The site is Astro 7, which brings Vite 8. In a shared pnpm tree that re-resolves the root
`vitest` against that Vite and breaks vitest-based suites elsewhere in the repo. The same
change was made in SuperPipeline for the same reason, where it took out all 556 `apps/api`
tests on a change that touched no product code.

Excluding it with a `!apps/docs` negation was tried there and rejected: the negation does
remove it from the project list, but a `node_modules` directory inside a globbed path still
perturbs the tree pnpm builds. Living outside the `apps/*` glob removes the whole class of
problem — `pnpm install` and this site's `npm install` cannot interact, in either order.

The site ships nothing any app imports, so it has no claim on their dependency resolution.

## What it wears

**The suite's docs theme**, `@superjackfruit/docs-theme`, vendored under `vendor/` with the
frontdoor and vibekit tarballs it needs (the same three files SuperDispatch's and SuperExchange's
docs sites carry; `.gitignore` keeps `vendor/*.tgz`). The whole design config is
`sjlDocs({ product: 'agentpod', status: 'lights on' })` in `astro.config.mjs`: vibekit's cobalt,
the suite's faces (self-hosted, so no page fetches a font from Google), the street and the phone
switcher, status badges, Copy Markdown and every page at `<page>.md`, the suite footer, the 404, the
edit link and the last-updated date. `src/docs-theme.d.ts`
types the theme's schema module, which ships as plain JavaScript, so `npm run check` passes under
`strict`.

The status is **lights on**: in production, still changing. Every `v*` tag releases the hub,
console and node binaries, and the surface still moves release to release.

**The sidebar uses the suite's groups**: Start, Use it, Build on it, Run it, Reference. The theme
warns at build time when a top-level group is anything else. Pages keep their folders (`use/nodes`
sits under Run it), so no URL changed when the groups did.

**For agents**: `/llms.txt`, `/llms-full.txt` and `/llms-small.txt` (`starlight-llms-txt`, through
the theme, with the description in `astro.config.mjs`). Search is Starlight's Pagefind and the
sitemap is Starlight's.

## Claims are checked

`apps/hub/tests/unit/docs-claims.test.ts` reads these pages and fails if one names an MCP
tool that is not registered, an `apn` command that is not dispatched, a gated capability
that is not gated, or an internal link that does not resolve — and if a page is missing a
title or description.

`docs/README.md` names the failure mode it exists to prevent: *"a description far from its
code with no check."* Publishing doubles that surface, and these are the pages strangers
read.

Run it with `cd apps/hub && bun test tests/unit/docs-claims.test.ts`.

## Publishing

Deployed by the `deploy-docs` job in `.github/workflows/ci.yml`, on every push to `main`
that passes the `hub` job — which is where `docs-claims` runs. A page that names a tool or
capability the code does not have should never reach the site.

### One-time setup

1. **Create the Pages project.** `agentpod-docs`, as a **direct-upload** project — do not
   connect it to the Git repo, or Cloudflare will race the CI job and deploy an unbuilt
   tree.

   ```sh
   npx wrangler pages project create agentpod-docs --production-branch=main
   ```

2. **Add the repo secret.** `CLOUDFLARE_API_TOKEN`, scoped to **Cloudflare Pages: Edit**.
   This repository has no Cloudflare secret today — the `worker` job only runs tests — so
   this is a new one rather than a widening.

3. **Point the domain.** `agentpod.dev` is on Cloudflare's nameservers (it was at Porkbun's
   when this was first written, which is why older notes describe a manual CNAME). Adding
   `docs.agentpod.dev` as a custom domain on the Pages project creates the DNS record.

### Checking it

The site is static with no runtime, so it either served the built tree or it did not:

```sh
curl -sI https://docs.agentpod.dev/start/what-it-is/
```
