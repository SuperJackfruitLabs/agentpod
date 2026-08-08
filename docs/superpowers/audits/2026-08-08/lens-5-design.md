# Lens 5 — Visual identity, typography, hierarchy, density, copy

Design review of `apps/console/src` after the "Crisp Console" revamp. Read-only audit.
All paths relative to `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp/apps/console/src`.

**Headline:** the revamp succeeded at removing the cyberpunk layer and failed to replace it with a
system. There is no type scale, no spacing scale, six competing status renderers, six radii in a
"6px radius" design language, and a shipped `[fleet]` prefix left over from the deleted theme sitting
in the primary empty state. What genuinely works — `AgentTable`, `LogTail`, `page-header.svelte`,
and `status-badge.ts` — works because one person built each carefully, not because a system carried them.

---

## 1. TOKENS & TYPE

### 1.1 There is no type scale. At all.

`app.css` is 841 lines. **591 of them are `@font-face`** (25 declarations, 20 families —
`grep -c "@font-face" app.css` → 25). The token block runs 595–724. In it:

- `--radius`, 30+ color tokens, 6 status tokens, 3 font-family vars.
- **Zero** type tokens: `grep -cE '\-\-text-|\-\-space-|\-\-leading-|\-\-tracking-|\-\-font-weight' app.css` → **0**.

So the "type scale" is whatever each file reached for. The actual distribution across all `.svelte`:

| class | count |
|---|---|
| `text-xs` | 137 |
| `text-sm` | 120 |
| `text-lg` | 12 |
| `text-base` | 8 |
| `text-2xl` | 8 |
| `text-xl` | 1 |
| arbitrary `text-[Npx]` | **35** |

**257 of 286 sizings are two values.** That is not a scale, it is a coin flip. And the 35 arbitrary
escapes prove the two values weren't enough: `text-[13px]` ×3, `text-[12px]` ×5, `text-[11px]` ×15,
`text-[10px]` ×11 — a shadow scale living in brackets because the real one has a hole between
12px (`text-xs`) and 14px (`text-sm`). Worst offenders:
`lib/components/stations/file-tree.svelte:237,247,261,292,322` (four sizes in one file),
`lib/components/stations/file-preview.svelte:51,67,82,90,116`,
`lib/components/stations/ConfigEditor.svelte:81,86,92,101,132,137`.

`text-[10px]` is used for real content, not decoration:
`lib/components/fleet/HarnessBadge.svelte:13` (the harness name — a primary domain fact),
`lib/components/fleet/FleetHeatmap.svelte:97` (status legend), `NodesOverview.svelte:275,308,325`.
10px mono in a pill is below the legibility floor for an ops surface people stare at.

**Weights are effectively two:** `font-medium` ×59, `font-semibold` ×19, `font-normal` ×1,
`font-bold` ×1. Four families × 4 weights each are bundled and shipped; two weights are used.

**Section headings have no agreed treatment.** The same structural role renders three ways:
- `routes/settings/+page.svelte:27,33,47` — `<p class="text-sm font-medium">` (Appearance / Connection / Account)
- `routes/+page.svelte:111`, `NeedsAttention.svelte:18` — `<p class="text-sm font-medium">` (Fleet health / Needs attention)
- `routes/nodes/[id]/+page.svelte:137,198` — `<h2 class="text-lg font-semibold">` (Detected Stations / Adopted Stations)
- `lib/components/fleet/connect-banner.svelte:55` — `<h3 class="font-semibold text-base">`

Settings' three section titles aren't headings at all — no `<h2>`, so the document outline is a
single `<h1>` from PageHeader and nothing else. Visually a section title is indistinguishable from
`NeedsAttention`'s panel label, which is indistinguishable from a form label.

> **Recommendation.** Define five roles as tokens in `app.css` and ban raw size classes outside them.
> Something like: `--text-page` (18/600, PageHeader h1 — already the de facto value at
> `page-header.svelte:132`), `--text-section` (14/600), `--text-body` (14/400), `--text-label`
> (12/500, muted, the `dt`/column-header role), `--text-metric` (24/600 mono). Expose as
> `.t-page/.t-section/.t-body/.t-label/.t-metric`. That single move deletes all 35 bracket escapes
> and makes the Settings-vs-nodes/[id] heading split impossible. Also: 20 font families is not a
> customization layer, it is 591 lines of CSS and a page-weight tax to support Press Start 2P
> (`app.css:523`) and Cormorant Garamond (`app.css:562`) in a fleet console. Cut to
> ~6 sans + 3 mono.

### 1.2 Mono-for-data is applied by vibe, not by rule

Where it's right — and it's genuinely good:
- `routes/activity/+page.svelte:83,87,97` — verb, node id, timestamp all `font-mono text-xs`. Best in product.
- `lib/components/fleet/OverviewStats.svelte:11,19,30` — `font-mono text-2xl font-semibold` metrics.
- `lib/components/stations/HealthPanel.svelte:142,150,158,166,174,180,188,194` — every `dd` mono.
- `lib/components/page-header.svelte:152` — subtitle (a filesystem path) mono. Correct instinct.
- `routes/login/+page.svelte:155` — the URL input is mono. Correct.

Where it's wrong, and it's the single worst typographic miss in the product:

**`lib/components/fleet/AgentTable.svelte:276–287` — the CPU, Mem, Uptime and Version cells are not mono.**

```
<Table.Cell class="hidden lg:table-cell text-xs text-muted-foreground" data-testid="cpu-cell">
  {formatCpu(agent.cpuPct)}
```

This is the densest, most-scanned numeric table in the console — `12.3%`, `512 MB`, `3h 41m`,
`v0.1.10` — set in proportional Inter. Digits don't align down the column, so an operator can't
scan for the outlier, which is the entire job of that table. Meanwhile the *Activity* table one
nav item away sets its data in mono. Same product, adjacent screens, opposite rules.

Also inconsistent: `NodesOverview.svelte:298,304,309` render `arch · cpuCount`, `v: version`, and
`version → version` in sans, while `routes/nodes/[id]/+page.svelte:105` renders the same
`node.agentVersion` in `font-mono`. The same field, mono on one page and sans on the other.

> **Recommendation.** State the rule as "any value the agent reported is mono; any word the console
> wrote is sans," then enforce it in one place: a `<Metric>`/`<DataCell>` component that owns
> `font-mono text-xs tabular-nums`. Retrofit `AgentTable`'s six data columns and
> `NodesOverview`'s card body first. `tabular-nums` is missing everywhere — add it to the token.

### 1.3 Spacing has no rhythm, and sibling surfaces disagree

