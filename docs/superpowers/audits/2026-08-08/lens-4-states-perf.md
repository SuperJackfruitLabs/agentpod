# Lens 4 audit — Loading/empty/error states, content resilience, performance

Codebase: `apps/console/src` (AgentPod fleet console, Svelte 5 SPA)
Scope: stores (connection/stations/nodes), API client, LogTail, Terminal, FileBrowser/FileTree, DataTable/AgentTable, Empty/Skeleton/Spinner primitives, and the route pages that drive them.

Findings are ordered by severity. `file:line` paths are absolute-relative to the repo; full absolute paths given in each heading's first mention.

---

## HIGH

### H1 — Fleet-wide data never refreshes or shows staleness; no hub-connectivity indicator anywhere in the shell
**Files:**
- `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/routes/+page.svelte` (Overview) — `loadFleet()` called once in `onMount`, never again
- `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/components/fleet/NodesOverview.svelte` — same, once on mount
- `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/routes/agents/+page.svelte` — same
- `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/stores/connection.svelte.ts` — `initConnection()` probes `/health` exactly once at boot; nothing re-probes it while the app is open
- `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/components/app-shell.svelte` — no connectivity/staleness affordance in the persistent chrome (sidebar/bottom nav)

**Rule:** Stale data honesty — when the connection to the hub drops or data ages, the UI must say so, not keep showing old data as fresh.

**Evidence:** `grep -rn "setInterval"` across `src` returns only `lib/themes/store.svelte.ts` (theme auto-mode clock). There is no polling, no WebSocket subscription, and no `setInterval`/visibility-based refresh anywhere feeding the fleet Overview, Nodes, or Agents pages — each does a single `fetch` in `onMount` and stops. `routes/settings/+page.svelte` prints `connection.apiUrl` as "Connected to …" using the same one-shot probe, so it can say "Connected" indefinitely even after the hub goes unreachable mid-session.

**User impact:** An operator watching the fleet dashboard during an incident (a node flapping offline, an agent crashing) sees a frozen snapshot from whenever the page was opened, with no visual cue that it's stale, no auto-refresh, and no manual "last updated Xs ago" affordance beyond a full page reload. This is exactly the failure mode called out by the brief: a fleet console silently showing outdated status as current.

**Fix sketch:** Add a lightweight poll (e.g. 15–30s `setInterval`, paused on `document.hidden`) to the three fleet list loaders, or a WS subscription if the hub already pushes snapshot deltas (LogTail/Terminal already have the reconnect infrastructure to copy). Surface a small "Updated Xs ago" / "Reconnecting…" indicator near `PageHeader`, and have `connection` re-probe periodically so `settings` and a persistent app-shell badge can reflect real-time reachability.

---

### H2 — RecentActivity swallows fetch errors and renders the same empty state as "genuinely no activity"
**File:** `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/components/fleet/RecentActivity.svelte:10-19`

```ts
onMount(async () => {
  try {
    const all = await listActivity();
    rows = all.slice(0, 6);
  } catch {
    // non-fatal: show empty state
  } finally {
    isLoading = false;
  }
});
```

**Rule:** "distinguish 'network failed' from 'no data' — a fleet console showing 'no nodes' when the hub is unreachable is lying" (verbatim from the brief).

**User impact:** If `/api/activity` 500s, times out, or the hub is unreachable, the widget on the Overview dashboard renders `data-testid="no-activity"` → "No activity yet", indistinguishable from a fleet that has genuinely never done anything. There's no retry affordance either.

**Fix sketch:** Track `error` state like every sibling panel does (`HealthPanel`, `ActivityPanel`, `CleanupPanel` all do this correctly) and render a small inline "Couldn't load activity — Retry" instead of collapsing into the empty state.

---

### H3 — FileTree write-mutation failures (delete/create/rename) are silently swallowed — dead end for the user
**File:** `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/components/stations/file-tree.svelte:165-228`

Three handlers all follow this pattern:
```ts
try {
  await del(stationId, path, { recursive: deleteTarget.type === "dir" });
  onDeleted?.(path);
} catch {
  // TODO: surface error
} finally {
  deleteTarget = null;
}
await refresh();
```
Same shape in `handleNewItemKeydown` (mkdir/create-file) and `handleRenameKeydown` (move).

**Rule:** "Errors: explain what went wrong + recovery action; no dead ends."

**User impact:** A user deletes a file, types Enter to create a new file, or renames an entry — if the hub/agent rejects the write (permission denied, path conflict, station offline), the dialog just closes and the tree quietly refreshes with nothing changed. There is zero feedback that the action failed; the user has to notice the file is still there. This sits right next to `ConfigEditor.svelte`, `CleanupPanel.svelte`, and `HealthPanel.svelte` in the same codebase, which all correctly surface `saveError`/`applyError`/`actionError` with a visible message — the pattern to copy already exists two files away.

**Fix sketch:** Add local `mutationError` state (or route through `toast.error`, which `routes/nodes/[id]/+page.svelte` and `AgentTable.svelte` already use for the same class of action) in all three handlers.

---

