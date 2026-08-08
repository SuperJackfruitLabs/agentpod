# UI Revamp Plan D — Overview, Agents & Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify all fleet status colors onto the `--status-*` token layer (with a scheme-accent audit fixing schemes whose accents collapse), and move Overview, Agents, and Activity onto the Crisp Console base — stat tiles, token heatmap, sortable agent table, DataTable-backed activity list.

**Architecture:** Plan D of the program (spec sweep steps 3+4), on Plans A–C. Verified facts: `statusBadgeClass` (`src/lib/utils/status-badge.ts`) maps to `chart-2/chart-4/chart-5/destructive/muted-foreground` via interpolated class strings (Tailwind-scanner-invisible — works only by luck of those utilities existing elsewhere); FleetHeatmap and activity's `resultClass` also bypass status tokens; AgentTable (326 lines) has NO sorting, hand-rolled filters, and its 9-cell row duplicated verbatim between grouped/flat branches; Activity renders a CSS-grid pseudo-table with an invalid `hsl(var(--muted)/0.3)` inline style; the command palette's `/?action=new-runtime` and `/?action=create-token` targets are DEAD (only `/nodes` handles `?action=`); `connect-banner` has an invalid `shadow-[0_0_16px_var(--primary)/15]`. Existing tests are text/testid-based except `OverviewStats` (asserts `text-primary` class) and `status-badge.test.ts` (asserts class fragments — will be rewritten).

**Tech Stack:** As before. Baseline: 265 tests / 37 files green, HEAD `659b4ab`.

## Global Constraints

- Commands from `apps/console/` in the worktree. After every task: `pnpm check` 0 errors, full `pnpm test` green, output pristine.
- Status colors ONLY via `text-status-*`/`bg-status-*`/`border-status-*` utilities written as FULL LITERAL class strings (never template-interpolated fragments — Tailwind v4 scans literals).
- Status is never conveyed by color alone: every colored status surface keeps its text label, count, or title/aria channel.
- Existing test testids and copy are load-bearing as noted per task; behavioral assertions extend, never weaken.
- Conventional commits + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Never touch `develop` or the main checkout.

---

### Task 1: Status color unification + scheme-accent audit

**Files:**
- Rewrite: `apps/console/src/lib/utils/status-badge.ts` + `status-badge.test.ts`
- Modify: `apps/console/src/lib/components/fleet/FleetHeatmap.svelte` (cell/legend maps), `apps/console/src/routes/activity/+page.svelte` (`resultClass` only — full restyle is Task 4)
- Modify: theme preset files under `apps/console/src/lib/themes/presets/` (accent fixes below)
- Test: `apps/console/src/lib/themes/preset-accents.test.ts` (new)

**Interfaces:**
- Consumes: `--status-*` tokens (Plan A).
- Produces: `statusBadgeClass(status)` returns full-literal classes on status tokens; new export `statusTextClass(status)` (text-only variant) and `statusBgClass(status)` (solid bg for heatmap cells) from the same module, driven by one internal `tokenFor()` mapping: running/online/healthy/active/connected → `running`; error/unhealthy/crashed → `error`; starting/stopping/warning/pending → `starting`; degraded → `degraded`; sleeping/hibernated → `sleeping`; stopped/offline/unknown/default → `stopped`. All five consumers (AgentTable ×2, NodesOverview, nodes/[id], runtimes) keep calling `statusBadgeClass` unchanged.

- [ ] **Step 1: Rewrite status-badge.ts (TDD — update its test first).** The class builder becomes a literal lookup, e.g.:

```ts
const BADGE: Record<StatusToken, string> = {
  running: "text-status-running border-status-running bg-status-running/10",
  degraded: "text-status-degraded border-status-degraded bg-status-degraded/10",
  starting: "text-status-starting border-status-starting bg-status-starting/10",
  stopped: "text-status-stopped border-status-stopped bg-status-stopped/10",
  error: "text-status-error border-status-error bg-status-error/10",
  sleeping: "text-status-sleeping border-status-sleeping bg-status-sleeping/10",
};
```

with `TEXT` and `BG` (solid, e.g. `bg-status-running`) records alike. Rewrite `status-badge.test.ts` to the new fragments (keep per-status coverage breadth).

- [ ] **Step 2: FleetHeatmap onto tokens.** `STATUS_CELL_CLASS` → `statusBgClass` values (`running→bg-status-running`, `stopped→bg-status-stopped/50`, `error→bg-status-error`, `unknown→bg-status-stopped/25`); `LEGEND_CLASS` similarly at reduced opacities, as full literals. Keep `data-testid`/`data-status`/aria/title exactly (12 tests).

- [ ] **Step 3: activity `resultClass`** → `ok: "text-status-running"`, `error: "text-status-error"`, else `"text-muted-foreground"`.