Padding distribution in routes + fleet + stations: `p-4` ×25, `p-3` ×20, `p-6` ×11, `p-2` ×5,
`p-8` ×1, `p-1`/`p-0.5` — plus `px-2` ×16, `px-3` ×14, `px-4` ×13, `px-6` ×8, `py-1.5` ×15,
`py-1` ×15, `py-2` ×4, `py-0.5` ×3, `py-2.5` ×2.

Three padding values for the same "bordered panel" role, on screens the user moves between:

| surface | padding | file:line |
|---|---|---|
| Settings section card | `p-6` | `routes/settings/+page.svelte:26,32,46` |
| Connect banner | `p-6` | `connect-banner.svelte:23` |
| Overview stat tile | `p-4` | `OverviewStats.svelte:9,17,26` |
| Overview "Fleet health" panel | `p-4` | `routes/+page.svelte:110` |
| Needs attention panel | `p-4` | `NeedsAttention.svelte:17` |
| Node card | `p-4` | `NodesOverview.svelte:261,288` |
| Health stat tile | `p-3` | `HealthPanel.svelte:140,148,156,164,172,178,186,192` |

Overview's stat tile is `p-4` and Health's stat tile is `p-3` — the same component idea, two
densities, one click apart. Settings is `p-6` for no reason other than it was written on a
different day.

### 1.4 Six radii in a "6px radius" design language

`--radius: 0.375rem` (6px) at `app.css:601`. Actual usage across `.svelte`:

```
72  rounded-lg   (= var(--radius), 6px)  ✓
39  rounded      (4px)
30  rounded-md   (= --radius-md = 4px)
26  rounded-full
 9  rounded-sm   (= --radius-sm = 2px)
 8  rounded-xl   (= 10px)
 5  rounded-none
 1  rounded-4xl  (pill)
```

Two specific failures:

**Badges are pills, not 6px.** `lib/components/ui/badge/badge.svelte:5` — base includes
`rounded-4xl`. Badges are the most frequent element in the product (every status, every harness,
every role) and they are the one component that ignores the stated radius entirely.

**Button radius varies by button size.** `button.svelte:7` base is `rounded-lg` (6px), but
`size: sm` (`:20`) and `size: xs` (`:19`) override to `rounded-[min(var(--radius-md),12px)]` and
`rounded-[min(var(--radius-md),10px)]` → 4px, since `--radius-md` is `calc(6px - 2px)`. So a `sm`
button is 4px and a `default` button beside it is 6px — visible in `HealthPanel:216–239` where
Start/Stop/Restart (`sm`) sit under `p-6` cards with 6px corners. The `min(…, 10px)` / `min(…, 12px)`
expressions are dead code: `--radius-md` is always 4px, so the `min` never binds. Upstream shadcn
cruft that stopped meaning anything the moment radius became 6.

**Skeletons don't match the shapes they stand in for**, so every page shifts on load:
`NodesOverview.svelte:224` `h-36 rounded-xl` → the card it replaces is `rounded-lg` (`:288`);
`routes/nodes/[id]/+page.svelte:156,205` `rounded-xl` → `Card.Root`; `routes/agents/+page.svelte:63`
`h-10 rounded-sm` → a `rounded-lg` bordered table.

**"No shadows" isn't true either** — `shadow-md`/`shadow-lg` survive in eight primitives:
`dropdown-menu-content.svelte:26`, `dropdown-menu-sub-content.svelte:15`, `popover-content.svelte:26`,
`select-content.svelte:30`, `sheet-content.svelte:38`, `tabs-trigger.svelte:16`, plus one in app
code at `LogTail.svelte:420` (the "N new lines" pill). Defensible for floating layers, but then say so.

> **Recommendation.** Radius gets three values, full stop: `--radius-sm` 4px (chips, inputs, cells),
> `--radius` 6px (buttons, cards, panels, badges), `--radius-full` (dots and avatars only). Delete
> `rounded-4xl` from `badge.svelte:5`, delete the size-scoped overrides in `button.svelte:19,20,23,24`,
> and make `Skeleton` inherit its radius from a `variant` prop matched to what it replaces.

---

## 2. HIERARCHY & DENSITY

### 2.1 Overview leads with inventory, not health

`routes/+page.svelte:65–124`. The visual sequence is: stat band → fleet health → two panels.
The stat band (`OverviewStats.svelte`) is the largest type on the page (`text-2xl`, `:11,19,30`)
and it says:

- Nodes online — `3/4`
- Agents — `12`
- Updates available — `0`

Two of three are inventory. **The number an operator actually opens this page for — how many agents
are not running — is nowhere in the stat band.** It's derivable only by reading the heatmap legend
chips at `FleetHeatmap.svelte:97` in `text-[10px]`, or by counting `<li>`s in `NeedsAttention`.
So the biggest type on the fleet dashboard is a count of machines, and the smallest type is the
count of broken agents.

`NeedsAttention` (`:17–63`) is the right idea and is visually the weakest thing on the page:
`text-sm font-medium` label, `text-xs` list items, same `p-4` bordered box as everything else,
sharing a 50/50 grid with `RecentActivity` (`routes/+page.svelte:120–123`) — so "3 agents are down"
gets exactly the same visual weight as "here is a log of things that happened." And when all is
well it renders `all healthy ✓` (`NeedsAttention.svelte:21`) — lowercase, with a literal checkmark
glyph, in a product that imports Lucide icons in 20+ files.

> **Recommendation.** Make the stat band report health, not inventory: `10 running / 2 stopped /
> 1 error` using the status tokens, with the three numbers colored, plus a smaller inventory line
> (`4 nodes · 13 agents · 0 updates`) beneath. Then give `NeedsAttention` full width above the
> heatmap when it is non-empty, and collapse it to a single quiet line when it is empty — the panel
> should shrink when there's nothing wrong, not sit there at equal weight saying "all healthy ✓".

### 2.2 HealthPanel is the flattening problem in its purest form

`lib/components/stations/HealthPanel.svelte:138–211`. Eight identical tiles in a 2-column grid,
each `rounded-lg border p-3` with a `text-xs` muted `dt` and a `font-mono text-lg` `dd`:

Status · PID · CPU · Memory · Disk · Uptime · Last Activity · Note

**"Status" — whether the agent is running at all — has the same tile, border, size and weight as
"Note"** (`:192–195`), a free-text field whose actual content is developer prose about shared
gateway processes (`:71` checks `health.note?.includes("gateway")`). And as "PID" (`:148`), which
an operator needs roughly never. The only differentiation Status gets is a text color from an
ad-hoc two-state map at `:73–75`.

The lifecycle controls below (`:214–240`) are state-blind: Start, Stop and Restart are all
rendered and all enabled regardless of `health.running`. Start is `variant="default"` (primary
filled) permanently — so on a *running* agent the loudest button on the panel is the one that does
nothing.

