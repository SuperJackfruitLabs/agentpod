# Station Configuration Tab — Design

**Date:** 2026-10-06
**Status:** approved, not yet implemented
**Scope:** `apps/console` station detail page information architecture

## Problem

An operator cannot find how to configure a station, because the console files
configuration under two headings that do not say "configuration":

- **`Skills`** holds three panels — skills inventory, skills management, and
  **plugin management**. `hasSkills` (`+page.svelte:181`) is
  `inventory || manage || native || plugins`, so plugins are reachable only by
  opening a tab whose label does not mention them.
- **`Files`** holds the file browser *and* the `HarnessConfigPanel`
  (`+page.svelte:669`), the declared-configuration surface shipped in #672.
  Nothing in the label suggests a station's declared settings live there.

So "configuration" currently means three unrelated-looking things in two tabs:
raw file editing (`ConfigEditor`, a dialog opened from the file browser),
declared harness settings, and plugin/skill enablement.

## The fact that decides the shape

These are not three unrelated things. On a Hermes station, plugin enablement,
skills registration and `approvals.*` all live in **one** configuration
document, and declared configuration reaches them by calling **the same
writers** the dedicated features use:

- `hermes_config_foldin.go:159` calls `hermesskills.RegisterIn` — the same
  function `apn hermes-skills register` reaches through `hermesskills.Register`
  (`hermes_config_foldin.go:135-136`).
- `hermes.plugins.enabled` and `hermes.plugins.stream_reasoning_deltas` are
  owned as one indivisible edit by `hermeslive.PlanEnableConfig`, which the
  fold-in reaches through `delegatePluginEnablement` (`hermes_config.go:95-97`),
  and that fold-in is required to produce byte-identical output to the verb it
  delegates to (`hermes_config_foldin.go:20`).

The console splits across two tabs what the node treats as one file. The fix is
to stop doing that.

## Decisions

**D1 — One tab, named Configuration.** The `Skills` tab becomes
**`Configuration`**, tab id `config`. The label is the operator's word for what
the tab does. "Config" alone is avoided in the UI label because the raw
`ConfigEditor` already claims that word for file editing.

**D2 — Three sections, ordered by how often they are touched.**

1. *Declared configuration* — `HarnessConfigPanel`
2. *Plugins* — `PluginManagementPanel`
3. *Skills* — `SkillsPanel` (inventory) then `SkillManagementPanel`

**D3 — Files goes back to being about files.** `HarnessConfigPanel` is removed
from the `filesContent` snippet. The `ConfigEditor` dialog stays where it is: it
edits a file, reached from the file browser, and that is honest.

**D4 — The tab's gate widens.** From `hasSkills` to
`hasSkills || hasConfigManagement`. This closes a real hole: a station that
advertises `config.manage` but no skills capability has, today, no tab of its
own — its declared configuration appears only under Files.

**D5 — Old deep links keep working.** Tab ids live in the URL (`?tab=`) because
the 2026-08-08 navigation audit's finding 2 made them deep-linkable, so
`?tab=skills` links exist in the wild. An unknown `?tab=` value currently falls
back to the default tab **silently** (`+page.svelte:90-99`), which would land a
stale link on Health with no explanation. Therefore:

- a resolution alias maps `skills` → `config`, applied before the
  `VALID_TABS` check;
- `handleTabChange` always writes the canonical id, so the alias never
  propagates into new links.

`?tab=files` stays valid. Someone who bookmarked Files *for the config panel*
lands on Files, which is indistinguishable from a genuine Files link and is not
worth guessing at.

**D6 — Configuration is a keep-alive tab, and re-entry refreshes.**
`HarnessConfigPanel` captures a plan and its digest **once and never
re-fetches**, by design: "re-deriving or re-fetching a digest at apply time
would silently turn 'apply what I reviewed' into 'apply whatever is current' —
the thing the digest exists to prevent" (`HarnessConfigPanel.svelte:152-162`).
Today the panel rides inside Files' `keepAlivePanel`, so a review survives a
tab switch. Under plain `mountedPanel` it would not: tabbing to Logs to check
something mid-review would destroy the reviewed plan.

So the tab uses `keepAlivePanel`, plus one addition: **re-entering the tab
refreshes the observation rows and leaves a captured plan intact**, and the plan
displays the time it was captured.

Keep-alive is safe here *because* apply sends the captured digest and a moved
document is refused with `PLAN_DIGEST_MISMATCH` / `PLAN_STALE`. Staleness can
therefore only ever produce a visible refusal, never a silent wrong write. The
same reasoning upgrades `PluginManagementPanel`, which uses the identical
capture discipline and today remounts on every visit.

**D7 — No accordion in v1.** Three bordered sections with headings. The panels
already carry their own chrome, and which section should start collapsed is a
guess until the tab has been used.

**D8 — Icon.** `Configuration` takes a sliders icon. `Skills` currently uses
`ScrollTextIcon` (`+page.svelte:356`), the same icon as `Logs`
(`+page.svelte:340`); retiring the tab ends that collision.

## Out of scope

Named here so they are not rediscovered as omissions:

- A staleness indicator on observation rows. D6 keeps today's freshness
  behaviour for the declared-configuration rows and improves it on re-entry;
  showing *how* stale an observation is remains unsolved and unasked-for.
- Relocating the raw `ConfigEditor`. It stays in Files (D3).
- Any other tab's label or position. Chat, Health, Logs, Terminal, Changes,
  Cleanup, Activity and the Identity rail are untouched.

## Testing

Page-level, in `page.svelte.test.ts` (which already drives `?tab=` through a
writable store):

- `?tab=skills` resolves to the Configuration tab and the tablist marks it
  selected — the alias of D5;
- choosing the tab writes `?tab=config`, never `?tab=skills`;
- the tab renders for a station advertising `config.manage` and **no** skills
  capability — the hole D4 closes;
- the Files tab no longer renders the declared-configuration panel;
- all three sections appear when every capability is advertised, and each is
  absent when its own capability is not.

`HarnessConfigPanel.svelte.test.ts`, `PluginManagementPanel.svelte.test.ts`,
`SkillsPanel.svelte.test.ts` and `SkillManagementPanel.svelte.test.ts` move with
their components unchanged — this design changes where panels are mounted, not
what they do.

A test for D6 must fail if the tab is switched to `mountedPanel`: capture a
plan, switch tabs, return, and assert the plan and its digest are still
displayed.

## Documentation impact

Three live documents reference these tabs. Measured, not estimated:

- **`docs-site/src/content/docs/use/config.md:532`** — published. The section
  "Seeing and applying it from the console" says the panel is on "its **Files**
  tab, below the file browser". Must be rewritten.
- `docs/strategy/2026-09-20-managed-skills.md:339` — "The station Skills tab
  exposes management only when `skills.manage` is advertised."
- `docs/OPERATING.md:1671` — refers to the Files tab for *browsing files*, and
  stays correct.

Archived docs, the 2026-08-08 audit and historical plans are records of what was
true when written and are not rewritten.

## Verification

Beyond the suite: on a live workspace station with `config.manage`, confirm the
tab appears, all three sections render, a declared setting can be planned and
applied from it, an old `?tab=skills` link lands on it, and the Files tab shows
only the browser.
