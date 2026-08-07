# UI Revamp Plan A — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Crisp Console foundation — remove dead dependencies, establish radius/status design tokens, refresh shadcn-svelte primitives, and add the missing primitives (Table, Breadcrumb, Command, Resizable, Empty, Spinner, Field, DataTable).

**Architecture:** This is Plan A of the UI revamp program defined in `docs/superpowers/specs/2026-08-08-ui-revamp-design.md`. Everything here is additive or subtractive infrastructure — no screen changes yet. Screens migrate in Plans B–H (written after this plan ships). The theme customization layer (store, ~20 schemes, font pairings, modes) must keep working unchanged; status tokens derive from the per-scheme `cyber-*` accent values that already exist in every scheme but are currently dead data.

**Tech Stack:** SvelteKit (SPA, Svelte 5 runes), Tailwind v4 (CSS-first config in `app.css`), shadcn-svelte on bits-ui (vendored), vitest + @testing-library/svelte (jsdom), pnpm workspace.

## Global Constraints

- All commands run from `apps/console/` inside the worktree at `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp` unless stated otherwise.
- After every task: `pnpm check` → 0 errors, `pnpm test` → all pass. Baseline: 31 files / 235 tests, `svelte-check` clean.
- Svelte 5 runes only (`$state`, `$derived`, `$props`); `<script lang="ts">`; double quotes; 2-space indent.
- Theme store, color schemes, font pairings, and light/dark/system/auto modes must not regress.
- Radius token becomes `0.375rem` (6px). Status tokens: `--status-running`, `--status-degraded`, `--status-starting`, `--status-stopped`, `--status-error`, `--status-sleeping`.
- Conventional commits: `feat(console): …`, `chore(console): …`, `test(console): …`. Every commit message ends with the Claude co-author trailer.
- Do not modify `develop` or the main checkout at `/Users/rakeshgangwar/Projects/agentpod` — all work stays on branch `ui-revamp` in the worktree.

---

### Task 1: Remove dead dependencies

The React bridge, assistant-ui, graph libs, and misc packages have zero live imports (verified 2026-08-08: only `lottie-web` among suspects is used, by `page-header.svelte`/`animated-icons.ts` — it stays until Plan B). Removing them shrinks install and build surface before any component work.

**Files:**
- Modify: `apps/console/svelte.config.js` (remove `preprocessReact`)
- Modify: `apps/console/src/app.css` (remove assistant-ui imports at lines 5–7 and the `/* assistant-ui custom styles */` block starting ~line 1458)
- Modify: `apps/console/package.json`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: a dependency set later tasks install on top of. No exports.

- [ ] **Step 1: Re-verify each package is unused before removal**

```bash
cd apps/console
for p in "@assistant-ui" "from \"react\"" "svelte-preprocess-react" "@xyflow" "dagre" "html2canvas" "lucide-react" "from \"sonner\"" "@opencode-ai" "assistant-stream" "react-dom"; do
  echo "== $p =="; grep -rn "$p" src svelte.config.js vite.config.js vitest.config.ts 2>/dev/null | grep -v "^Binary" | head -3
done
```

Expected: only hits are `svelte.config.js` (`svelte-preprocess-react`) and `src/app.css` (`@assistant-ui/styles`). If any OTHER file imports one of these packages, STOP and report — do not remove that package.

- [ ] **Step 2: Remove the React preprocessor from `svelte.config.js`**

Delete the import line `import preprocessReact from "svelte-preprocess-react/preprocessReact";` and remove `preprocessReact` from the `preprocess: [...]` array (keep `vitePreprocess`).

- [ ] **Step 3: Remove assistant-ui CSS from `app.css`**

Delete lines 5–7 (`/* assistant-ui styles */`, both `@import "@assistant-ui/styles/..."` lines). Then find the `/* assistant-ui custom styles */` comment (~line 1458) and delete that whole block up to the next unrelated top-level comment/selector. Read the surrounding lines first to find the block's true end.

- [ ] **Step 4: Remove packages**

```bash
pnpm remove @assistant-ui/react @assistant-ui/react-markdown @assistant-ui/styles @dagrejs/dagre @xyflow/svelte lucide-react sonner @opencode-ai/sdk assistant-stream @types/dagre @types/react @types/react-dom react react-dom svelte-preprocess-react html2canvas
```

Note: `mode-watcher`, `svelte-sonner`, `diff`, `marked`, `shiki`, `material-file-icons`, `@internationalized/date`, `lottie-web` are all USED — do not remove.

