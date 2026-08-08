# AgentPod Console — World-Class UI Audit (2026-08-08)

Five parallel audit lenses were run over `apps/console/src` at worktree HEAD `607f1b3`
(post Crisp Console revamp, PRs #197/#201 merged and deployed):

1. Interactions, forms, keyboard & focus (Vercel Web Interface Guidelines)
2. Navigation, URL state & information architecture
3. Accessibility & status communication (with computed WCAG contrast on the real theme tokens)
4. Loading/empty/error states, content resilience, performance
5. Visual identity, typography, hierarchy, density & interface copy (frontend-design lens)

Full lens reports with complete evidence: `docs/superpowers/audits/2026-08-08/lens-*.md`.
~64 raw findings, deduplicated below (several were independently confirmed by 2–3 lenses).

## Verdict

**Nothing found is a taste failure; nearly everything is a system/wiring failure.** The revamp
deleted the cyberpunk design language and did not replace it with a system, so five well-built
components each solved typography, status, radius, and density independently. The strongest work —
`AgentTable`, `LogTail`, `Terminal`, `status-badge.ts`, `page-header.svelte`, the Activity table —
is genuinely good and proves the team can execute; the missing layer is the one *above* the
components. The single biggest product-level gap is that a fleet console never refreshes its fleet
data and cannot tell the user when it's lying.

---

## P0 — Data loss, safety, broken accessibility (small diffs, fix first)

| # | Finding | Evidence | Lens |
|---|---|---|---|
| P0-1 | **ConfigEditor discards unsaved Monaco edits silently** on Escape / overlay click / Close; `hasChanges` is tracked but never read before close; no `beforeNavigate`/`beforeunload` guard anywhere in the app | `ConfigEditor.svelte:31,88-96`; `stations/[stationId]/+page.svelte:200-205` | 1 |
| P0-2 | **TypeToConfirmDialog pre-fills the confirm phrase as the input's placeholder**, defeating the gate protecting Destroy runtime and permanent file deletion | `TypeToConfirmDialog.svelte:57` | 5 |
| P0-3 | **File delete/create/rename failures are completely silent** (`catch { /* TODO: surface error */ }` ×3); a failed permanent delete gives zero feedback | `file-tree.svelte:165-228` | 1,4,5 |
| P0-4 | **Raw HTTP lines are production error copy** (`POST /api/runtimes → 500`, `API Error: 401`, raw response body in a toast) while `lib/utils/errors.ts` — 332 lines of finished error copy with `parseError`/`cleanErrorMessage` — has **zero importers** | `client.ts:32,34,136`; `admin.ts:60,70,72`; `errors.ts` | 5 |
| P0-5 | **Primary sidebar nav has no accessible name at 768–1023px** (labels `hidden lg:block`, lucide icons auto-`aria-hidden`); same for station tabs below `sm` (tooltip ≠ accessible name) | `app-shell.svelte:104-150`; `page-header.svelte:194-201` | 3 |
| P0-6 | **Keyboard highlight in menus/selects/⌘K palette is ~1.09–1.31:1 contrast** in default themes (`accent`≈`background`, `outline-hidden`, no ring fallback) — arrow-key focus is invisible | `dropdown-menu-item.svelte:23`, `select-item.svelte:21`, `command-item.svelte:18`; tokens `presets/default/neutral.ts:14,26,69` | 3 |
| P0-7 | **Shared focus-visible ring fails WCAG 1.4.11 in light mode app-wide** (`border-ring` 2.58:1, `ring-ring/50` ≈1.54:1 vs 3:1 floor) — one-place fix in `buttonVariants`/`Input` | `button.svelte:9`; `input.svelte:~24` | 3 |
| P0-8 | **`ConfirmDialog` defaults `confirmLabel="Confirm"`** and that default ships on permanent file delete and cleanup-apply — make the prop required | `ConfirmDialog.svelte:19`; `file-tree.svelte:372-378`; `CleanupPanel.svelte:190` | 1,5 |

## P1 — Trustworthiness & core interaction quality

**P1-1. The fleet chrome never refreshes and never admits staleness** (lens 4's top finding).
Overview / Nodes / Agents fetch once in `onMount`; the only `setInterval` in the app is the theme
clock. `connection` probes `/health` once at boot, so Settings can say "Connected" forever after
the hub dies. Fix: 15–30s visibility-aware poll (or WS subscription — LogTail/Terminal already own
the reconnect machinery to copy), an "Updated Xs ago / Reconnecting…" affordance near `PageHeader`,
and periodic re-probe feeding a persistent shell connectivity badge.
(`routes/+page.svelte`, `NodesOverview.svelte`, `agents/+page.svelte`, `stores/connection.svelte.ts`, `app-shell.svelte`)

**P1-2. Error states that lie or dead-end.** `RecentActivity.svelte:10-19` renders "No activity
yet" on fetch failure (network failure == empty fleet). Station/node metadata fetch failures are
silent (`stations/[stationId]/+page.svelte:78-85`, `nodes/[id]/+page.svelte:24-31`): tabs vanish
or the title falls back to a raw UUID with no explanation. A deep link to a deleted station renders
a broken shell instead of "Station not found → back to node". No `+error.svelte` exists, so
mistyped URLs hit SvelteKit's bare default page. (Lenses 2+4 independently)

**P1-3. URL state is missing exactly where operators need it.** Every tab title is "AgentPod"
(zero `<svelte:head>` repo-wide — `app.html:7`). Station detail tabs (health/logs/files/terminal/
cleanup/activity) are local state: not shareable, not cmd-clickable, back-button exits the page
(`stations/[stationId]/+page.svelte:29-98`). Admin filters/pagination reset on refresh
(`admin/users/+page.svelte:46-58`). Agents/Activity table sort/filter/group state is local; the
`?updates=1` seed is read once and never written back (`AgentTable.svelte:54-71`).

**P1-4. Form plumbing gaps** (all small): CreateUserDialog's submit button lives outside the
`<form>` with default `type="button"` → Enter doesn't submit (`CreateUserDialog.svelte:100-180`);
zero `autocomplete` attributes in the entire app (login + admin credential fields); validation
failure doesn't focus the first invalid field; loading buttons swap label but never show the
existing `Spinner` (8 sites); HealthPanel Start/Stop/Restart and admin Unban/Ban give *no* pending
feedback at all — just `disabled` (`HealthPanel.svelte:216-239`); theme-name input doesn't submit
on Enter; "Public signup" label isn't wired to its Switch.

**P1-5. Live surfaces are silent for assistive tech.** Terminal connection state is a color-only
`aria-hidden` dot with no text for connecting/connected/reconnecting (`Terminal.svelte:247-253`);
LogTail status changes have no `aria-live` (`LogTail.svelte:277-306`); xterm lacks
`screenReaderMode: true` so terminal output is entirely invisible to screen readers
(`Terminal.svelte:273-279`). Heatmap `running` vs `error` differ only by hue at identical opacity —
the classic red-green confusion pair on the one screen built for glancing
(`FleetHeatmap.svelte:16-25`).

## P2 — The missing design system (the world-class layer)

**P2-1. One `<Status>` component, and make it the signature.** `status-badge.ts` is the
best-designed file in the console and **six other places render status without it**, with visible
consequences: a `degraded` agent renders as the same pale grey square as `unknown` in the heatmap
(3 of 6 statuses unsupported — `FleetHeatmap.svelte:16-25`); one stopped agent is grey-pill
`stopped` in AgentTable, **red** `text-destructive/80` in NeedsAttention, and mono Title-Case
`Stopped` in HealthPanel; node `error` collapses to `stopped` before reaching PageHeader
(`nodes/[id]/+page.svelte:83-90`); eight ad-hoc opacity steps = 48 possible status appearances.
Ship `<Status form="badge|dot|text|cell">` over `status-badge.ts`, two opacity steps, lowercase
mono everywhere, and convert all seven sites. Then promote the `cell` form into a **status ribbon**
at three scales — `lg` (the existing Overview heatmap), `sm` (inside node rows / AgentTable group
headers), `xs` (a 3px live strip under `PageHeader`, scoped to the current page). The thin
always-present strip that *is the fleet* becomes the product's visual signature — six existing
colors, one shape, no gradients, never animates on load.

**P2-2. Tokenize type, spacing, radius; enforce mono-for-data.** `app.css` has zero type/spacing
tokens (591 of 841 lines are `@font-face` for 20 families); 257 of 286 font sizings are
`text-xs`/`text-sm` and 35 are arbitrary `text-[10-13px]` escapes; section headings render three
different ways; Settings sections aren't headings at all. Define five type roles
(`page 18/600 · section 14/600 · body 14/400 · label 12/500 · metric 24/600-mono`), delete the
escapes, cut font families to ~6 sans + 3 mono. Radius: three values (4px chips/inputs, 6px
everything else, full for dots) — delete `rounded-4xl` from `badge.svelte:5` and the dead
size-scoped overrides in `button.svelte:19-24`; make Skeleton radius match what it replaces.
Spacing: one panel padding (`p-4`) and one card padding, not `p-3/p-4/p-6` by authorship date.
Mono rule: *"agent-reported values are mono; console-written words are sans"* — ship a `<Metric>`
component owning `font-mono tabular-nums` and retrofit `AgentTable.svelte:276-287` (CPU/Mem/Uptime/
Version currently in proportional Inter — the densest numeric table in the product).

**P2-3. Hierarchy: health first, inventory second.** Overview's biggest type is a machine count;
the number the page exists for — agents not running — appears only in a 10px legend. Rebuild the
stat band as `10 running / 2 stopped / 1 error` in status colors with inventory beneath;
`NeedsAttention` goes full-width when non-empty and collapses to one quiet line when healthy.
HealthPanel: promote Status out of the eight-equal-tiles grid into a full-width row (dot + label +
uptime + the one contextual action); demote PID/Note behind a disclosure; make lifecycle buttons
state-aware (Start shouldn't be the loudest button on a running agent — `HealthPanel.svelte:138-240`).
Nodes: cards of near-static inventory become a table with AgentTable's grammar (host · status ·
agents-running · CPU · mem · version · update), keeping cards only for provisioning stories.

**P2-4. Copy: settle the nouns, wire the grammar.** One noun per entity: **agent** (never
station — nav says Agents, detail page says "Adopted Stations", confirm dialogs demand "the station
ID"), **node** (Runtimes becomes a filter of Nodes, not a peer nav item), **hub** (never API
Endpoint / Management API / server — four names today, two of them 13 lines apart in login).
One error grammar: "Couldn't X" + what to do next (admin says "Failed to X", fleet says "X failed").
Sentence case everywhere (the admin area is systematically Title Case — reads as a different
product). Kill remaining system-speak: `[fleet]` prefix in the primary empty state
(`connect-banner.svelte:56`), `Verb` column header, truncated UUIDs where hostnames belong,
`Shiki:` in the theme picker, `Diff (original → buffer)`, `node-agent` in user-facing dialog copy.
Empty states get descriptions + CTAs (the Activity page's is the template). Full rewrite table:
lens-5 report §5.3.

**P2-5. Motion: one choreography, fewer defaults.** Today every animation is a library default or
a spinner (the 1px button press is the only opinionated motion, and it's right). Add the one
orchestrated moment the product deserves — the lifecycle transition: on Restart, the status row's
dot pulses `running→starting`, the same agent's cell crossfades in every on-screen status ribbon,
and on return `starting→running` with uptime resetting. Color + pulse only, duration bounded by the
real request, suppressed under reduced-motion. Also: `transition-all` → `transition-colors` in
Button/Badge/Switch/Tabs; spinners/skeletons need reduced-motion handling (`app.css` reduced-motion
block only covers theme transitions); scope the 0.5s theme crossfade to a `[data-theme-transition]`
flag so data refreshes don't read as lag; tooltip `delayDuration` 0 → ~500ms (bits-ui gives
skip-delay for peers free).

## P3 — Polish backlog (verified, low severity)

- `rename` input: `outline-none` with no focus style at all (`file-tree.svelte:320-326`) — lenses 1+3
- StationTree chevron 20px hit target (`StationTree.svelte:54-65`)
- `overscroll-contain` missing on Dialog/Sheet content (matters for the 80vh ConfigEditor dialog)
- Icon-only buttons missing `aria-label`: delete-theme (`theme-settings.svelte:374-382`), back-to-node (`stations/[stationId]/+page.svelte:132-140`), UserFilters refresh; `title=`→`aria-label` swaps in FileBrowser/admin
- `relativeTime` not locale-aware + duplicated inline in ActivityPanel (`Intl.RelativeTimeFormat`)
- Stale low-contrast `--status-*` fallbacks in `app.css:634-679` don't match any shipped theme (2.1-2.4:1) — dead-code landmine
- FileBrowser breadcrumbs are `href="#"` + preventDefault → should be buttons
- Two back-navigations use `onclick={goto}` instead of `href` (`admin/users/[id]:93`, `admin/+layout.svelte:53`)
- `h1→h3` heading skip in connect-banner; decorative inline SVG missing `aria-hidden`
- LogTail search undebounced over 10k lines; FileQuickOpen renders uncapped result lists; AgentTable unpaginated/unvirtualized at fleet scale
- App boot is a full-viewport spinner where shell chrome + content skeleton fits better (`+layout.svelte:77-83`)
- Border/input token 2.67:1 (just under the 3:1 non-text floor) in light mode
- `1 lines` plural bug in LogTail; `...` vs `…`; "cannot" vs "can't"; station-detail page never shows the parent node's hostname

## What's already world-class (keep and build on)

- **Terminal + LogTail**: full connection state machines, exponential backoff with capped budget,
  manual reconnect, SSE burst batching, `content-visibility` virtualization, ring buffer.
- **`status-badge.ts`**: canonical tokens, normalizer, JIT-safe literal maps, documented constraints.
- **AgentTable**: tri-state `aria-sort` sorting, severity-ranked status sort, responsive column
  shedding, node grouping — the ops-table grammar the rest of the product should adopt.
- **Destructive-action culture**: type-to-confirm on destroy/delete/cleanup (once P0-2/P0-8 fix its
  two loopholes), and near-universally consistent in-flight labels (`Creating…`/`Destroying…`).
- **Loading/error/empty triads** on nearly every page with hand-tuned skeleton dimensions and
  `Retry` wired to the real loader; `Field` errors use `role="alert"`; toasts ride svelte-sonner's
  built-in live region; dark-mode contrast comfortably passes everywhere checked.
- **Monaco/xterm dynamically imported**; real `<a>` links for all primary nav/rows; bits-ui
  primitives everywhere (focus trap/return for free); `?action=` back-nav re-trigger correctly solved.

## Suggested delivery shape

- **Plan H (fix pass, ~1 day):** all of P0 + P1-4 form plumbing + P3 aria/focus one-liners. Pure
  defect burn-down, no design decisions needed.
- **Plan I (live console):** P1-1 refresh/staleness + P1-2 honest errors + P1-5 live-region a11y +
  `+error.svelte` + not-found states.
- **Plan J (design system):** P2-1 `<Status>` + ribbon signature, P2-2 tokens/`<Metric>`,
  P2-3 hierarchy rebuild (Overview stat band, HealthPanel, Nodes table).
- **Plan K (language & motion):** P2-4 noun settlement + copy sweep + URL state (P1-3 pairs
  naturally with retitling), P2-5 lifecycle choreography + motion hygiene.

Each plan lands mergeable and green, same as the A–G program.
