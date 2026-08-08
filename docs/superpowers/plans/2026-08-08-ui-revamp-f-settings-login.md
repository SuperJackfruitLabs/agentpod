# UI Revamp Plan F — Settings, Login & Atmosphere Purge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the dead theme components, the setup stub, and ~330 orphaned lines of app.css; restyle Settings (+ThemeSettings) and Login onto the Crisp base with `Field`/`PageHeader`/chip idioms; kill the OpenCode-era motifs (`[bracket]` headings, `// comments`, shouty-mono labels) on these surfaces.

**Architecture:** Plan F of the program (spec sweep step 6), on Plans A–E. Verified facts (2026-08-08 survey): `theme-picker.svelte` and `theme-toggle.svelte` have ZERO importers (toggle has a stale vi.mock in `admin/users/[id]/page.svelte.test.ts:34-36`; its scoped styles use broken `hsl(var(--border)/0.5)`); `cyber-scrollbar` has NO definition anywhere (no-op class, 3 call sites); setup route is a redirect stub whose only inbound link is settings' `handleDisconnect`; login/settings/theme-settings carry the remaining non-admin atmosphere classes; `theme-settings.svelte:97-100` and `theme-picker.svelte:51-54` hold the last inline chip literals; malformed arbitrary values exist (`shadow-[0_0_12px_var(--primary)/15]` in theme-settings:176/284, `color-mix` role chip in settings:105); login's `checkSignupStatus` uses a raw fetch with dead `checkingSignupStatus` state and an unguarded `$effect`; login has a dynamic `import()` inside an inline onclick and a hardcoded `AgentPod v0.1.0`; station detail line ~142 has the last `uppercase tracking-wider` badge in nodes/ (→ `HarnessBadge`).

**Tech Stack:** As before. Baseline: 406 tests / 41 files green, HEAD `732f851`.

## Global Constraints

