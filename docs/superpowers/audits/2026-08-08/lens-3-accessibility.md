# AgentPod Console — Accessibility & Status-Communication Audit

Scope: `apps/console/src`. Read-only. All findings verified by reading the actual
component/CSS source (line-cited) and, for contrast claims, by converting the
project's own OKLCH/hex design tokens to sRGB and computing WCAG contrast
ratios (script-checked, not eyeballed).

Severity legend: **Critical** (blocks core task for AT/low-vision users, no
workaround) · **High** (blocks/severely degrades a common path) · **Medium**
(real gap, has partial mitigation or narrower reach) · **Low** (polish/hygiene).

---

## Critical

### 1. Desktop sidebar nav becomes unlabeled icon buttons at md–lg viewport widths
`src/lib/components/app-shell.svelte:104-150`

The `<aside>` is `w-16 lg:w-56` (icon rail from 768px–1023px, full width only
≥1024px). At that width the brand label, group labels, and every nav-item
label are `hidden lg:block` (`display:none`, removed from the accessibility
tree):
```svelte
<a href={item.href} ... aria-current={active ? "page" : undefined}>
  <item.icon class="h-4 w-4 shrink-0" />
  <span class="hidden lg:block truncate">{item.label}</span>
</a>
```
`item.icon` is a `@lucide/svelte` icon; its own `Icon.svelte` auto-applies
`aria-hidden="true"` whenever no `aria-label`/a11y prop is passed (verified in
`node_modules/.../@lucide/svelte/dist/Icon.svelte:11`). No `aria-label` is set
on the `<a>` itself. Result: in that ~768–1023px range — a common
tablet-landscape / narrow-laptop-window width — every primary nav link
(Overview, Agents, Nodes, Runtimes, Activity, Settings, Admin) has **zero**
accessible name for screen-reader/switch users, while still being fully
visible and clickable for sighted mouse users. This is the app's primary
navigation, present on every authenticated screen.
**Fix:** add `aria-label={item.label}` on the `<a>` (or wrap the hidden span
in `sr-only` instead of `hidden` so it's still in the a11y tree at every
breakpoint).

### 2. Station page tabs (Health/Logs/Files/Terminal/Cleanup/Activity) become unlabeled below `sm`
`src/lib/components/page-header.svelte:194-201`, consumed by
`src/routes/nodes/[id]/stations/[stationId]/+page.svelte:87-93`

```svelte
{#if tab.icon}
  {@const TabIcon = tab.icon}
  <TabIcon class="h-4 w-4" aria-hidden="true" />
{/if}
<span class="hidden sm:inline">{tab.label}</span>
```
Below the `sm` breakpoint the label is `display:none`; the icon is explicitly
`aria-hidden`. The only text fallback is a `Tooltip.Content` gated to
`sm:hidden` (mobile-only) — but hover/focus tooltips don't reliably fire on
touch, and even when they do, tooltip text supplies a *description*
(`aria-describedby`), not an accessible *name*, for the accname algorithm.
Net effect: on mobile, the tab bar for every station's core surfaces (this is
the primary way to reach a runtime's logs/terminal/health) announces as a set
of nameless `role="tab"` buttons.
**Fix:** same as #1 — `aria-label={tab.label}` on the tab `<button>`
regardless of viewport.

---

## High

### 3. Keyboard-highlighted menu items are ~1.1–1.3:1 contrast — effectively invisible — in the default theme
`src/lib/components/ui/dropdown-menu/dropdown-menu-item.svelte:23`,
`dropdown-menu-checkbox-item.svelte`, `dropdown-menu-radio-item.svelte`,
`dropdown-menu-sub-trigger.svelte`, `src/lib/components/ui/select/select-item.svelte:21`,
`src/lib/components/ui/command/command-item.svelte:18`,
`command-link-item.svelte:16`