> **Recommendation.** Promote status out of the grid: a single full-width row at the top carrying
> the status dot, the label, uptime, and the contextual action (Stop + Restart when running;
> Start when stopped — disable rather than render the inapplicable one). Demote PID and Note into
> a `<details>` "Process details" disclosure. The remaining four live metrics (CPU/Mem/Disk/Uptime)
> then read as one row of four, not eight-of-equal.

### 2.3 Cards where a table belongs — and the product already knows it

`AgentTable.svelte` is the strongest surface in the console: sortable tri-state columns
(`:73–83`), an `aria-sort` implementation done right (`:85–88,305`), severity-ranked status sort
that reuses `tokenFor` instead of re-deriving (`:94–101,125–126`), collapsible node grouping
(`:382–404`), responsive column shedding at `sm`/`md`/`lg`. That is a real ops table.

Then `NodesOverview.svelte:258–332` renders nodes as **cards in a 3-column grid**, each carrying
five lines of near-static inventory: hostname, `arch · cpuCount`, `os`, `v: version`, and
conditionally an update row. Four of those five never change. With a 4-node fleet that is four
large boxes of constants occupying the whole viewport, and it tells the operator nothing about
whether those nodes are *healthy* beyond a single online/offline badge (`:293`) — no CPU, no
station count, no "3/4 agents running".

`routes/nodes/[id]/+page.svelte` then presents the same entity two ways on one page: detected
stations as cards in a 3-col grid (`:162–191`) and adopted stations as a tree (`:211`).

> **Recommendation.** Nodes becomes a table with the same grammar as `AgentTable`: host · status ·
> agents (`3/4` running, colored) · CPU · mem · version · update. Keep cards only for the
> provisioning state (`:260–280`), where the content genuinely is a status story rather than a row
> of facts. And reuse `AgentTable`'s sort/group machinery rather than writing a third table idiom.

---

## 3. SIGNATURE

### 3.1 Current state: yes, it landed at "clean but anonymous shadcn"

The brand mark is a stock Lucide `Server` glyph in a `rounded-md bg-primary` square, at
`app-shell.svelte:116–118` (`size-8`) and `login/+page.svelte:128–130` (`size-10`). That exact
construction — Lucide icon, primary-filled rounded square, `text-sm font-semibold` wordmark beside
it — is the single most templated pattern in contemporary web UI. In dark mode `--primary` is
`oklch(0.929 …)` (`app.css:649`), so the mark is a white square. There is nothing in a screenshot
of this console that identifies it as this product.

Worse, `connect-banner.svelte:28–51` builds a **third** treatment of the same idea: a `size-14`
`rounded-full` medallion containing a hand-inlined copy of the Lucide `server` path, in a codebase
that imports Lucide in 20+ files. Two shapes, three sizes, one icon, zero identity.

And the deleted theme left fingerprints. `connect-banner.svelte:56`:

```
<h3 class="font-semibold text-base">
  [fleet] Connect your first node
</h3>
```

**`[fleet]` is a shipped artifact of the removed cyberpunk layer** — the file's own header comment
(`:6`) still says "styled for the fleet/cyber theme." This is the primary empty state: the literal
first sentence a new user reads is a bracket-prefixed log-line affectation from a design language
that no longer exists.

### 3.2 The signature the product already owns: the status cell grid

Three candidates exist in the product's own world, and one is clearly best:

- **The terminal aesthetic** (`LogTail.svelte:300`, `Terminal.svelte:357`) — full mono panels with
  a status-colored toolbar. Strong, but it's an inherited convention, not an identity; every log
  viewer looks like this.
- **Harness identity** (`HarnessBadge.svelte:13`) — every harness renders `text-primary`, so
  hermes / openclaw / claude-code / codex / opencode are visually identical at 10px. A wasted axis.
- **The heatmap cell** (`FleetHeatmap.svelte:77–89`) — 20px status-filled squares, one per agent.
  This is the most *AgentPod* object in the codebase: it is the fleet, at a glance, in a shape no
  other product uses. And it appears exactly once, on Overview, with four of six statuses
  supported and a native `title=` tooltip (`:82`).

**Proposal — one element, no re-theming: the status ribbon.**

Promote the heatmap cell into a single primitive, `<StatusRibbon agents={…} size="…">`, with one
fixed geometry — a square cell, 2px radius, filled with the status token, no border, 1px gap — and
render it at three scales in exactly three places:

1. **`lg` (20px cells)** — Overview, where the heatmap already is. Unchanged in function.
2. **`sm` (8px cells)** — one row inside each node row in the new Nodes table, and inside each
   `AgentTable` group header (`AgentTable.svelte:384–397`, which today shows only
   `· 4 agents` in muted text). The operator reads a node's whole health in one 60px strip.
3. **`xs` (3px tall, cells as 3×8px bars)** — a single strip flush under the `PageHeader` border
   (`page-header.svelte:114–119`), scoped to whatever the page is about: the whole fleet on
   Overview/Agents, one node's agents on `nodes/[id]`, one agent's recent status samples on the
   station page.

That last one is the signature: a thin, live, colored strip that is always at the top of the
console and always means the same thing. It reads as a spectrum bar from across the room, it costs
nothing (six colors that already exist, one shape, no new font, no gradient, no glow), and it is
recognizably this product's — because no other product's top-of-page strip *is the fleet*.

Restraint conditions, so it doesn't become decoration: the ribbon never animates on load; it never
appears where its scope is ambiguous; cells are 3px tall at `xs` so it reads as chrome rather than
a chart; and it inherits the status tokens with zero opacity variants (see 4.2 — the current
`/25`, `/50`, `/10` soup is what makes it look decorative).

While you're in there: replace the native `title=` tooltip at `FleetHeatmap.svelte:82` with the
`Tooltip` primitive already used in `page-header.svelte:171–207`. A 500ms browser tooltip is the
one place the product's best idea feels unfinished.

---

## 4. STATUS LANGUAGE

### 4.1 `status-badge.ts` is well-built and widely ignored

`lib/utils/status-badge.ts` is the best-designed file in the console. Six canonical tokens (`:18`),
a `tokenFor` normalizer that folds 15 upstream strings into them (`:27–59`), three literal lookup
tables kept interpolation-free so Tailwind's JIT can see them (`:62–89`), and a documented reason
for that constraint (`:9–11`). It even anticipates reuse for sorting (`:20–26`), which
`AgentTable:125` actually honors.

**And then six other places render status without it.**

