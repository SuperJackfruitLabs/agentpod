# Console "Muster" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the AgentPod console around the fleet as navigation, one attention lane, and two laws — colour means state, mono means machine-issued — without removing the existing theme system.

**Architecture:** SvelteKit 2 + Svelte 5 runes, SPA mode (`ssr = false`, `prerender = true`), Tailwind v4 with shadcn-svelte primitives. No SvelteKit `load()` functions: pages fetch in `onMount` and poll with `startPolling(fn, 30_000)` into local `$state`. The new shell replaces `app-shell.svelte` and hosts existing pages unchanged, then pages migrate into it one at a time.

**Tech Stack:** Svelte 5, SvelteKit, Tailwind CSS v4, bits-ui/shadcn-svelte, vitest + jsdom + @testing-library/svelte.

**Spec:** `docs/superpowers/specs/2026-09-02-console-muster-design.md`

**Prototype (visual reference, authoritative for layout and copy):** https://claude.ai/code/artifact/ba28a356-2d93-4b68-aa87-bcd54bc09689

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **Never leave the console broken.** Every task ends with `pnpm check`, `pnpm test` and `pnpm build` all passing in `apps/console`, and every existing route still rendering. There is no staging environment; this branch gets deployed by hand.
2. **Colour means state.** Chrome uses only neutral tokens (`background`, `card`, `muted`, `border`, `muted-foreground`, `foreground`). Never use `primary`, `accent`, or a `cyber-*` token decoratively in new markup. Saturated colour appears only via `--color-status-*` / `bg-status-*` / `text-status-*`.
3. **Mono means machine-issued.** `font-mono` for handles, station keys, mxids, `prn_` ids, session ids, version tags, timestamps, audit verb names, file paths. Never for prose, never for a page description.
4. **Station status is exactly `running | stopped | error | unknown`.** There is no `degraded` station. `unknown` is its own state with its own colour and is never rendered as "stopped".
5. **No hub or contract changes.** Console-only. If a screen wants a field the API does not return, the screen does without it and the task report records the gap.
6. **Every state is a dot AND a word.** Never hue alone.
7. **Accessibility floor:** visible keyboard focus on every control, `prefers-reduced-motion` respected, wide content scrolls in its own `overflow-x-auto` container, the page body never scrolls horizontally.
8. **Tests:** co-located `*.svelte.test.ts` / `*.test.ts`, vitest + jsdom, `@testing-library/svelte`. Note that `vitest.config.ts` strips every Svelte `<style>` block and sets `css: false` — **component-scoped CSS is not testable**, so assert on classes, text and roles, never computed styles.
9. **Run commands with `pnpm` from `apps/console`**, matching CI. Do not use bun or npm here.
10. Follow the repository's existing comment style: comments explain *why*, at the point the reader would ask.

---

## File Structure

**New files**

| Path | Responsibility |
|---|---|
| `src/lib/fleet/state.ts` | The single state vocabulary. Maps station/node/runtime/session status strings to `{ id, label, token }`. Every status render goes through it. |
| `src/lib/fleet/attention.ts` | Derives the attention-lane items from fleet data. Pure function, heavily tested. |
| `src/lib/components/shell/TopBar.svelte` | Wordmark, hub pill, palette cue, appearance menu, user, mobile roster toggle. |
| `src/lib/components/shell/AttentionLane.svelte` | Renders `AttentionItem[]`; the empty state. |
| `src/lib/components/shell/RosterRail.svelte` | The fleet as navigation: filter, grouping, state ribbon, keyboard. |
| `src/lib/components/shell/ContextRail.svelte` | Identity / Placement / Who may dispatch it. |
| `src/lib/components/shell/StateDot.svelte` | A dot + optional word, from `state.ts`. Replaces ad-hoc status markup. |
| `src/lib/components/shell/StateBar.svelte` | The stacked fleet-state bar. |
| `src/lib/components/fleet/ActivityFeed.svelte` | Activity rows with consecutive repeats collapsed. Used by the muster and the station Activity tab. |
| `src/lib/stores/fleet.svelte.ts` | One shared fleet poll (`getFleet` + `listNodes` + `listRuntimes`) so the shell, roster, lane and muster do not each poll. |

