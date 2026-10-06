# Station Configuration Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a station one tab, `Configuration`, that holds declared configuration, plugins and skills — the three surfaces that write one config document on the node — and give the `Files` tab back to files.

**Architecture:** Pure console change. The `skills` tab id becomes `config`, with an alias so existing `?tab=skills` links still land somewhere sensible; `HarnessConfigPanel` moves out of the `Files` tab's snippet into the new tab beside `PluginManagementPanel`, `SkillsPanel` and `SkillManagementPanel`. The tab is keep-alive so a reviewed plan survives a tab switch, and the harness panel gains an `active` prop so re-entering the tab refreshes its observation rows without destroying that plan. No hub, node, or contract change.

**Tech Stack:** SvelteKit (`adapter-static`, SPA), Svelte 5 runes, TypeScript, vitest + @testing-library/svelte, Tailwind, `@lucide/svelte` icons.

**Spec:** `docs/superpowers/specs/2026-10-06-station-configuration-tab-design.md`

## Global Constraints

- **TDD.** Failing test first, every time; a regression test for every bug fix (`CLAUDE.md`).
- **Never break an existing `?tab=` link.** Tab ids are in URLs since the 2026-08-08 navigation audit; an unknown value falls back to the default tab *silently*, so a retired id must be aliased, not dropped (spec D5).
- **Never re-fetch or re-derive a plan digest at apply time.** Apply sends the digest of exactly the plan on screen; re-reading it would turn "apply what I reviewed" into "apply whatever is current" (`HarnessConfigPanel.svelte:155-162`, spec D6).
- **Local host or agent names never appear in shipped code, tests or docs.** The product word is **workspace**.
- **Verification command:** `cd apps/console && pnpm check && pnpm test && pnpm build`. `pnpm check` runs `svelte-kit sync` first — it is SvelteKit.
- **In a fresh worktree, run `pnpm install` then `pnpm exec svelte-kit sync` before `pnpm test`.** Without the sync there is no `.svelte-kit/tsconfig.json`, and vitest dies in `vite:esbuild` resolving `tsconfig.json`'s `extends` — a failure that looks nothing like its cause.
- Required CI checks are `contract`, `hub`, `node-agent`, `console`, `worker`, and branch protection is `strict`: the branch must be up to date with `main` before it merges.
- Console production builds need `PUBLIC_HUB_URL=https://hub.agentpod.dev` at build time.

## File Structure

| File | Responsibility after this plan |
|---|---|
| `apps/console/src/lib/components/stations/HarnessConfigPanel.svelte` | Unchanged purpose. Gains an `active` prop (refresh on re-entry) and shows when its plan was captured. |
| `apps/console/src/lib/components/stations/HarnessConfigPanel.svelte.test.ts` | Gains the two tests for that behaviour. |
| `apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte` | Owns the tab list, the `?tab=` alias, and which panels each tab hosts. |
| `apps/console/src/routes/nodes/[id]/stations/[stationId]/page.svelte.test.ts` | Gains the tab-identity, gating and panel-placement tests. |
| `docs-site/src/content/docs/use/config.md` | Published prose must name the new tab. |
| `docs/strategy/2026-09-20-managed-skills.md` | One sentence naming the old tab. |

`PluginManagementPanel`, `SkillsPanel`, `SkillManagementPanel` and their tests are **not modified** — they are re-hosted, not rewritten.

---

### Task 1: The harness panel refreshes on re-entry and dates its plan

Spec D6. The panel is about to live in a keep-alive tab, so it can be hidden and shown again without remounting. On being shown again it must re-read its observation rows, and it must **not** discard a plan under review.