- Commands from `apps/console/` in the worktree. After every task: `pnpm check` 0 errors, full `pnpm test` green, output pristine.
- Every app.css deletion is gated on a zero-consumer grep (the survey's counts are a guide, not proof — re-verify each class immediately before deleting it; a keyframe is deletable only with its last `animation:` reference).
- No new mono-uppercase labels; section headings sentence case; bracket/`//` motifs eliminated on touched surfaces.
- The admin tree (`src/routes/admin/**`) is Plan G — do not touch it except the ONE stale vi.mock removal noted in Task 1.
- Conventional commits + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Never touch `develop` or the main checkout.

---

### Task 1: Dead-code deletion + app.css purge

**Files:**
- Delete: `apps/console/src/lib/components/theme-picker.svelte`, `apps/console/src/lib/components/theme-toggle.svelte`, `apps/console/src/routes/setup/+page.svelte` (whole `setup/` route dir)
- Modify: `apps/console/src/routes/admin/users/[id]/page.svelte.test.ts` (remove ONLY the stale `theme-toggle` vi.mock lines ~34-36)
- Modify: `apps/console/src/routes/settings/+page.svelte` (`handleDisconnect` → `goto("/login")`) and ANY other `/setup` reference (`grep -rn '"/setup"\|/setup' src/` — the root `+layout.svelte` treats `/setup` as a bare route; update its allowlist/conditions so nothing references the deleted route)
- Modify: `apps/console/src/app.css` — delete, after per-class grep verification, the zero-consumer set from the survey: `cyber-btn/-primary/-danger` (~1321-1386), `session-activity-indicator`/`activity-dot`/`session-activity-badge`/`activity-dot-small`/`@keyframes activity-pulse` (~1256-1315), `health-indicator` block (~1412-1443), `scanlines` (~871-890), `ascii-border-top` (~1388-1410), `ticker-*` + keyframes (~1539-1548), `streaming-cursor`/`streaming-text-container`/`@keyframes cursor-blink` (~989-1007), `animate-collapsible-down/-up` + keyframes (~1024-1050), `animate-pulse-glow`/`pulse-slow`/`border-glow`/`glow-sweep` + keyframes, `@keyframes float`/`slide-in-right`/`node-pulse`, `stagger-4..8`, `cyber-card .no-lift` (~1111-1114), `touch-target`/`no-select`/`mobile-only`/`desktop-only` + unused responsive-container utils (~1470-1524, EXCEPT `scrollbar-hide` which page-header consumes — keep it).
- Modify: `apps/console/src/lib/components/theme-settings.svelte` — remove the two no-op `cyber-scrollbar` class usages (168/277) only (full restyle is Task 2).

**Interfaces:** nothing new; pure removal. The legacy `themePresets`/`setPreset` store surface stays (localStorage migration path uses it).

- [ ] **Step 1:** Grep-verify each deletion target (components, route, every CSS class) — record evidence in the report. STOP on any unexpected consumer.
- [ ] **Step 2:** Delete; update `/setup` references; remove stale mock.
- [ ] **Step 3:** `pnpm check && pnpm test && pnpm build` (build catches CSS syntax slips). Commit `chore(console): delete dead theme components, setup stub, ~330 lines orphaned css`.

---

### Task 2: Settings + ThemeSettings restyle

**Files:**
- Modify: `apps/console/src/routes/settings/+page.svelte` (+ its test — extend, don't weaken)
- Modify: `apps/console/src/lib/components/theme-settings.svelte`
- Create: `apps/console/src/lib/components/theme-settings.svelte.test.ts` (first tests — mock `$lib/themes/store.svelte` like the settings page test does, lines 57-82 there)

Requirements:
1. Settings page: drop `noise-overlay`/`grid-bg`/`mesh-gradient`/own title bar → `PageHeader title="Settings"` + standard `container mx-auto max-w-7xl px-4 sm:px-6 py-6` body (match sibling routes). Three sections → crisp Cards (`rounded-lg border p-4`/`p-6`): headings `Appearance` / `Connection` / `Account` (sentence case, `text-sm font-medium`; kill `[bracket]` motifs and `animate-fade-in-up stagger-N`).
2. Connection card: `CONNECTED_TO:` → `Connected to` label (`text-xs text-muted-foreground`) with the URL in mono; "Use different server" drops `border-chart-4/50 text-chart-4` → plain `variant="outline"`; disconnect goes to `/login` (Task 1 already changed the target — keep).
3. Account card: `NAME:/EMAIL:/ROLE:` → sentence-case labels; role chip's `color-mix` literal → `Badge variant="secondary"` (plain); Sign out button unchanged in behavior.
4. ThemeSettings: mode-selector chips → `cn(chipClass(active), "flex flex-col items-center gap-2 p-3")` (layout classes composed on top; drop the old `/30 bg-background/50` inactive tint); tab triggers drop `font-mono text-[10px] uppercase tracking-wider` + the `!important` overrides (let the refreshed Tabs primitive style them); the three mono-uppercase `<Label>`s → sentence case `text-sm font-medium`; the two malformed `shadow-[0_0_12px_var(--primary)/15]` selected-card literals → `ring-2 ring-primary` (valid, token-driven); custom-theme DELETE gets a `ConfirmDialog` (one-click destroy today); save row restyled inline (no Dialog needed).
5. Tests: settings page test keeps its 3 assertions (email, hub URL, Sign out); add one for `Connected to` label presence. New theme-settings test file (mocked store): renders the four mode options; clicking a mode calls `themeStore.setMode` with the value; custom-theme delete opens the confirm dialog and only calls `deleteCustomTheme` after confirm.

- [ ] **Step 1:** RED (new + extended tests) → implement → GREEN.
- [ ] **Step 2:** Full gate. Commit `feat(console): crisp settings — cards, sentence labels, safe theme delete`.

---

### Task 3: Login restyle (+ station-detail badge ride-along)

**Files:**
- Modify: `apps/console/src/routes/login/+page.svelte`
- Create: `apps/console/src/routes/login/page.svelte.test.ts` (first tests)
- Modify (ride-along): `apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte` line ~142 → `<HarnessBadge harness={station.harness} class="shrink-0" />` (import from `$lib/components/fleet/HarnessBadge.svelte`)

Requirements:
1. Shell: drop `noise-overlay`/`grid-bg`/`mesh-gradient`/`typing-cursor`/`animate-*`/`cyber-card corner-accent` → centered `max-w-md w-full rounded-lg border bg-card p-6` card on plain `bg-background`. Brand mark: replace the inline rotated-diamond svg block with the sidebar's idiom (`flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground` + `Server` icon) + `AgentPod` sans semibold.
2. Copy: `// connect_to_api` → `Connect to your hub`; `// authenticate_user` → `Sign in`; `// create_account` → `Create account`; `[error]` banners → the standard error-card idiom (`role="alert"`, `border-destructive/50 bg-destructive/5`) — ONE shared `{#snippet errorBanner(message)}` replacing the two duplicated blocks.
3. Forms → `Field` ×4 (API Endpoint w/ description; Name signup-only; Email; Password w/ conditional `Minimum 8 characters` description). Inputs drop the 4× repeated `font-mono bg-background/50 …` literal (plain `Input`; mono ONLY on the API-URL input — it's a URL). Submit buttons: sentence case (`Connect` / `Sign in` / `Create account`), no uppercase/tracking/mono; the two inline 12-line spinner SVGs → `<Spinner size="sm" class="text-primary-foreground" />`.
4. Plumbing fixes: `checkSignupStatus` — remove dead `checkingSignupStatus` state; guard the `$effect` against redundant re-runs (track last-checked apiUrl); keep the raw fetch (it's pre-auth; add a one-line comment saying why it bypasses the client) and the silent `signupEnabled = true` fallback. Inline dynamic `import("$lib/stores/connection.svelte")` onclick → the statically imported `disconnect` (import it at top). Remove the hardcoded `AgentPod v0.1.0` footer line entirely.
5. New tests (mock `$lib/stores/connection.svelte` + `$lib/stores/auth.svelte` module singletons; check how the root layout/other tests mock them, else vi.mock with minimal shape): disconnected → connect form (API Endpoint field + Connect button); connected → email form (Sign in) and toggle to signup shows Name field; signup disabled → toggle blocked with the disabled message.

- [ ] **Step 1:** RED → implement → GREEN.
- [ ] **Step 2:** Full gate. Commit `feat(console): crisp login — field forms, clean card, harness badge ride-along`.

---

### Task 4: Plan F gate (controller-run)

```bash
pnpm exec svelte-kit sync && pnpm check && pnpm test && pnpm build
grep -rn "noise-overlay\|grid-bg\|mesh-gradient\|cyber-card\|corner-accent\|typing-cursor\|animate-fade-in-up\|uppercase tracking-wider\|cyber-scrollbar" src/routes/settings src/routes/login src/lib/components/theme-settings.svelte src/routes/nodes 2>/dev/null | grep -v test
wc -l src/app.css
git push origin ui-revamp
```

Expected: gate green; grep zero non-test hits (setup/ no longer exists); app.css meaningfully below its pre-F line count. Remaining atmosphere consumers after F: the five admin files (Plan G), which then unblocks the final deletion of noise-overlay/grid-bg/mesh-gradient/cyber-card/corner-accent/status-indicator/.status-* component classes/typing-cursor/animate-fade-in-up/animate-fade-in/animate-pulse-dot/stagger-1..3.