**Rewritten**

| Path | Change |
|---|---|
| `src/lib/components/app-shell.svelte` | Replaced by the three-column shell. Its 158-LOC test is rewritten with it. |
| `src/routes/+layout.svelte` | Mounts the new shell; keeps `initConnection`/`initAuth`/theme init/⌘K exactly as they are. |
| `src/routes/+page.svelte` | The muster. |
| `src/routes/activity/+page.svelte` | Uses `ActivityFeed`. |
| `src/routes/nodes/[id]/stations/[stationId]/+page.svelte` | New header + tab bar; existing panels re-hosted unchanged. |
| `src/routes/admin/grants/+page.svelte` | Handles, not `prn_` hashes. |
| `src/app.css` | Fixed status tokens, `--status-unknown`, Archivo `@font-face` blocks. |
| `src/lib/themes/store.svelte.ts` | Stops writing `--status-*`. |
| `src/lib/themes/fonts/index.ts` | Adds the Archivo pairing; it becomes the default. |

**Untouched (re-hosted, not rewritten):** everything under `src/lib/components/stations/` except the station page's own header, all of `src/lib/components/ui/`, `acp-chat.svelte.ts`, `transcript.ts`, `Terminal.svelte`, `file-tree.svelte`, `ConfigEditor.svelte`, `LogTail.svelte`, `MatrixIdentityPanel.svelte`.

---

## Task 1: The state vocabulary and the fixed status tokens

**Files:**
- Create: `src/lib/fleet/state.ts`
- Create: `src/lib/fleet/state.test.ts`
- Modify: `src/app.css` (lines ~633–639 `:root`, ~674–679 `.dark`, ~718–723 `@theme inline`)
- Modify: `src/lib/themes/store.svelte.ts` (the `cyber-*` → `--status-*` writes in `applyColorScheme`)
- Modify: `src/lib/themes/store-status-tokens.svelte.test.ts` (it asserts the old mapping)

**Interfaces — Produces:**
```ts
export type StateId = "running" | "starting" | "unknown" | "error" | "sleeping" | "stopped";

export interface StateInfo {
  id: StateId;
  /** Sentence-case, for the word that always accompanies the dot. */
  label: string;
  /** Tailwind colour token suffix: use as bg-status-{token} / text-status-{token}. */
  token: StateId;
}

export const STATE: Record<StateId, StateInfo>;

/** Worst-first, for sorting and for grouping the roster by state. */
export const STATE_ORDER: StateId[];

/** FleetAgent.status ("running" | "stopped" | "error" | "unknown") → StateInfo. */
export function stationState(status: string): StateInfo;

/** NodeSummary.status ("online" | "offline") → StateInfo. */
export function nodeState(status: string): StateInfo;

/** ProvisionedRuntime.status (8 values) → StateInfo. */
export function runtimeState(status: string): StateInfo;

/** AcpSessionStatus ("starting"|"idle"|"working"|"waiting"|"ended") → StateInfo. */
export function sessionState(status: string): StateInfo;
```

Mappings, exactly:
- station: `running→running`, `stopped→stopped`, `error→error`, `unknown→unknown`, anything else → `unknown`.
- node: `online→running`, `offline→error`, else `unknown`.
- runtime: `provisioning|starting|stopping→starting`, `online→running`, `stopped|destroyed→stopped`, `asleep→sleeping`, `error→error`, else `unknown`.
- session: `starting→starting`, `idle→stopped`, `working→running`, `waiting→unknown`, `ended→stopped`, else `unknown`.

- [ ] **Step 1: Write the failing tests** for every mapping above plus the unknown-fallback, in `src/lib/fleet/state.test.ts`. Include a test asserting `STATE_ORDER` is `["error","unknown","starting","running","sleeping","stopped"]`.