- [ ] **Step 5: Verify green**

```bash
pnpm exec svelte-kit sync && pnpm check && pnpm test && pnpm build
```

Expected: 0 check errors, 235 tests pass, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore(console): remove dead React bridge, assistant-ui, graph deps"
```

---

### Task 2: Crisp Console base tokens (radius + status tokens in CSS)

**Files:**
- Modify: `apps/console/src/app.css` (`:root` block ~line 599, `.dark` block ~line 639, `@theme inline` block ~line 673)

**Interfaces:**
- Consumes: nothing.
- Produces: CSS custom properties `--status-running|degraded|starting|stopped|error|sleeping` and Tailwind utilities `text-status-*`, `bg-status-*`, `border-status-*` (via `--color-status-*` theme mapping). Task 3 and all later plans rely on these exact names.

- [ ] **Step 1: Change radius token**

In `:root` (~line 605): `--radius: 0.625rem;` → `--radius: 0.375rem;`

- [ ] **Step 2: Add status token defaults**

At the end of the `:root` block (after `--sidebar-ring`), add:

```css
  /* Fleet status tokens — overridden per color scheme by the theme store */
  --status-running: oklch(0.723 0.192 149.58);
  --status-degraded: oklch(0.769 0.188 70.08);
  --status-starting: oklch(0.715 0.143 215.221);
  --status-stopped: var(--muted-foreground);
  --status-error: oklch(0.577 0.245 27.325);
  --status-sleeping: oklch(0.606 0.25 292.717);
```

At the end of the `.dark` block, add:

```css
  --status-running: oklch(0.792 0.209 151.711);
  --status-degraded: oklch(0.828 0.189 84.429);
  --status-starting: oklch(0.789 0.154 211.53);
  --status-stopped: var(--muted-foreground);
  --status-error: oklch(0.704 0.191 22.216);
  --status-sleeping: oklch(0.702 0.183 293.541);
```

- [ ] **Step 3: Map into Tailwind theme**

At the end of the `@theme inline` block, add:

```css
  --color-status-running: var(--status-running);
  --color-status-degraded: var(--status-degraded);
  --color-status-starting: var(--status-starting);
  --color-status-stopped: var(--status-stopped);
  --color-status-error: var(--status-error);
  --color-status-sleeping: var(--status-sleeping);
```

- [ ] **Step 4: Verify green**

```bash
pnpm check && pnpm test && pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add src/app.css && git commit -m "feat(console): crisp 6px radius + fleet status design tokens"
```

---

### Task 3: Theme store writes status tokens from scheme accents

Every color scheme already defines `cyber-cyan`, `cyber-emerald`, `cyber-amber`, `cyber-red`, `cyber-magenta` per light/dark (see `ThemeStyleProps` in `src/lib/themes/presets/types.ts`), but `applyColorScheme` in `src/lib/themes/store.svelte.ts` never writes them (its `cssVarMap` omits them). Map them onto the new status tokens so every scheme themes the status colors with zero preset edits.

**Files:**
- Modify: `apps/console/src/lib/themes/store.svelte.ts` (the `cssVarMap` object, ~lines 220–258)
- Test: `apps/console/src/lib/themes/store-status-tokens.svelte.test.ts` (new)

**Interfaces:**
- Consumes: `--status-*` custom properties from Task 2.
- Produces: at runtime, scheme switches update `--status-running` (from `cyber-emerald`), `--status-degraded` (from `cyber-amber`), `--status-error` (from `cyber-red`), `--status-starting` (from `cyber-cyan`), `--status-sleeping` (from `cyber-magenta`). `--status-stopped` stays CSS-derived from `--muted-foreground`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/themes/store-status-tokens.svelte.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

// The store touches matchMedia at module init in some paths — stub before import.
vi.stubGlobal(
  "matchMedia",
  vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })),
);

import { themeStore, colorSchemesMap } from "./store.svelte";

describe("status token application", () => {
  it("writes --status-* vars from the scheme's accent colors on scheme change", () => {
    const scheme = colorSchemesMap.get("cyberpunk") ?? [...colorSchemesMap.values()][0];
    themeStore.setColorScheme(scheme.id);

    const root = document.documentElement;
    const mode = themeStore.resolvedMode; // "light" | "dark"
    const styles = scheme.styles[mode];

    expect(root.style.getPropertyValue("--status-running")).toBe(styles["cyber-emerald"]);
    expect(root.style.getPropertyValue("--status-degraded")).toBe(styles["cyber-amber"]);
    expect(root.style.getPropertyValue("--status-error")).toBe(styles["cyber-red"]);
    expect(root.style.getPropertyValue("--status-starting")).toBe(styles["cyber-cyan"]);
    expect(root.style.getPropertyValue("--status-sleeping")).toBe(styles["cyber-magenta"]);
  });
});
```