All of bits-ui's menu-item primitives are styled `outline-hidden` and rely
*solely* on a background-color swap (`focus:bg-accent` / `data-highlighted:bg-accent`
/ `data-selected:bg-muted`) to show which item is focused during keyboard
navigation (arrow keys through DropdownMenu, Select, and the ⌘K Command
Palette). In the app's default color scheme (`default-neutral`, and also
`default-blue` and `minimal-graphite`), `accent`/`muted` are essentially the
same lightness as `background`:

| token pair | light | dark |
|---|---|---|
| `accent` vs `background` (default-neutral) | `#f5f5f5` vs `#ffffff` → **1.09:1** | `#262626` vs `#0a0a0a` → **1.31:1** |

(computed via OKLCH→sRGB→WCAG relative-luminance from the literal values in
`src/lib/themes/presets/default/neutral.ts:14,26,69`; WCAG 1.4.11 requires
**3:1** for UI-component state indicators — this is 2.5–3× under threshold).
Since the container itself is `outline-none`/`outline-hidden` with no ring or
border fallback, there is **no other visible cue at all** for the currently
focused item while arrowing through a menu, select, or the command palette in
the app's own default theme. Low-vision and sighted-but-not-hovering keyboard
users cannot tell which item is selected.
**Fix:** add a persistent `data-highlighted:ring-1 data-highlighted:ring-ring`
(or a left-border accent) that doesn't depend on the accent/background
lightness delta of whatever theme is active.

### 4. Shared focus-visible ring fails contrast in light mode, app-wide
`src/lib/components/ui/button/button.svelte:9` (`buttonVariants` base class),
`src/lib/components/ui/input/input.svelte:~24`

Every `Button` and `Input` in the app shares:
```
focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50
```
Computed against the default-neutral light background (`ring: oklch(0.708 0 0)`
vs `background: oklch(1 0 0)`):
- `border-ring` (full-opacity border swap): **2.58:1**
- `ring-ring/50` (the actual box-shadow ring, rendered at 50% opacity over
  white): **≈1.54:1**

Both are well under the WCAG 1.4.11 3:1 minimum for a focus indicator (dark
mode fares much better: 4.18:1 / 1.85:1 — still the box-shadow layer fails).
This is the shared focus style for essentially every button, icon button, and
text input in the product, in its default light theme — a systemic gap, not a
one-off.
**Fix:** raise ring opacity (e.g. `/70`+) or pair with a stronger
`border-ring` (not just the current pale gray) so the effective ring meets
3:1 against `--background` in the shipped default theme.

### 5. Terminal connection status is color-only and `aria-hidden` while connecting/connected/reconnecting
`src/lib/components/stations/Terminal.svelte:247-253, 364-380`