- [ ] **Step 2: Run and watch it fail.** `pnpm vitest run src/lib/fleet/state.test.ts`

- [ ] **Step 3: Implement `src/lib/fleet/state.ts`.**

- [ ] **Step 4: Add `--status-unknown` to app.css.** In the `:root` block beside the other fleet status tokens add `--status-unknown: oklch(0.769 0.188 70.08);` and in `.dark` add `--status-unknown: oklch(0.828 0.189 84.429);` (the values `--status-degraded` currently holds — amber is right for "the hub cannot tell you"). Add `--color-status-unknown: var(--status-unknown);` to the `@theme inline` block beside the other `--color-status-*` entries. Leave `--status-degraded` defined; it is removed in Task 12.

- [ ] **Step 5: Stop the theme store writing status tokens.** In `applyColorScheme` remove the five `cyber-* → --status-*` `setProperty` calls, and add `root.style.removeProperty("--status-running")` and the same for `-starting`, `-error`, `-sleeping`, `-stopped`, `-unknown`, `-degraded` — a removal, not an omission, because a user who already has a scheme applied has those inline styles persisted on `<html>` from a previous session and an omission would leave them stuck. Put a comment above it explaining that a scheme may not recolour state.

- [ ] **Step 6: Rewrite `store-status-tokens.svelte.test.ts`** to assert the inverse of what it asserts today: after `applyColorScheme` for two schemes with different `cyber-*` values, `document.documentElement.style.getPropertyValue("--status-running")` is empty for both, and the token resolves from the stylesheet instead.

- [ ] **Step 7: `pnpm test && pnpm check && pnpm build`**

- [ ] **Step 8: Commit** — `feat(console): one state vocabulary, and a theme can no longer recolour it`

---

## Task 2: Archivo, and the default type pairing

**Files:**
- Create: `static/fonts/archivo/archivo-{400,500,600,700,800}.woff2`
- Modify: `src/app.css` (the `@font-face` region, lines 13–589)
- Modify: `src/lib/themes/fonts/index.ts`
- Modify: `src/lib/themes/fonts/index.test.ts` if one exists; otherwise extend `src/lib/themes/preset-accents.test.ts` coverage is **not** appropriate — add `src/lib/themes/fonts.test.ts`

- [ ] **Step 1: Fetch the Archivo woff2 files.** Use the Google Fonts CSS API with a browser UA so it serves woff2, then download each weight to `static/fonts/archivo/`:
```bash
cd apps/console && mkdir -p static/fonts/archivo
for w in 400 500 600 700 800; do
  url=$(curl -s -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" \
    "https://fonts.googleapis.com/css2?family=Archivo:wght@$w" | grep -o 'https://[^)]*\.woff2' | head -1)
  curl -sL "$url" -o "static/fonts/archivo/archivo-$w.woff2"
done
ls -la static/fonts/archivo/
```
Verify each file is non-empty and starts with `wOF2` (`file static/fonts/archivo/*.woff2` or `head -c4`). If the download fails, STOP and report — do not ship a broken `@font-face`.

- [ ] **Step 2: Add the `@font-face` blocks** to `src/app.css` in the same shape as the existing ones (`font-family: 'Archivo'; font-style: normal; font-weight: N; font-display: swap; src: url('/fonts/archivo/archivo-N.woff2') format('woff2');`), placed alphabetically among the existing families.

- [ ] **Step 3: Add the pairing** to `src/lib/themes/fonts/index.ts`:
```ts
{
  id: "muster-archivo",
  label: "Archivo · IBM Plex Mono",
  category: /* the same category the existing default uses */,
  description: "The console's own pairing: a signage grotesk with an institutional mono.",
  fonts: { "font-body": "Archivo", "font-heading": "Archivo", "font-mono": "IBM Plex Mono" },
}
```
and change `DEFAULT_FONT_PAIRING_ID` to `"muster-archivo"`. Leave `classic-inter` in the list.

