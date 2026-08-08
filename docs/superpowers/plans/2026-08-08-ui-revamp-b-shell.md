# UI Revamp Plan B — App Shell & Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the app frame to the Crisp Console look — slim the page-header (Lucide-only icons, no collapse), delete the Lottie stack, restyle sidebar/bottom-nav, rebuild the command palette on the `Command` primitive, and replace the cyber loading screen.

**Architecture:** Plan B of the program in `docs/superpowers/specs/2026-08-08-ui-revamp-design.md` (sweep step 1), building on Plan A's foundation (status tokens, refreshed primitives, `Command`, `Spinner`). Screens keep their current content; only the frame changes. Cyber CSS classes are deleted only when this plan removes their last consumer.

**Tech Stack:** Same as Plan A. Baseline at start: 244 tests / 37 files, `pnpm check` clean, HEAD `cc69592`.

## Global Constraints

- All commands run from `apps/console/` inside the worktree at `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp`.
- After every task: `pnpm check` → 0 errors, `pnpm test` → all pass, test output pristine.
- Crisp Console rules: sans-serif (`font-body`) for UI text — nav labels, tab labels, headings; monospace only for data (paths, IDs, counts). No uppercase-tracked mono labels in new markup. Status colors ONLY via `text-status-*`/`bg-status-*` tokens.
- The theme customization layer must not regress.
- Conventional commits with the trailer line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Do not modify `develop` or the main checkout — all work on branch `ui-revamp` in the worktree.
- Program carry-forwards (do NOT do them in this plan; they are scheduled later): scheme-accent distinguishability audit → first status-heavy plan (C/D); DataTable filter/pagination tests → Plan E.

---

### Task 1: Slim page-header to the Crisp Console header

Replace `src/lib/components/page-header.svelte` (344 lines: emoji/Lottie icon union, collapsible mode, cyber status classes) with a compact title/status/actions/tabs bar. Verified consumers: 7 pages; only Lucide `Component` icons are ever passed (admin/users, admin/users/[id]); only the station page passes `collapsible={true}`.

**Files:**
- Rewrite: `apps/console/src/lib/components/page-header.svelte`
- Modify: `apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte` (remove `collapsible={true}` prop, line ~82)
- Test: `apps/console/src/lib/components/page-header.svelte.test.ts` (new)

**Interfaces:**
- Consumes: `Tooltip` primitives, `cn`, status tokens.
- Produces: `PageHeader` props `{ title: string; icon?: Component; subtitle?: string; status?: { label: string; variant: "running"|"starting"|"stopped"|"error"|"sleeping"|"degraded"; animate?: boolean }; tabs?: Tab[]; activeTab?: string; onTabChange?: (id: string) => void; sticky?: boolean; actions?: Snippet; leading?: Snippet }`, `Tab = { id; label; icon?: Component; disabled?; disabledReason? }`. All Plans C–H use this contract. REMOVED vs old: emoji-string icons, `{type:"animated"}` icons, `collapsible`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/components/page-header.svelte.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { fireEvent } from "@testing-library/dom";
import PageHeader from "./page-header.svelte";

