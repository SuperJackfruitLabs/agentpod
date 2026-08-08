# UI Revamp Plan E — Nodes, Node Detail & Runtimes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Nodes list, Node detail, and Runtimes screens onto the Crisp Console base (PageHeader everywhere, DataTable for runtimes, Empty/error+Retry states, chip idiom on status tokens), unify the toggle-chip and retry vocabulary into shared utils, and close the Plan D carry-ins (relativeTime consolidation, updates deep-link).

**Architecture:** Plan E of the program (spec sweep step 5), on the shipped A–D base. Verified facts: NodesOverview renders its own header (not PageHeader), duplicates the enrollment curl string ×3, uses `.cyber-card` ×3 + `chart-2` copy-button + raw `text-yellow-500/90`; its `?action=` `$effect` with `handledAction` guard is FRESH (Plan D) — preserve semantics and its `$app/state` import (tests mock it). Node detail has NO test file, hand-rolled header, 3 cyber-cards, `$app/stores` (inconsistent), duplicate harness-badge markup vs StationTree. Runtimes is a hand-rolled grid pseudo-table with invalid `hsl(var(--muted)/0.3)` inline style, dead local `relativeTime` copy, chart-2 Start button, plain destroy confirm (vs ProvisionedNodeControls' TypeToConfirmDialog). NewRuntimeDialog's 4 form blocks are the first `Field` consumers. LogTail says "Retry", Terminal says "Reconnect" (socket-specific — keep); chip idiom literals live in LogTail.

**Tech Stack:** As before. Baseline: 380 tests / 38 files green, worktree HEAD = merge of origin/main (00135bf).

## Global Constraints

- Commands from `apps/console/` in the worktree. After every task: `pnpm check` 0 errors, full `pnpm test` green, output pristine.
- Chip idiom (exact literals, via the new shared util of Task 1): base `"rounded-md border px-2 py-1 whitespace-nowrap transition-colors"`; active `"border-primary bg-primary/10 text-primary"` (or status-token tone variants `border-status-X bg-status-X/10 text-status-X`); inactive `"border-border text-muted-foreground hover:text-foreground"`. Always with `aria-pressed` on toggles.
- Retry vocabulary: fetch/load failures → button label `Retry`; socket reconnects (Terminal only) keep `Reconnect`.
- Status colors ONLY via status tokens (full literals). `text-yellow-500/90` and `chart-2` uses on these surfaces are eliminated.
- Load-bearing test copy/testids per task notes — never weaken assertions.
- Conventional commits + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Never touch `develop` or the main checkout.

---

### Task 1: Shared utils — toggle-chip, relativeTime widening, HarnessBadge

**Files:**
- Create: `apps/console/src/lib/utils/toggle-chip.ts` + `toggle-chip.test.ts`
- Modify: `apps/console/src/lib/utils/relative-time.ts` (+ create `relative-time.test.ts`)
- Create: `apps/console/src/lib/components/fleet/HarnessBadge.svelte`
- Modify: `apps/console/src/lib/components/stations/LogTail.svelte`, `apps/console/src/lib/components/fleet/AgentTable.svelte`, `apps/console/src/lib/components/stations/file-preview.svelte` (adopt the utils; zero visual/behavior change)

**Interfaces:**
- `toggle-chip.ts` exports `chipClass(active: boolean, tone?: "primary" | "running" | "degraded" | "starting" | "error" | "stopped" | "sleeping"): string` returning the exact literals above (tone defaults `"primary"`; status tones use `border-status-X bg-status-X/10 text-status-X` full literals via a lookup record — no interpolation).
- `relative-time.ts` widens to `relativeTime(dateStr: string | null): string` — `null` → `"unknown"`; invalid date keeps returning `"?"` (existing try/catch). Existing callers (RecentActivity, activity page) never pass null — behavior unchanged.
- `HarnessBadge.svelte` props `{harness: string; class?: string}` → `<Badge variant="outline" class={cn("font-mono text-[10px] text-primary border-primary/40", className)}>{harness}</Badge>` (the exact markup currently duplicated in node-detail:165-170 and StationTree:78-82).

- [ ] **Step 1 (TDD):** `toggle-chip.test.ts` — assert exact class strings for active/inactive × primary/error tones. `relative-time.test.ts` — null→"unknown", recent→"just now", minutes/hours/days, invalid→"?". RED (files/behavior missing) → implement → GREEN.
- [ ] **Step 2:** Adopt: LogTail's local chip class expressions → `chipClass(...)` calls (its rendered class strings must remain identical — its tests keep passing); AgentTable's `chipClass()` local → shared; file-preview's local `relativeTime` copy → shared import with the null-guard now handled by the util (delete the local copy; `"unknown"` behavior preserved).
- [ ] **Step 3:** Green (LogTail, AgentTable, file-preview/FileBrowser, new util tests + full suite), commit `feat(console): shared toggle-chip, harness badge, null-safe relativeTime`.

---

### Task 2: NodesOverview restyle

**Files:**
- Modify: `apps/console/src/lib/components/fleet/NodesOverview.svelte` (+ its test file — extend only)
- Modify: `apps/console/src/routes/nodes/+page.svelte` (wraps in PageHeader if cleaner — see Step 1)
- Create: `apps/console/src/lib/components/fleet/EnrollmentCommand.svelte` (the curl block, deduped from 3 copies)

**Interfaces:**
- `EnrollmentCommand.svelte` props `{token: string; hubUrl: string; copied: boolean; onCopy: () => void; class?: string}` — renders the mono curl one-liner (`curl -fsSL {hubUrl}/enroll.sh | AGENTPOD_TOKEN={token} sh` — copy the EXACT current string from NodesOverview:168 when implementing) inside a crisp bordered block with the copy button (chip idiom; copied state uses tone "running"). The token must remain inside a single text node with the curl command (tests regex `/tok_.../` against one node).

Requirements:
1. Header: adopt `PageHeader` (title `Nodes`, subtitle `Connected machines`, actions snippet with the two existing buttons — New runtime keeps outline variant, Create enrollment token primary; drop `font-mono uppercase tracking-wider` from both). Keep the conditional rendering rule for the token button (loading OR nodes>0 OR provisioning>0) — it prevents a duplicate accessible name vs ConnectBanner's CTA.
2. The three `.cyber-card` blocks → crisp: token block → `EnrollmentCommand`; error → inline error card + `Retry` button (wired to `loadData`); empty-state token card → `EnrollmentCommand` inside the centered column.
3. Copy button `chart-2` classes → `chipClass(copied, "running")`; update-hint `text-yellow-500/90` → `text-status-degraded`; the ad-hoc mini Update button → chip idiom (`chipClass(false)` + hover, keep exact accessible name `Update`).
4. Node cards: `rounded-lg border bg-card p-4` vocabulary; keep every load-bearing text node exactly (`online`/`offline` standalone status text, `update: vA → vB` single text node, hostnames, hrefs, provisioning card contents).
5. `?action=` block, `$app/state` import, and `handledAction` guard: DO NOT restructure; restyle only around them.
6. Extend tests: one test asserting the error branch's Retry button refetches (mock reject-then-resolve).

- [ ] **Step 1:** RED (Retry test) → implement → all NodesOverview tests green.
- [ ] **Step 2:** Full gate; commit `feat(console): crisp nodes overview — PageHeader, enrollment command, token chips`.

---

### Task 3: Node detail restyle (+ first tests for the route)

**Files:**
- Modify: `apps/console/src/routes/nodes/[id]/+page.svelte`
- Create: `apps/console/src/routes/nodes/[id]/page.svelte.test.ts`
- Modify (adopt HarnessBadge): same file + `apps/console/src/lib/components/stations/StationTree.svelte`

**Interfaces:** consumes `PageHeader` (leading/back, status, actions), `Empty`, `HarnessBadge`, `statusBadgeClass`, stations store.

Requirements:
1. Header → `PageHeader`: title = `node.hostname ?? id` (mono is fine for the value — pass plain title; PageHeader's h1 styling governs), `leading` snippet = the back arrow link (keep `aria-label="Back to fleet"`), `status` prop from node.status (`online`→`running` variant, `offline`→`stopped`), actions snippet = agentVersion text + update hint (`text-status-degraded`, keep `update: vA → vB` single text node) + Update button + nothing else. `ProvisionedNodeControls` stays in the body below the header.
2. `$app/stores` → `$app/state` (`page.params.id`), matching NodesOverview; the new test file mocks `$app/state` the same way other route tests do.
3. The three cyber-cards → error card + Retry (store error; retry re-calls the three loaders) and two `Empty` components (`title="No stations detected"` / `title="No stations adopted yet"` — keep sentence copy distinct from StationTree's internal `"No stations adopted."`).
4. Detected station cards → crisp vocabulary + `HarnessBadge`; StationTree's inline harness badge markup → `HarnessBadge` (its test asserts `getAllByText("claude").length >= 2` — HarnessBadge renders the harness as its own text node, preserved).
5. Section headings: `Detected Stations` / `// ready to adopt` → heading + sans `text-sm text-muted-foreground` subtitle `Ready to adopt`; same for Adopted (`Active workspaces`).
6. New tests (this route had none): renders hostname + status badge; detected station card shows Adopt and calls `adopt(id, [key])` on click; adopt-all calls `adopt` with all unadopted keys; both Empty states render; StationTree receives adopted stations (presence via station name).

- [ ] **Step 1:** RED (new test file) → implement → GREEN.
- [ ] **Step 2:** Full gate; commit `feat(console): crisp node detail — PageHeader, empty states, shared harness badge`.

---

### Task 4: Runtimes on DataTable

**Files:**
- Modify: `apps/console/src/routes/runtimes/+page.svelte` + its test file
- Consumes: `DataTable` (`rowTestId` prop exists), `TypeToConfirmDialog`, `chipClass`, `relativeTime`, `Empty`.

Requirements:
1. Replace the hand-rolled grid pseudo-table with `DataTable`: columns Name (mono), Provider, Status (snippet cell: outline Badge + `statusBadgeClass`, keep `data-testid="status-badge"`), Created (shared `relativeTime(rt.createdAt)` — NEW column, fixture already provides createdAt), Actions (snippet cell with the Start/Stop/Destroy buttons). `rowTestId="runtime-row"`. NO sorting on the Actions column (interactive-cell rule: pass `enableSorting: false`); default order = API order (tests assert badge order — DataTable unsorted preserves input order).
2. Action buttons → chip idiom: Start `chipClass(false, "running")`-style (hover-activating variant is fine — keep exact `data-testid` hooks `start-btn`/`stop-btn`/`destroy-btn` and visibility rules: Start when stopped|error, Stop when online, Destroy unless provisioning|destroyed).
3. Destroy confirm → `TypeToConfirmDialog` with `confirmPhrase={runtime.name}`, message `This will permanently destroy the runtime. This action cannot be undone.`, `confirmLabel="Destroy"`. Update the destroy test to the ProvisionedNodeControls pattern (type the phrase into the placeholder input, then click the confirm button — keep or re-add `data-testid="confirm-destroy-btn"` if TypeToConfirmDialog passes through attrs; otherwise target the last button per the established pattern and note it).
4. Kill: `.cyber-card` ×3, the invalid inline `hsl(var(--muted)/0.3)` style, `hover:bg-primary/3`, the dead local `relativeTime`. Error branch → inline error card + `Retry`. Empty branch keeps `data-testid="empty-state"` + `empty-new-runtime-btn` (crisp card, copy `No runtimes yet` / `Provision your first runtime to get started` — update the test's `"no runtimes yet"` containment match if case-sensitive).
5. Subtitle `// provisioned containers` → `Provisioned containers`.

- [ ] **Step 1:** Update/extend tests first where behavior changes (destroy flow, empty copy case). RED → implement → GREEN (all 10 testids intact).
- [ ] **Step 2:** Full gate; commit `feat(console): runtimes on DataTable — token chips, type-to-confirm destroy`.

---

### Task 5: NewRuntimeDialog on Field + deep-link carry-in

**Files:**
- Modify: `apps/console/src/lib/components/fleet/NewRuntimeDialog.svelte` (+ test file, selector updates only)
- Modify: `apps/console/src/lib/components/fleet/NeedsAttention.svelte` (+ test), `apps/console/src/routes/agents/+page.svelte` (+ test), `apps/console/src/lib/components/fleet/AgentTable.svelte`

Requirements:
1. NewRuntimeDialog: the 4 label+control blocks → `Field` (`label`, `for` matching existing ids `runtime-provider/name/tier/harness`; error stays the dialog-level `role="alert"` block, not per-field). Load-bearing: placeholder `"Runtime name"`, trigger texts `docker`/`small`/`Generic`, button name `/^create$/i`, exact provisionRuntime payload. Extract the thrice-repeated Select value coercion into one local `const single = (v: string | string[], fallback: string) => Array.isArray(v) ? (v[0] ?? fallback) : v;`.
2. Updates deep-link (Plan D carry-in): agents page's `ExternalFilter` gains `updatesOnly?: boolean` parsed from `?updates=1`; AgentTable seeds its `updates only` pill from `externalFilter.updatesOnly` (URL wins on first render; pill stays user-toggleable after). NeedsAttention's "N updates available" href `/agents?status=running` → `/agents?updates=1` (update its href test). Add one agents-page test: `?updates=1` renders with the pill pressed (`aria-pressed="true"`) and only update-available rows shown.

- [ ] **Step 1:** RED (deep-link tests + any dialog selector churn) → implement → GREEN.
- [ ] **Step 2:** Full gate; commit `feat(console): runtime form on Field primitive, updates deep-link`.

---

### Task 6: Plan E gate (controller-run)

```bash
pnpm exec svelte-kit sync && pnpm check && pnpm test && pnpm build
grep -rn "cyber-card\|chart-2\|text-yellow-500\|hsl(var(" src/lib/components/fleet/NodesOverview.svelte "src/routes/nodes" src/routes/runtimes src/lib/components/fleet/NewRuntimeDialog.svelte src/lib/components/fleet/ProvisionedNodeControls.svelte src/lib/components/stations/StationTree.svelte | grep -v test
git push origin ui-revamp
```

Expected: gate green; grep zero non-test hits. Remaining cyber surfaces after E: settings, login, setup, admin (Plan F/G).