- [ ] **Step 4: Write `src/lib/themes/fonts.test.ts`** asserting: `DEFAULT_FONT_PAIRING_ID` resolves in `fontPairingsMap`; every pairing's three font families appear in `app.css` as a `@font-face` family name (read the file with `node:fs` and regex the `font-family:` declarations) — this catches a pairing naming a font that was never bundled, which is the actual failure mode.

- [ ] **Step 5: `pnpm test && pnpm check && pnpm build`**

- [ ] **Step 6: Commit** — `feat(console): Archivo, and a default pairing that is the console's own`

---

## Task 3: One shared fleet poll

**Files:**
- Create: `src/lib/stores/fleet.svelte.ts`
- Create: `src/lib/stores/fleet.svelte.test.ts`

Today `NodesOverview` and `/agents` each run their own 30s poll of overlapping endpoints. The shell, the roster rail, the attention lane and the muster all need the same data; four more polls is not acceptable.

**Interfaces — Produces:**
```ts
export interface FleetSnapshot {
  agents: FleetAgent[];        // from getFleet()
  stats: FleetStats | null;
  nodes: NodeSummary[];        // from listNodes()
  runtimes: ProvisionedRuntime[]; // from listRuntimes()
  loadedAt: number | null;
}
export const fleet: {
  readonly agents: FleetAgent[];
  readonly stats: FleetStats | null;
  readonly nodes: NodeSummary[];
  readonly runtimes: ProvisionedRuntime[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly loadedAt: number | null;
};
/** Idempotent. Returns a stop function. Ref-counted: the last caller to stop ends the poll. */
export function startFleetPoll(): () => void;
export function refreshFleet(quiet?: boolean): Promise<void>;
```

Use `Promise.allSettled` with per-result failure tolerance, exactly as `NodesOverview.loadData` does — one dead endpoint must not blank the shell. Use `startPolling` from `src/lib/utils/poll.ts` (visibility-aware) at 30_000.

- [ ] **Step 1: Write the failing test** — mock `$lib/api/client`, assert: a snapshot populates after `refreshFleet`; a rejected `listRuntimes` leaves `agents` populated and sets no global error; `startFleetPoll` twice then stopping once keeps polling; stopping twice stops it.
- [ ] **Step 2: Run, watch it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `pnpm test && pnpm check && pnpm build`**
- [ ] **Step 5: Commit** — `feat(console): one fleet poll, shared`

---

## Task 4: Deriving what needs a human

**Files:**
- Create: `src/lib/fleet/attention.ts`
- Create: `src/lib/fleet/attention.test.ts`

**Interfaces — Produces:**
```ts
export type AttentionKind = "permission" | "unoccupied" | "node-offline" | "drift" | "runtime-error";

export interface AttentionItem {
  kind: AttentionKind;
  /** The state token that colours the tick. */
  token: StateId;
  /** Prose. Sentence case, no trailing period. "Waiting on your answer" */
  what: string;
  /** The machine-issued name of the thing. Rendered in mono. */
  who: string;
  /** Prose detail. "wants to run a shell command" */
  detail: string;
  /** Where clicking goes. */
  href: string;
}

export function deriveAttention(input: {
  agents: FleetAgent[];
  nodes: NodeSummary[];
  runtimes: ProvisionedRuntime[];
}): AttentionItem[];
```

Rules, in this priority order (the returned array is already sorted):

1. `unoccupied` — an agent row with no principal, or whose principal is suspended. `token: "error"`, what: `"Dispatchable by nobody"`, who: the station key, detail: `"no agent occupies this station"` or `"its agent is suspended"`.
2. `node-offline` — `node.status === "offline"`. `token: "error"`, what: `"Node offline"`, who: node name, detail: `"N agents unknown"` (count the stations on it).
3. `runtime-error` — `runtime.status === "error"`. `token: "error"`, what: `"Runtime failed to start"`, who: runtime name, detail: `runtime.statusReason ?? "no reason given"`.
4. `drift` — `node.updateAvailable`. `token: "unknown"`, what: `"Node agent is behind"`, who: node name, detail: `` `${node.agentVersion} to ${node.latestVersion}` ``.
5. `permission` — deferred: the fleet endpoint does not report a waiting ACP session. **Do not invent an endpoint.** Define the kind, leave it underived, and record the gap in the task report.