**Files:**
- Modify: `apps/console/src/lib/components/stations/HarnessConfigPanel.svelte` (props at `:30-35`; `reloadTrigger` at `:169`; `reviewChanges`'s accept callback at `:202-204`; the review section's header at `:397-399`)
- Test: `apps/console/src/lib/components/stations/HarnessConfigPanel.svelte.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a new optional prop on `HarnessConfigPanel` — `active?: boolean`, default `true`. Task 2 passes `active={activeTab === "config"}`. Default `true` keeps every existing call site and test working unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `apps/console/src/lib/components/stations/HarnessConfigPanel.svelte.test.ts`:

```ts
test("becoming active again re-reads the observations", async () => {
  const getStationConfig = mockLoad({
    observations: [observation({ state: "matches", declared: true, observed: true, level: "station" })],
    settings: [setting({ id: "hermes.plugins.enabled" })],
  });
  // `rerender` REPLACES the prop set in @testing-library/svelte 5 — every
  // rerender below spreads `props`, or stationId/nodeId would vanish and the
  // panel would reload for a different reason than the one under test.
  const props = { stationId: STATION_ID, nodeId: NODE_ID, stationKey: STATION_KEY, active: true };
  const view = render(HarnessConfigPanel, { props });
  await waitFor(() => expect(getStationConfig).toHaveBeenCalledTimes(1));

  // Hidden (the operator switched tabs), then shown again.
  await view.rerender({ ...props, active: false });
  await view.rerender({ ...props, active: true });

  await waitFor(() => expect(getStationConfig).toHaveBeenCalledTimes(2));
});