## MEDIUM

### M1 — Fleet-wide AgentTable has no pagination or virtualization
**File:** `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/components/fleet/AgentTable.svelte`

Unlike the generic `DataTable` (which paginates client- or server-side at `pageSize = 50` by default), `AgentTable` renders `filteredAgents`/`groupedAgents` directly via `{#each}` with no cap — every station in the fleet becomes a DOM row on `/agents` and inside each node group.

**Rule:** "virtualize lists >50 items … DataTable pagination covers tables?" — here it explicitly doesn't, because this table bypasses `DataTable` entirely.

**User impact:** Fine at current fleet sizes; becomes a real jank source (initial render + re-sort + re-filter cost) as the fleet grows past a few hundred agents, since every sort/filter keystroke re-sorts/re-renders the full unpaginated set.

**Fix sketch:** Either route through `DataTable`'s row model (adds pagination for free) or add a windowed/virtualized rendering for the flat and grouped views once agent count exceeds ~100.

### M2 — FileTree and FileQuickOpen render unbounded/unvirtualized lists
**Files:**
- `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/components/stations/file-tree.svelte` — recursive `{#each}` renders every expanded directory's children with no windowing
- `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/components/stations/file-quick-open.svelte` — walks up to `MAX_DIRS = 200` directories and dumps every collected file into one flat `Command.List`
- `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/components/ui/command/command-list.svelte:15` — `max-h-72 … overflow-y-auto`, a plain scroll container with no virtualization

**User impact:** A station workspace with thousands of files (e.g. a `node_modules`-adjacent monorepo — though `node_modules`/`.git`/`dist`/etc. are explicitly skip-listed, which helps) can still produce a large flat list rendered in full on every quick-open. Same for a deeply-nested/wide directory fully expanded in the tree.