| # | where | what it does |
|---|---|---|
| 1 | `lib/utils/status-badge.ts:62–89` | canonical — BADGE / TEXT / BG |
| 2 | `lib/components/page-header.svelte:96–111` | its own `statusText`/`statusBg` maps, plus a hand-copied `StatusVariant` union at `:15` duplicating `StatusToken` |
| 3 | `lib/components/fleet/FleetHeatmap.svelte:16–21, 67–72` | `STATUS_CELL_CLASS` + `LEGEND_CLASS`, over a *different* four-value vocabulary |
| 4 | `lib/components/fleet/NeedsAttention.svelte:33` | `text-destructive/80`, ad hoc, ignores tokens entirely |
| 5 | `lib/components/stations/HealthPanel.svelte:73–75` | two states only: `running` / `stopped` |
| 6 | `lib/components/stations/LogTail.svelte:283–288` | `statusColor` for connection lifecycle |
| 7 | `lib/components/stations/Terminal.svelte:367` | `statusDotClass`, a seventh derivation |

The consequences are visible, not theoretical:

**A degraded agent is invisible on the heatmap.** `FleetHeatmap.svelte:16–25` knows only
`running / stopped / error / unknown`. `degraded`, `starting` and `sleeping` — three of the six
canonical tokens — fall through to `?? "bg-status-stopped/25"` (`:24`), which is also what
`unknown` renders. So a degraded agent and an unknown agent are the same pale grey square, and the
legend chip for it never appears (`:94` only renders the four hardcoded statuses). The one screen
whose job is "spot the sick agent" cannot show `degraded`.

**The same status renders three different ways in three places.** For one stopped agent:
- `AgentTable.svelte:272–274` — outline badge, `bg-status-stopped/10`, lowercase `stopped`, sans, pill
- `NeedsAttention.svelte:33` — bare text, `text-destructive/80` (**red**, not the stopped token), lowercase
- `HealthPanel.svelte:142–144` — `font-mono text-lg`, **Title Case `Stopped`**, `text-status-stopped`

So the operator sees `stopped` grey in the table, `stopped` **red** in Needs attention, and
`Stopped` in mono Title Case on the detail page. Three casings, two colors, three type treatments,
one fact.

**Node status collapses to two values before it reaches the renderer.**
`routes/nodes/[id]/+page.svelte:83–90`: `variant: (node.status === "online" ? "running" : "stopped")`.
A node in `error` renders as `stopped`. `PageHeader` supports all six variants (`:15`); the caller
throws four away.

**The dot-vs-label decision is unmade.** `Terminal.svelte:364–372` shows connection state as a
*colored dot* plus a mono station id. `LogTail.svelte:305–306` shows it as an *icon plus a colored
text label* (`Connected` / `Disconnected`, Title Case per `:277–282`). These are two tabs in the
same tab bar (`stations/[stationId]/+page.svelte:91,88`), one click apart, presenting the identical
concept with different grammar.

**Opacity is unsystematic.** Across the maps: `/10` (badge bg), `/20` and `/30` and `/40` (legend
chips, `FleetHeatmap:67–72`), `/25` and `/50` (heatmap cells, `:16–21`), `/60` and `/80`
(`NeedsAttention:32,33`, `FleetHeatmap:71`). Eight opacity steps of six colors — 48 possible
status appearances, arrived at one file at a time.

Also: `HarnessBadge` (`:13`) and status badges are both `variant="outline"` pills at 10–12px
sitting adjacent in `stations/[stationId]/+page.svelte:142` and `nodes/[id]/+page.svelte:169,186`.
Harness and status are different *kinds* of fact and they wear the same clothes.

