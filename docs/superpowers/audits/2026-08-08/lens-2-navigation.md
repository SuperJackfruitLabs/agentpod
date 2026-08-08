# Lens 2 — Navigation, URL State & Information Architecture

Codebase: `apps/console/src` (SvelteKit SPA, adapter-static, `ssr=false`)

---

## P1 — High severity

### 1. `<title>` never reflects the current route — every page is "AgentPod"
**Files:** `src/app.html:7` (static `<title>AgentPod</title>`), and the absence of any `<svelte:head>` anywhere in `src/routes/**` or `src/lib/components/**` (grep for `svelte:head` returns zero hits repo-wide).

**Rule:** `<title>` matches current context per route.

**User impact:** Every route — Overview, Agents, Activity, Nodes, `/nodes/[id]`, station detail (health/logs/files/terminal/cleanup/activity tabs), Runtimes, Updates references, Settings, Login, Admin (`/admin/users`, `/admin/users/[id]`) — shows the browser tab title "AgentPod". A fleet operator with 6 tabs open (two node detail pages, a terminal session, the activity log, admin) cannot tell them apart from the tab strip, can't search browser history by page name, and bookmarks all save as "AgentPod". This is worse the more the console is used as an ops tool (multiple tabs is the expected workflow here).

**Fix sketch:** Add a `<svelte:head><title>{computed}</title></svelte:head>` to each `+page.svelte` (e.g. `"Nodes · AgentPod"`, `"{station.displayName} · AgentPod"`, `"{tab label} · {station} · AgentPod"` on the station page). A small `setTitle(parts: string[])` helper or a `<PageTitle>` snippet wired through `PageHeader` would cover all routes from one place and stop this from being repeated ad hoc.

---

### 2. Station detail tabs (health/logs/files/terminal/cleanup/activity) are not deep-linkable and don't participate in back/forward
**File:** `src/routes/nodes/[id]/stations/[stationId]/+page.svelte:29-30,96-98`
```ts
type Tab = "health" | "logs" | "files" | "terminal" | "cleanup" | "activity";
let activeTab = $state<Tab>("health");
...
function handleTabChange(tabId: string) { activeTab = tabId as Tab; }
```
The tab buttons rendered by `page-header.svelte:174-201` are plain `<button role="tab" onclick={...}>` — not `<a>`, no `href`, no query/hash param, no `goto`/`pushState`.

**Rule:** URL reflects state — tab selection must be deep-linkable; back/forward should work predictably.

**User impact:** This is the single most-used deep-dive screen in the product. An operator cannot:
- Send a teammate a link straight to "Terminal" or "Logs" for a specific station — every shared link lands on Health.
- Cmd/Ctrl-click a tab to open Logs in a new tab while keeping Health open in the current one.
- Use the browser back button to return to the previous tab; back instead leaves the station page entirely (goes to `/nodes/[id]`), which is surprising once a user has clicked through 2-3 tabs.
- Reload the page and stay on the tab they were working in (e.g. an open terminal session or a mid-cleanup review always resets to Health on refresh).

Compounding this: inside the Files tab, `FileBrowser.svelte` breadcrumb navigation (`revealDir`, `activePath`) is also local-only — the open file/directory isn't reflected in the URL either (see finding 5), so even a "Files" deep link couldn't restore file-open state.

**Fix sketch:** Drive `activeTab` from `?tab=logs` (or a route segment `/stations/[stationId]/[tab]`) via `page.url.searchParams` on read and `goto`/`replaceState` on tab change (non-scrolling, `noScroll: true`, `keepFocus: true`). Render the tab buttons as `<a href="?tab={id}">` (or equivalent) styled as tabs so keyboard/middle-click/cmd-click all work, matching the pattern the codebase already knows how to do correctly for row links (see "what's good").

---

### 3. Admin user list — search, role filter, banned filter, and pagination are all local state, not in the URL
**File:** `src/routes/admin/users/+page.svelte:46-58` (`pageIndex`, `searchQuery`, `roleFilter`, `bannedFilter` are plain `$state`, never read from or written to `page.url`).