An offline node already explains its stations being `unknown`, so a station on an offline node must **not** also produce an item. Test that explicitly.

- [ ] **Step 1: Write the failing tests** — one per rule, plus: empty input gives `[]`; ordering across mixed input; the offline-node suppression above; a suspended principal and a null principal both produce `unoccupied`.
- [ ] **Step 2: Run, watch it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `pnpm test && pnpm check && pnpm build`**
- [ ] **Step 5: Commit** — `feat(console): derive what needs a human`

---

## Task 5: StateDot and StateBar

**Files:**
- Create: `src/lib/components/shell/StateDot.svelte`, `StateDot.svelte.test.ts`
- Create: `src/lib/components/shell/StateBar.svelte`, `StateBar.svelte.test.ts`

`StateDot` props: `{ state: StateInfo; withLabel?: boolean; pulse?: boolean; size?: "sm" | "md" }`. Renders a `bg-status-{token}` dot and, when `withLabel`, the label text. `pulse` adds `animate-pulse` and must be inert under `prefers-reduced-motion` (the existing `@media (prefers-reduced-motion: reduce)` block in app.css already covers `animate-*`; verify and extend if not). Always sets `title` to the label so the dot alone is never the only carrier.

`StateBar` props: `{ counts: Partial<Record<StateId, number>> }`. Renders one segment per non-zero state in `STATE_ORDER`, flex-basis proportional, count shown inside when the segment is over 7% wide, plus a legend below with dot + label + count. Each segment is a button emitting `onselect(state)`.

- [ ] **Step 1: Write the failing tests.** For `StateBar`: given `{running:12, stopped:3}` two segments render with the right labels and counts; zero-count states are absent; the legend lists both.
- [ ] **Step 2: Run, watch fail. Step 3: Implement. Step 4: `pnpm test && pnpm check && pnpm build`. Step 5: Commit** — `feat(console): a dot that always carries its word`

---

## Task 6: The shell

**Files:**
- Create: `src/lib/components/shell/TopBar.svelte` + test
- Create: `src/lib/components/shell/AttentionLane.svelte` + test
- Create: `src/lib/components/shell/AppShell.svelte` + test
- Modify: `src/routes/+layout.svelte`
- Delete: `src/lib/components/app-shell.svelte`, `src/lib/components/app-shell.svelte.test.ts`

This is the task that must not break anything. The new `AppShell` renders `{@render children()}` in the stage column, so **every existing route keeps rendering unchanged inside it**.

`AppShell` layout: `grid-rows-[46px_auto_1fr]`, and inside the third row a `grid-cols-[272px_1fr_320px]`. The roster rail slot is empty in this task (Task 7 fills it); reserve the column and render nothing in it, so the grid is proven before the rail lands. The context rail column is rendered only when a `contextRail` snippet prop is supplied — no route supplies one yet.

**Critical CSS note from the prototype:** the outer grid needs `grid-template-columns: minmax(0, 1fr)` and the columns grid needs `min-width: 0` on its children, or the attention lane's horizontally-scrolling item list forces the whole shell wider than the viewport and pushes the right column off-screen. This bug was found and fixed in the prototype; do not reintroduce it.

`TopBar` contents, left to right: a mobile-only roster toggle, the `AGENTPOD · MUSTER` wordmark (`· MUSTER` hidden under 900px), the **hub pill** — a button showing `connection.apiUrl` with its host only, in mono, with a `StateDot` coloured by `connection.reachable`, linking to `/settings` — a spacer, the palette cue (`Message an agent, or run a command` + `⌘K`, collapsing to an icon under 900px) wired to `commandPalette.toggle()`, the appearance menu button linking to `/settings`, and the user avatar with initials from `auth.initials`.