test("a plan under review survives being hidden and shown again, and apply still sends the reviewed digest", async () => {
  mockLoad({
    observations: [
      observation({ settingId: "hermes.command_timeout_ms", state: "drifted", declared: 900, observed: 300 }),
    ],
    settings: [setting({ id: "hermes.command_timeout_ms" })],
  });
  const planSpy = vi
    .spyOn(api, "planStationConfig")
    .mockResolvedValue(plan({ planDigest: "digest-reviewed", operationId: "cfgop_reviewed" }));
  const applySpy = vi.spyOn(api, "applyStationConfig").mockResolvedValue(receipt({ phase: "applied" }));

  const props = { stationId: STATION_ID, nodeId: NODE_ID, stationKey: STATION_KEY, active: true };
  const view = render(HarnessConfigPanel, { props });
  await waitFor(() => expect(view.getByRole("row", { name: /hermes\.command_timeout_ms/ })).toBeTruthy());
  await fireEvent.click(view.getByRole("button", { name: "Review changes" }));
  await waitFor(() => expect(view.getByText("digest-reviewed")).toBeTruthy());
  expect(view.getByText(/Planned at /)).toBeTruthy();

  await view.rerender({ ...props, active: false });
  await view.rerender({ ...props, active: true });

  // The plan on screen is still the reviewed one...
  expect(view.getByText("digest-reviewed")).toBeTruthy();
  // ...and it is exactly what apply sends. This is the invariant that makes
  // keep-alive safe: never "apply whatever is current" (spec D6).
  await fireEvent.click(view.getByRole("button", { name: "Apply reviewed plan" }));
  await waitFor(() => expect(applySpy).toHaveBeenCalledOnce());
  expect(applySpy).toHaveBeenCalledWith(STATION_ID, "cfgop_reviewed", "digest-reviewed");
  // Re-entry refreshed the rows; it must NOT have re-planned.
  expect(planSpy).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/console && pnpm test src/lib/components/stations/HarnessConfigPanel`

Expected: the first fails with `getStationConfig` called 1 time, not 2 (nothing watches `active`); the second fails on `getByText(/Planned at /)` — no such text exists yet. Note the digest is queryable without opening the `<details>` block: jsdom renders its children either way, which is how the existing digest test at `:498` reads it.

- [ ] **Step 3: Add the `active` prop**

In `HarnessConfigPanel.svelte`, replace the props destructuring (`:30-35`):

```svelte
  let {
    stationId,
    nodeId,
    stationKey,
    onRestart,
    active = true,
  }: {
    stationId: string;
    nodeId: string;
    stationKey?: string;
    onRestart?: () => void;
    /** False while the panel is mounted but hidden — the keep-alive tab it
     *  lives in keeps it alive across tab switches (spec D6). Becoming true
     *  again re-reads the observations; it never clears a plan under review. */
    active?: boolean;
  } = $props();
```

- [ ] **Step 4: Refresh the rows when the panel is shown again**

Immediately after `let reloadTrigger = $state(0);` (`:169`), add:

```ts
  /**
   * Re-entering the tab re-reads the observations, because a kept-alive panel
   * would otherwise show whatever was true when the operator last looked.
   *
   * It deliberately does NOT clear `plan` (spec D6). Apply sends the digest of
   * the plan on screen, and a document that moved underneath is refused with
   * PLAN_DIGEST_MISMATCH / PLAN_STALE — so a kept plan can only ever produce a
   * visible refusal, never a silent wrong write. Dropping it instead would
   * destroy a review every time the operator checked Logs mid-review.
   *
   * `wasActive` starts null so the first run only records the initial value:
   * mounting while active must not double-load.
   */
  let wasActive: boolean | null = null;
  $effect(() => {
    const isActive = active;
    if (wasActive !== null && isActive && !wasActive) reloadTrigger++;
    wasActive = isActive;
  });
```

- [ ] **Step 5: Record and show when the plan was captured**

Add beside the other review state (after `let plan = $state<ConfigPlan | null>(null);`, `:164`):

```ts
  /** When `plan` was captured — a kept-alive plan can now outlive the glance
   *  that produced it, so the panel says how old the thing under review is. */
  let planCapturedAt = $state<Date | null>(null);
```

In `clearReview()` (`:173-179`) add `planCapturedAt = null;` beside `plan = null;`.

In `reviewChanges`'s accept callback (`:202-204`):

```ts
      (result) => {
        plan = result;
        planCapturedAt = new Date();
      },
```

And in the review section's header row (`:397-399`), after the `<h3>`:

```svelte
        <h3 class="font-semibold">Review and apply</h3>
        {#if planCapturedAt}
          <p class="text-xs text-muted-foreground">
            Planned at {planCapturedAt.toLocaleTimeString()}
          </p>
        {/if}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/console && pnpm test src/lib/components/stations/HarnessConfigPanel`

Expected: PASS, and every pre-existing test in that file still passes — they omit `active`, which defaults to `true`.

- [ ] **Step 7: Prove the guard can fail**

Temporarily change `if (wasActive !== null && isActive && !wasActive)` to `if (false)` and re-run. Expected: "becoming active again re-reads the observations" goes RED. Restore the line. A test that cannot fail is not a test.

- [ ] **Step 8: Commit**

```bash
git add apps/console/src/lib/components/stations/HarnessConfigPanel.svelte apps/console/src/lib/components/stations/HarnessConfigPanel.svelte.test.ts
git commit -m "console: the harness panel refreshes on re-entry and dates its plan"
```

---

### Task 2: One Configuration tab

Spec D1, D2, D3, D4, D5, D7, D8. The `Skills` tab becomes `Configuration`, hosts all three configuration surfaces, and `Files` stops hosting any of them.

**Files:**
- Modify: `apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte` (`Tab` type and `VALID_TABS` at `:62-84`; `activeTab` at `:90-99`; heavy-tab effect at `:111-122`; `hasSkills` at `:181`; tab list at `:356`; `filesContent` at `:658-678`; `skillsContent` at `:688-696`)
- Test: `apps/console/src/routes/nodes/[id]/stations/[stationId]/page.svelte.test.ts`

**Interfaces:**
- Consumes: `HarnessConfigPanel`'s `active?: boolean` prop from Task 1.
- Produces: tab id `"config"`, label `"Configuration"`; `TAB_ALIASES: Record<string, Tab>`; `hasConfiguration` derived gate. No other module imports these.

- [ ] **Step 1: Write the failing tests**

Append to `page.svelte.test.ts`. The file's own helpers are used: `station(capabilities)`, `tabNames`, `selected`, `setUrl`, `goto`.

```ts
// ─── the Configuration tab ──────────────────────────────────────────────────

test("plugins, skills and declared configuration share one Configuration tab", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([
    station(["health", "skills.inventory", "plugins.manage", "config.manage"]),
  ]);
  setUrl("?tab=config");

  const { getAllByRole, getByRole } = render(StationPage);
  await waitFor(() => expect(selected(getAllByRole("tab"))).toBe("Configuration"));

  expect(getByRole("region", { name: "Harness configuration" })).toBeTruthy();
  expect(getByRole("region", { name: "Plugin management" })).toBeTruthy();
  expect(getByRole("region", { name: "Skill inventory" })).toBeTruthy();
  // The retired label is gone.
  expect(tabNames(getAllByRole("tab"))).not.toContain("Skills");
});

test("a station with only config.manage still gets the tab", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "config.manage"])]);
  setUrl("?tab=config");

  const { getAllByRole, getByRole } = render(StationPage);
  await waitFor(() => expect(tabNames(getAllByRole("tab"))).toContain("Configuration"));
  expect(getByRole("region", { name: "Harness configuration" })).toBeTruthy();
});

