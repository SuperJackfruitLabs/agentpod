# Muster: reimagining the AgentPod console

**Status:** approved 2026-09-02
**Prototype:** https://claude.ai/code/artifact/ba28a356-2d93-4b68-aa87-bcd54bc09689
**Supersedes the findings in:** the console review of 2026-09-01

---

## Why

The console today is the database schema rendered as navigation. Its sidebar
reads Overview / Agents / Nodes / Runtimes / Activity — five tables, one per
entity, in the order the entities were built. Nothing on any of those pages
tells you what needs a person.

Two observations from walking all ten routes fix the diagnosis:

**The search box is on the page with one row.** Admin · Users has a search
field, two filter dropdowns, a Search button and a refresh control above a
single row. Agents has thirty-two rows and no search, no filter, no sort. The
apparatus is where it was cheap to add and absent where it is needed, because
neither was decided by looking at the screen.

**The two readable pages are the two that use plain tables.** Nodes is the best
page in the console — a real table, status pills, and a version cell reading
`v0.1.27 → v0.1.32` with an Update button *in the row*: state and its remedy in
the same place. Almost everything else is a bordered card, so borders have
stopped meaning grouping.

The rest follows from those two. Overview reports "5 stopped" for what is
`stopped·4 / unknown·1`. Agents renders each name twice, identically for 30 of
32 rows, and repeats two links 64 times. Node detail shows 15 cards, 14 of
which say "Added", with paths truncated at the wrong end. Station detail's Chat
tab opens on two settings cards. Activity shows 18 identical `posture.scan`
rows with an empty Agent column. Grants prints 32 raw `prn_` hashes.

## What this is not

This is not a re-skin. The token set stays close to what shadcn already gives
us; what changes is the shell, the information architecture, and two laws that
did not exist before. Individual panes that already work — the file tree, the
terminal, the diff viewer, the config editor — are kept as they are and
re-hosted. Their rewrite is out of scope and is not deferred work either: they
are not the problem.

---

## The two laws

Everything below is downstream of these. They are stated first because every
later decision is checkable against them.

### Law 1 — Colour means state

All chrome is achromatic: ground, surface, line, ink, and the dim and faint
inks derived from it. The only saturated colour on any screen encodes a
station, node, runtime or session state.

Six state tokens, and no others:

| Token | Hue role | Applies to |
|---|---|---|
| `--st-running` | green | station `running`, node `online`, runtime `online` |
| `--st-starting` | teal | runtime `provisioning` / `starting` / `stopping`, session `starting` |
| `--st-unknown` | amber | station `unknown`, anything the hub cannot currently answer |
| `--st-error` | rust | station `error`, node `offline`, runtime `error` |
| `--st-asleep` | violet | runtime `asleep` |
| `--st-stopped` | grey | station `stopped`, runtime `stopped` — deliberately colourless |

`unknown` gets its own colour and is never folded into `stopped`. "The hub
cannot tell you" is a different fact from "it is off", and collapsing them is
what produced Overview's "5 stopped". Station live status is exactly
`running | stopped | error | unknown` (`unknown` when the node is offline, no
health report exists, or the report is older than 75s). There is no "degraded".

**A theme may not redefine these six.** See Personalisation.

### Law 2 — Mono means machine-issued

`--mono` is for strings a machine minted and a person must be able to compare
character by character: handles, station keys, mxids, `prn_` ids, session ids,
version tags, timestamps, audit verb names, room ids, file paths.

Prose is never mono. Today every page header sets its description in mono,
which is why the console reads like a config file.

---

## Structure

### The shell

Three columns under a 46px top bar and one attention lane.

```
┌──────────────────────────────────────────────────────────────┐
│ AGENTPOD · MUSTER   ● hub.agentpod.dev      ⌘K   ◑   RG      │  46px
├──────────────────────────────────────────────────────────────┤
│ NEEDS YOU 5 │ Waiting on your answer writer-quill │ … │ … │  │  lane
├───────────┬────────────────────────────────┬─────────────────┤
│ roster    │ stage                          │ context         │
│ 272px     │ 1fr                            │ 320px           │
└───────────┴────────────────────────────────┴─────────────────┘
```

**The hub URL is permanently visible in the top bar.** This is a functional
fix, not decoration: `hubUrl()` falls back to `http://localhost:3001`, and the
hosted console has no `PUBLIC_HUB_URL` at build time, so a console pointed at
nothing looks identical to a working one. It stays on screen with a
reachability dot, and clicking it opens the hub switcher.

### The roster rail — the fleet is the navigation

One row per agent, 34px, always present. Columns: a 3px state ribbon, a status
dot, the handle in mono, and either a flag (waiting on you / suspended /
dispatchable by nobody) or the time since it last spoke.

The ribbons form a vertical barcode of fleet health readable in one glance.

- Grouped by node (default), by state, or flat by name — one control cycles.
- A filter box that earns its place: it matches handle, node, harness, station
  key, purpose and status.
- Below a divider, "Where they run": Nodes and Runtimes as two entries.

This replaces Overview, Agents and Nodes as *destinations*. Nodes and Runtimes
keep their pages; they stop being the way you reach an agent.

### The attention lane — the signature

A single strip holding only things that need a human. Sources, in priority
order:

1. A session in `waiting` (a permission request is pending).
2. A station whose `principalId` is null, or whose principal is suspended —
   "dispatchable by nobody". Per the hub inventory this is the console's single
   most important non-error warning state, and today it is a banner on one page.
3. A node `offline`, with the count of stations it takes `unknown` with it.
4. A node agent behind `latestVersion`, with the drift and an Update.
5. A runtime in `error`, carrying its `statusReason` prose.

Each item names the thing in mono and states the condition in prose, and clicks
through to the agent or page that can resolve it.

**When there is nothing, the lane says so in words** — "Nothing needs you. The
fleet is running itself." A dashboard whose proudest state is empty.

### The stage

- **Nothing selected → the muster.** A hero stating the fleet in words
  (`22 agents on 5 nodes. 5 need you.`), one stacked state bar replacing six
  stat cards, the nodes table, and the activity feed with repeats collapsed.
- **An agent selected → the station page.** Header carries handle, station key,
  node, state and last-spoke. Tabs are capability-gated exactly as today
  (`acp`→Chat, `logs`, `fs.read`→Files, `terminal`, `changeset`→Changes,
  `cleanup`; Health and Activity always). **Chat is the default tab and opens
  on the transcript**, with the session-mode chips (Ask / Accept edits / Full
  auto) on one line above it and the approval gate inline in the transcript.
- **Nodes / Runtimes** keep dedicated pages in the same language.

### The context rail — identity gets a permanent home

Three sections: Identity (handle, mxid, principal id, credential mode),
Placement (station key, node, harness, node-agent version, purpose), and **Who
may dispatch it** — rendered as handles with a person/agent/service kind, never
as `prn_` hashes, with the enforcement state stated in one line.

Below 1240px the rail is hidden and **Identity becomes a tab** on the station
page. It does not disappear.

### Activity

Consecutive events with the same verb and result collapse to one row with a
`×N` count. The row is `time · result-coloured tick · verb (mono) · subject
(mono) · result · detail`. Eighteen identical `posture.scan` rows become one.

### Admin

Admin keeps its own surface — Users and Grants — in the same design language,
reached from the command palette and a link in the top bar, **not** from the
roster rail. Operating the fleet and administering it are different jobs, and
mixing them puts ban and suspend one keystroke from a chat box.

Grants renders principals as handles grouped by kind. The `prn_` id is
available but is never the primary label.

### The command palette

Already exists (⌘K). It grows real verbs: message an agent by handle, update
every node agent, create an enrolment token, run a posture scan, new runtime,
edit a grant, suspend a principal. Destructive entries are marked.

---

## Personalisation

Themes stay. They are personalisation, not a substitute for a design decision.

**A theme moves the ground and the type. It never touches the six state
hues.** If a theme could recolour `error`, Law 1 would be false the moment
someone picked one, and the design would lose the only thing holding it
together.

- **Schemes** redefine eleven neutral tokens only: `ground, surface, surface-2,
  raised, line, line-soft, ink, ink-dim, ink-faint, sel, sel-line`. Five ship:
  Ink (default), Slate, Umber, Harbor, Carbon. Each defines a light and a dark
  variant.
- **Mode** is system / light / dark. System is the default and follows
  `prefers-color-scheme`.
- **Type pairings**: Archivo · IBM Plex Mono (default), Inter · JetBrains Mono
  (what the console ships today, so nothing familiar is taken away), Instrument
  Sans · Spline Sans Mono.
- Custom user themes continue to work, and are constrained to the same eleven
  neutrals.

The existing theme store keeps its persistence and its public API. What changes
is the token set it writes and the fact that it can no longer write state
colours.

---

## Accessibility and responsiveness

- Every state is carried by a dot **and** a word, never by hue alone.
- Visible keyboard focus on every control; `prefers-reduced-motion` respected —
  the only animation is a slow pulse on `starting`, meaning work in progress.
- `j`/`k` move through the roster, `esc` returns to the muster, ⌘K opens the
  palette.
- **≤1240px** — the context rail folds into an Identity tab.
- **≤900px** — one column. Roster and stage become two screens; selecting an
  agent goes to it, a top-bar control returns to the roster.
- **≤560px** — the hub URL truncates, the palette cue becomes an icon.
- Wide content (tables, diffs, terminal) scrolls inside its own container. The
  page body never scrolls horizontally.

---

## Out of scope

- The `PUBLIC_HUB_URL` build-time configuration bug. The console review found
  it and it is real, but it is a build/deploy fix, not a UI one, and it is
  tracked separately. This spec makes the *symptom* visible (the hub pill); it
  does not fix the cause.
- Console auto-deploy from GitHub to Cloudflare Pages.
- Rewriting the file tree, terminal, diff viewer, config editor or permission
  card internals.
- Any hub or contract change. This is a console-only spec. If a screen wants a
  field the API does not return, the screen does without it and the gap is
  recorded, rather than the hub growing an endpoint mid-plan.

## Assumptions recorded

- Admin is its own surface (settled here, not by the user).
- The six state tokens replace today's six (`running, degraded, starting,
  stopped, error, sleeping`). `degraded` and `sleeping` are retired as station
  states; `sleeping` survives as the runtime `asleep` token.
- No API changes, so "who may dispatch it" for one agent is derived from the
  existing `GET /api/admin/grants` payload and is admin-only. For a non-admin
  the context rail shows Identity and Placement and says the grant is not
  visible to them, rather than showing an empty list.