describe("PageHeader", () => {
  it("renders title, subtitle, and status with token classes", () => {
    render(PageHeader, {
      title: "hermes-01",
      subtitle: "~/projects/hermes",
      status: { label: "Running", variant: "running" },
    });
    expect(screen.getByRole("heading", { name: "hermes-01" })).toBeTruthy();
    expect(screen.getByText("~/projects/hermes")).toBeTruthy();
    const badge = screen.getByText("Running");
    expect(badge.closest("[class*='text-status-running']")).toBeTruthy();
  });

  it("fires onTabChange when an enabled tab is clicked, not for disabled tabs", async () => {
    const onTabChange = vi.fn();
    render(PageHeader, {
      title: "t",
      tabs: [
        { id: "health", label: "Health" },
        { id: "files", label: "Files", disabled: true, disabledReason: "No capability" },
      ],
      activeTab: "health",
      onTabChange,
    });
    await fireEvent.click(screen.getByRole("tab", { name: /health/i }));
    expect(onTabChange).toHaveBeenCalledWith("health");
    await fireEvent.click(screen.getByRole("tab", { name: /files/i }));
    expect(onTabChange).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/components/page-header.svelte.test.ts`
Expected: FAIL — old component has no `role="tab"` and status uses `.status-indicator` cyber class, and the old heading is still found but the badge-class assertion fails.

- [ ] **Step 3: Rewrite the component**

Replace the entire file content of `page-header.svelte` with:

```svelte
<script lang="ts">
  import type { Snippet, Component } from "svelte";
  import { cn } from "$lib/utils";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import LockIcon from "@lucide/svelte/icons/lock";

  export interface Tab {
    id: string;
    label: string;
    icon?: Component;
    disabled?: boolean;
    disabledReason?: string;
  }

  type StatusVariant = "running" | "starting" | "stopped" | "error" | "sleeping" | "degraded";

  interface Props {
    title: string;
    icon?: Component;
    subtitle?: string;
    status?: { label: string; variant: StatusVariant; animate?: boolean };
    tabs?: Tab[];
    activeTab?: string;
    onTabChange?: (tabId: string) => void;
    sticky?: boolean;
    actions?: Snippet;
    leading?: Snippet;
  }

  let {
    title,
    icon = undefined,
    subtitle = undefined,
    status = undefined,
    tabs = [],
    activeTab = "",
    onTabChange = undefined,
    sticky = true,
    actions = undefined,
    leading = undefined,
  }: Props = $props();

  const Icon = $derived(icon);

  const statusText: Record<StatusVariant, string> = {
    running: "text-status-running",
    starting: "text-status-starting",
    stopped: "text-status-stopped",
    error: "text-status-error",
    sleeping: "text-status-sleeping",
    degraded: "text-status-degraded",
  };
  const statusBg: Record<StatusVariant, string> = {
    running: "bg-status-running",
    starting: "bg-status-starting",
    stopped: "bg-status-stopped",
    error: "bg-status-error",
    sleeping: "bg-status-sleeping",
    degraded: "bg-status-degraded",
  };
</script>

<header
  class={cn(
    "z-40 border-b bg-background/90 backdrop-blur-md pt-[env(safe-area-inset-top,0px)]",
    sticky && "sticky top-0",
  )}
>
  <div class="container mx-auto max-w-7xl px-4 sm:px-6">
    <div class="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex min-w-0 items-center gap-3">
        {#if leading}
          {@render leading()}
          <div class="hidden h-6 w-px bg-border sm:block"></div>
        {/if}
        {#if Icon}
          <Icon class="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {/if}
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2.5 overflow-hidden">
            <h1 class="truncate text-lg font-semibold tracking-tight">{title}</h1>
            {#if status}
              <span
                class={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium",
                  statusText[status.variant],
                )}
              >
                <span
                  class={cn(
                    "size-1.5 rounded-full",
                    statusBg[status.variant],
                    status.animate && "animate-pulse",
                  )}
                ></span>
                {status.label}
              </span>
            {/if}
          </div>
          {#if subtitle}
            <p class="mt-0.5 truncate font-mono text-xs text-muted-foreground">{subtitle}</p>
          {/if}
        </div>
      </div>
      {#if actions}
        <div class="flex shrink-0 items-center gap-2">
          {@render actions()}
        </div>
      {/if}
    </div>

    {#if tabs.length > 0}
      <nav class="scrollbar-hide -mb-px flex gap-1 overflow-x-auto" role="tablist">
        {#each tabs as tab (tab.id)}
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  disabled={tab.disabled}
                  class={cn(
                    "flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                    tab.disabled
                      ? "cursor-not-allowed border-transparent text-muted-foreground/50"
                      : activeTab === tab.id
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                  )}
                  onclick={() => !tab.disabled && onTabChange?.(tab.id)}
                >
                  {#if tab.disabled}
                    <LockIcon class="h-3.5 w-3.5" aria-hidden="true" />
                  {:else if tab.icon}
                    {@const TabIcon = tab.icon}
                    <TabIcon class="h-4 w-4" aria-hidden="true" />
                  {/if}
                  <span class="hidden sm:inline">{tab.label}</span>
                </button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content class={tab.disabled ? "" : "sm:hidden"}>
              <p>{tab.disabled && tab.disabledReason ? tab.disabledReason : tab.label}</p>
            </Tooltip.Content>
          </Tooltip.Root>
        {/each}
      </nav>
    {/if}
  </div>
</header>
```

Note: if the refreshed Tooltip.Trigger does not support the `child` snippet render-delegation shown above, fall back to the pre-refresh pattern used elsewhere in the codebase (Tooltip.Trigger wrapping the button directly) — behavior over exact markup. Tests may need `Tooltip.Provider` context: if `render(PageHeader, …)` throws about missing tooltip context, wrap via a small test-host component or mount with the provider as the existing route tests do (check `src/routes/runtimes/page.svelte.test.ts` for the established pattern).

- [ ] **Step 4: Remove `collapsible={true}` from the station page**

In `src/routes/nodes/[id]/stations/[stationId]/+page.svelte`, delete the `collapsible={true}` line from the `<PageHeader …>` invocation.

- [ ] **Step 5: Run tests and fix fallout**

Run: `pnpm exec vitest run src/lib/components/page-header.svelte.test.ts && pnpm test`
Expected: new tests pass. Route tests that asserted old markup (mono uppercase tab classes, `.status-indicator`) need selector updates only — behavioral assertions stay.

- [ ] **Step 6: Verify types and commit**

```bash
pnpm check && git add -A && git commit -m "feat(console): crisp PageHeader — slim header, token status badge, accessible tabs"
```

---

### Task 2: Delete the Lottie stack

After Task 1, nothing imports `LottieIcon`. Verified consumers before Task 1 were exactly: `page-header.svelte`, `lottie-icon.svelte`, `animated-icons.ts` (+ `src/mocks/lottie-web.ts`).

**Files:**
- Delete: `apps/console/src/lib/components/lottie-icon.svelte`, `apps/console/src/lib/utils/animated-icons.ts`, `apps/console/src/mocks/lottie-web.ts`
- Modify: `apps/console/vitest.config.ts` (remove the `lottie-web` alias to the mock, if present), `apps/console/package.json` (remove `lottie-web`)

**Interfaces:**
- Consumes: Task 1 (removed the last import).
- Produces: nothing — pure deletion.

- [ ] **Step 1: Verify no remaining imports**

```bash
grep -rn "lottie" src/ vitest.config.ts vite.config.js | grep -v "Binary"
```

Expected: hits only in the three files being deleted + the vitest alias + package.json. Any OTHER hit → STOP and report.

- [ ] **Step 2: Delete files, alias, and dependency**

```bash
rm src/lib/components/lottie-icon.svelte src/lib/utils/animated-icons.ts src/mocks/lottie-web.ts
# edit vitest.config.ts: remove the lottie-web alias entry if one exists
pnpm remove lottie-web
```

- [ ] **Step 3: Verify green and commit**

```bash
pnpm check && pnpm test && git add -A && git commit -m "chore(console): remove lottie animated-icon stack"
```

---

### Task 3: Restyle app shell (sidebar + bottom nav)

`src/lib/components/app-shell.svelte` is structurally sound (grouped sidebar, derived nav, BottomNav reuse) — this is a restyle, not a rebuild. Bottom-nav gets the same treatment.

**Files:**
- Modify: `apps/console/src/lib/components/app-shell.svelte`
- Modify: `apps/console/src/lib/components/ui/bottom-nav/bottom-nav.svelte`, `.../bottom-nav-item.svelte`
- Test: existing `apps/console/src/lib/components/app-shell.svelte.test.ts` (update selectors only if needed)

**Interfaces:**
- Consumes: nothing new.
- Produces: same `AppShell` props (`children`, `hideBottomNav`, `attentionCount`, `class`) — unchanged contract.

- [ ] **Step 1: Restyle the sidebar in `app-shell.svelte`**

Exact changes (keep everything else, including nav data, `isActive`, responsive behavior):

1. Brand block (lines ~115–128): replace the bordered `bg-primary/10` icon box with a plain flat mark, and the mono brand with sans semibold:

```svelte
    <div class="p-3 lg:px-4 lg:py-4 border-b shrink-0">
      <div class="flex items-center gap-2.5">
        <div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Server class="size-4" />
        </div>
        <span class="hidden lg:block truncate text-sm font-semibold tracking-tight">AgentPod</span>
      </div>
    </div>
```

2. Group label (line ~134): sans, not mono-tracked:

```svelte
          <p class="hidden lg:block px-2 pt-4 pb-1 text-xs font-medium text-muted-foreground first:pt-1">
            {group.label}
          </p>
```

3. Nav link classes (lines ~142–149): sans labels, `rounded-md`, quieter active state:

```svelte
              class={cn(
                "flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
```

4. Remove the `active && "scale-110"` icon transform (line ~156) — icons stay `h-4 w-4` (change from `h-5 w-5`), no scaling.
5. Sidebar container (lines ~105–111): replace `border-border/50` with plain `border-r`, and simplify the background to solid `bg-background` (the blur/translucency reads as effect-layer; Crisp Console uses flat surfaces).

- [ ] **Step 2: Restyle bottom-nav**

In `bottom-nav.svelte` / `bottom-nav-item.svelte` (30 + 73 lines — read them first): apply the same vocabulary — solid `bg-background`, `border-t`, sans `text-[11px] font-medium` labels, active = `text-foreground` with `text-muted-foreground` inactive (keep the badge logic and touch targets). No mono, no glow/pulse classes; if the item uses any `cyber-*`/`animate-pulse-glow` class, replace with plain token classes.

- [ ] **Step 3: Run tests, fix selector drift only**

Run: `pnpm exec vitest run src/lib/components/app-shell.svelte.test.ts && pnpm test`

- [ ] **Step 4: Commit**

```bash
pnpm check && git add -A && git commit -m "feat(console): crisp app shell — flat sidebar and bottom nav"
```

---

### Task 4: Rebuild command palette on the Command primitive

`src/lib/components/command-palette.svelte` (270 lines) hand-rolls filtering/highlight/keyboard handling on Dialog+Input. Rebuild it on `Command.Dialog` (bits-ui Command from Plan A) keeping the exact same behaviors: opens via the `commandPalette` store (⌘K binding lives in `+layout.svelte` — untouched), static actions (New runtime, Create enrollment token, Fleet, Settings, node entries), node search via `listNodes()` loaded when opened, Enter runs the item, Esc closes.

**Files:**
- Rewrite: `apps/console/src/lib/components/command-palette.svelte`
- Test: existing command-palette test if present; otherwise add `apps/console/src/lib/components/command-palette.svelte.test.ts` with the two tests below.
- Do NOT modify: `apps/console/src/lib/stores/command-palette.svelte.ts` (store API stays the source of open state).

**Interfaces:**
- Consumes: `Command` namespace (`$lib/components/ui/command`), `commandPalette` store (read its file for the exact open-state getter and `open()/close()` methods — adapt names in the code below to the real API, keeping behavior identical), `listNodes` from `$lib/api/client`.
- Produces: same component contract — mounted once in `+layout.svelte`, no props.

- [ ] **Step 1: Write/adapt the test**

```ts
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import CommandPalette from "./command-palette.svelte";
import { commandPalette } from "$lib/stores/command-palette.svelte";

vi.mock("$lib/api/client", () => ({
  listNodes: vi.fn().mockResolvedValue([]),
}));

describe("CommandPalette", () => {
  it("shows static actions when opened", async () => {
    render(CommandPalette);
    commandPalette.open();
    expect(await screen.findByText("New runtime")).toBeTruthy();
    expect(screen.getByText("Create enrollment token")).toBeTruthy();
  });

  it("renders nothing when closed", () => {
    render(CommandPalette);
    expect(screen.queryByText("New runtime")).toBeNull();
  });
});
```

Adapt store-call and mock shape to the real store/API signatures (read both files first); assertion substance stays.

- [ ] **Step 2: Run test to verify current state**

Run: `pnpm exec vitest run src/lib/components/command-palette.svelte.test.ts`
If the old component passes both tests already, note it — the rewrite must keep them passing (they become regression cover).

- [ ] **Step 3: Rewrite on Command.Dialog**

Structure (adapt identifiers to the real store API and the Command namespace's actual export names):

```svelte
<script lang="ts">
  import * as Command from "$lib/components/ui/command";
  import { commandPalette } from "$lib/stores/command-palette.svelte";
  import { listNodes } from "$lib/api/client";
  import { goto } from "$app/navigation";
  import ServerIcon from "@lucide/svelte/icons/server";
  import PlusCircleIcon from "@lucide/svelte/icons/plus-circle";
  import KeyRoundIcon from "@lucide/svelte/icons/key-round";
  import LayoutDashboardIcon from "@lucide/svelte/icons/layout-dashboard";
  import SettingsIcon from "@lucide/svelte/icons/settings";

  let nodes = $state<{ id: string; hostname: string }[]>([]);

  // Bridge store <-> dialog open state
  const open = {
    get current() {
      return commandPalette.isOpen;
    },
    set current(v: boolean) {
      if (v) commandPalette.open();
      else commandPalette.close();
    },
  };

  $effect(() => {
    if (commandPalette.isOpen) {
      listNodes()
        .then((n) => (nodes = n.map((x) => ({ id: x.id, hostname: x.hostname }))))
        .catch(() => (nodes = []));
    }
  });

  function run(fn: () => void) {
    fn();
    commandPalette.close();
  }
</script>

<Command.Dialog bind:open={() => open.current, (v) => (open.current = v)} title="Command palette" description="Search actions and nodes">
  <Command.Input placeholder="Type a command or search…" />
  <Command.List>
    <Command.Empty>No results found.</Command.Empty>
    <Command.Group heading="Actions">
      <Command.Item onSelect={() => run(() => goto("/?action=new-runtime"))}>
        <PlusCircleIcon class="mr-2 size-4" />
        New runtime
      </Command.Item>
      <Command.Item onSelect={() => run(() => goto("/?action=create-token"))}>
        <KeyRoundIcon class="mr-2 size-4" />
        Create enrollment token
      </Command.Item>
      <Command.Item onSelect={() => run(() => goto("/"))}>
        <LayoutDashboardIcon class="mr-2 size-4" />
        Fleet
      </Command.Item>
      <Command.Item onSelect={() => run(() => goto("/settings"))}>
        <SettingsIcon class="mr-2 size-4" />
        Settings
      </Command.Item>
    </Command.Group>
    {#if nodes.length > 0}
      <Command.Separator />
      <Command.Group heading="Nodes">
        {#each nodes as node (node.id)}
          <Command.Item onSelect={() => run(() => goto(`/nodes/${node.id}`))}>
            <ServerIcon class="mr-2 size-4" />
            {node.hostname}
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}
  </Command.List>
</Command.Dialog>
```

Carry over from the OLD component anything behavioral this sketch missed — read it before deleting: exact static-action list and labels, any admin-gated items, the exact `listNodes` result shape. The old footer kbd-hint row is intentionally dropped (Command.Dialog provides its own affordances).

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run src/lib/components/command-palette.svelte.test.ts && pnpm test`

- [ ] **Step 5: Commit**

```bash
pnpm check && git add -A && git commit -m "feat(console): rebuild command palette on Command primitive"
```

---

### Task 5: Clean loading screen + shell-layer verification

**Files:**
- Modify: `apps/console/src/routes/+layout.svelte` (lines ~76–82: the loading branch using `noise-overlay`/`grid-bg`/`mesh-gradient`)
- Possibly modify: `apps/console/src/app.css` (delete cyber classes whose LAST consumer this plan removed)

**Interfaces:**
- Consumes: `Spinner` from Plan A.
- Produces: nothing new.

- [ ] **Step 1: Replace the loading screen**

In `+layout.svelte`, replace the cyber loading branch (the `noise-overlay` div and `grid-bg mesh-gradient` wrapper) with:

```svelte
      <div class="flex min-h-screen items-center justify-center bg-background">
        <div class="flex flex-col items-center gap-3">
          <Spinner size="lg" />
          <p class="text-sm text-muted-foreground">Connecting…</p>
        </div>
      </div>
```

Add `import { Spinner } from "$lib/components/ui/spinner";` to the script block. Read the surrounding lines first — keep whatever loading-state condition wraps the branch.

- [ ] **Step 2: Delete orphaned cyber CSS**

For each class this plan's tasks stopped using, check remaining consumers and delete the CSS block from `app.css` ONLY if zero remain:

```bash
for c in noise-overlay grid-bg mesh-gradient glitch-hover; do echo "== $c =="; grep -rln "$c" src/ | grep -v app.css; done
```

Delete from `app.css` the definitions (class rules + their dedicated keyframes) of every class with no consumers. `status-indicator`/`status-dot` almost certainly still have consumers (fleet components) — leave them for Plans C/D.

- [ ] **Step 3: Collapsible visual sanity check (carried from Plan A ledger)**

```bash
grep -rln "collapsible" src/ --include="*.svelte" | grep -v components/ui/collapsible
```

For each consumer found, read how it uses `Collapsible` and confirm the refreshed registry version still animates/functions (the refresh dropped explicit animate-collapsible-* classes). If a consumer visibly depends on the lost animation classes, re-add them to that consumer's `CollapsibleContent` usage via `class` prop. Note findings in the report either way.

- [ ] **Step 4: Full gate and commit**

```bash
pnpm exec svelte-kit sync && pnpm check && pnpm test && pnpm build
git add -A && git commit -m "feat(console): clean loading screen, prune orphaned cyber CSS"
```

- [ ] **Step 5: Push**

```bash
git push origin ui-revamp
```