The hub pill is the point of this task beyond layout: a console pointed at `localhost:3001` currently looks identical to a working one.

`AttentionLane` props: `{ items: AttentionItem[] }`. A fixed label cell (`NEEDS YOU` + count badge, the badge `bg-status-unknown` when non-zero and a bordered outline when zero), then a horizontally scrolling list, or — when empty — the words `Nothing needs you. The fleet is running itself.`

Responsive, exactly as the spec's table: ≤1240px hides the context column, ≤900px collapses to one column with roster/stage as two views driven by a `view` state on the shell, ≤560px truncates the hub pill.

- [ ] **Step 1: Write the failing tests.** `AppShell`: renders its children; shows the hub host; the lane's empty wording appears with `items: []`. `TopBar`: clicking the palette cue calls the store's toggle; the avatar shows `auth.initials`. `AttentionLane`: N items render N buttons with their `what` and `who`; the count badge shows N.
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement, and update `src/routes/+layout.svelte`** to import the new `AppShell` — keeping `initConnection`/`initAuth`/`themeStore.initialize`/the ⌘K handler/`startReachabilityProbe`/the `/login` public-route logic **byte-for-byte as they are**. Only the component being rendered changes.
- [ ] **Step 4: Delete the old shell and its test.**
- [ ] **Step 5: Walk every route manually** with `pnpm dev` and confirm each still renders: `/`, `/agents`, `/nodes`, `/nodes/[id]`, `/runtimes`, `/activity`, `/settings`, `/admin/users`, `/admin/grants`. Record in the report which you loaded.
- [ ] **Step 6: `pnpm test && pnpm check && pnpm build`**
- [ ] **Step 7: Commit** — `feat(console): a shell that says which hub it is talking to`

---

## Task 7: The roster rail

**Files:**
- Create: `src/lib/components/shell/RosterRail.svelte` + test
- Modify: `src/lib/components/shell/AppShell.svelte` (fill the reserved column)

One row per agent, 34px (`h-[34px]`), `grid-cols-[3px_12px_1fr_auto]`: state ribbon (full-height `bg-status-*`), `StateDot`, handle in mono truncating, then either a flag dot (waiting / suspended / unoccupied, `title` explaining which) or the time since last activity via the existing `src/lib/utils/relative-time.ts`.

Header: a filter input matching handle, node, harness, station key, purpose and status; a count; and one button cycling `by node → by state → by name`. Grouping headers are sticky. Below a divider, a "Where they run" section with `Nodes` and `Runtimes` links carrying counts.

Keyboard: `j`/`k` move the selection and scroll it into view; `Escape` clears it. Register these on the shell, and **ignore them when the event target is an input or textarea** or typing in the filter box will navigate the roster.

Selection drives the route: clicking an agent goes to `/nodes/{nodeId}/stations/{stationId}`, which is the existing station route. The rail highlights the row matching the current URL rather than holding its own selection state, so a deep link and a click agree.

- [ ] **Step 1: Write the failing tests.** Given 5 agents on 2 nodes: node grouping renders 2 headers; cycling to state grouping regroups; filtering by `"hermes"` narrows to the hermes stations; a row's `aria-current` follows a mocked `page.url.pathname`; an agent with a null principal renders the unoccupied flag.
- [ ] **Step 2: Run, watch fail. Step 3: Implement. Step 4: `pnpm test && pnpm check && pnpm build`. Step 5: Commit** — `feat(console): the fleet is the navigation`

---

## Task 8: The muster

**Files:**
- Modify: `src/routes/+page.svelte` (147 LOC today)
- Create: `src/lib/components/fleet/ActivityFeed.svelte` + test
- Modify: `src/routes/activity/+page.svelte` to use `ActivityFeed`
- Modify or delete: `src/lib/components/fleet/OverviewStats.svelte`, `FleetHeatmap.svelte`, `NeedsAttention.svelte`, `RecentActivity.svelte`, `StatusRibbon.svelte` and their tests — the muster replaces all five. Delete the ones nothing else imports; check with `rg` before deleting.

