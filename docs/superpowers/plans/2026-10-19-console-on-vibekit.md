# AgentPod console on vibekit: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. The headings say "Part N" (a repository guard forbids the older wording).

**Goal:** Restyle the AgentPod console (`apps/console`) onto vibekit 0.0.13: four vibes in light and dark, cobalt accent, a persistent navigation, phone layouts with a bottom bar, the same behaviour and copy (plus the listed defect fixes), as drawn in the approved mockups.

**Architecture:** Keep SvelteKit, Svelte 5 runes, Tailwind v4 and the shadcn-style components. Replace the theme system with vibekit's appearance model (cookie, `VibeRoot`). Map the console's shadcn token names to vibekit tokens in `app.css` (the compatibility layer), use vibekit components where their behaviour matches and keep local ones (restyled) where it does not, rebuild the shell and pages to the mockups, theme the third-party widgets from tokens.

**Tech Stack:** SvelteKit 2, Svelte 5, Tailwind v4, bits-ui, vibekit 0.0.13 (vendored tarball, `file:` dependency), vitest + @testing-library/svelte, Playwright + axe for the stubbed sweep (dev dependency), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-19-console-on-vibekit-design.md` (binding). **Mockups:** design canvas https://claude.ai/artifact/KabncsLYMYiTxSkSgs75YH, page "AgentPod" ("Restyle ·" rows). Local copies of the artboard HTML: `/private/tmp/claude-501/-Users-rakeshgangwar-SuperJackfruit/334b7847-9e4e-49d0-8bdf-e05d1ab11e31/scratchpad/ap2-mockups/project/AP2-*.dc.html` with renders in `.../scratchpad/ap2-shots/`. **Console facts:** the reports `agentpod-inventory/` (INVENTORY.md = every route, panel and state with strings; FACTS.md; DEFECTS.md; TOKENS.md = theme system and token mapping; THIRD-PARTY.md) at `/Users/rakeshgangwar/SuperJackfruit/superpipeline-worktrees/vibes-sweep-plan/.superpowers/sdd/2026-10-12-vibes-sweep/agentpod-inventory/`.

## Global Constraints

- Behaviour, routes, API calls, accessible names and copy unchanged, except the defect fixes and the words the mockups add (the Appearance control labels, "More", "About {agent}", the navigation labels, "Reload", "Try again"). Tests assert real strings and roles: keep them passing; a test that names a removed element (theme settings, font picker) is removed with it and listed in the PR.
- `cd apps/console && pnpm check && pnpm test && pnpm build` must pass at the end of every Part (CI job `console`). Never remove `src/vitest-setup.ts`'s teardown.
- vibekit's Tailwind export and the console's Tailwind theme are NOT both imported (name clashes). The shadcn token names stay; `muted`, `accent`, `secondary` are background fills in shadcn and are mapped deliberately (never a blind rename).
- No `.dark` class, no oklch strings in third-party widgets: `[data-theme="dark"]` and hex from vibekit tokens.
- No inline event handlers beyond what exists; no remote fonts (vibekit's bundle is self-hosted); no new product features (spec "Non-goals"); no hub, contract or node-agent change; no deploy; no merge.
- TDD: failing test first where behaviour or markup is asserted; a regression test per defect fixed. Public repo: no secrets, no cookies or tokens in files or logs.
- Disk is tight (about 3 GB free on the machine): install only the console's workspace (`pnpm install --filter @agentpod/console...`), no Docker, delete screenshot output when done.
- Commits: `git commit` with the two trailer lines the session gives (`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01AXbi6PzpHRt7n1bX4un6Mb`); never "Task N" or the section sign in tracked files. One PR for the whole restyle: branch `feat/console-vibekit`, opened for review, never merged by an agent.

## Inputs to test (implied by the spec, easy to miss)

1. First paint: with a saved vibe and theme the page never flashes another palette or font (the first-frame script runs before any stylesheet).
2. A saved old `agentpod-theme-mode` of dark/light seeds the new appearance once, then the old keys are ignored (and cleared).
3. Third-party widgets repaint when the vibe or theme changes while open (Monaco, xterm, Shiki code blocks).
4. A station with 5 capabilities missing shows only its real tabs; the tab strip never overflows the page at 360.
5. A long unbroken value (principal id, matrix id, file path, node hostname) never widens the page at 360 or 390.

## Parts

### Part 0: Worktree, vendored vibekit, theme system out, appearance in, token bridge

**Files:** Create `apps/console/vendor/superjackfruit-vibekit-0.0.13.tgz` (copy `/Users/rakeshgangwar/SuperJackfruit/vibekit-worktrees/artifacts/superjackfruit-vibekit-0.0.13.tgz`), `src/lib/appearance.svelte.ts` (adapt Superpipeline's `/Users/rakeshgangwar/SuperJackfruit/superpipeline/apps/web/src/lib/appearance.svelte.ts`: product `agentpod`, legacy key `agentpod-theme-mode`), `src/lib/vibekit-notes.md`; modify `package.json`, `src/app.html`, `src/app.css`, `src/routes/+layout.svelte`, `svelte.config.js` only if needed; delete `src/lib/themes/**`, `theme-settings.svelte`, the 21 self-hosted font families under `static/fonts` and their `@font-face`, the Lottie icons and sample-workflows that nothing references, `mode-watcher` and the dead `cyber-*` props.

- [ ] **Step 1:** worktree is `/Users/rakeshgangwar/SuperJackfruit/agentpod-worktrees/console-vibekit` (branch `feat/console-vibekit` from `origin/main`). `pnpm install --frozen-lockfile --filter @agentpod/console...` (check the lockfile policy; if the new `file:` dependency changes `pnpm-lock.yaml`, commit it).
- [ ] **Step 2 (tests first):** `appearance.test.ts`: choosing vibe/theme/accent writes `vk_appearance` and sets `data-vibe`/`data-theme`/`data-accent`/`data-product="agentpod"` on `<html>`; the old `agentpod-theme-mode` seeds once; a follow-the-sun setting resolves by the clock. Then implement.
- [ ] **Step 3:** `app.html`: the first-frame scripts (legacy seed, then vibekit's `HEAD_SCRIPT` inline: the console serves no CSP) and the first-frame background `<style>` per vibe (copy Superpipeline's, which a test there pins against drift: add the same `head-script.test.ts`). `data-product="agentpod"` on `<html>`.
- [ ] **Step 4:** `app.css`: import vibekit's `bundle.css` (fonts included), then the compatibility layer: shadcn tokens to vibekit tokens per the table in `agentpod-inventory/TOKENS.md` section 3 (background/foreground/card/popover/primary/secondary/muted/accent/destructive/border/input/ring/chart/sidebar/status), `@custom-variant dark (&:is([data-theme="dark"] *))`, the type roles (`t-page` etc.) re-based on `--vk-font-*`, radii from `--vk-radius-*`. Status tokens (`--status-running|degraded|starting|stopped|error|sleeping|unknown`) map to vibekit success, signal, accent/info, faint, danger, and a local violet for sleeping. Add `--sw`-style local tones for warning and info (copy `apps/web` Superpipeline or the Superwitness `tones.css` approach: hexes from the mockups' `--ap-warn*`, `--ap-info*`).
- [ ] **Step 5:** `+layout.svelte`: wrap in `VibeRoot`, call `appearance.init()`; remove the theme store, `ModeWatcher` leftovers and the sonner `mode` import (the toaster follows `data-theme`: regression test).
- [ ] **Step 6:** run `pnpm check && pnpm test && pnpm build`; fix the tests that referenced the theme store; list removed tests. Commit `Console: vibekit appearance replaces the theme system; token bridge`.

### Part 1: Primitives and third-party widgets

**Files:** `src/lib/components/ui/**`, `Terminal.svelte`, `ui/monaco-editor/monaco-editor.svelte`, `ui/markdown/markdown-viewer.svelte`, `ui/code-block/code-block.svelte`, `chat/Response.svelte`, `ui/sonner/sonner.svelte`, `ui/status/status.svelte`, the hard-coded palette classes listed in TOKENS.md 1.8.

- [ ] **Step 1 (tests first):** helper `src/lib/utils/vk-colors.ts` `tokenHex(name): string` reading the computed vibekit token and returning hex (vibekit tokens are hex); tests with jsdom stubs. xterm theme builder `terminalTheme()` returning background/foreground/cursor/selection and a 16-colour ANSI palette per vibe and theme (hex, with contrast >= 4.5 against the background for the 8 normal colours except black/white) and a test that it changes with `data-vibe`/`data-theme`; Monaco theme `defineMonacoTheme()` from tokens and re-applied on appearance change; Shiki: dual themes selected by `[data-theme]` instead of `.dark`; markdown preview sanitised (regression test with `<img onerror>` and `javascript:` links; use DOMPurify only if a sanitiser is not already a dependency, otherwise the existing one).
- [ ] **Step 2:** restyle the primitives: Button, Input/Textarea/Select, Badge, Card, Tabs, Table, Dialog, Sheet, Dropdown-menu, Popover, Tooltip, Skeleton, Switch, Avatar, Command, Breadcrumb get vibekit's look through the token bridge and per-vibe rules (`:where([data-vibe=...])`: radius, borders, density) matching the mockups (Dialogs board, Settings board). Where vibekit's own component matches behaviour (Dialog sizes, Sheet, Menu, Tabs with links, DataTable, CommandPalette, Notice, EmptyState, Loading, Toast, StateLabel, Face), write the failing test that pins the console's current behaviour first and switch only if it passes; record each wrap-or-build decision in `src/lib/vibekit-notes.md`. Fix the five dialogs with a doubled Portal and Overlay. Replace the 16 hard-coded palette uses with tokens (one shared warning box component).
- [ ] **Step 3:** run check, tests, build; commit `Console: vibekit look for the primitives; widgets themed from tokens`.

### Part 2: Shell, navigation, appearance control, phone chrome

**Files:** `src/lib/components/shell/**` (AppShell, TopBar, RosterRail, ContextRail, StateBar, AttentionLane, command-palette trigger), `src/routes/+layout.svelte`, a new `Navigation.svelte`, `AccountMenu.svelte` (account chip: email and initials, menu with Appearance, Sign out), `PhoneBar.svelte` (bottom bar), `MoreSheet.svelte`.

- [ ] **Step 1 (tests first):** navigation lists Fleet, Agents, Nodes, Runtimes, Activity, Settings and, only for admins, Admin, with `aria-current="page"` from the route; the account menu holds Appearance (vibe, Light / Dark / Follow the sun, accent) and Sign out; the hub pill states (no-hub, error, unreachable); the attention lane shows only real kinds (node offline, runtime error, drift, unoccupied) and NEVER an approval; the roster keeps `j`/`k`/`Esc`; Cmd/Ctrl+K still opens the palette; under 900px the bottom bar (Fleet, Agents, Activity, More; more marks itself current for Nodes, Runtimes, Settings, Admin) and the More sheet (Nodes, Runtimes, Settings, Admin for admins, Appearance, the account email, Sign out); the roster/stage toggle stays in the top bar.
- [ ] **Step 2:** implement to the mockups (`AP2-Overview-<Vibe>`, `AP2-Phone-Fleet-<Vibe>`, `AP2-Settings-<Vibe>` account menu open, `AP2-OverviewStates-<Vibe>` for the lane kinds): Daylight and Paper a top navigation row, Studio the ink rail with labelled icons, Quiet a plain list of links; vibekit's `AppShell`, `AppNav`, `Masthead`, `PhoneTabBar`, `AppearancePicker` where they match (record decisions). Keep the three-part layout (roster 272px, stage, context rail 320px at >= 1241px).
- [ ] **Step 3:** screenshot harness (needed from here): `apps/console/e2e/shots.mjs` (Playwright, serving the built `build/` with stubs for `/public/org-plane`, `/api/me`, `/api/fleet`, `/api/nodes`, `/api/agents`, `/health`, ... shaped as the contract says; sign-in bypass by seeding what the layout needs) taking each vibe x light/dark at 1440x900 and 390x844 into a git-ignored folder; compare by eye with the mockup renders and fix visible differences. (Playwright and axe as dev dependencies: use the already cached browsers; do not download new ones.)
- [ ] **Step 4:** run check, tests, build; commit `Console: shell, navigation and phone bottom bar on vibekit`.

### Part 3: Fleet pages (Overview, Agents, Nodes, Node, Runtimes, Activity, Settings, sign-in, errors)

**Files:** `src/routes/+page.svelte`, `agents/`, `nodes/`, `nodes/[id]/`, `runtimes/`, `activity/`, `settings/`, `login/`, `auth/callback/`, `+error.svelte`, fleet components (`AgentTable`, `NodesOverview`, `StatusRibbon`, `ActivityFeed`, node and runtime components).

- [ ] **Step 1 (tests first):** keep every existing page test; add tests for the defect fixes: `/agents?action=create` opens the Create dialog (palette "Create an agent" works); the error page offers "Reload"; a failed sign-in offers "Try again"; Settings' Appearance is the vibekit control (no theme picker); the plane notice for Users and Grants is rendered without the legacy controls above it.
- [ ] **Step 2:** implement to the mockups: `AP2-Overview`, `AP2-Agents`, `AP2-Nodes`, `AP2-Node`, `AP2-RuntimesActivity`, `AP2-Settings`, `AP2-SignIn` and their State sheets (`AP2-OverviewStates`, `AP2-AgentsStates`) in all four vibes; DataTable where its behaviour matches (sort, groups, row links), faces via vibekit `Face`, status via `StateLabel`/the local status component on the new tokens.
- [ ] **Step 3:** screenshot comparison per page and vibe (light and dark, desktop and phone) against `ap2-shots`; fix; run check, tests, build; commit per page group.

### Part 4: Station page: header, tabs, chat, context rail, About sheet, Health, Logs

**Files:** `src/routes/nodes/[id]/stations/[stationId]/`, `src/lib/components/stations/**` (chat: 24 files, Health, Logs, tabs, context rail, identity), the About sheet.

- [ ] **Step 1 (tests first):** keep the station page tests; add: the About sheet on phone holds Identity, Placement (purpose, node, harness, node agent version), Who may dispatch it (including the console's error alert "Couldn't read the grants." when the grants call fails), Voice, Restart, Stop (Restart and Stop also stay in the page header; both ask to confirm); no Identity tab on phone, the Identity tab remains between 901 and 1240px.
- [ ] **Step 2:** implement to the mockups: `AP2-Station`, `AP2-StationStates`, `AP2-ChatStates`, `AP2-HealthLogs`, `AP2-Phone-Station`, `AP2-Phone-Tabs` (Chat, Health, Logs parts). The transcript stays the user's and the agent's real words (Paper must not turn the chat into letters); permission cards, tool-call cards, reasoning disclosures, the composer and session switcher restyled; the chat states strip, toasts and the session history dialog as built.
- [ ] **Step 3:** screenshot comparison per vibe, light/dark, desktop, 1024 and phone; fix; check, tests, build; commit.

### Part 5: Station Files, Terminal, Changes, Cleanup, Activity, Configuration

**Files:** `src/lib/components/stations/` (FileBrowser, file-tree, file-preview, quick-open, ConfigEditor, Terminal, ChangesetPanel, CleanupPanel, ActivityPanel, Configuration panels, PosturePanel).

- [ ] **Step 1 (tests first):** file tree gets real tree semantics (role `tree`/`treeitem`, `aria-expanded`, arrow keys) and its rename/delete controls are visible and >= 44px on touch (regression tests); diff blocks use token tones (a single shared `DiffBlock` style for ChangesetPanel and ConfigEditor); xterm and Monaco repaint on appearance change (test with the theme builders from Part 1).
- [ ] **Step 2:** implement to the mockups: `AP2-Files`, `AP2-TerminalChanges`, `AP2-Config`, `AP2-Phone-Tabs` (the remaining tabs), in all four vibes; third-party widgets framed by the vibe, inside coloured by tokens.
- [ ] **Step 3:** screenshots; fix; check, tests, build; commit.

### Part 6: Admin, dialogs, palette

**Files:** `src/routes/admin/**`, `src/lib/components/admin/**`, fleet dialogs (`AgentCreate`, `AssignAgent`, `NewRuntimeDialog`, enrollment token, remove node/station), `ConfirmDialog`, `TypeToConfirmDialog`, `command-palette.svelte`.

- [ ] **Step 1 (tests first):** the admin guard shows "You do not have permission to access this area." only for a real 403 and a retryable error (with Retry) for network and 500 (regression); Users and Grants under the plane show only the plane notice and no Create user, signup switch or filters; the palette keeps its groups (Go to, Fleet, Authority for admins); the dialogs keep their copy.
- [ ] **Step 2:** implement to the mockups: `AP2-Admin`, `AP2-AdminStates`, `AP2-Dialogs` (all dialogs and the palette), vibekit `Dialog` with `consequences` where the console's copy fits, `CommandPalette` where grouping and keyboard behaviour match.
- [ ] **Step 3:** screenshots; fix; check, tests, build; commit.

### Part 7: Phone pass and tablet

**Files:** every page and the station tabs at <= 900px and 901 to 1240px.

- [ ] **Step 1:** implement the remaining phone boards (`AP2-Phone-Pages`, `AP2-Phone-States`, `AP2-Phone-Tabs`): tables become cards under 768px, the tab strips scroll sideways with edge fades as today, dialogs stack footers, sheets use the grab handle; the context rail is hidden below 1241px and the Identity tab appears between 901 and 1240px; harmonise the three breakpoint mechanisms (900, 1240, 700) into named constants in one file with tests.
- [ ] **Step 2:** screenshots at 390 and 360 for every page type; fix; check, tests, build; commit.

### Part 8: Sweep, docs, PR

- [ ] **Step 1:** extend the stubbed harness into `apps/console/e2e/sweep.spec.ts` (Playwright, axe `wcag2a`/`wcag2aa`): ALL page types and key states on Daylight (light and dark) and one representative per page type on Paper, Studio and Quiet, at 360, 390, 1024 and 1440; assert no axe violations, no horizontal page scroll, no console error, targets >= 44px under 1024px; add `pnpm e2e` (not part of the required `pnpm test`; document how to run it, and add a CI job only if it runs without a hub). Fix what it finds (CSS first; behaviour changes need a test and a note).
- [ ] **Step 2:** docs: `apps/console/README` (or the repo README's console section), `docs/DEPLOYMENT.md` console build note (no new build variables), `CHANGELOG.md`; `src/lib/vibekit-notes.md`; a vendor README for the tarball (how to update).
- [ ] **Step 3:** full run: `pnpm check && pnpm test && pnpm build` (with `PUBLIC_HUB_URL` as in CI), the sweep, `git status` clean. Push `feat/console-vibekit`; open a PR (GitHub, `SuperJackfruitLabs/agentpod`): what changes for a person, what did not, the mockups link, removed theme system (a one-time reset), tests removed with reasons, test results and the sweep matrix, known gaps (vibekit lacks warn/info tones and the product-local components; follow-up issue), the defects fixed, and "not deployed: Cloudflare Pages deploy after review". Wait for CI (`contract`, `hub`, `node-agent`, `console`, `worker`), fix failures, mark ready when green. Never merge.
- [ ] **Step 4:** follow-ups (not in this PR): issue on vibekit for warn/info tones and the product-local components; issue on agentpod for the things the mockups propose that need hub work.

## Self-review notes

Spec coverage: decisions 1 to 8 map to Parts 0 (1, 2), 2 (3, 4, 7, 8), 4 and 7 (4), 2 and 3 (5, 6); goals 1 to 4 to Parts 1 to 8; every defect in the spec's list has a test in Parts 1, 3, 5 or 6. Risks: the token bridge makes the console look like vibekit-coloured shadcn until the per-page work lands (Parts 2 to 7 close that gap); jsdom tests of Monaco and xterm need stubs; the stubbed-hub harness depends on the console's boot path (plane discovery, `/api/me`): Part 2 step 3 settles it.
