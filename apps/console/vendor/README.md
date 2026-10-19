# Vendored vibekit

`superjackfruit-vibekit-0.0.13.tgz` is the suite's design system, vibekit, at version 0.0.13
(tag `v0.0.13` in the vibekit repository on the forge). The console depends on it through a
`file:` dependency in `apps/console/package.json`:

```json
"@superjackfruit/vibekit": "file:./vendor/superjackfruit-vibekit-0.0.13.tgz"
```

It is vendored so that the console builds anywhere (CI, Cloudflare Pages, a bare laptop) without
access to the forge or a private registry. vibekit requires Node 22 or newer.

## Updating

1. In a checkout of the vibekit repository, check out the new tag and build its tarball:
   ```bash
   git checkout v0.0.N
   pnpm install
   pnpm package && pnpm pack
   ```
2. Copy the resulting `superjackfruit-vibekit-0.0.N.tgz` into this folder and delete the old one.
3. Change the `file:` dependency in `apps/console/package.json` to the new file name.
4. From the repository root, run `pnpm install` (it rewrites `pnpm-lock.yaml`; commit both).
5. In `apps/console`, run the checks:
   ```bash
   pnpm check && pnpm test
   PUBLIC_HUB_URL=https://hub.agentpod.dev pnpm build
   pnpm e2e:sweep --vibes=daylight   # then paper, studio, quiet
   ```
6. Read vibekit's changelog for renamed tokens or components, and check
   `src/lib/vibekit-notes.md` for the places the console depends on them.