The page: a hero stating the fleet in words — `{n} agents on {m} nodes.` then `{k} need you.` on its own line, coloured `text-status-unknown` when k > 0 and `text-status-running` when k is 0 — the `StateBar`, the nodes table (Node / Link / Agents / Uptime / Node agent / Posture / action, with the drift cell showing `v0.1.27 → v0.1.32` and an Update button in the row), and `ActivityFeed`.

`ActivityFeed` props: `{ rows: ActivityRow[]; limit?: number }`. **Collapse consecutive rows sharing the same `verb` and `result`** into one row with a `×N` badge. Row shape: time (mono) · a tick coloured by result (`ok→running`, `pending→unknown`, `error→error`) · verb (mono) · subject (mono) · result · detail.

- [ ] **Step 1: Write the failing tests.** `ActivityFeed`: 18 consecutive identical `posture.scan` rows render as one row with `×18`; a different verb between two identical ones prevents collapsing (three rows out). Muster: the hero states the counts; a node with `updateAvailable` renders an Update button.
- [ ] **Step 2: Run, watch fail. Step 3: Implement. Step 4: Delete the superseded components only after `rg` shows no importers. Step 5: `pnpm test && pnpm check && pnpm build`. Step 6: Commit** — `feat(console): the fleet in words, and eighteen identical rows become one`

---

## Task 9: The station page

**Files:**
- Modify: `src/routes/nodes/[id]/stations/[stationId]/+page.svelte` (421 LOC)
- Modify: its test (319 LOC)
- Create: `src/lib/components/shell/ContextRail.svelte` + test

Header: `StateDot` + handle in mono at 21px, then a prose line `{stationKey} on {node} · {state} · last spoke {t} ago`, then Restart and a destructive Stop. Tabs stay exactly as they are — capability-gated, `?tab=` driven, Chat default when `acp` is present — but restyled as an underlined tab bar. **Chat opens on the transcript**, with the session mode chips on one line above it.

`ContextRail`: Identity (handle, mxid, principal id, credential mode in prose — "Held by the agent itself" for `harness`, "The bridge speaks for it" for `bridge`), Placement (station key, node, harness, node-agent version, purpose), and Who may dispatch it. The last section needs `GET /api/admin/grants`, which is admin-only: for a non-admin, render Identity and Placement and one line saying the grant is not visible to them. Do not call the endpoint as a non-admin.

Below 1240px the rail is not rendered by the shell; the station page adds an **Identity tab** in that case, using `matchMedia("(max-width: 1240px)")` with a listener so it appears and disappears on resize.

- [ ] **Step 1: Write the failing tests.** Chat is the default tab for an `acp`-capable station and Health for one without; the header shows the station key in a `font-mono` element; a `harness`-mode station's rail says "Held by the agent itself"; a non-admin sees the grant-not-visible line and `listGrants` is not called.
- [ ] **Step 2: Run, watch fail. Step 3: Implement. Step 4: `pnpm test && pnpm check && pnpm build`. Step 5: Commit** — `feat(console): the station page opens on the conversation`

---

## Task 10: Nodes, Runtimes, Grants

Three independent, same-shape restyles. **Batch them into one dispatch.**

**Files:**
- Modify: `src/lib/components/fleet/NodesOverview.svelte` (496) + test — adopt `StateDot`, the drift cell, and drop the card chrome. `/nodes/[id]` keeps its panels; only its header and the "Detected agents" list restyle, and the 15-cards-saying-Added list becomes one table.
- Modify: `src/routes/runtimes/+page.svelte` (375) + test — a table with `statusReason` prose under the status pill, and conditional Start / Wake (`asleep`) / Stop / Destroy.
- Modify: `src/routes/admin/grants/+page.svelte` (426) + test — **render principals as handles with a kind label, never as a bare `prn_` hash.** The id stays available (a `title`, and shown in the dialog) but is never the primary label. Group by kind.