test("an old ?tab=skills link lands on Configuration", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "skills.inventory"])]);
  setUrl("?tab=skills");

  const { getAllByRole } = render(StationPage);
  await waitFor(() => expect(selected(getAllByRole("tab"))).toBe("Configuration"));
});

test("choosing the tab writes ?tab=config, never the alias", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "config.manage"])]);

  const { getByRole } = render(StationPage);
  await waitFor(() => expect(getByRole("tab", { name: "Configuration" })).toBeTruthy());
  await fireEvent.click(getByRole("tab", { name: "Configuration" }));

  expect(String(goto.mock.calls[0][0])).toContain("tab=config");
  expect(String(goto.mock.calls[0][0])).not.toContain("tab=skills");
});

test("the Files tab holds files only — no declared configuration", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "fs.read", "config.manage"])]);
  setUrl("?tab=files");

  const { queryByRole, getAllByRole } = render(StationPage);
  await waitFor(() => expect(selected(getAllByRole("tab"))).toBe("Files"));
  expect(queryByRole("region", { name: "Harness configuration" })).toBeNull();
});

test("a reviewed plan survives a switch to Logs and back", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([station(["health", "logs", "config.manage"])]);
  setUrl("?tab=config");

  const { getAllByRole, getByRole } = render(StationPage);
  await waitFor(() => expect(selected(getAllByRole("tab"))).toBe("Configuration"));
  const region = getByRole("region", { name: "Harness configuration" });

  await fireEvent.click(getByRole("tab", { name: "Logs" }));
  setUrl("?tab=logs");
  await waitFor(() => expect(selected(getAllByRole("tab"))).toBe("Logs"));

  // Kept alive, not torn down: the same element is still in the document.
  expect(region.isConnected).toBe(true);
  expect(region.closest('[role="tabpanel"]')!.className).toContain("hidden");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/console && pnpm test src/routes/nodes/\[id\]/stations`

Expected: all six fail — there is no tab named `Configuration`, `?tab=config` is not a valid id so it falls back to Health, and the harness panel is still inside the Files panel.

- [ ] **Step 3: Rename the tab id and alias the old one**

In `+page.svelte`, in the `Tab` union (`:62-72`) replace `| "skills"` with `| "config"`, and in `VALID_TABS` (`:73-84`) replace `"skills",` with `"config",`.

Immediately after `VALID_TABS`, add:

```ts
  /**
   * Retired tab ids, mapped to what replaced them.
   *
   * Tab ids live in the URL, so links to them exist in bookmarks, in chat
   * history and in docs. An unknown ?tab= value falls back to the default tab
   * SILENTLY (below), which would land a two-week-old link on Health with no
   * explanation — so a retired id is aliased, never dropped. `skills` became
   * `config` when plugins, skills and declared configuration were gathered
   * into one tab.
   */
  const TAB_ALIASES: Readonly<Record<string, Tab>> = { skills: "config" };
```

In `activeTab` (`:90-99`), resolve the alias before validating:

```ts
  const activeTab = $derived.by<Tab>(() => {
    const raw = $page.url.searchParams?.get("tab");
    const t = raw !== null && raw !== undefined ? (TAB_ALIASES[raw] ?? raw) : raw;
    const wanted = VALID_TABS.includes(t as Tab) ? (t as Tab) : defaultTab;
```

Leave the rest of that function — including the "must be a tab the bar renders" check — exactly as it is.

- [ ] **Step 4: Widen the gate and relabel the tab**

Add after `hasSkills` (`:181`):

```ts
  /** The Configuration tab's gate. Declared configuration is a reason for the
   *  tab to exist on its own: a station can advertise `config.manage` without
   *  any skills capability, and before this it had no home but the Files tab. */
  const hasConfiguration = $derived(hasSkills || hasConfigManagement);
```

Replace the tab entry (`:356`):

```ts
    ...(hasConfiguration
      ? [{ id: "config" as const, label: "Configuration", icon: SlidersHorizontalIcon }]
      : []),
```

Add the icon import beside the others (near `:48-52`):

```ts
  import SlidersHorizontalIcon from "@lucide/svelte/icons/sliders-horizontal";
```

`ScrollTextIcon` stays — `Logs` still uses it, and it no longer collides with a second tab.

- [ ] **Step 5: Make it a keep-alive tab**

In the heavy-tab effect (`:111-122`), add `config` to the set of tabs kept alive once visited:

```ts
      (activeTab === "chat" ||
        activeTab === "logs" ||
        activeTab === "files" ||
        activeTab === "terminal" ||
        // Declared configuration captures a plan and its digest once and never
        // re-fetches them (spec D6). Remounting would destroy a review in
        // progress, so this tab is kept alive and refreshes on re-entry.
        activeTab === "config") &&
```

- [ ] **Step 6: Move the panels**

In `filesContent` (`:658-678`), delete the `{#if hasConfigManagement}…{/if}` block containing `<HarnessConfigPanel …>`, leaving the `FileBrowser` and its wrapper exactly as they were.

Replace the whole `{#if hasSkills}` block that renders `skillsContent` (`:688-696`) with:

```svelte
  {#if hasConfiguration}
    {@render keepAlivePanel("config", configContent)}
    {#snippet configContent()}
      {#if hasConfigManagement}
        <HarnessConfigPanel
          {stationId}
          {nodeId}
          stationKey={station?.stationKey}
          active={activeTab === "config"}
          onRestart={canLifecycle ? () => askFor("restart") : undefined}
        />
      {/if}
      {#if hasPluginManagement}
        <PluginManagementPanel
          {stationId}
          canManage={mayGrantReach}
          onRestart={canLifecycle ? () => askFor("restart") : undefined}
        />
      {/if}
      {#if hasSkillInventory}<SkillsPanel {stationId} />{/if}
      {#if hasSkillManagement || hasNativeSkillManagement}
        <SkillManagementPanel
          {stationId}
          harness={station?.harness ?? ""}
          canManage={hasSkillManagement && mayGrantReach}
          canNative={hasNativeSkillManagement && mayGrantReach}
        />
      {/if}
    {/snippet}
  {/if}
```

Section order is spec D2: declared configuration, then plugins, then skills. Each panel already carries its own `<section aria-label>` and `border-t p-4` chrome, so no wrapper and no accordion is added (spec D7).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/console && pnpm test src/routes/nodes/\[id\]/stations`

Expected: PASS, including every pre-existing tab test in the file.

- [ ] **Step 8: Prove the alias guard can fail**

Temporarily change `TAB_ALIASES` to `{}` and re-run. Expected: "an old ?tab=skills link lands on Configuration" goes RED. Restore it.

- [ ] **Step 9: Typecheck, full suite, build**

Run: `cd apps/console && pnpm check && pnpm test && pnpm build`

Expected: `check ok` with no new errors, the whole console suite green, `build ok`. A leftover reference to the `"skills"` tab id anywhere in the file is a type error here, which is the point of renaming the union member rather than adding to it.

- [ ] **Step 10: Commit**

```bash
git add "apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte" "apps/console/src/routes/nodes/[id]/stations/[stationId]/page.svelte.test.ts"
git commit -m "console: one Configuration tab for declared config, plugins and skills"
```

---

### Task 3: Say so in the docs

Spec "Documentation impact". Two live documents name the old locations. The published one is wrong the moment Task 2 merges.

**Files:**
- Modify: `docs-site/src/content/docs/use/config.md:530-535`
- Modify: `docs/strategy/2026-09-20-managed-skills.md:339`

**Interfaces:**
- Consumes: the tab label `Configuration` and id `config` from Task 2.
- Produces: nothing code depends on.

- [ ] **Step 1: Fix the published page**

In `docs-site/src/content/docs/use/config.md`, the section `## Seeing and applying it from the console` opens:

```
Everything above has a CLI-free path too, on a station's own page — its **Files** tab, below
the file browser. A **declared configuration** panel appears there whenever the station
```

Replace that location with the new one:

```
Everything above has a CLI-free path too, on a station's own page — its **Configuration**
tab, which also holds the station's plugins and skills, because on a Hermes station all
three write the same configuration document. A **declared configuration** panel appears at
the top of that tab whenever the station
```

Keep the rest of the sentence and section as they are.

- [ ] **Step 2: Fix the strategy document's one line**

In `docs/strategy/2026-09-20-managed-skills.md:339`, replace:

```
The station Skills tab exposes management only when `skills.manage` is advertised.
```

with:

```
The station Configuration tab exposes skill management only when `skills.manage` is advertised.
```

- [ ] **Step 3: Check nothing else names the old tabs**

Run:

```bash
grep -rnE '\*{0,2}(Files|Skills)\*{0,2} tab' docs docs-site --include='*.md' | grep -v '/archive/' | grep -v 'superpowers/'
```

Expected: only `docs/OPERATING.md:1671`, which refers to the Files tab for *browsing files* and is still correct. Hits under `docs/superpowers/` are specs, plans and audits — records of what was true when written, and not rewritten.

- [ ] **Step 4: Build the docs site**

Run: `cd docs-site && pnpm install --frozen-lockfile && pnpm build`

Expected: a clean build. The `landing` check is not a required check for merge, but a broken docs build blocks the deploy job.

- [ ] **Step 5: Commit**

```bash
git add docs-site/src/content/docs/use/config.md docs/strategy/2026-09-20-managed-skills.md
git commit -m "docs: the declared configuration panel lives on the Configuration tab"
```

---

## Verification before the PR closes

Spec "Verification". On a live workspace station advertising `config.manage`:

- [ ] the `Configuration` tab appears, and all three sections render in spec D2's order
- [ ] a declared setting can be planned and applied from it, and the receipt comes back `applied`
- [ ] switching to `Logs` mid-review and back leaves the reviewed plan and its digest on screen
- [ ] an old `?tab=skills` link lands on `Configuration`
- [ ] the `Files` tab shows the browser and no configuration panel

---

## Executed with these corrections (2026-10-06)

Three things the plan got wrong, found by running it. Recorded here because the
task steps above were written before any of them was known.

**1. `rerender` cannot drive the `active` flip.** Measured: one render plus two
rerenders with *identical* props calls `getStationConfig` three times, because
rerender replaces the prop set and re-runs the load effect regardless. A test
built on it could not tell "refreshed because the tab was re-entered" from
"refreshed because rerender happened". Task 1 therefore adds
`apps/console/src/lib/components/stations/harness-config-panel-test-host.svelte`
— a `*-test-host.svelte` wrapper in the existing convention, owning `active` as
its own `$state` and exposing a toggle button. A parent flipping one prop is
exactly what a tab switch is.

**2. The review section had to come out of the loading chain.** It sat inside
the `{:else}` of `{#if loading}`, so the refresh that D6 introduces would take a
reviewed plan **and its apply button** off the screen while the rows reloaded —
and leave them off if the reload errored, though the plan was still good. It now
renders on its own condition,
`{#if plan || planRefusal || (!loading && !error && rows.length > 0)}`.
Waiting for the refresh in the test would have hidden this; the test asserts
without waiting, so it fails if the review is ever re-gated on loading.

**3. Both new guards were revert-proofed.** Stubbing the refresh effect to
`if (false)` turns "becoming active again re-reads the observations" red;
re-gating the review on `!loading` turns the plan-survival test red.