```svelte
<span class={cn("size-2 shrink-0 rounded-full", statusDotClass, ...)} aria-hidden="true"></span>
<span class="shrink-0 truncate font-mono text-xs text-muted-foreground">{stationId}</span>
{#if status === "closed"}
  <span class="shrink-0 text-xs text-status-error">{closeMessage}</span>
  ...
{/if}
```
The only signal for `connecting` / `connected` / `reconnecting` is the colored
dot, which is explicitly `aria-hidden="true"` — and there is no accompanying
text for those three states (only `closed` gets a text message). A
screen-reader user opening a live terminal session gets no indication
whatsoever that the session is still connecting, has connected, or has
silently started reconnecting after a drop — they only find out once it gives
up entirely ("Connection lost" / "Session ended"). Combine with finding #6:
even that text isn't in a live region, so it's only heard if focus happens to
land there.
**Fix:** give the dot a visually-hidden text twin (`sr-only`) mirroring
`closeMessage`'s pattern for all four states, and wrap it in a
`role="status" aria-live="polite"` region (see #6).

---

## Medium

### 6. LogTail connection status changes are never announced (no `aria-live`)
`src/lib/components/stations/LogTail.svelte:277-288, 306`

`statusLabel`/`statusColor` render "Connecting…" / "Connected" /
"Reconnecting…" / "Disconnected" as a plain `<span>` — no `aria-live`,
`role="status"`, or `role="alert"` anywhere in the file (grepped the whole
component tree; the only `role="status"` in the entire app is the generic
`Spinner`). A screen-reader user watching a live log stream is told nothing
when the SSE connection drops and starts retrying, nor when it gives up after
5 attempts and shows the "Retry" button — they'd have to poll the toolbar
manually. (The log lines themselves are correctly *not* wrapped in a live
region — announcing every streamed line would be unusable — but the discrete,
low-frequency connection-state transitions should be.)
**Fix:** wrap the status `<span>` in `role="status" aria-live="polite"`.

### 7. xterm terminal output is invisible to screen readers (no `screenReaderMode`)
`src/lib/components/stations/Terminal.svelte:273-279`

The `Terminal` is constructed without `screenReaderMode: true`:
```ts
term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: ..., theme: ... });
```
xterm.js ships an accessibility helper that mirrors terminal output into a
live-announced buffer, but it's opt-in via this flag. Without it, the entire
terminal — the primary way to operate a runtime interactively — produces no
output a screen reader can read at all (only the toolbar buttons are
reachable). This is a known xterm limitation, not a bug the team introduced,
but the fix is a one-line config flag away and currently unset.
**Fix:** `new Terminal({ ..., screenReaderMode: true })`, gated behind a user
toggle if the live-announce verbosity is a concern for sighted users' extra
DOM churn.

### 8. Icon-only buttons with no accessible name at all
- `src/lib/components/theme-settings.svelte:374-382` — delete-custom-theme
  button: only child is `<Trash2Icon class="h-4 w-4" />`, no `aria-label`,
  no `title`, only a `data-testid`.
- `src/routes/nodes/[id]/stations/[stationId]/+page.svelte:132-140` — the
  "back to node" button: `href="/nodes/{nodeId}"`, only child
  `<ArrowLeftIcon class="h-4 w-4" />`, no `aria-label`/`title` at all.

Both compute to an empty accessible name (lucide auto-`aria-hidden`s the icon
when nothing else supplies a name — see finding #1). Contrast with
`src/lib/components/stations/file-tree.svelte:328-352`, which does this
correctly (`aria-label="Rename {entry.name}"` / `"Delete {entry.name}"`) —
the pattern is known and used elsewhere, just missed on these two.
**Fix:** add `aria-label="Delete theme"` / `aria-label="Back to node"`.

### 9. Fleet heatmap: running (green) vs error (red) not distinguishable for red-green color blindness
`src/lib/components/fleet/FleetHeatmap.svelte:16-25`

```ts
const STATUS_CELL_CLASS = {
  running: "bg-status-running",   // full opacity
  stopped: "bg-status-stopped/50",
  error: "bg-status-error",       // full opacity, same opacity as running
  unknown: "bg-status-stopped/25",
};
```
`running` and `error` are the two most-consequential states in an
at-a-glance fleet heatmap and are rendered at identical opacity, differing
only by hue (green vs red) — the classic deuteranopia/protanopia confusion
pair, with no shape, icon, pattern, or border-weight difference between them.
Each cell *does* carry a correct `aria-label="{name} ({status})"` and a
`title` tooltip (good — screen readers and hover users get the real status),
but the entire point of a heatmap is glanceable scanning without per-cell
interaction, and that fails for colorblind sighted users.
**Fix:** give `error` a distinct visual weight (e.g. a ring/border, or a
small dot overlay) independent of hue, not just a different color.

### 10. Stale, low-contrast `--status-*` fallback tokens in `app.css`
`src/app.css:634-639` (light) / `:674-679` (dark)

The `:root` fallback values (`--status-running: oklch(0.723 0.192 149.58)`
etc.) don't match *any* shipped theme preset's derived status colors — e.g.
compare to the actual default theme's values in
`src/lib/themes/presets/default/neutral.ts:47-52`
(`cyber-emerald/amber/cyan: oklch(0.5/0.55 ...)`, quite different lightness).
Computed against a white page background, the `app.css` fallback set is bad:

| token | light ratio | vs. real default-neutral theme |
|---|---|---|
| `--status-degraded` (amber) | **2.13:1** | 4.87:1 |
| `--status-running` (green) | **2.28:1** | 4.94:1 |
| `--status-starting` (blue) | **2.37:1** | 3.86:1 |
| `--status-sleeping` (purple) | 4.40:1 | 6.79:1 |

All fail WCAG AA for text (4.5:1); the first three also fail the 3:1
non-text/UI-component floor. In normal operation this window is mostly
theoretical — `routes/+layout.svelte:45-53,77-83` gates all
status-colored UI behind a full-screen "Connecting…" spinner until
`themeStore.initialize()` has already overwritten these tokens via inline
styles — but it's a real landmine: any future code path that reads
`--status-*` before that gate (SSR, a new route that skips the loading state,
a `document.documentElement` reset) will silently render near-unreadable
status colors. Also just confusing to maintain since the tokens are dead code
that doesn't reflect any real theme.
**Fix:** either delete the hardcoded fallback and let it inherit
`--muted-foreground` until JS applies a scheme, or replace the fallback
values with the actual `default-neutral` light/dark values so they're never
misleading.

---

## Low

### 11. Comparable numeric table columns don't use `tabular-nums`
`src/lib/components/fleet/AgentTable.svelte:276-283` — CPU%, Mem, and Uptime
cells (`data-testid="cpu-cell"/"mem-cell"/"uptime-cell"`) are plain
`text-xs text-muted-foreground`, no `font-mono`/`tabular-nums`. Everywhere
else that renders comparable metrics (`HealthPanel.svelte`,
`OverviewStats.svelte`) uses `font-mono`, which is monospace and sidesteps
the issue naturally — AgentTable's three numeric columns are the outlier and
will visibly mis-align digit-for-digit down the column.
**Fix:** add `tabular-nums` (or `font-mono`, consistent with the rest of the
app) to those three cells.

### 12. `relativeTime()` is not locale-aware
`src/lib/utils/relative-time.ts:14-28` hand-rolls `"5m ago"` / `"2h ago"` /
`"3d ago"` in hardcoded English abbreviations, regardless of the user's
locale. `src/lib/components/stations/ActivityPanel.svelte:37-48` duplicates
the same logic inline instead of importing the shared helper (so there are
now two non-locale-aware implementations to fix). This is a real gap against
the audit's explicit ask, though contrast it with
`src/lib/utils/format-date.ts:13-31`, which does this correctly via
`date.toLocaleDateString(undefined, {...})`.
**Fix:** use `Intl.RelativeTimeFormat` (`new Intl.RelativeTimeFormat(undefined,
{ numeric: "auto" })`) and have `ActivityPanel` import the shared util instead
of re-deriving it.

### 13. Rename input has no visible focus indicator
`src/lib/components/stations/file-tree.svelte:320-326` — the inline
file/folder rename `<input>` is `outline-none` with a static `border-input`
and no `focus-visible:ring`/`focus-visible:border-*` companion (every other
input in the app pairs `outline-none` with a focus-visible ring — this one
doesn't). Narrow surface (only visible mid-rename, and the field
autofocuses), but if a user tabs away and back there's no way to tell it's
focused.
**Fix:** add the same `focus-visible:border-ring focus-visible:ring-3
focus-visible:ring-ring/50` used by the shared `Input` component.

### 14. Decorative inline SVG missing `aria-hidden`
`src/lib/components/fleet/connect-banner.svelte:33-49` — the hand-rolled
server-icon `<svg>` (not a `@lucide/svelte` icon, so it doesn't get the
library's automatic `aria-hidden` fallback) has no `aria-hidden="true"` and
no `role="img"`+label. Purely decorative next to a heading that already says
"Connect your first node" — should be silenced for AT rather than
potentially exposed as an unlabeled graphic.

### 15. A couple of icon-only buttons rely on `title` instead of `aria-label`
`src/lib/components/stations/FileBrowser.svelte:286` (`title="Refresh"`) and
`src/routes/admin/users/[id]/+page.svelte:90-98` (`title="Back to Users"`).
Both do compute a technically-valid accessible name via the `title` fallback
step of the accname algorithm, so this isn't a "no name" bug like #8 — but
`title` isn't reliably exposed on touch, isn't focusable-triggered in most
browsers, and is explicitly what the project's own lens/rule calls for
`aria-label` instead. Cheap, consistent fix: swap `title=` for `aria-label=`
(can keep `title` too for the native mouse tooltip).

### 16. `border`/`input` token contrast sits just under the 3:1 non-text floor
`src/app.css:617-618` — light-mode `--border`/`--input`
(`oklch(0.70 0.013 255.508)`) against `--background` (white) computes to
**2.67:1**, just under WCAG 1.4.11's 3:1 for meaningful UI-component
boundaries (input field outlines). Minor/borderline — most inputs also carry
a background/shadow that helps them read against the page, but worth a look
if a stricter AA audit is ever run against this token pair specifically.

---

## What's already good

- **Status badges are never color-only where it matters most**: `NodesOverview.svelte`,
  `AgentTable.svelte`, `page-header.svelte`'s status pill, and `HarnessBadge.svelte`
  all pair the status color with the literal status text — the
  `statusBadgeClass`/`statusTextClass`/`statusBgClass` trio in
  `lib/utils/status-badge.ts` is a clean, theme-robust, Tailwind-JIT-safe
  pattern and is used correctly almost everywhere it's imported.
- **`FleetHeatmap` cells and the data-table sort indicators both carry real
  accessible names** (`aria-label`, `aria-sort`) even where the visual cue is
  color/arrow-only — good defense in depth even though #9 flags a
  colorblind-specific gap on the same component.
- **Toasts are fully accessible by default** — `svelte-sonner` (wrapped in
  `lib/components/ui/sonner/sonner.svelte`) ships its own ARIA live region,
  and every action-feedback path in the app (`toast.success`/`toast.error`
  for restarts, updates, bans, etc.) routes through it — this covers the
  "action feedback announced" requirement app-wide for free.
- **Form validation errors use `role="alert"`**: `lib/components/ui/field/field.svelte:29-31`
  correctly wraps inline field errors so they're announced the moment they
  appear, and every admin dialog (`CreateUserDialog`, `RoleDialog`,
  `BanUserDialog`) properly pairs `<Label for=...>`/`<Field label=...>` with
  its input.
- **`<img>` usage is 100% correct**: both real `<img>` tags in the codebase
  (`admin/users/+page.svelte`, `admin/users/[id]/+page.svelte`) have
  meaningful `alt`.
- **The shared `Button`/`Input` focus-visible pattern is used consistently**
  (no scattered one-off `outline-none` without a ring) — the contrast problem
  in finding #4 is a values bug, not an inconsistency/coverage bug, which
  makes it a one-place fix.
- **`formatDate.ts` is properly locale-aware** (`toLocaleDateString(undefined, ...)`),
  the correct counter-example to finding #12.
- **`DataTable`** sort buttons are real `<button>` elements with `aria-sort`
  on the header cell and an `aria-hidden` decorative arrow — good
  semantic-HTML-first structure, no ARIA-only shortcuts.
- **Dark mode contrast is comfortably above AA everywhere checked** — every
  dark-mode status/text/muted pair computed in this audit lands at 5.5:1+
  (many 9–17:1); the contrast problems found here are specifically light-mode
  and specifically the default/blue/graphite themes, not systemic.