Adjust the store's actual public API names if they differ (`themeStore.setColorScheme`, `themeStore.resolvedMode`, `colorSchemesMap` are exported per `store.svelte.ts:343,489`) — read the file, keep the assertions identical.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run src/lib/themes/store-status-tokens.svelte.test.ts
```

Expected: FAIL — `--status-running` is `""` (never written by the store).

- [ ] **Step 3: Extend `cssVarMap`**

In `applyColorScheme`'s `cssVarMap`, after the `radius` entry, add:

```ts
    // Fleet status tokens derive from the scheme's accent colors
    "cyber-emerald": "--status-running",
    "cyber-amber": "--status-degraded",
    "cyber-red": "--status-error",
    "cyber-cyan": "--status-starting",
    "cyber-magenta": "--status-sleeping",
```

The loop already skips missing values (`if (value)`), so schemes lacking an accent fall back to the CSS defaults from Task 2.

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm exec vitest run src/lib/themes/store-status-tokens.svelte.test.ts && pnpm test
```

Expected: new test passes; no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/lib/themes && git commit -m "feat(console): theme store drives status tokens from scheme accents"
```

---

### Task 4: Refresh existing shadcn-svelte primitives from upstream registry

**Files:**
- Modify: everything under `apps/console/src/lib/components/ui/` that the registry owns: `avatar badge button card collapsible dialog dropdown-menu input label popover scroll-area select separator sheet skeleton switch tabs tooltip`
- Do NOT overwrite: `bottom-nav`, `inline-tabs`, `ConfirmDialog`, `TypeToConfirmDialog`, `monaco-editor`, `markdown`, `code-block`, `sonner` (custom mode-watcher integration — refresh manually only if diff is trivial).

**Interfaces:**
- Consumes: dependency set from Task 1.
- Produces: refreshed primitives with unchanged import paths (`$lib/components/ui/<name>`). Later tasks and plans import them exactly as today.

- [ ] **Step 1: Snapshot current state**

```bash
git status --porcelain # must be clean before starting
```

- [ ] **Step 2: Overwrite registry-owned primitives**

```bash
pnpm dlx shadcn-svelte@latest add avatar badge button card collapsible dialog dropdown-menu input label popover scroll-area select separator sheet skeleton switch tabs tooltip --overwrite --yes
```

If the CLI errors (network/registry), report it, run `git checkout -- src/lib/components/ui` to reset, mark this task SKIPPED in the plan file with the CLI error, and move to Task 5. The existing vendored primitives are functional; the refresh is desirable, not load-bearing.

- [ ] **Step 3: Reconcile breakage**

```bash
pnpm check 2>&1 | head -50
```

Expected breakage class: renamed exports or prop changes in refreshed components. Fix call sites to the new component APIs (do not patch the refreshed components back toward the old API). Re-run until 0 errors.

- [ ] **Step 4: Run full tests, fix selectors**

```bash
pnpm test
```

Test failures here should be markup/selector drift, not behavior. Update test selectors only; if a test fails on behavior (focus, aria, events), investigate the component diff before touching the test.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore(console): refresh shadcn-svelte primitives from upstream registry"
```

---

### Task 5: Add Table, Breadcrumb, Command, Resizable primitives

**Files:**
- Create (via CLI): `apps/console/src/lib/components/ui/table/`, `.../breadcrumb/`, `.../command/`, `.../resizable/`
- Test: `apps/console/src/lib/components/ui/table/table.test.ts` (new)

**Interfaces:**
- Consumes: refreshed primitive base from Task 4.
- Produces: `$lib/components/ui/table` (exports `Table.Root/Header/Body/Row/Head/Cell` style namespace per registry), `$lib/components/ui/breadcrumb`, `$lib/components/ui/command`, `$lib/components/ui/resizable`. Plan B uses `command` for the palette; Plan C uses `resizable`+`breadcrumb` for FileBrowser; Task 7 uses `table` for DataTable.

- [ ] **Step 1: Add components**

```bash
pnpm dlx shadcn-svelte@latest add table breadcrumb command resizable --yes
```