- [ ] **Step 1:** For each, write the failing test first (grants: a principal renders its handle and not its `prn_` id as the row label; runtimes: an `asleep` runtime offers Wake, an `error` one shows its `statusReason`; nodes: a node with `updateAvailable` shows both versions).
- [ ] **Step 2: Run, watch fail. Step 3: Implement all three. Step 4: `pnpm test && pnpm check && pnpm build`. Step 5: Commit** — `feat(console): three tables that say what they mean`

---

## Task 11: Palette verbs

**Files:**
- Modify: `src/lib/components/command-palette.svelte` (89) + test (201)

Groups: **Go to** — one entry per agent, `Message {handle}`, tailed with node and state, navigating to its station page. **Fleet** — update every node agent (only when at least one is behind, tailed with the count), create an enrolment token, new runtime, run a posture scan. **Authority** — edit a grant, suspend a principal; both tailed `destructive` in `text-status-error`.

Only offer an action the current user may perform: the Authority group is admin-only.

- [ ] **Step 1: Write the failing tests** — typing a handle surfaces its Message entry; a non-admin sees no Authority group; with no node behind, the update entry is absent.
- [ ] **Step 2: Run, watch fail. Step 3: Implement. Step 4: `pnpm test && pnpm check && pnpm build`. Step 5: Commit** — `feat(console): a palette with the fleet's verbs in it`

---

## Task 12: Retire what the redesign replaced

**Files:**
- Modify: `src/app.css` — remove `--status-degraded` and `--color-status-degraded` once `rg "status-degraded" src/` is empty.
- Modify: `src/lib/components/page-header.svelte` (192) — its description slot must not be mono. Check `t-body`/`t-label` utilities in app.css lines 736–764 and fix whichever sets a mono family for prose.
- Delete: `src/lib/components/ui/bottom-nav/` if the new shell no longer uses it and `rg` shows no importers.
- Modify: `src/routes/agents/+page.svelte` — the roster rail replaces it as a destination, but it is the only place an agent is **created** and **assigned to a station**. Keep it, reachable from the palette and from the roster's empty state; do not delete it.

- [ ] **Step 1: `rg` for each symbol before deleting anything. Record what you found.**
- [ ] **Step 2: Remove. Step 3: `pnpm test && pnpm check && pnpm build`. Step 4: Commit** — `chore(console): remove what the redesign replaced`

---

## Task 13: Responsive and accessibility verification

**Files:** whatever the findings require.

- [ ] **Step 1:** Run `pnpm build && pnpm preview`, and with Playwright check at 1500px, 1240px, 900px and 414px that `document.documentElement.scrollWidth === window.innerWidth` on `/`, a station page, `/runtimes` and `/admin/grants`. The prototype hit exactly this bug twice; it is the single most likely regression.
- [ ] **Step 2:** Verify keyboard focus is visible on the roster, the tabs, the palette and every destructive button; that `j`/`k` do nothing while a text input has focus; and that `prefers-reduced-motion` stops the `starting` pulse.
- [ ] **Step 3:** Confirm no status is conveyed by hue alone anywhere — every dot has a word or a `title`.
- [ ] **Step 4: Fix what you find. Step 5: `pnpm test && pnpm check && pnpm build`. Step 6: Commit.**

---

## Self-review notes

- **Spec coverage:** Laws 1 and 2 → Tasks 1, 12. Shell → 6. Roster → 7. Attention lane → 4, 6. Muster → 8. Station page → 9. Context rail → 9. Activity → 8. Admin → 10. Palette → 11. Personalisation → 1, 2. Responsive/a11y → 6, 13.
- **Known gap, deliberate:** the `permission` attention kind cannot be derived from any endpoint the console has. Task 4 defines it and leaves it underived rather than inventing a hub change, per Global Constraint 5. This is the one place the prototype shows something the build will not.
- **Known gap, deliberate:** `PUBLIC_HUB_URL` is not fixed here (spec, Out of scope). Task 6 makes the symptom visible instead.
