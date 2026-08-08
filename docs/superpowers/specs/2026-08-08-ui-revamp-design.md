# UI Revamp — Crisp Console

**Date:** 2026-08-08
**Status:** Approved
**Branch:** `ui-revamp`

## Problem

The console's components feel homemade in both directions: the heavy views (file browser, logs, terminal) lack table-stakes capability (search, filtering, tabs, resizable panes), and the everyday primitives (cards, tables, lists, forms) carry hand-rolled `.cyber-*` styling instead of leaning on a well-built base. The cyberpunk layer (noise, scanlines, glitch, corner accents) is a large part of why: every component fights custom CSS in a 1,748-line `app.css`.

## Goals

- **Better components everywhere** — both more capable and more refined. All screens, including admin/login/settings.
- **Evolve to a cleaner look** — the "Crisp Console" direction (see below), dropping the cyberpunk effect layer.
- **Keep the customization layer intact** — the theme store, ~20 color schemes, font pairings, and light/dark/system/auto modes continue to work unchanged. They keep writing the same token names.

## Non-goals

- No information-architecture changes: the route structure and nav grouping (Fleet: Overview/Agents/Nodes/Runtimes/Activity; System: Settings/Admin) stay as-is.
- No consolidation into `packages/ui` — it stays unused; that is a separate later decision.
- No backend (hub/node-agent) changes beyond what existing APIs already provide.

## Visual direction: Crisp Console

Chosen over "Quiet Terminal" (all-mono, denser) and "Soft Professional" (full SaaS, terminal DNA gone). Linear-style hybrid:

- **Sans-serif for headings and UI text; monospace reserved for data** — IDs, counts, paths, log lines, terminal. Terminal DNA kept where it carries meaning.
- **Crisp 1px borders, no shadows, 6px radius** (radius token changes to `0.375rem`), dense but breathable spacing.
- **Deleted:** noise overlay, grid/mesh backgrounds, scanlines, glitch/glow/ticker keyframes, `.cyber-card`/`.cyber-btn`/corner accents, `[bracket]` and `//` label motifs, uppercase-tracked mono headings.
- **Status colors become first-class theme tokens** (running/degraded/starting/stopped/error/sleeping) so badges, dots, heatmap, log levels, and terminal palette all derive from one place per scheme.

## Foundation layer

**Tokens & CSS.** `app.css` keeps: font-face blocks, `:root`/`.dark` oklch token set, `@theme inline` mapping, and a small app-utility layer. The ~650-line cyber design system is deleted incrementally — each class removed when its last consumer screen is migrated. New status-color tokens added to every theme scheme.

**Primitive refresh.** Vendored shadcn-svelte components in `apps/console/src/lib/components/ui/` are re-pulled from the current upstream registry. New primitives added:

- `Table` + a data-table pattern (sorting, filtering, pagination) — replaces hand-rolled tables in Agents, Activity, and Admin.
- `Resizable` panes (file browser split).
- `Breadcrumb` (file browser path).
- `Command` (upgrades the command palette).
- `Empty` state, `Field`/form composition, and a consistent `Spinner`/skeleton loading convention.

Custom keepers restyled to match: bottom-nav, inline-tabs, ConfirmDialog, TypeToConfirmDialog, monaco-editor, markdown viewer.

**`page-header` slims down.** From 344 lines to a simple title/actions/tabs bar. Emoji and Lottie icon support removed (Lucide only); collapsible mode removed.

**Dead weight removed** (after verifying no live usage): `@assistant-ui/react`, `react`, `react-dom`, `svelte-preprocess-react`, `@xyflow/svelte`, `@dagrejs/dagre`, and their CSS imports. `lottie-web` removed if page-header was its last consumer.

## Workhorse components

**File browser** (`stations/FileBrowser.svelte`, currently 502 lines):

- Resizable tree/preview split with drag handle.
- Multiple open files as tabs.
- Breadcrumb path with click-to-navigate.
- Fuzzy "go to file" (⌘P), integrated with the command palette.
- Rich preview: Monaco with syntax highlight for code, image preview, **markdown files render with a rendered/source toggle** (reusing the existing markdown component), binary fallback with metadata.
- File metadata strip: type, size, mtime.

**Log viewer** (`stations/LogTail.svelte`):

- Virtualized scrollback (10k+ lines without jank).
- Text search with match highlighting.
- Log-level detection + filter chips with counts (Error/Warn/Info/All).
- Follow-tail toggle that auto-pauses on scroll-up, with an "N new lines" resume pill.
- Line-wrap toggle, timestamp normalization, export/download of visible range.

**Terminal** (`stations/Terminal.svelte`):

- Scrollback search with match navigation (xterm search addon).
- Copy-on-select + right-click paste working across browsers.
- Terminal palette driven by the active theme's tokens (all schemes carry through).
- Fullscreen mode keeps the toolbar; inline reconnect status instead of silent drops.
- WebGL renderer where available.

## Screen sweep (order)

Each screen moves fully onto the new base; cyber classes are deleted with their last consumer. Each step ends in a mergeable, green state.

1. **App shell + navigation** — sidebar, bottom nav, command palette (on `Command`), slimmed page-header.
2. **Station detail** — showcase screen: health/logs/files/terminal/cleanup/activity tabs; all three workhorses land here.
3. **Overview** — stat tiles, heatmap, needs-attention, recent activity on new card/table primitives.
4. **Agents + Activity** — real data-table pattern (sorting, filtering, pagination).
5. **Nodes + Node detail + Runtimes** — list/detail cards, station tree, New Runtime dialog on new form primitives.
6. **Settings + Login** — new form/field pattern; theme customization UI kept and restyled; login two-step flow cleaned; OpenCode-era vestiges removed.
7. **Admin** — users page (792 lines) decomposed onto data-table + form primitives; user detail rebuilt.

## State contract (every screen)

- Every list/table has an `Empty` state.
- Every async view has a skeleton.
- Failures render an inline error card with retry — no silent blank panes.

## Testing & verification

- Colocated vitest/@testing-library tests updated per screen: behavior assertions stay, selectors change with markup.
- Playwright screenshot pass (desktop + mobile) at each phase, compared against the June ui-unification baseline shots in `docs/superpowers/screenshots/`.
- `pnpm check` and the full test suite green at every phase boundary.

## Delivery

Work happens on `ui-revamp`, PR'd, merged after CI passes, and deployed via the existing Cloudflare pipeline.

## Scope dispositions (recorded during implementation)

- **Image/binary preview** (file browser): the hub exposes no binary-read endpoint and backend changes are a non-goal, so image/binary files render a typed metadata card (icon, name, type, size, mtime) instead of pixels. Revisit if a binary endpoint ships.
- **Timestamp normalization** (log viewer): descoped from the v1 rebuild — lines render their timestamps as received. The viewer's level detection and search operate on ANSI-stripped text. Follow-up if mixed-format logs prove painful in dogfooding.
- **⌘P "go to file"**: implemented as the file browser's own quick-open (capped BFS over the station fs API), not as a global command-palette entry — the palette has no station context outside the station page. Revisit if global file search is wanted.
- **Screenshot passes**: deferred to a single visual pass at PR time (the console requires an authenticated hub session, making per-phase automated screenshots impractical mid-program); dogfood checklist for the live fleet: WebGL terminal renderer, ⌘P inside a focused Monaco pane, fullscreen Escape vs xterm, copy-on-select across browsers, `/` log-search shortcut.