This pulls `paneforge` (resizable) as a dependency; accept it. If `command` is offered via `bits-ui` Command, accept the registry default.

- [ ] **Step 2: Write a smoke test for table**

Create `src/lib/components/ui/table/table.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as Table from "./index.js";

describe("table primitive", () => {
  it("exports the composable parts", () => {
    expect(Table.Root).toBeTruthy();
    expect(Table.Header).toBeTruthy();
    expect(Table.Body).toBeTruthy();
    expect(Table.Row).toBeTruthy();
    expect(Table.Head).toBeTruthy();
    expect(Table.Cell).toBeTruthy();
  });
});
```

Adjust export names to what the registry's `index.ts` actually exports (read it first); the point is the module resolves and exposes composable parts.

- [ ] **Step 3: Run tests + check**

```bash
pnpm exec vitest run src/lib/components/ui/table/table.test.ts && pnpm check && pnpm test
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(console): add table, breadcrumb, command, resizable primitives"
```

---

### Task 6: Empty, Spinner, Field primitives (hand-written)

Small primitives the registry may not provide; hand-write them in the app's component idiom.

**Files:**
- Create: `apps/console/src/lib/components/ui/empty/empty.svelte`, `.../empty/index.ts`
- Create: `apps/console/src/lib/components/ui/spinner/spinner.svelte`, `.../spinner/index.ts`
- Create: `apps/console/src/lib/components/ui/field/field.svelte`, `.../field/index.ts`
- Test: `apps/console/src/lib/components/ui/empty/empty.test.ts`, `.../field/field.test.ts`

**Interfaces:**
- Consumes: `cn` from `$lib/utils`, Button from `$lib/components/ui/button`.
- Produces:
  - `Empty` props: `{ icon?: Component; title: string; description?: string; class?: string; children?: Snippet }` — children slot renders action buttons.
  - `Spinner` props: `{ class?: string; size?: "sm" | "md" | "lg" }`.
  - `Field` props: `{ label: string; description?: string; error?: string; for?: string; class?: string; children: Snippet }` — wraps any input control with label/description/error slots.
  - Every list/table screen in Plans B–H uses `Empty`; every form uses `Field`; async views use `Spinner`.

- [ ] **Step 1: Write failing tests**

`src/lib/components/ui/empty/empty.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import Empty from "./empty.svelte";

describe("Empty", () => {
  it("renders title and description", () => {
    render(Empty, { title: "No agents yet", description: "Connect a node to get started." });
    expect(screen.getByText("No agents yet")).toBeTruthy();
    expect(screen.getByText("Connect a node to get started.")).toBeTruthy();
  });
});
```

`src/lib/components/ui/field/field.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import Field from "./field.svelte";

const control = createRawSnippet(() => ({ render: () => `<input id="name" />` }));

describe("Field", () => {
  it("renders label, description, and error", () => {
    render(Field, {
      label: "Node name",
      description: "Shown in the fleet list.",
      error: "Name is required",
      for: "name",
      children: control,
    });
    expect(screen.getByText("Node name")).toBeTruthy();
    expect(screen.getByText("Shown in the fleet list.")).toBeTruthy();
    expect(screen.getByText("Name is required")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm exec vitest run src/lib/components/ui/empty src/lib/components/ui/field
```

Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement**

`src/lib/components/ui/empty/empty.svelte`:

```svelte
<script lang="ts">
  import type { Component, Snippet } from "svelte";
  import { cn } from "$lib/utils";

  let {
    icon = undefined,
    title,
    description = undefined,
    class: className = undefined,
    children = undefined,
  }: {
    icon?: Component;
    title: string;
    description?: string;
    class?: string;
    children?: Snippet;
  } = $props();
  const Icon = $derived(icon);
</script>

<div class={cn("flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center", className)}>
  {#if Icon}
    <Icon class="size-8 text-muted-foreground" aria-hidden="true" />
  {/if}
  <p class="text-sm font-medium text-foreground">{title}</p>
  {#if description}
    <p class="max-w-sm text-sm text-muted-foreground">{description}</p>
  {/if}
  {#if children}
    <div class="mt-2 flex items-center gap-2">
      {@render children()}
    </div>
  {/if}
</div>
```

`src/lib/components/ui/empty/index.ts`:

```ts
export { default as Empty } from "./empty.svelte";
```

`src/lib/components/ui/spinner/spinner.svelte`:

```svelte
<script lang="ts">
  import { cn } from "$lib/utils";

  let {
    class: className = undefined,
    size = "md",
  }: { class?: string; size?: "sm" | "md" | "lg" } = $props();

  const sizes = { sm: "size-3.5", md: "size-4.5", lg: "size-6" } as const;
</script>

<svg
  class={cn("animate-spin text-muted-foreground", sizes[size], className)}
  viewBox="0 0 24 24"
  fill="none"
  role="status"
  aria-label="Loading"
>
  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
</svg>
```

`src/lib/components/ui/spinner/index.ts`:

```ts
export { default as Spinner } from "./spinner.svelte";
```

`src/lib/components/ui/field/field.svelte`:

```svelte
<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils";
  import { Label } from "$lib/components/ui/label";

  let {
    label,
    description = undefined,
    error = undefined,
    for: htmlFor = undefined,
    class: className = undefined,
    children,
  }: {
    label: string;
    description?: string;
    error?: string;
    for?: string;
    class?: string;
    children: Snippet;
  } = $props();
</script>

<div class={cn("flex flex-col gap-1.5", className)}>
  <Label for={htmlFor}>{label}</Label>
  {@render children()}
  {#if description && !error}
    <p class="text-xs text-muted-foreground">{description}</p>
  {/if}
  {#if error}
    <p class="text-xs text-status-error" role="alert">{error}</p>
  {/if}
</div>
```

`src/lib/components/ui/field/index.ts`:

```ts
export { default as Field } from "./field.svelte";
```

Note: `Field` shows description only when there is no error (error replaces it). The test asserts both render because it passes both — adjust the test to match this contract: split into two renders (one with `description` only, one with `error` only) if the single-render assertion fails.

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm exec vitest run src/lib/components/ui/empty src/lib/components/ui/field && pnpm check && pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/ui/empty src/lib/components/ui/spinner src/lib/components/ui/field && git commit -m "feat(console): add Empty, Spinner, Field primitives"
```

---

### Task 7: DataTable pattern

Reusable sorted/filtered/paginated table on `@tanstack/table-core`, consumed by Agents, Activity, and Admin in later plans.

**Files:**
- Create (via CLI if available, else manual): `apps/console/src/lib/components/ui/data-table/` — `data-table.svelte`, `flex-render.svelte` (or registry equivalent), `index.ts`
- Test: `apps/console/src/lib/components/ui/data-table/data-table.test.ts`

**Interfaces:**
- Consumes: `Table` primitive namespace from Task 5, `Empty` from Task 6.
- Produces: `DataTable` component with props `{ columns: ColumnDef<T>[]; data: T[]; emptyTitle?: string; emptyDescription?: string; pageSize?: number; class?: string }`. Column defs are standard TanStack `ColumnDef`. Sorting via header click; global filtering exposed by binding `filterValue?: string`. Plans E and H rely on these exact prop names.

- [ ] **Step 1: Try the registry first**

```bash
pnpm dlx shadcn-svelte@latest add data-table --yes
```

If the registry provides `createSvelteTable`/`FlexRender` helpers, use them as the base and continue. If not available, install the core directly:

```bash
pnpm add @tanstack/table-core
```

- [ ] **Step 2: Write the failing test**

`src/lib/components/ui/data-table/data-table.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import DataTable from "./data-table.svelte";
import type { ColumnDef } from "@tanstack/table-core";

type Row = { name: string; status: string };
const columns: ColumnDef<Row>[] = [
  { accessorKey: "name", header: "Name" },
  { accessorKey: "status", header: "Status" },
];
const data: Row[] = [
  { name: "hermes-01", status: "running" },
  { name: "forge-01", status: "stopped" },
];