**Fix sketch:** Cap the quick-open result count for render (it's fine to keep collecting for the "capped" search-budget banner, but only mount the top N matches, or add basic list virtualization via `content-visibility: auto` the way `LogTail` already does for lines — see "already good" below).

### M3 — LogTail's search filter runs uncapped, undebounced over up to 10,000 lines per keystroke
**File:** `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/components/stations/LogTail.svelte:198-214`

```ts
const visibleLines = $derived.by(() => {
  const query = search.trim().toLowerCase();
  return lines.filter((line) => { ... });
});
```
bound directly to the search `<input>` with no debounce, over a buffer capped at `MAX_LINES = 10_000`.

**Rule:** "debounce search/filter inputs."

**User impact:** Typing quickly into log search on a station with a large buffer re-filters (and re-renders `highlightSegments` for) up to 10k lines per keystroke; likely fine on modern hardware for a few thousand lines but the exact kind of per-keystroke full-list scan the brief calls out.

**Fix sketch:** Debounce `search` (~120–150ms) before it feeds `visibleLines`, or filter incrementally.

### M4 — `transition-all` used in the most common UI primitives
**Files:**
- `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/components/ui/button/button.svelte:7`
- `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/components/ui/badge/badge.svelte:5`
- `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/components/ui/switch/switch.svelte:22`
- `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/components/ui/tabs/tabs-trigger.svelte:16`
- `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/components/theme-settings.svelte:178,286`

**Rule:** "animate only transform/opacity, never top/left/width/height … avoid `transition: all`."

**Impact:** `Button`/`Badge`/`Switch`/`Tabs` are used dozens of times per page (every row action, every status pill), so Tailwind's `transition-all` (which watches every animatable CSS property, including border-width/box-shadow/background) is the app-wide default hover/press transition. Per-element cost is small, but it's the default everywhere rather than the narrower `transition-colors`/`transition-transform` most of the codebase otherwise uses correctly (`transition-colors` shows up 20+ times elsewhere, so the convention already exists).

**Fix sketch:** Swap `transition-all` → `transition-colors` (or `transition-[color,background-color,border-color,box-shadow]`) in these five spots; matches the pattern already used throughout the rest of the app.

### M5 — Loading-spinner animations don't respect `prefers-reduced-motion`
**Files:**
- `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/app.css:784-802` — the only reduced-motion block in the app, and it only disables the custom theme-color `transition`s (background/border/box-shadow), not animation utilities
- `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/components/ui/spinner/spinner.svelte:13` (`animate-spin`)
- `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/components/ui/skeleton/skeleton.svelte:15` (`animate-pulse`)
- Plus every `Loader2`/status-dot spinner site: `file-tree.svelte:298`, `NodesOverview.svelte:267`, `Terminal.svelte:368`, `page-header.svelte:144`, `UserFilters.svelte:118`, `markdown-viewer.svelte:107`

**Rule:** "honor `prefers-reduced-motion` (grep for it — the app has animations)."

**User impact:** Users who've set `prefers-reduced-motion: reduce` still get every skeleton pulsing and every spinner spinning throughout the app (loading states are the single most-encountered animation surface), since Tailwind's `animate-spin`/`animate-pulse` are unconditional keyframe animations and nothing in `app.css` scopes them down under the media query.

**Fix sketch:** Add `@media (prefers-reduced-motion: reduce) { .animate-spin, .animate-pulse { animation: none; } }` (or swap to `motion-safe:animate-spin` / `motion-reduce:animate-none` at each Tailwind call site) — loading spinners are exactly the class of "informational but non-essential motion" the guideline exists for.

### M6 — App bootstrap is a spinner-only full-page load with no shell skeleton
**File:** `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/routes/+layout.svelte:77-83`

```svelte
{#if shouldShowLoading}
  <div class="flex min-h-screen items-center justify-center bg-background">
    <div class="flex flex-col items-center gap-3">
      <Spinner size="lg" />
      <p class="text-sm text-muted-foreground">Connecting…</p>
    </div>
  </div>
```

**Rule:** "flag spinner-only full-page loads where a skeleton fits better."

**User impact:** Every hard refresh / first load blanks the entire viewport (no nav, no header) behind a centered spinner while `initConnection()` + `initAuth()` resolve, then pops in the full `AppShell` + page content at once — a jarring transition and the textbook case the guideline calls out, especially since the eventual layout (sidebar + header + content) is fully known ahead of time and could be skeleton-shaped instead.

**Fix sketch:** Render the static `AppShell` chrome immediately (nav items don't depend on auth state resolving) with a content-area skeleton, rather than blanking the whole page.

---

## LOW

### L1 — Station metadata fetch failures are silent, with visible but unexplained side-effects
**File:** `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte:78-85`
```ts
onMount(async () => {
  try {
    const rows = await listStations(nodeId);
    station = rows.find((r) => r.id === stationId) ?? null;
  } catch {
    // Capabilities will stay null — Terminal tab won't appear
  }
});
```
If this fetch fails, the Terminal/Cleanup tabs simply never appear and the header falls back to the raw stationId — with no error message or retry, the user has no way to tell "this station legitimately has no terminal" from "the fetch failed."

### L2 — Node detail page's own metadata load fails silently
**File:** `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/routes/nodes/[id]/+page.svelte:24-31` (`loadNode`) — comment says "non-fatal: node info is best-effort; stations still load," which is a reasonable degrade (stations still show, `retryAll()` exists), but there's no visible signal that node header info (hostname, version, update banner) is missing vs. absent.

### L3 — Fleet activity has no client-supplied paging/limit
**File:** `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src/lib/api/client.ts:226-238` (`listActivity`/`listFleetActivity`) — no `limit`/`offset` params; the console always requests the full audit log and paginates only client-side via `DataTable`. Fine today; a scale risk for a long-lived busy fleet's payload size / TTFB.

---

## What's already good

- **Terminal.svelte** and **LogTail.svelte** are genuinely strong reference implementations: explicit `connecting/connected/reconnecting/closed` state machine, exponential backoff (1s/2s/4s[/8s]) with a capped attempt budget, a manual "Reconnect"/"Retry" button that resets the budget, and clear on-screen status labels/colors. LogTail additionally batches SSE bursts (`FLUSH_INTERVAL_MS` leading+trailing flush) to avoid O(n²) reactive updates, ring-buffers to `MAX_LINES = 10,000`, and uses `content-visibility: auto` + `contain-intrinsic-size` per line as a lightweight virtualization technique.
- **Monaco and xterm.js (+ all its addons, including the optional WebGL renderer) are dynamic-imported**, not in the main bundle — confirmed via `import("@xterm/...")`/`import("monaco-editor")` inside `onMount`, never as static imports.
- **Consistent loading/error/empty triads** across nearly every top-level page (`routes/+page.svelte`, `NodesOverview.svelte`, `agents/+page.svelte`, `runtimes/+page.svelte`, `activity/+page.svelte`, `admin/users/+page.svelte`, `HealthPanel`, `ActivityPanel`, `CleanupPanel`) — each has a distinct skeleton state, a `role="alert"` error box with a `Retry` button wired to the same loader, and a purpose-built `Empty` state (often with a CTA), not a shared generic spinner.
- **Mutations consistently show pending state and disable their trigger**: lifecycle start/stop/restart, node/runtime update, runtime destroy/start/stop, ban/unban all flip a per-item boolean, relabel the button ("Updating…", "Destroying…", "Stopping…"), and surface failures via `toast.error` or inline `*Error` state — this is applied uniformly enough that it reads as a deliberate convention, not an accident.
- **Truncation/min-w-0 hygiene is solid**: `FileBrowser`/`FileTree`/`StationTree`/breadcrumbs/tab strips consistently pair `truncate` with `min-w-0` on the flex ancestor and `shrink-0` on the icon/badge siblings — no obvious broken-layout candidates found for long station names/paths.
- **`Empty` and `Skeleton` are shared, dimension-aware primitives** — skeleton heights in each page are hand-tuned to roughly match the real content (`h-36` for node cards, `h-20` for stat tiles, `h-9`/`h-10`/`h-12` for table rows), which is exactly the "skeleton mirrors final content" pattern the brief asks for, not a single generic spinner reused everywhere.

---

## Counts by severity
- High: 3
- Medium: 6
- Low: 3