**Rule:** URL reflects state — filters and pagination must be deep-linkable.

**User impact:** An admin cannot bookmark or share "banned users, page 2" or "role=admin search=jane" — the exact workflow admin screens exist for (triage banned accounts, audit admins). Refresh or back-navigation silently resets to page 1 / no filters, discarding whatever the admin was looking at, with no warning.

**Fix sketch:** Mirror `search`/`role`/`banned`/`page` into `page.url.searchParams` with `goto(url, { replaceState: true, keepFocus: true, noScroll: true })` on each filter/page change, and read initial values from `page.url` in `onMount`/module init before the first `loadData()` call.

---

## P2 — Medium severity

### 4. Fleet-wide table toolbar state (search, sort, group-by, "updates only") isn't URL-backed — Agents & Activity tables
**Sites:**
- `src/lib/components/fleet/AgentTable.svelte:54-71` — `searchQuery`, `groupByNode`, `sortKey`/`sortDir` are local `$state`; only the *initial* `filterUpdateAvailable` value is seeded from the URL (`untrack(() => externalFilter?.updatesOnly ?? false)`, line 59) — after that first render it's disconnected from the URL, so toggling it doesn't update `?updates=1` and it's lost on refresh.
- `src/routes/activity/+page.svelte:19,139` — `filterValue` (search box) is bound into `DataTable` but never synced to the URL.
- `src/lib/components/ui/data-table/data-table.svelte:22,28,50` — the shared `DataTable` component's `pageIndex` (client-mode pagination) and internal `sorting` state are always local; only `manualPagination` callers (admin users) even have the *option* of URL-syncing pageIndex, and none currently take it.

**Rule:** Pagination, sort, and filter text should be deep-linkable.

**User impact:** Sorting the Agents table by CPU, filtering to "updates only", switching to flat view, or searching Activity — none of it survives a refresh, a shared link, or a back-navigation from a station detail page. Users re-establish the same filter/sort every time they return, which is exactly the "state gets discarded" problem the rule targets. Lower severity than findings 2-3 because these are convenience filters on list views rather than the primary way users reach a specific record (the `?station=`/`?status=`/`?updates=1` deep-link *entry points* from Overview do work — see "what's good").

**Fix sketch:** Extend the existing `externalFilter` pattern in `agents/+page.svelte` to be bidirectional (write back to `page.url` on every toggle/sort/search change via `replaceState`), and do the same for Activity's `filterValue`. `DataTable` could optionally accept a `urlParam` prefix and own the sync itself so every future table gets it for free.

---

### 5. FileBrowser breadcrumb links use `href="#"` + `preventDefault()` instead of a real control
**File:** `src/lib/components/stations/FileBrowser.svelte:273`
```svelte
<Breadcrumb.Link href="#" onclick={(e: MouseEvent) => { e.preventDefault(); revealDir(seg.path); }}>
```
**Rule:** Links are real `<a>`/navigable elements; avoid fake `href="#"` click-handlers.

