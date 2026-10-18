# AgentPod console on vibekit: design

Date: 2026-10-19. Status: scope approved by the operator (mockups first: the AgentPod boards on the design canvas; decisions below; "use the existing mockups, draw only what is missing"; implementation to PR approved 2026-10-19).

## Intent

The AgentPod console (`apps/console`, SvelteKit static SPA on Cloudflare Pages) has its own theme system (20 colour schemes, 20 font pairings, custom themes, in localStorage) and a shadcn-svelte + Tailwind v4 component set. Every other Super Jackfruit product now runs on **vibekit**: four user-selectable vibes (Daylight, Paper, Studio "Annual report", Quiet), each in light and dark, with an accent that defaults to the product colour (AgentPod = **cobalt**). The console joins them. **Behaviour, routes, API calls and copy stay as they are**, with the decisions below.

## Source of truth for the look

The design canvas "Vibes Product Mockups" (https://claude.ai/artifact/KabncsLYMYiTxSkSgs75YH), page "AgentPod": the rows titled "Restyle ·" (round 1: Overview, Agents, Station chat, Nodes, Admin, Settings with the account menu, Sign-in states, Phone Fleet, Phone Station) and the round-2 sheets (states, the station tabs, node page, runtimes and activity, admin states, dialogs, phone tabs, pages and states). The older AgentPod boards were reviewed and removed or marked superseded. The inventory of the console and the review of the earlier mockups are the reports `agentpod-inventory/` (INVENTORY.md, FACTS.md, DEFECTS.md, TOKENS.md, THIRD-PARTY.md, MOCKUP-REVIEW.md, COVERAGE.md) in the Superpipeline `vibes-sweep-plan` worktree under `.superpowers/sdd/2026-10-12-vibes-sweep/`.

## Decisions by the operator

1. Accent: **cobalt** (vibekit's `agentpod` product accent), not the old cyan mark; the accent stays user-selectable.
2. The old theme system is **removed**: no colour schemes, font pairings, custom themes or the 18:00 auto-dark rule. Appearance = vibe + light / dark / follow the sun + accent (cookie `vk_appearance`), in the account chip menu and on Settings. A one-time reset of the person's old choice is accepted.
3. **Navigation is added**: one persistent navigation (Fleet, Agents, Nodes, Runtimes, Activity, Settings, Admin for admins), alongside the roster rail, the stage and the station page's context rail.
4. **Phone**: a bottom bar (Fleet, Agents, Activity, More); More opens a sheet (Nodes, Runtimes, Settings, Admin, Appearance, account, Sign out); on an agent page an "About {agent}" sheet reaches identity, placement, who may dispatch it, voice, Restart and Stop (also kept in the page header). No Identity tab on phone.
5. **No "Needs you" approvals** (the hub does not derive them): the attention lane shows only real kinds.
6. **Copy**: today's words, plus defect fixes only (error page "Reload", failed sign-in "Try again", the admin guard says "You do not have permission to access this area." only for a real 403).
7. Account chip: email and initials as today. 8. No "Time of day" control.

## Goals

1. Every route, tab, dialog, sheet and state in the console renders in all four vibes, light and dark, at 1440, 1024, 390 and 360 wide, with no horizontal page scroll and no axe violations; touch targets >= 44px under 1024px.
2. The existing unit tests (they assert real strings and roles) pass; tests that name a removed element (the theme settings, the font picker) are removed with it, each listed in the PR.
3. The build stays a static SPA (`adapter-static`, `fallback: index.html`) on Cloudflare Pages; `PUBLIC_HUB_URL` handling and the dev proxy do not change.
4. Third-party widgets follow the vibe: Monaco, xterm (with an ANSI palette), Shiki and the markdown renderer read vibekit's tokens (hex), switch with `data-theme`, never with a `.dark` class or an oklch string.

## Non-goals

No new product features (no chat slash commands, attachments, usage display, structured error card, approvals in "Needs you", search, new filters); no change to the hub, the contract, the node agent or the API; no deploy (the operator deploys to Cloudflare Pages after review); no change to `apps/landing` or `docs-site`.

## Constraints

- `cd apps/console && pnpm check && pnpm test && pnpm build` must pass (CI job `console`). Do not remove `src/vitest-setup.ts` teardown.
- vibekit 0.0.13 is vendored as a tarball (`apps/console/vendor/superjackfruit-vibekit-0.0.13.tgz`, a `file:` dependency), as Superpipeline does. Its Tailwind export and the console's Tailwind theme both define `--color-primary`, `--color-muted`, `--color-accent`, `--font-*`, `--radius-*`: they are NOT both imported. The console keeps its shadcn token NAMES and maps them to vibekit tokens in `app.css` (a compatibility layer); shadcn's `muted`, `accent` and `secondary` are background fills there (vibekit's `muted` is a text colour, `accent` the brand colour), so each is mapped deliberately, never renamed blindly.
- Public repository: no secrets; names are fine.
- Tests: TDD, a regression test for every defect fixed.

## How it is built (layers)

A. **Foundation**: vibekit vendored, VibeRoot and the appearance store replace the theme store, fonts come from vibekit's bundle (the 21 self-hosted families and the font picker are deleted), a token bridge in `app.css`, the first-frame script in `app.html` (the console has no CSP, so vibekit's inline `HEAD_SCRIPT` is fine), third-party widget theming from tokens.
B. **Primitives**: the shadcn components get vibekit's look through the token bridge and per-vibe rules where radius or density differ; vibekit's own components (Dialog, Sheet, Menu, Tabs, DataTable, CommandPalette, Notice, EmptyState, Loading, Toast, StateLabel, Face, AppearancePicker) are used where their behaviour matches (tests decide), otherwise the local component stays and is restyled. Every decision is recorded in `apps/console/src/lib/vibekit-notes.md`.
C. **Shell and pages**: rebuilt to the mockups in order: shell and navigation, fleet pages, station page, admin, dialogs and palette, phone.
D. **Sweep**: a stubbed-hub screenshot and axe harness, defect fixes, docs, PR.

## Defects fixed on the way (from DEFECTS.md; each with a test)

The sonner toaster ignored the console's theme (ModeWatcher never mounted); Monaco ignored the colour scheme; xterm was fed oklch strings and had no ANSI palette; Shiki and markdown used a `.dark` class selector; hard-coded amber/emerald/green/red palette classes outside tokens (16 places); two different treatments of the Shiki background; the unsanitised `{@html}` in the markdown preview; the file tree had no tree semantics and its rename/delete buttons were invisible on touch; five dialogs doubled their Portal and Overlay; the palette's "Create an agent" opened `/agents?action=create`, which the page ignored; the admin guard showed "You do not have permission" for network and 500 errors; no flash-free first paint (font and scheme). Dead assets (Lottie files, sample workflows, unused fonts) are removed.

## What is left to the builder

Component internals and file layout, the exact CSS (taken from the mockup artboards), test structure. The builder may not change behaviour, copy (other than the listed fixes and the words the mockups add: the Appearance control labels, "More", "About {agent}", the navigation labels) or routes.