> **Recommendation.** Ship one `<Status>` component over `status-badge.ts`, with a `form` prop —
> `badge` | `dot` | `text` | `cell` — and make every one of the seven sites above call it.
> Concretely: delete `page-header.svelte:15,96–111` and pass a raw status string (let `tokenFor`
> classify); delete `FleetHeatmap.svelte:16–21,67–72` and `STATUSES` in favour of the six tokens
> plus `statusBgClass`; replace `NeedsAttention.svelte:33` with `<Status form="text">`; replace
> `HealthPanel.svelte:73–75,142–144` and drop the Title-Casing. Then fix the casing rule once, in
> the component — I'd render status lowercase everywhere, since it is agent-reported data, which
> also means it should be mono (it currently isn't, anywhere). Restrict opacity to exactly two
> steps: `/10` for fills behind text, `100%` for dots and cells.

### 4.2 Where it's right

`routes/activity/+page.svelte:22–32` maps `ok`/`error` results onto `statusTextClass("running")`
and `statusTextClass("error")` rather than inventing colors — exactly the right instinct.
`lib/utils/toggle-chip.ts:29–37` is a legitimate shared abstraction (LogTail's level filters and
AgentTable's pills share one class builder), and `LogTail.svelte:289–294` maps log levels onto
`status-error`/`status-degraded` so a warning line and a degraded agent are the same amber. That is
a real system, working. It just isn't the one status renders through.

---

## 5. COPY

### 5.0 The finished error-copy layer is dead code, and raw HTTP is shipping instead

`lib/utils/errors.ts` is **332 lines of complete, polished, user-facing error copy** — a
`cleanErrorMessage` normalizer (`:208`), a `parseError` categorizer (`:230`), and per-category
suggested actions like "Check your internet connection and try again." (`:184–196`).

**It has zero importers.** Verified: `grep -rn "utils/errors|parseError|cleanErrorMessage"` returns
only matches inside the file itself.

What ships instead is `lib/api/client.ts:32,34`:

```
throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
```

Every error banner in the app renders `e.message` directly, so the production error copy — the
string the operator actually reads in the destructive-red box — is **`POST /api/runtimes → 500`**.
`lib/api/client.ts:136` does the same with a station UUID embedded. `lib/api/admin.ts:60,70` produce
**`API Error: 401`**, and `:72` passes the **entire raw HTTP response body** into a toast
description. Every friendly fallback string catalogued in 5.3 below is effectively unreachable —
they only fire when a non-`Error` value is thrown.

> **Recommendation.** Wire `parseError` into `client.ts`/`admin.ts` at the throw site, or delete
> `errors.ts` and inline its category logic. Either way, no HTTP verb, path, status code, or
> response body should reach a rendered string. This is the highest-value copy fix in the audit and
> it is roughly a 20-line change, because the copy has already been written.

### 5.0b The type-to-confirm gate pre-fills its own answer

`lib/components/ui/TypeToConfirmDialog.svelte:48–58` asks "Type `{confirmPhrase}` to confirm:" and
then sets `placeholder={confirmPhrase}` on the input. The exact string the user must type to prove
deliberateness is displayed *inside the field they must type it into*. This is the gate protecting
Destroy runtime (`ProvisionedNodeControls.svelte:130`, `runtimes/+page.svelte:290`) and permanent
file deletion (`file-tree.svelte:372`). Drop the placeholder entirely.

Related: `ProvisionedNodeControls.svelte:130–141` and `runtimes/+page.svelte:290–297` share the
title "Destroy runtime" but have **different bodies**, and the former demands `node.hostname` as
the confirm phrase while destroying a *runtime* — the dialog asks for the name of a different noun
than the one in its title.

### 5.1 The structural problem: six nouns for three things

The console asks the operator to hold **node, runtime, station, agent, harness, matrix** — and at
least two of those pairs are the same object under different names.

**"Station" vs "Agent" — one entity, two user-visible names.** The nav says Agents
(`app-shell.svelte:55`), the page is titled "Agents" with subtitle "Every agent in the fleet"
(`routes/agents/+page.svelte:57`), and rows link to `/nodes/{nodeId}/stations/{stationId}`
(`AgentTable.svelte:259`) — where the headings read **"Detected Stations"** and
**"Adopted Stations"** (`routes/nodes/[id]/+page.svelte:137,198`). The contract type is
`FleetAgent` with a `stationId` and an `agentName`. Then the confirm dialogs escalate it:
"Type the station ID below to confirm" (`HealthPanel.svelte:251`, `CleanupPanel.svelte:188`) — the
user is asked to type the ID of a thing the rest of the console never called a station.

**"Node" vs "Runtime" — two nav destinations for one overlapping set.** `app-shell.svelte:56,57`
lists both. `NodesOverview.svelte:258–332` renders provisioned runtimes and nodes in the *same
grid*, and `node.provisioned` (`:324`) marks a node that is a runtime. So "Runtimes" is a filtered
view of "Nodes" presented as a peer resource.

**"Provision a runtime" has four names for one action.** Header button "New runtime"
(`routes/runtimes/+page.svelte:236`) → empty-state button "Provision runtime" (`:270`) → dialog
title "New Runtime" (`NewRuntimeDialog.svelte:75`, Title Case *and* `font-mono`) → confirm button
"Create" (`:164`). The user clicks four different words to do one thing.

Same pattern in admin: "Change Role" (`admin/users/[id]:154`) → dialog "Change role"
(`RoleDialog.svelte:75`) → confirm "Update role" (`:108`) — the verb mutates from *Change* to
*Update* between trigger and commit. And "Ban" (`admin/users/+page.svelte:198`) → "Ban User"
(`admin/users/[id]:170`) → "Ban user" (`BanUserDialog.svelte:72,94`) — three casings.

**The admin area is systematically Title Case while the fleet area is sentence case** — "Change
Role" (`:154`), "Ban User" (`:170`), "Back to Users" (`:95`), "User Details" (`:80`), "Email
Verified" (`:198`), "User ID" (`:190`). That is a whole region of the product on a different
convention, which reads as a different product.

**"Hub" vs "API Endpoint" vs "Management API" vs "server" — four names, two of them 13 lines apart.**
`login/+page.svelte:135` "Connect to your hub"; `:148` `label="API Endpoint"` with
`description="Enter your AgentPod Management API URL"`; `:264` "← Use different server";
`settings/+page.svelte:33,35,41` "Connection" / "Connected to" / "Use different server".
"Management API" appears nowhere else in the product.

> **Recommendation.** Pick one noun per entity and change the UI strings (not the code) to match:
> **agent** (never station), **node** (runtime becomes a node *property* — a filter chip on Nodes,
> not a nav item), **hub** (never API endpoint / Management API / server). This is the single
> highest-value copy change and it cascades into ~20 strings below.

### 5.2 Casing is not decided

Sentence case: "Needs attention" (`NeedsAttention.svelte:18`), "Fleet health"
(`routes/+page.svelte:111`), "Nodes online" (`OverviewStats.svelte:10`), "Updates available"
(`:28`), "Color mode" (`theme-settings.svelte:112`), "Saved combinations" (`:360`).

Title Case: "Detected Stations" / "Adopted Stations" (`nodes/[id]:137,198`), "Last Activity"
(`HealthPanel.svelte:187`), "API Endpoint" (`login:148`), "Color Schemes" / "Font Pairings"
(`theme-settings.svelte:140,141`), "All Categories" (`:159,268`).

`theme-settings.svelte` contradicts itself inside one component: sentence case at `:112,360,401`,
Title Case at `:140,141,159`.

Ellipsis: `…` at `AgentTable:296,329`, `NodesOverview:202,320`, `login:166,231`, `LogTail:278,280,319`
— but `"My custom theme..."` (three periods) at `theme-settings.svelte:406`.

### 5.3 Concrete rewrites

**Cyber-layer leftover — fix first**

| file:line | before | after |
|---|---|---|
| `connect-banner.svelte:56` | `[fleet] Connect your first node` | `Connect your first node` |
| `connect-banner.svelte:59` | `No nodes yet. Generate an enrollment token and run the agent on any server — it will appear here once it comes online.` | `Create an enrollment token, run the installer on any machine, and it appears here the moment it connects.` (drop "No nodes yet" — the empty state already says that; drop "server" per 5.1) |

**Buttons that don't say what they do**

`ConfirmDialog.svelte:19` defaults `confirmLabel = "Confirm"`, and the framework's default is what
ships in the two places it matters most:

| file:line | before | after |
|---|---|---|
| `HealthPanel.svelte:253` | `confirmLabel="Confirm"` (title is "Restart station", trigger button is "Restart") | `confirmLabel="Restart agent"` — three names for one action today |
| `file-tree.svelte:372–378` | no `confirmLabel` → **"Confirm"** on a permanent file delete | `confirmLabel="Delete file"` |
| `CleanupPanel.svelte:190` | `confirmLabel="Confirm"` (title "Apply cleanup") | `confirmLabel="Delete items"` |
| `login/+page.svelte:264` | `← Use different server` | `Use a different hub` (drop the text arrow; `settings:41` says "Use different server" for the same action — unify) |
| `nodes/[id]/+page.svelte:148` | `Adopt all` | `Add all agents` — "adopt" is internal jargon; the user is registering, not adopting |
| `nodes/[id]/+page.svelte:183` | `Adopt` | `Add agent` |
| `AgentTable.svelte:354` | `{groupByNode ? "Grouped" : "Flat"}` — the label describes current state, so it reads as "you are grouped" and is pressed | `Group by node` with `aria-pressed` (already present at `:352`) — a toggle should name the thing it toggles, not its state |

`ProvisionedNodeControls.svelte:135` `confirmLabel="Destroy"`, `theme-settings.svelte:393`
`confirmLabel="Delete"`, `runtimes/+page.svelte:295` `confirmLabel="Destroy"` — these are right.
The default is the problem: change `ConfirmDialog.svelte:19` to make `confirmLabel` **required**
so "Confirm" can never ship again.

**Escalation is inverted.** `HealthPanel.svelte:248–256` requires the operator to *type the full
station ID* to **restart** — a reversible, routine, everyday action. Meanwhile
`nodes/[id]/+page.svelte:148` deletes nothing but "Adopt all" runs with no confirmation at all.
Restart should be a plain `ConfirmDialog` (or no dialog and an undo toast); type-to-confirm belongs
on Destroy and Delete only.

**Empty states that don't invite action**

`Empty` (`ui/empty/empty.svelte`) supports `description` (`:26`) and a `children` CTA slot
(`:29–33`). Most callers pass only `title`:

| file:line | before | after |
|---|---|---|
| `nodes/[id]/+page.svelte:160` | `<Empty title="No stations detected" />` | title `No agents found on this node`, description `AgentPod looks for hermes, openclaw, claude-code, codex and opencode. Start one and rescan.`, CTA `Rescan` |
| `nodes/[id]/+page.svelte:209` | `<Empty title="No stations adopted yet" />` | title `No agents added yet`, description `Add a detected agent above to start monitoring it.` |
| `StationTree.svelte:96` | `No stations adopted.` (bare `<p>`, not even `<Empty>`) | use `<Empty>`; same copy as above |
| `AgentTable.svelte:378` | `No agents match the current filter` | keep title, add CTA `Clear filters` — the operator's next move is a click, not a re-read |
| `LogTail.svelte:395` | `No log output yet` | add description `The agent is connected but hasn't logged anything.` |
| `activity/+page.svelte:121` | `No activity yet` / `Activity from the fleet will appear here.` | **correct as-is** — this is the one empty state done right; make it the template |

`LogTail` also renders three different empty treatments in one component: `<Empty>` (`:395`), and
two bare `italic text-muted-foreground` divs (`:397`, `:399`) — italic appears nowhere else in the
product.

**Errors that don't say how to fix**

| file:line | before | after |
|---|---|---|
| `login/+page.svelte:77` | `Connection failed` | `Couldn't reach the hub at {apiUrl}. Check the URL and that the hub is running.` |
| `AgentTable.svelte:243,248`, `NodesOverview.svelte:159,164`, `nodes/[id]:59,64` | `toast.error("Update failed", { description: … ?? "Unknown error" })` — **"Unknown error" ships in six places** | `The node didn't respond. It may already be restarting — check back in a minute.` Never surface "Unknown error"; if there is no detail, say what to do next |
| `HealthPanel.svelte:33` | `Failed to load health` | `Couldn't read this agent's health. The node may be offline.` |
| `HealthPanel.svelte:83` | `Action failed` | name the action: `Couldn't {action} the agent — {reason}.` |
| `+page.svelte:42`, `agents:46`, `NodesOverview:63`, `activity:40` | `Failed to load fleet` / `Failed to load nodes` / `Failed to load activity` — four near-identical strings, four copy-pasted error banners (`+page.svelte:77–83`, `agents:68–74`, `NodesOverview:230–236`, `activity:111–117`, `HealthPanel:127–133`, `nodes/[id]:127–131`) | one `<ErrorState>` component, one string pattern: `Couldn't load {thing}.` + Retry |

**System-speak reaching the user**

| file:line | before | after |
|---|---|---|
| `activity/+page.svelte:55` | column header `Verb` — the raw hub field name (values like `fs.read`) | `Action` |
| `activity/+page.svelte:61` | column `Station` with `row.stationKey` | `Agent` |
| `activity/+page.svelte:87–88` | node column shows `value.slice(0, 8)` — a truncated UUID | show the hostname; keep the id in the tooltip |
| `HealthPanel.svelte:193–194` | a tile labeled `Note` containing developer prose about gateway processes | fold into the metric it qualifies — the `(gateway)` suffix pattern at `:151,159,167,181` already does this well; drop the tile |
| `HealthPanel.svelte:149` | `PID` | keep, but move behind a "Process details" disclosure (see 2.2) |
| `NodesOverview.svelte:304` | `v: {node.agentVersion ?? "unknown"}` | `{version}` in mono, label-free, or `Agent v0.1.10`; `v:` is a log-line abbreviation |
| `NodesOverview.svelte:309`, `nodes/[id]:110` | `update: {a} → {b}` (lowercase, colon-prefixed) | `Update available · v0.1.9 → v0.1.10` |
| `login/+page.svelte:148` | `label="API Endpoint"` / `description="Enter your AgentPod Management API URL"` | `label="Hub URL"` / `description="Where your AgentPod hub is running."` — drop "Enter your", drop "Management API" |
| `settings/+page.svelte:68` | `Not signed in.` | unreachable state on an authed page; if kept, drop the period (no other UI string has one) |

**Silent failures — the user is told nothing at all**

`lib/components/stations/file-tree.svelte:172–174, 189–191, 218–220` — delete, create and rename
failures each end in `// TODO: surface error`. **A file deletion can fail and the UI says nothing.**
`:133–135` renders an empty folder when the directory load fails, which is indistinguishable from an
empty folder. `routes/+page.svelte:53–55` swallows a token-mint failure with the comment
"ConnectBanner handles the error display" — `connect-banner.svelte` has no error UI at all.
`routes/nodes/[id]/stations/[stationId]/+page.svelte:82–84` swallows the station fetch, so the
Terminal and Cleanup tabs silently vanish rather than explaining why.

**Two error grammars, split by region.** Admin says "Failed to X" (`BanUserDialog.svelte:60`,
`RoleDialog.svelte:63`, `CreateUserDialog.svelte:84`, `admin/users/+page.svelte:120,139`); fleet says
"X failed" (`NodesOverview.svelte:159`, `AgentTable.svelte:243`, `runtimes/+page.svelte:83,97,111`).
Pick one — "Couldn't X" is better than both, because it leaves room for the fix.

**Two feedback mechanisms for one event class.** Toasts exist *only* for admin actions and
node/runtime lifecycle (22 calls, `+layout.svelte:74` mounts `Toaster`). Every other failure — all
data loads, all station operations, file read/write, config save, cleanup, login — uses an inline
banner. Meanwhile Settings has no save/apply feedback at all: `settings/+page.svelte:10–18`
disconnects and signs out with no confirmation and no toast, and
`theme-settings.svelte:71–76` saves a custom theme with no confirmation.

**More system-speak, from the copy sweep**

| file:line | before | after |
|---|---|---|
| `theme-settings.svelte:228` | `{category} · Shiki: {light}/{dark}` — **the syntax-highlighter library's name, shown to users** | drop `Shiki:`; the scheme names alone suffice |
| `NewRuntimeDialog.svelte:78` | `Provision a new managed node-agent runtime.` — `node-agent` is the internal Go daemon's package name | `Create a container that runs an agent for you.` |
| `CreateUserDialog.svelte:98` | `Create a new user account (bypasses signup restrictions)` — exposes internal policy mechanics | `Create an account directly, even when public signup is off.` |
| `ConfigEditor.svelte:134` | `Diff (original → buffer)` — `buffer` is editor-internal | `Changes` |
| `FileBrowser.svelte:297` | `Edit (diff)` | `Edit` |
| `file-preview.svelte:68` | `Preview not available over the station API` — names the transport | `Can't preview this file type.` |
| `file-preview.svelte:63` | `Binary/Image file` | `Binary file` |
| `file-preview.svelte:117` | `{ext.toUpperCase()}` → renders `MARKDOWN · 4.2 KB · modified 2h ago` | `Markdown · 4.2 KB · modified 2h ago` |
| `CleanupPanel.svelte:169` | `{item.kind}` with CSS `uppercase` | sentence case |
| `settings/+page.svelte:63`, `RoleDialog.svelte:58` | raw role token (`admin`) | `Admin` |
| `lib/stores/stations.svelte.ts:20,30,37` | `failed to load detected stations` / `failed to adopt stations` / `failed to load adopted stations` — **the only all-lowercase error strings in the app**, surfaced at `nodes/[id]:128` | sentence case, and rename per 5.1 |
| `lib/stores/auth.svelte.ts:191,243` | `Sign in failed` **and** `Failed to sign in` — two strings for one failure (likewise `:270`/`:289`) | one string |
| `lib/stores/connection.svelte.ts:81` | `Health check failed` — internal probe name | `Couldn't reach the hub.` |
| `lib/utils/relative-time.ts:15` | `unknown` (lowercase) | `—`, matching every other missing-value in the product |
| `RecentActivity.svelte:26` | `view all →` — all-lowercase with a text arrow | `View all` |
| `CreateUserDialog.svelte:79` | `User {email} created successfully` — **the one "successfully" in the app** | `{email} added` |
| `CreateUserDialog.svelte:164`, `RoleDialog.svelte:98` | `Warning: Admins have full access to manage all users and system settings.` (duplicated verbatim in two files) | drop `Warning:` — the placement carries it |
| `admin/users/[id]:82` | subtitle `{email \|\| "Loading..."}` — a loading string used as a page subtitle | omit the subtitle while loading |
| `command-dialog.svelte:12` | default title `Command Palette` — contradicts its only consumer's `Command palette` (`command-palette.svelte:50`) | sentence case |
| `UserFilters.svelte:117` | refresh button is icon-only with **no `aria-label`** | add one |

Three empty-state strings for one concept: `No stations detected` (`nodes/[id]:160`),
`No stations adopted yet` (`:209`), `No stations adopted.` (`StationTree.svelte:96`, with a period,
as a bare `<p>`). And `No activity yet` appears three times in two different renderings
(`activity/+page.svelte:121` via `<Empty>`, `ActivityPanel.svelte:84` via `<Empty>`,
`RecentActivity.svelte:33` as a bare `<p>`).

Six loading strings for one state: `Loading health data…` (`HealthPanel.svelte:118`),
`Loading activity…` (`ActivityPanel.svelte:76`), `Loading file…` (`file-preview.svelte:73`),
`Loading…` (`ConfigEditor.svelte:112`, `file-tree.svelte:274`, `RecentActivity.svelte:31`).

**Filler and punctuation**

- `HealthPanel.svelte:118` `Loading health data…` sits directly above eight skeletons (`:120–122`) — the skeletons already say "loading". Delete the line.
- `LogTail.svelte:399` `No lines match the current filter.` (trailing period) vs `AgentTable.svelte:378` `No agents match the current filter` (none). Same sentence, two punctuations.
- `LogTail.svelte:383,423` `{lines.length} lines` / `{newLinesCount} new lines` — no singular form, so `1 lines` ships. `AgentTable.svelte:394` and `CleanupPanel.svelte:188` both handle plurals correctly; do the same here.
- `theme-settings.svelte:406` `"My custom theme..."` → `My custom theme…`
- `login/+page.svelte:256` `Public registration is disabled. Contact an administrator to create an account.` — good: states the situation and the fix. Keep.
- Ellipsis is right in all seven search placeholders (`AgentTable:329`, `activity:132`, `LogTail:319`, `Terminal:390`, `file-quick-open:84`, `command-palette:53`, `file-tree:262`) and wrong in all five non-search ones: `theme-settings.svelte:406`, `command-dialog.svelte:13`, `BanUserDialog.svelte:83`, `UserFilters.svelte:61`, `admin/users/[id]:82`.
- `cannot be undone` ×4 vs `can't be undone` (`theme-settings.svelte:392`).
- `CreateUserDialog.svelte:111` placeholder `John Doe` — placeholder-name filler; and `:122` uses `user@example.com` where login (`:205`) uses `you@example.com` for the same field.

**Credit where it's due.** "Please" appears **zero** times in live UI (its four instances are all
inside the dead `errors.ts:184–196`). No "Oops", no "Sorry", one "successfully". The in-flight
button labels are excellent and near-universally consistent — `Creating…`, `Updating…`, `Saving…`,
`Signing in…`, `Destroying…`, `Scanning…`, `Banning…` — and `Retry` is used identically in all
eight error banners. The chattiness dimension is already clean; the problem is technical leakage and
name drift, not verbosity.

**Headings to sentence case**

`nodes/[id]:137` `Detected Stations` → `Detected agents`; `:198` `Adopted Stations` → `Your agents`;
`:138` `Ready to adopt` → `Found on this node, not yet added`; `:199` `Active workspaces` → delete
(the heading carries it); `HealthPanel:187` `Last Activity` → `Last activity`;
`theme-settings:140,141,159,268` → `Color schemes`, `Font pairings`, `All categories`.

---

## 6. MOTION

### 6.1 Inventory: almost all of it is library default or spinner

- **bits-ui defaults** — `fade-in/zoom-in-95` at `duration-100` on dialog (`dialog-content.svelte:31`),
  overlay (`dialog-overlay.svelte:15`), dropdown (`dropdown-menu-content.svelte:26`), popover
  (`popover-content.svelte:26`), select (`select-content.svelte:30`), tooltip
  (`tooltip-content.svelte:30`), sheet at `duration-200` (`sheet-content.svelte:38`). Untouched, fine.
- **Indeterminate** — `animate-pulse` on `Skeleton` (`skeleton.svelte:15`) and
  `markdown-viewer.svelte:107`; `animate-spin` on `Spinner` (`spinner.svelte:13`),
  `NodesOverview:267`, `file-tree:298`, `UserFilters:118`.
- **`transition-colors`** on essentially every interactive element. Correct and quiet.
- **One genuine micro-interaction:** `button.svelte:7` — `active:not-aria-[haspopup]:translate-y-px`.
  A 1px press. It's the only piece of motion in the product with an opinion, and it's the right one.
- **Two status-linked animations:** `Terminal.svelte:368` pulses the connection dot while
  connecting/reconnecting — genuinely informative. `page-header.svelte:144` supports
  `status.animate && "animate-pulse"`, but **no caller ever passes `animate`**
  (`nodes/[id]:83–90` and `admin/users/[id]:83` are the only two callers that pass `status` at all,
  and neither sets it). Dead capability.
- **`app.css:754–773`** — a 0.5s `background-color`/`background` transition plus 0.3s
  `border-color`/`box-shadow` on `body, main, aside, header, footer, nav, section, article,
  [data-slot=content], [data-slot=sidebar], [role=dialog], [role=menu]`. Properly gated behind
  `prefers-reduced-motion` (`:784–802`) and honestly documented as being for theme switching.

**Verdict: nothing here is decorative, and nothing here is orchestrated.** Every animation is
either a library default or a spinner. The two selectors worth flagging: the app.css transition
covers `section` and `article`, so *any* background change on a content section — not just a theme
switch — crossfades over half a second, which will read as lag on a data refresh. Scope it to
`[data-theme-transition]` on `<html>`, applied only while a theme change is in flight.

### 6.2 The one moment that would earn its place: the lifecycle transition

The product's central emotional beat is *pressing Restart and watching an agent come back*.
Today that beat is: type the station ID into a dialog (`HealthPanel.svelte:248`), press Confirm,
`doLifecycle` awaits (`:77–87`), then `health` is replaced wholesale and eight tiles swap text
with zero transition (`:138–211`). Nothing connects the press to the outcome, and nothing connects
the outcome to the three *other* places that agent's status is displayed.

**Proposal — one ~900ms choreography, driven by a single status change, on exactly three elements:**

1. **t=0** — on confirm, the status row (per 2.2) transitions its dot and label
   `running → starting`, and the dot picks up the existing `animate-pulse`. The action button
   becomes `Restarting…`. No spinner overlay; the pulsing dot *is* the spinner.
2. **t=0** — that agent's cell in the status ribbon (§3.2) crossfades to the `starting` token over
   200ms, in every ribbon currently on screen — including the `xs` strip under the page header.
   This is the payoff of having one ribbon primitive: the operator sees the change propagate to the
   fleet-level view, which is the actual mental model.
3. **t=return** — the status row transitions `starting → running` over 200ms and the pulse stops.
   Uptime resets to `0m` and counts. One toast, and only if it failed.

Rules that keep it honest: the *only* thing animating is the status token's color and the pulse —
no layout movement, no scale, no stagger across the eight tiles. Duration is bounded by the real
request, not a fixed timeline (if it returns in 80ms, the pulse shows for 80ms). Fully suppressed
under `prefers-reduced-motion`, where the status text still changes. And the same choreography
drives Start, Stop, node Update (`NodesOverview:150–167`) and the terminal reconnect
(`Terminal.svelte:374–380`) — one motion vocabulary for "this thing's state is in flight,"
reused rather than re-authored.

---

## Verdict

Could a designer at Linear/Vercel/Railway find nothing to sneer at? Not yet — but the distance is
short and the good parts are genuinely good. `AgentTable`, `LogTail`, `status-badge.ts`,
`page-header.svelte` and the Activity table are all work a strong team would ship. What's missing is
the layer above them: the revamp deleted a design language and replaced it with per-file judgment,
so five well-built components each solved typography, status, radius and density independently and
arrived at five answers. The same pattern explains the copy — a finished error-copy layer sits
unwired in `errors.ts` while `POST /api/runtimes → 500` renders in the error banner. Nothing here is
a taste failure; it is all a wiring failure. A reviewer would sneer at four specific things:
`[fleet]` still shipping in the primary empty state, a raw HTTP status line as user-facing error
copy, a type-to-confirm dialog that pre-fills its own answer as the placeholder, and a fleet
dashboard whose largest number is a machine count while its smallest is the count of broken agents.

## The three highest-leverage design moves

1. **One status system, and make it the signature.** Collapse the seven status renderers
   (`page-header.svelte:96–111`, `FleetHeatmap.svelte:16–21,67–72`, `NeedsAttention.svelte:33`,
   `HealthPanel.svelte:73–75`, `LogTail.svelte:283–288`, `Terminal.svelte:367`) into one `<Status>`
   component over `status-badge.ts` with four forms — badge, dot, text, cell — two opacity steps,
   and one casing. Then promote the `cell` form into the status ribbon at three scales (§3.2): the
   thin strip under `PageHeader` becomes the thing that makes a screenshot of this console
   unmistakable. This one move fixes the invisible-`degraded` bug, the red-vs-grey "stopped"
   contradiction, and the missing identity simultaneously.

2. **Tokenize type and enforce mono-for-data.** Add five named type roles to `app.css` (which today
   has zero type tokens) and delete all 35 `text-[Npx]` escapes plus the text-xs/text-sm coin flip;
   collapse radius to three values by removing `rounded-4xl` from `badge.svelte:5` and the
   size-scoped overrides in `button.svelte:19,20,23,24`; and ship a `<Metric>` component owning
   `font-mono tabular-nums` so `AgentTable.svelte:276–287` stops setting the console's densest
   numeric table in proportional Inter.

3. **Wire the copy layer that already exists, then settle the nouns.** Two cheap, high-visibility
   fixes first: connect `parseError` from the dead `lib/utils/errors.ts` into `client.ts:32,34` and
   `admin.ts:60,70,72` so `POST /api/runtimes → 500` stops being production error copy, and delete
   `placeholder={confirmPhrase}` at `TypeToConfirmDialog.svelte:57` so the safety gate works. Then
   settle one noun per entity — agent (not station), node (runtime is a property, not a nav item),
   hub (not API endpoint / Management API / server) — make `confirmLabel` required in
   `ConfirmDialog.svelte:19`, delete `[fleet]` at `connect-banner.svelte:56`, and put the three
   `// TODO: surface error` file operations (`file-tree.svelte:172,189,218`) on the toast path.
   In the same pass, fix hierarchy: Overview's stat band reports health
   (`10 running / 2 stopped / 1 error`) instead of inventory, `NeedsAttention` goes full width when
   non-empty, status leaves `HealthPanel`'s eight-equal-tiles grid, and node cards become a table
   with `AgentTable`'s grammar.