**User impact:** Minor here since `revealDir` only manipulates in-panel tree state (no real URL to navigate to, since finding 2 already established file/tab state isn't URL-driven) — but semantically this should be a `<button>` inside the breadcrumb, not an anchor with a dead `href` and a `preventDefault`. As written, middle-click/cmd-click do nothing useful (no new tab makes sense, but the affordance implies one exists), and it trips up anyone auditing the codebase for real `<a>` compliance.

**Fix sketch:** Swap to `Breadcrumb.Item`'s button variant (or a plain `<button type="button">` styled identically) since there is no URL for these to represent yet.

---

### 6. Deep link to a station that no longer exists shows a broken shell with no "not found" message
**File:** `src/routes/nodes/[id]/stations/[stationId]/+page.svelte:78-85`
```ts
onMount(async () => {
  try {
    const rows = await listStations(nodeId);
    station = rows.find((r) => r.id === stationId) ?? null;
  } catch { /* Capabilities will stay null — Terminal tab won't appear */ }
});
```
If `stationId` doesn't match any row (station removed/renamed on the node), `station` stays `null` forever. Nothing in the template checks for this: `PageHeader` falls back to raw `title={stationId}`, and Health/Logs/Files/Activity panels are still rendered and will each independently fail against a nonexistent station.

**Rule:** Deep links to entities that no longer exist must be handled gracefully; no dead ends.

**User impact:** A bookmarked or shared link to a station that's been un-adopted or a node that's been re-provisioned lands on a page titled with a raw UUID, tabs that silently fail one by one, and no single message telling the user "this station is gone, here's how to get back to the node." The same gap exists one level up: `src/routes/nodes/[id]/+page.svelte` shows the raw `id` as the title and empty "no stations" sections if the node itself doesn't resolve (line 93, 20-31) — no explicit "Node not found" state either, just a page that looks broken.

**Fix sketch:** After `onMount` resolves, if `station === null` (and the fetch didn't itself error), render an `Empty`-style "Station not found" panel with a link back to `/nodes/{nodeId}`, instead of rendering tabs/panels against a nonexistent id. Same treatment for the node page when `node` fails to resolve.

---

### 7. No custom `+error.svelte` anywhere — unmatched routes hit SvelteKit's bare default error page
**Files:** none exist under `src/routes/**+error.svelte`; `svelte.config.js` sets `fallback: "index.html"` for SPA routing.

**Rule:** No dead ends — 404s must offer a next step.

**User impact:** A mistyped URL, a stale bookmark to a route that was removed, or a link from an external tool pointing at a since-renamed path renders SvelteKit's generic unstyled error screen — no `AppShell`, no sidebar, no "back to Overview" link, doesn't match the app's chrome at all. It's a genuine dead end for anyone who lands there without already knowing to hit browser-back.

**Fix sketch:** Add a root `src/routes/+error.svelte` that reuses `PageHeader`/`Empty` with a link back to `/`.

---

## P3 — Low severity

### 8. Two "back" navigations use `onclick={() => goto(...)}` instead of `href`, inconsistent with the rest of the app
**Sites:**
- `src/routes/admin/users/[id]/+page.svelte:93` — `<Button ... onclick={() => goto("/admin/users")}>` for the back arrow.
- `src/routes/admin/+layout.svelte:53` — `<Button onclick={() => goto("/")}>Return to home</Button>` on the access-denied screen.

**Rule:** Links are real `<a>` elements supporting Cmd/Ctrl/middle-click.

**User impact:** Small but real — an admin who Cmd-clicks the back arrow on a user-detail page (to keep the list open while opening the detail... or vice versa, a common admin workflow) gets nothing; a normal click is the only way to navigate. `button.svelte` (`src/lib/components/ui/button/button.svelte:58-70`) already renders a real `<a>` whenever an `href` prop is passed, and this exact pattern is used correctly elsewhere (`nodes/[id]/stations/[stationId]/+page.svelte:133-140` passes `href="/nodes/{nodeId}"` to the same `Button`). This is a one-line fix in each spot.

**Fix sketch:** `<Button variant="ghost" size="icon" href="/admin/users">` / `<Button href="/">Return to home</Button>`.

---

### 9. Heading hierarchy skips h2 → h3 in the "no nodes yet" empty state
**Files:** `src/lib/components/fleet/connect-banner.svelte:55` (`<h3>[fleet] Connect your first node</h3>`), rendered directly under `PageHeader`'s `<h1>` on both `src/routes/+page.svelte:98` (Overview empty state) and `src/lib/components/fleet/NodesOverview.svelte:251` (Nodes empty state) — no intervening `<h2>` on either page.

**Rule:** Heading hierarchy h1–h6 sequential per page.

**User impact:** Low — only affects the pre-enrollment empty state (a new deployment with zero nodes), which is a narrow window in a fleet's lifecycle, but a screen-reader user in that state hears an h1 followed by an h3 with no h2, which reads as a structural skip.

**Fix sketch:** Change `connect-banner.svelte`'s heading to `<h2>`.

---

### 10. Station detail page shows no breadcrumb back to the parent node's name
**File:** `src/routes/nodes/[id]/stations/[stationId]/+page.svelte:123-145` — `PageHeader` is given `title={station?.displayName ?? stationId}` and `subtitle={station?.workspacePath}`; the node's hostname is never fetched on this page (only `listStations(nodeId)` is called) and never rendered anywhere in the header. The only way "up" is an unlabeled `ArrowLeftIcon` link.

**Rule:** Breadcrumbs/hierarchy — a user should always be able to tell where they are.

**User impact:** Someone arriving via a shared deep link (e.g. from the Agents table's `href="/nodes/{agent.nodeId}/stations/{agent.stationId}"`) sees only the station name — nothing on the page tells them which physical node it's running on unless they click the unlabeled back arrow and read the next page.

**Fix sketch:** Fetch the node summary (or accept it as a param) and show it as a small breadcrumb/subtitle segment, e.g. `subtitle="{node.hostname} · {station.workspacePath}"`, or a proper `Nodes / {hostname} / {station}` breadcrumb trail.

---

## What's already good

- **Real `<a>` links for primary navigation and card/row targets** — sidebar (`app-shell.svelte:133-146`), `BottomNav` items (`bottom-nav-item.svelte:23`), Node cards (`NodesOverview.svelte:284-330`), Agent table rows (`AgentTable.svelte:258-263`), Runtime table's node cell (`runtimes/+page.svelte:167-176`), Admin user row/`View` button (`admin/users/+page.svelte:157,201`), `NeedsAttention`/`RecentActivity` panel links (`NeedsAttention.svelte:26-58`, `RecentActivity.svelte:25`), `StationTree` rows — all real anchors with `aria-current="page"` where relevant, so Cmd/Ctrl/middle-click all work as expected.
- **Inbound filter deep-links from Overview → Agents are real query params** — `?station=`, `?status=`, `?updates=1` are read reactively from `page.url.searchParams` in `agents/+page.svelte:25-37` and composed correctly; the heatmap and "needs attention" panel both drive these, so *arriving* at a filtered Agents view via a link works, even though the table's own controls don't write back (finding 4).
- **`?action=` handling in `NodesOverview.svelte:85-126` is carefully engineered to avoid the exact back-nav re-trigger trap the rules warn about** — it uses `replaceState` immediately after consuming the param and tracks `handledAction` so a browser back-navigation onto a history entry that still carries `?action=new-runtime` doesn't reopen the dialog a second time. This is the one place in the codebase that explicitly reasons about the "state params re-triggering on back-nav" failure mode, and does it correctly.
- **Tab list a11y is solid within a single tab strip** — `page-header.svelte` implements proper `role="tablist"`/`role="tab"`/`aria-selected`/`aria-controls`, full arrow-key/Home/End roving-tabindex keyboard support, and disabled-tab tooltips (`page-header.svelte:61-94,163-210`). The only gap is that the tabs aren't URL-addressable (finding 2) — the interaction pattern itself is well built.
- **`DataTable` sortable headers use real `<button>` elements with `aria-sort` on the `<th>`**, not click-handlers on non-interactive elements (`data-table.svelte:113-146`).
- **Skip-to-content and heading hierarchy are otherwise clean** on every non-empty-state screen — one `<h1>` per page via `PageHeader`, sequential `<h2>`s where used (`nodes/[id]/+page.svelte:137,198`).

---

## Route map reference

```
/                                    Overview
/agents                              Agents (?station, ?status, ?updates deep-linkable)
/activity                            Activity
/nodes                               Nodes (?action=new-runtime|create-token)
/nodes/[id]                          Node detail
/nodes/[id]/stations/[stationId]     Station detail (health/logs/files/terminal/cleanup/activity tabs — NOT in URL)
/runtimes                            Runtimes
/settings                            Settings
/login                               Login (public route, no AppShell)
/admin                               → redirects to /admin/users
/admin/users                         Admin user list (filters/pagination NOT in URL)
/admin/users/[id]                    Admin user detail
```
No dedicated "Updates" route exists — update affordances are inline per-node/per-agent actions on Nodes/Agents/Overview, not a standalone screen.