describe("DataTable", () => {
  it("renders headers and rows", () => {
    render(DataTable, { columns, data } as never);
    expect(screen.getByText("Name")).toBeTruthy();
    expect(screen.getByText("hermes-01")).toBeTruthy();
    expect(screen.getByText("forge-01")).toBeTruthy();
  });

  it("shows the empty state when data is empty", () => {
    render(DataTable, { columns, data: [], emptyTitle: "No rows" } as never);
    expect(screen.getByText("No rows")).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm exec vitest run src/lib/components/ui/data-table
```

Expected: FAIL — module missing.

- [ ] **Step 4: Implement `data-table.svelte`**

If the registry supplied `createSvelteTable` + `FlexRender`, implement with them:

```svelte
<script lang="ts" generics="T">
  import {
    getCoreRowModel,
    getSortedRowModel,
    getFilteredRowModel,
    getPaginationRowModel,
    type ColumnDef,
    type SortingState,
  } from "@tanstack/table-core";
  import { createSvelteTable, FlexRender } from "./index.js";
  import * as Table from "$lib/components/ui/table";
  import { Empty } from "$lib/components/ui/empty";
  import { Button } from "$lib/components/ui/button";
  import { cn } from "$lib/utils";

  let {
    columns,
    data,
    emptyTitle = "Nothing here yet",
    emptyDescription = undefined,
    pageSize = 50,
    filterValue = $bindable(""),
    class: className = undefined,
  }: {
    columns: ColumnDef<T>[];
    data: T[];
    emptyTitle?: string;
    emptyDescription?: string;
    pageSize?: number;
    filterValue?: string;
    class?: string;
  } = $props();

  let sorting = $state<SortingState>([]);

  const table = createSvelteTable({
    get data() {
      return data;
    },
    columns,
    state: {
      get sorting() {
        return sorting;
      },
      get globalFilter() {
        return filterValue;
      },
    },
    onSortingChange: (updater) => {
      sorting = typeof updater === "function" ? updater(sorting) : updater;
    },
    onGlobalFilterChange: (updater) => {
      filterValue = typeof updater === "function" ? updater(filterValue) : updater;
    },
    initialState: { pagination: { pageSize } },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });
</script>

{#if data.length === 0}
  <Empty title={emptyTitle} description={emptyDescription} />
{:else}
  <div class={cn("rounded-lg border", className)}>
    <Table.Root>
      <Table.Header>
        {#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
          <Table.Row>
            {#each headerGroup.headers as header (header.id)}
              <Table.Head
                class={header.column.getCanSort() ? "cursor-pointer select-none" : undefined}
                onclick={header.column.getToggleSortingHandler()}
              >
                {#if !header.isPlaceholder}
                  <FlexRender content={header.column.columnDef.header} context={header.getContext()} />
                  {#if header.column.getIsSorted() === "asc"}<span aria-hidden="true"> ↑</span>{/if}
                  {#if header.column.getIsSorted() === "desc"}<span aria-hidden="true"> ↓</span>{/if}
                {/if}
              </Table.Head>
            {/each}
          </Table.Row>
        {/each}
      </Table.Header>
      <Table.Body>
        {#each table.getRowModel().rows as row (row.id)}
          <Table.Row>
            {#each row.getVisibleCells() as cell (cell.id)}
              <Table.Cell>
                <FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} />
              </Table.Cell>
            {/each}
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
    {#if table.getPageCount() > 1}
      <div class="flex items-center justify-end gap-2 border-t px-3 py-2">
        <span class="text-xs text-muted-foreground">
          Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
        </span>
        <Button variant="outline" size="sm" disabled={!table.getCanPreviousPage()} onclick={() => table.previousPage()}>
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={!table.getCanNextPage()} onclick={() => table.nextPage()}>
          Next
        </Button>
      </div>
    {/if}
  </div>
{/if}
```

Export from `index.ts` alongside the registry helpers:

```ts
export { default as DataTable } from "./data-table.svelte";
```

If the registry did NOT supply `createSvelteTable`/`FlexRender`, port the two helpers from the shadcn-svelte data-table documentation into this directory first (they are ~40 lines total: a `createSvelteTable` wrapper that adapts TanStack's vanilla core to runes reactivity, and a `FlexRender` component that renders string | snippet | component cells).

- [ ] **Step 5: Run tests to verify pass**

```bash
pnpm exec vitest run src/lib/components/ui/data-table && pnpm check && pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(console): reusable DataTable with sorting, filtering, pagination"
```

---

### Task 8: Foundation verification pass

**Files:** none created; verification + push only.

**Interfaces:**
- Consumes: everything above.
- Produces: a pushed `ui-revamp` branch ending Plan A; Plan B starts from this state.

- [ ] **Step 1: Full gate**

```bash
pnpm exec svelte-kit sync && pnpm check && pnpm test && pnpm build
```

Expected: 0 errors, all tests pass (235 baseline + new primitive tests), production build succeeds.

- [ ] **Step 2: Confirm the app still boots**

```bash
pnpm exec vite preview --port 4173 &
sleep 2 && curl -s http://localhost:4173 | head -5 && kill %1
```

Expected: HTML shell renders (SPA fallback).

- [ ] **Step 3: Push the branch**

```bash
git push -u origin ui-revamp
```