- [ ] **Step 4: Accent audit fixes.** In DARK and LIGHT variants of the offender schemes, adjust ONLY the five `cyber-*` accent values so each scheme keeps its palette character while the five statuses stay mutually distinguishable AND semantically sane (running reads green-ish/positive, error red-ish, degraded warm, starting cool, sleeping violet-ish — within the scheme's vibe). Offenders + minimum fixes (dark-mode values shown; adjust light analogously):
  - `creative/elegant-luxury.ts`: emerald `#fbbf24`→ a green (e.g. `#86c85a`-family gold-green), cyan `#f87171`→ a cool tone (e.g. `#7fb4c9`); amber stays.
  - `creative/rose-gold.ts`: emerald `#fcd34d`→ rose-compatible green (e.g. `#a3c9a8`), cyan `#fbbf24`→ cool rose-silver (e.g. `#9fb8c8`).
  - `brand/supabase.ts`: cyan `#4ade80`→ actual cyan (e.g. `#38bdf8`).
  - `nature/sunset-horizon.ts`: emerald `#feb47b`→ dusk green (e.g. `#8fbf87`).
  - `creative/mocha-mousse.ts`: spread the four warm tans — emerald→ mocha-green `#9aab7e`, cyan→ cool mocha `#8fa8b8`, magenta→ plum `#b78aa6`; amber stays.
  - `nature/ocean-breeze.ts`: red `#ffc5c5`→ visible coral-red (e.g. `#ff8a8a`).
  - `developer/cosmic-night.ts`: emerald `#64b5f6`→ green (e.g. `#7ee787`); `developer/midnight-bloom.ts`: emerald `#8ab4ff`→ green (e.g. `#8ad7a0`), and separate cyan/magenta periwinkles (cyan→ `#7fd4e8`).
  - `minimal/graphite.ts` (deliberately monochrome): keep grayscale character but make error clearly red (already `#f87171`), set degraded to a desaturated warm `#c9a98a`, keep running/starting/sleeping as distinct grays — acceptable because badges/legends always carry labels (constraint above).
- [ ] **Step 5: preset-accents.test.ts** — for every color scheme × {light,dark}: assert the five accent values are pairwise distinct strings, and (cheap semantic floor) that `cyber-red` ≠ `cyber-emerald`. Import `colorSchemes` from `$lib/themes/colors`.
- [ ] **Step 6: Green + commit** — run status-badge, FleetHeatmap, preset-accents, activity tests, then full gate. `git commit -m "feat(console): unify fleet status colors on status tokens, fix scheme accents"`

---

### Task 2: Overview restyle

**Files:**
- Modify: `apps/console/src/routes/+page.svelte`, `apps/console/src/lib/components/fleet/OverviewStats.svelte`, `NeedsAttention.svelte`, `RecentActivity.svelte`, `connect-banner.svelte`, `FleetHeatmap.svelte` (container styling only)
- Create: `apps/console/src/lib/utils/relative-time.ts` (dedupe the two identical `relativeTime()` copies — RecentActivity + activity page; both import it)
- Modify: `apps/console/src/lib/components/command-palette.svelte` (dead-action fix: `goto("/?action=new-runtime")` → `goto("/nodes?action=new-runtime")`, same for create-token; update its test if it asserts targets)
- Tests: existing component tests (testids/copy preserved: `stat-nodes/agents/updates`, `"3/5"` text, `all-healthy` exact text, `attention-*` testids + hrefs, 6-row cap, `view-all-activity`, `/connect your first node/i` + CTA name)

**Interfaces:** props unchanged everywhere.

Requirements:
1. `OverviewStats`: `cyber-card` ×3 → stat tiles in the HealthPanel vocabulary (`rounded-lg border p-4`, label `text-xs text-muted-foreground`, value `font-mono text-2xl font-semibold`). The `text-primary` class assertion in its test may be updated to the new accent class you choose — keep an is/isn't distinction assertion.
2. Page: `// fleet control plane` subtitle → plain `Fleet control plane`; `// fleet health` eyebrow → sans `text-sm font-medium` heading `Fleet health`; heatmap wrapper + attention/activity cards → `rounded-lg border p-4` Cards; error branch → inline error card + Retry (same pattern as HealthPanel); loading → Skeleton tiles; empty-state token card → crisp bordered card with mono curl line (keep copy).
3. `connect-banner`: remove the invalid `shadow-[0_0_16px_var(--primary)/15]` and gradient; crisp `rounded-lg border bg-card p-6`; keep heading/CTA copy exactly.
4. `RecentActivity` + `NeedsAttention`: `cyber-card` → Card vocabulary; import shared `relativeTime`; `Empty` NOT required here (they have their own compact empty texts with load-bearing testids — keep them).
5. Palette dead-action fix per Files above.

- [ ] **Step 1:** Implement all; run the five component test files + palette test.
- [ ] **Step 2:** Full gate; commit `feat(console): crisp overview — stat tiles, token heatmap, card grid`.

---

### Task 3: AgentTable rebuild — Table primitives, sorting, single row snippet

**Files:**
- Rewrite: `apps/console/src/lib/components/fleet/AgentTable.svelte`
- Modify: `apps/console/src/lib/components/fleet/AgentTable.svelte.test.ts` (extend; 24 existing tests' testids/copy load-bearing: `group-header`, `cpu-cell/mem-cell/uptime-cell`, `/no agents match/i`, row hrefs, badge text, `updating…` label, aria-pressed pill)
- Modify: `apps/console/src/routes/agents/+page.svelte` (restyle error branch + subtitle only; filters contract unchanged)

**Interfaces:**
- Consumes: `* as Table` primitives, `statusBadgeClass`, `Empty`.
- Produces: same props `{agents, externalFilter}`.

Requirements:
1. Rebuild markup on `Table.Root/Header/Body/Row/Head/Cell` (semantic `<table>` stays). ONE `{#snippet agentRow(agent)}` used by both grouped and flat branches — the 48-line duplication dies.
2. **Sorting:** clickable headers for Agent, Node, Status, CPU, Mem, Uptime — tri-state (asc/desc/none), sorting FLAT rows fully and WITHIN each group when grouped. Follow the DataTable pattern's accessibility: real `<button>` in the header, `aria-sort` on the `<th>`, keyboard-activatable. Null health values sort last in both directions.
3. Toolbar: search input + `updates only` pill (keep `aria-pressed`) + group/flat toggle in crisp vocabulary (`rounded-md border` chips, same idiom as LogTail's toolbar chips).
4. Header cells: sans `text-xs font-medium text-muted-foreground` (drop mono-uppercase-tracking).
5. Filtered-empty state: `Empty` component INSIDE the table region replacing the body (keep `/no agents match/i` copy in its title).
6. Status badge unchanged (`statusBadgeClass` from Task 1).
7. New tests: sorting by status (click Status header → error rows first on asc? define: sort by status token alphabetically is meaningless — sort by severity order error < degraded < starting < running < sleeping < stopped and document it), sorting by CPU with nulls last, aria-sort presence, sort-within-groups (grouped mode: order changes inside a group, groups' order untouched).

- [ ] **Step 1:** RED: add the 4 sorting tests. **Step 2:** rebuild. **Step 3:** all AgentTable tests + agents page tests green; full gate; commit `feat(console): agent table — table primitives, sortable columns, single row snippet`.

---

### Task 4: Activity on DataTable (+ DataTable carry-in fixes)

**Files:**
- Modify: `apps/console/src/lib/components/ui/data-table/data-table.svelte` (carry-in: filtered-empty-state — when `data.length > 0` but the filtered row model is empty, render an in-table `Empty` row/region titled `No matching rows` instead of a silent empty body)
- Modify: `apps/console/src/lib/components/ui/data-table/data-table.test.ts` (carry-in tests: global filter narrows rows via bound `filterValue`; pagination Next/Previous over pageSize-sized data; filtered-empty state)
- Rewrite: `apps/console/src/routes/activity/+page.svelte` + its test file (testids preserved: `activity-row` semantics move to DataTable rows — keep a `data-testid="activity-row"` on rows via column/cell rendering or a wrapper; `empty-state` testid for the no-data branch; relative-time strings; error message)

**Interfaces:**
- Consumes: `DataTable` (Plan A contract), `listActivity()`, `relativeTime` util (Task 2), `statusTextClass` (Task 1).
- Produces: Activity page = toolbar (search input bound to `filterValue`) + `DataTable` with columns Verb (mono), Station, Node (mono, truncated), Result (token-colored text via cell render), When (relative). `pageSize: 50`.

Requirements:
1. DataTable filtered-empty-state fix + the three carry-in tests FIRST (TDD in the data-table test file).
2. Activity page rebuild on DataTable; kill the CSS-grid pseudo-table, the invalid `hsl(var(--muted)/0.3)` inline style, `hover:bg-primary/3`, and the `cyber-card` shells (error/empty/table). Error branch → inline error card + Retry. No-data branch keeps `data-testid="empty-state"` (use `Empty` inside it).
3. Column cells: `Verb` mono; `Result` uses `statusTextClass("running"|"error")`-style mapping (ok→running, error→error, else muted) with the raw result text; `When` uses shared `relativeTime`.
4. If TanStack cell-render friction with Svelte snippets makes per-cell components heavy, a `columns` def using `cell: (ctx) => string` plain-text plus a `class` per column is acceptable — but Result's color then comes from a row-level class function; keep it accessible (text still present).

- [ ] **Step 1:** DataTable carry-ins RED→GREEN. **Step 2:** Activity rebuild, its tests updated. **Step 3:** Full gate; commit `feat(console): activity worklist on DataTable, filtered-empty + pagination coverage`.

---

### Task 5: Plan D gate (controller-run)

```bash
pnpm exec svelte-kit sync && pnpm check && pnpm test && pnpm build
grep -rn "cyber-card\|chart-2\|chart-4\|chart-5" src/routes/+page.svelte src/routes/agents src/routes/activity src/lib/components/fleet/OverviewStats.svelte src/lib/components/fleet/FleetHeatmap.svelte src/lib/components/fleet/NeedsAttention.svelte src/lib/components/fleet/RecentActivity.svelte src/lib/components/fleet/AgentTable.svelte | grep -v test
git push origin ui-revamp
```

Expected: gate green; grep returns zero non-test hits (NodesOverview/nodes/runtimes keep theirs until Plan E).
