# UI Revamp Plan C — Station Detail & Workhorses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the three workhorses — log viewer, file browser, terminal — with real capability (search, filtering, follow-tail, resizable split, file tabs, markdown preview, terminal search, theme-aware palette, reconnect) and move the station-detail screen fully onto the Crisp Console base.

**Architecture:** Plan C of the program in `docs/superpowers/specs/2026-08-08-ui-revamp-design.md` (sweep step 2), on Plans A+B. Key existing facts (verified 2026-08-08): LogTail uses SSE via `logsUrl()` with no reconnect; `TerminalClient` (`$lib/api/terminal.ts`) exposes only `onData/send/resize/close` — no close/exit callback; FileBrowser previews via plain `<pre>` and calls `listFiles/readFile/writeFile/mkdir/move/del`; `paneforge` resizable, `breadcrumb`, `command`, `MonacoEditor` (theme-aware, `{code, language, readonly, onchange, onsave}`), `MarkdownViewer` (`{content, class}`) all exist and are unused-or-ready. The hub has NO binary file endpoint — image/binary preview is a typed metadata fallback, not pixels (backend changes are a spec non-goal).

**Tech Stack:** As Plans A/B. Baseline at start: 247 tests / 37 files green, HEAD `0d3e7a2`.

## Global Constraints

- Commands run from `apps/console/` in the worktree `/Users/rakeshgangwar/Projects/agentpod/.claude/worktrees/ui-revamp`.
- After every task: `pnpm check` → 0 errors, `pnpm test` all pass, output pristine.
- Crisp Console rules as Plan B. Status/level colors ONLY via `text-status-*`/`bg-status-*` tokens. No `.cyber-card` in new markup (LogTail/Terminal are its last station-surface consumers).
- Existing test accessible-names are load-bearing where noted in tasks; behavioral assertions may be extended, never weakened.
- Conventional commits + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Never touch `develop` or the main checkout.

---

### Task 1: Station frame — full tab ARIA, kept-alive panels, Dialog config editor

**Files:**
- Modify: `apps/console/src/lib/components/page-header.svelte` (tab a11y completion)
- Modify: `apps/console/src/lib/components/page-header.svelte.test.ts`
- Modify: `apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte`
- Modify: `apps/console/src/lib/components/ui/bottom-nav/bottom-nav-item.svelte` (ride-along: remove `scale-110` transform, line ~43)
- Modify: `apps/console/vitest.config.ts` (ride-along: fix stale `lottie-icon.svelte` comment, line ~11)

**Interfaces:**
- Consumes: PageHeader contract from Plan B.
- Produces: PageHeader tabs gain `aria-controls`/`id` wiring + Home/End/arrow-key navigation + `aria-disabled` (focusable) disabled tabs whose tooltips now work; new optional prop `tabsId?: string` (default `"page-tabs"`) used to build ids `{tabsId}-tab-{tab.id}` / panels `{tabsId}-panel-{tab.id}`. Station page renders each panel inside `<div role="tabpanel" id="{tabsId}-panel-{id}" aria-labelledby="{tabsId}-tab-{id}">`. Heavy panels (logs/files/terminal) stay mounted once visited.

- [ ] **Step 1: Extend the PageHeader test (RED)**

Add to `page-header.svelte.test.ts`:

```ts
  it("supports arrow-key navigation and keeps disabled tabs focusable with aria-disabled", async () => {
    const onTabChange = vi.fn();
    render(PageHeaderTestHost, {
      title: "t",
      tabs: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta", disabled: true, disabledReason: "locked" },
        { id: "c", label: "Gamma" },
      ],
      activeTab: "a",
      onTabChange,
    });
    const alpha = screen.getByRole("tab", { name: /alpha/i });
    const beta = screen.getByRole("tab", { name: /beta/i });
    expect(beta.getAttribute("aria-disabled")).toBe("true");
    expect(beta.hasAttribute("disabled")).toBe(false);
    alpha.focus();
    await fireEvent.keyDown(alpha, { key: "ArrowRight" });
    expect(document.activeElement).toBe(beta); // focus moves; activation does not
    await fireEvent.click(beta);
    expect(onTabChange).not.toHaveBeenCalled();
    await fireEvent.keyDown(beta, { key: "ArrowRight" });
    await fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });
    expect(onTabChange).toHaveBeenCalledWith("c");
  });
```

(Adapt host-component name/props to the existing test-host pattern.) Run to see it fail.

- [ ] **Step 2: Implement in page-header.svelte**

- Replace native `disabled={tab.disabled}` with `aria-disabled={tab.disabled ? "true" : undefined}` (button stays focusable; the existing `onclick` guard already blocks activation — keep it, and guard Enter/Space too).
- Add `id="{tabsId}-tab-{tab.id}"`, `aria-controls="{tabsId}-panel-{tab.id}"`, and roving `tabindex` (`0` for the active tab, `-1` otherwise).
- Add an `onkeydown` on the tablist container implementing ArrowLeft/ArrowRight (move focus, wrapping), Home/End (first/last), Enter/Space (activate focused tab unless `aria-disabled`). Focus moves without activating (manual-activation pattern).
- Tooltip on disabled tabs now works because the button receives pointer/focus events again.

- [ ] **Step 3: Station page — tabpanels + kept-alive heavy panels**

In the station page replace the `{#if activeTab === …}` chain for the six panels with:

```svelte
<script>
  // add near activeTab:
  let visited = $state(new Set<Tab>(["health"]));
  $effect(() => {
    if (!visited.has(activeTab)) visited = new Set(visited).add(activeTab);
  });
</script>

{#snippet panel(id: Tab, content: Snippet)}
  {#if visited.has(id)}
    <div
      role="tabpanel"
      id="page-tabs-panel-{id}"
      aria-labelledby="page-tabs-tab-{id}"
      class={activeTab === id ? "contents" : "hidden"}
    >
      {@render content()}
    </div>
  {/if}
{/snippet}
```

and render each existing panel through it (health/cleanup/activity may stay if-mounted if simpler — the kept-alive behavior is REQUIRED for logs, files, and terminal so tab switches no longer drop the SSE stream, tree state, or terminal scrollback). Replace the three hardcoded `h-[480px]` wrappers with a page-level flex column: content wrapper gets `flex flex-1 flex-col min-h-0` and each heavy-panel wrapper `flex-1 min-h-[320px]` so panels fill the viewport. Replace the hand-rolled ConfigEditor modal (`fixed inset-0 …` at lines ~132–148) with `Dialog.Root`/`Dialog.Content class="max-w-4xl h-[80vh] …"` from `$lib/components/ui/dialog`, preserving open/close semantics (Escape, backdrop) and passing the same props to `ConfigEditor`.

- [ ] **Step 4: Ride-alongs**

Remove `scale-110` (and its `transition-transform` if now unused) from `bottom-nav-item.svelte`; fix the stale `lottie-icon.svelte` mention in `vitest.config.ts`'s comment.

- [ ] **Step 5: Green + commit**

```bash
pnpm exec vitest run src/lib/components/page-header.svelte.test.ts && pnpm test && pnpm check
git add -A && git commit -m "feat(console): complete tab ARIA, keep station panels alive, dialog config editor"
```

---

### Task 2: LogTail rebuild — search, levels, follow-tail, reconnect

**Files:**
- Rewrite: `apps/console/src/lib/components/stations/LogTail.svelte`
- Rewrite/extend: `apps/console/src/lib/components/stations/LogTail.svelte.test.ts`

**Interfaces:**
- Consumes: `logsUrl(stationId)` SSE endpoint (unchanged), `Empty`, status tokens.
- Produces: same component contract `{stationId}`. Internal line model: `{ raw: string; text: string; level: "error"|"warn"|"info"|null }` where `text` is ANSI-stripped raw.

Behavior spec (all REQUIRED):
1. **Buffer:** `MAX_LINES = 10_000`, ring via `slice(-MAX_LINES)`. Each line classified once on arrival: strip ANSI (`/\[[0-9;]*m/g` → ""), level = first match of `/\b(ERROR|ERR|FATAL)\b/i` → error, `/\b(WARN|WARNING)\b/i` → warn, `/\b(INFO|NOTICE)\b/i` → info, else null.
2. **Toolbar:** search input (placeholder `Search logs…`, focuses on `/` key when the container has focus); level filter chips `All | Error N | Warn N | Info N` with live counts (counts of ALL buffered lines, independent of search); Follow toggle; Wrap toggle; Download button (saves currently-visible (filtered) lines as a `.log` Blob via `URL.createObjectURL`); line counter text `{lines.length} lines` (keep this exact "N lines" format — the existing cap test greps it).
3. **Filtering:** visible = lines matching active level chip AND case-insensitive substring of search. Search-match highlighting via `<mark>` around matched substrings.
4. **Follow-tail:** on new lines, auto-scroll ONLY if follow is on. A manual scroll-up (scrollTop more than ~40px from bottom) pauses follow; while paused, count arriving lines and show a centered pill button `{n} new lines ↓` that on click re-enables follow and jumps to bottom. Scrolling back to the bottom re-enables follow.
5. **Rendering perf:** one `<div>` per visible line with `content-visibility: auto; contain-intrinsic-size: auto 1.25rem;` (style via a CSS class in the component) — no virtualization library. `whitespace-pre` default; Wrap toggle switches to `whitespace-pre-wrap break-all`.
6. **Reconnect:** on SSE `onerror`, close and retry with backoff 1s/2s/4s/8s (max 5 attempts), status chip cycling `connecting/connected/reconnecting/closed`; a `Retry` button appears when closed. Status colors: connected → `text-status-running`, connecting/reconnecting → `text-status-starting`, closed → `text-status-error`.
7. **Levels color:** error lines `text-status-error`, warn `text-status-degraded`, info default foreground/muted, null muted. Container: `rounded-lg border bg-background font-mono text-xs` — no `.cyber-card`, no hardcoded hex.
8. **Empty state:** `Empty` component when zero lines and status connected.

- [ ] **Step 1: Extend tests first (RED).** Keep the existing three (rendering, ordering, cap — cap text now `10000 lines` after 10_500 pushes; update MAX and expectations). Add, using the existing `MockEventSource` pattern:

```ts
  it("filters by level chip and search text", async () => { /* push "ERROR boom", "WARN slow", "INFO ok"; click "Error 1" chip -> only boom visible; type "slo" in search with All chip -> only slow visible */ });
  it("pauses follow on scroll-up and shows new-lines pill", async () => { /* set container scrollTop away from bottom, dispatch scroll event, push 3 lines, expect /3 new lines/ pill; click pill -> pill gone */ });
  it("reconnects after error with backoff", async () => { /* vi.useFakeTimers; mock.onerror(); advance 1000ms; expect a second EventSource constructed */ });
```

Write them as real assertions (the comments above describe the scenario; the code must implement them). jsdom note: `scrollTop`/`scrollHeight` are settable/mockable via `Object.defineProperty` on the container element.

- [ ] **Step 2: Implement per the behavior spec.** Derived values with `$derived`; single classification pass on arrival (not per render). Keep `data-testid` hooks minimal.

- [ ] **Step 3: Green + commit**

```bash
pnpm exec vitest run src/lib/components/stations/LogTail.svelte.test.ts && pnpm test && pnpm check
git add -A && git commit -m "feat(console): log viewer — search, level filters, follow-tail, SSE reconnect"
```

---

### Task 3: FileBrowser rebuild — resizable split, file tabs, rich preview, quick-open

**Files:**
- Rewrite: `apps/console/src/lib/components/stations/FileBrowser.svelte` (may split out `stations/file-preview.svelte` and `stations/file-quick-open.svelte` — preferred, keeps files focused)
- Modify: `apps/console/src/lib/components/stations/FileBrowser.svelte.test.ts` (extend; existing 8 tests' accessible names are load-bearing: `getByText(name)` rows, `Rename X`/`Delete X` button names, `/truncated/i`, `/folder name/i` placeholder, `Edit (diff)`)

**Interfaces:**
- Consumes: `listFiles/readFile/writeFile/mkdir/move/del` (unchanged signatures), `ResizablePaneGroup/ResizablePane/ResizableHandle` from `$lib/components/ui/resizable`, `* as Breadcrumb` from `$lib/components/ui/breadcrumb`, `* as Command` from `$lib/components/ui/command`, `MonacoEditor` (readonly preview), `MarkdownViewer`, `FileIcon` (`$lib/components/file-icon.svelte`), `Empty`, `Spinner`.
- Produces: same public props `{stationId, canWrite?, onOpenConfigEditor?}`.

Behavior spec (REQUIRED unless marked optional):
1. **Split:** `ResizablePaneGroup direction="horizontal"` — tree pane (defaultSize 28, minSize 15) | handle | preview pane. Tree keeps current lazy-load + copy-on-write state logic and write flows (new file/dir, rename, delete with TypeToConfirmDialog) — carry them over, do not regress the 8 existing tests.
2. **Tree icons:** replace hardcoded Folder/FileText Lucide pair with `FileIcon {filename} {isDirectory} {isExpanded} size="xs"`.
3. **File tabs:** clicking a file opens it as a tab (`openFiles: {path, name}[]`, `activePath`); tab strip above the preview with per-tab close (×) buttons; re-clicking an open file activates its tab; content cache `Map<path, {content, truncated}>` so switching tabs doesn't refetch; refetch on explicit Refresh action.
4. **Breadcrumb:** `Breadcrumb` above the preview showing the active file's path segments; clicking a directory segment expands+scrolls the tree to that dir (calling the existing `toggleDir`/load logic).
5. **Preview by type**, decided from the file extension:
   - Markdown (`.md`, `.mdx`, `.markdown`): toggle `Rendered | Source` — Rendered = `MarkdownViewer {content}`, Source = Monaco readonly with language `markdown`. Default Rendered.
   - Known-text/code extensions (reuse `getMonacoLanguage`'s map via the MonacoEditor `language` prop): `MonacoEditor code={content} language={ext} readonly` (theme-aware).
   - Image/binary extensions (`png jpg jpeg gif webp svg ico woff woff2 ttf zip gz tar bin exe pdf`): NO content fetch; render a metadata card (FileIcon large, name, type "Binary/Image file", size from `FsEntry.size`, modified from `FsEntry.modified`) with note `Preview not available over the station API`. (The hub has no binary endpoint — do not attempt readFile on these.)
   - Unknown extension: fetch and render as plaintext Monaco readonly; if content contains ` `, swap to the binary metadata card.
6. **Metadata strip** under the preview: `{language/type} · {size formatted} · modified {relative time}` from the entry.
7. **Edit flows preserved:** `Edit (diff)` button (→ `onOpenConfigEditor`) and the inline textarea edit path from the current component may be DROPPED in favor of Edit (diff) only IF the existing test suite permits — it does not (no inline-edit test exists; the tests cover Edit (diff), not the textarea), so: keep `Edit (diff)` exactly, drop the inline textarea editor (ConfigEditor in its Dialog is now the single edit path).
8. **Quick-open (⌘P / Ctrl+P when the browser has focus):** a `Command.Dialog` listing files matching the query. Source: BFS walk over `listFiles`, on-demand when the dialog opens, seeded from already-loaded `folderContents`, skipping `node_modules`, `.git`, `dist`, `build`, `.svelte-kit`, `target`, capped at 200 directories per open (show `Search capped — refine your query` hint when the cap hits, via a `Command.Item` disabled row or footer note). Selecting a result opens the file as a tab. Cache the walk result per dialog-open session.
9. **Monaco in jsdom:** the existing ConfigEditor test mocks Monaco via `monaco-editor.stub.svelte`; do the same in FileBrowser tests (`vi.mock` the `$lib/components/ui/monaco-editor` module to the stub). Same for MarkdownViewer if shiki misbehaves in jsdom (mock to a div rendering `content`).

- [ ] **Step 1: Extend tests (RED)** — add, alongside the existing 8 (which must keep passing):

```ts
  it("opens multiple files as tabs and switches between them without refetching", async () => { /* open README.md then src/index.ts; expect two tabs; readFile called once per file; click first tab -> its content shown, readFile still 2 calls total */ });
  it("renders markdown files with a Rendered/Source toggle", async () => { /* open README.md; expect toggle; Rendered shows mocked MarkdownViewer output; Source shows mocked Monaco stub with content */ });
  it("shows a metadata card instead of fetching binary files", async () => { /* logo.png entry; click it; readFile NOT called; expect /preview not available/i and size text */ });
  it("closes a tab with its close button", async () => { /* open two, close one, expect one tab left and active switches */ });
```

- [ ] **Step 2: Implement.** Prefer extracting `file-preview.svelte` (props `{entry: FsEntry, content: string|null, truncated: boolean, loading: boolean, error: string|null}`) and `file-quick-open.svelte` (props `{stationId, seeded: Map<string, FsEntry[]>, onPick(path,name), open: bindable}`) so `FileBrowser.svelte` stays the orchestrator under ~400 lines.

- [ ] **Step 3: Green + commit**

```bash
pnpm exec vitest run src/lib/components/stations/FileBrowser.svelte.test.ts && pnpm test && pnpm check
git add -A && git commit -m "feat(console): file browser — resizable split, tabs, rich preview, quick-open"
```

---

### Task 4: Terminal rebuild — search, theme-aware palette, reconnect, fullscreen

**Files:**
- Modify: `apps/console/src/lib/api/terminal.ts` (extend `TerminalClient`)
- Modify: `apps/console/src/lib/api/terminal.test.ts` (extend)
- Rewrite: `apps/console/src/lib/components/stations/Terminal.svelte`
- Modify: `apps/console/package.json` (add `@xterm/addon-search`; `@xterm/addon-webgl` optional — see Step 3)

**Interfaces:**
- Consumes: hub WS protocol (unchanged), theme tokens via `getComputedStyle`, `themeStore` for reactivity.
- Produces: `TerminalClient` gains `onClose(cb: (reason: "exit" | "error" | "closed") => void): void` (single callback, last-wins, fired exactly once per connection when the socket ends: `{t:"exit"}` → "exit", `onerror` → "error", clean close → "closed"). Component props unchanged `{stationId}`.

Behavior spec (REQUIRED):
1. **terminal.ts:** add the `onClose` registration; wire `ws.onclose`/`ws.onerror`/`{t:"exit"}` to fire it once with the right reason. Do not change the wire protocol or existing method semantics. TDD: extend `terminal.test.ts` with cases — exit message fires `onClose("exit")`; socket error fires `onClose("error")`; `close()` then socket close does NOT double-fire.
2. **Connection lifecycle in the component:** statuses `connecting | connected | reconnecting | closed`. On `onClose`: if reason `exit` → status closed with message `Session ended`; else auto-reconnect up to 3 attempts (1s/2s/4s), then closed with a `Reconnect` button (manual retry resets the budget). On reconnect, create a fresh client, re-wire `term` handlers, resize.
3. **Toolbar** (replaces `.cyber-card` header): status dot (`bg-status-*` by status: connected running, connecting/reconnecting starting, closed error) + mono `station` label; search input (⌘F/Ctrl+F focuses it) with next/prev buttons wired to `@xterm/addon-search` (`findNext`/`findPrevious`, decorations enabled); Clear button (`term.clear()`); Fullscreen toggle.
4. **Fullscreen:** toggling adds a wrapper class `fixed inset-0 z-50 bg-background p-2` (component-local state; toolbar stays visible; Escape exits; refit on toggle via `fitAddon.fit()` after a `requestAnimationFrame`).
5. **Theme-aware palette:** build the xterm theme from computed tokens — read `getComputedStyle(document.documentElement)` values of `--background`, `--foreground`, `--primary`, `--muted-foreground` and set `{background, foreground, cursor: foreground, cursorAccent: background, selectionBackground: primary at ~35% (use color-mix string "color-mix(in oklab, X 35%, transparent)")}`. Recompute inside a `$effect` that reads `themeStore.resolvedMode` and the active scheme id so scheme/mode switches re-theme the live terminal (`term.options.theme = …`). Remove the inline `background:#0a0a0a` and all hardcoded hex.
6. **Ergonomics:** load `@xterm/addon-web-links` (already installed) alongside fit+search; copy-on-select (`term.onSelectionChange` → `navigator.clipboard.writeText(selection)` guarded non-empty & document.hasFocus()); right-click paste via `contextmenu` handler (`navigator.clipboard.readText()` → `client.send`, preventDefault). Debounce the ResizeObserver callback 100ms.
7. **WebGL (optional, non-blocking):** try `@xterm/addon-webgl` in a try/catch and fall back silently; if the dep or load misbehaves, SKIP it and note in the report — do not fight it.
8. Container: `rounded-lg border bg-background` — no `.cyber-card no-lift`.

- [ ] **Step 1: terminal.ts TDD (RED→GREEN)** per spec item 1.
- [ ] **Step 2: Component rebuild** per spec items 2–8. No component-level vitest (xterm+jsdom is not testable here — the client layer carries the tests); state this in the report.
- [ ] **Step 3: Green + commit**

```bash
pnpm add @xterm/addon-search   # (+ @xterm/addon-webgl only if Step 2 kept it)
pnpm exec vitest run src/lib/api/terminal.test.ts && pnpm test && pnpm check && pnpm build
git add -A && git commit -m "feat(console): terminal — search, theme palette, reconnect, fullscreen"
```

---

### Task 5: Station panel restyles — Health, Cleanup, Activity

**Files:**
- Modify: `apps/console/src/lib/components/stations/HealthPanel.svelte`, `CleanupPanel.svelte`, `ActivityPanel.svelte` (+ their test files, selector updates only)

**Interfaces:** props unchanged on all three.

Requirements:
1. **HealthPanel:** `<dl>` grid becomes stat tiles (`rounded-lg border p-3` per tile, label `text-xs text-muted-foreground`, value `font-mono text-lg`), status value uses `text-status-*`; lifecycle buttons unchanged in behavior; loading state = `Skeleton` tiles; fetch failure = inline error card with Retry button (currently silent) — add one test for the retry path (mock reject then resolve).
2. **CleanupPanel:** toolbar (Scan, total bytes badge, Apply) on one row; item rows become bordered list with checkbox, mono path, size right-aligned; empty scan result renders `Empty` (`title="Nothing to clean"`); behavior + TypeToConfirmDialog flow unchanged.
3. **ActivityPanel:** rows keep `data-testid="activity-row"`; result badge colors via status tokens (`ok` → `text-status-running`, `error` → `text-status-error`); empty list renders `Empty` (`title="No activity yet"`); Refresh keeps working.
4. All three: no `.cyber-card`, no hardcoded hex, sans labels / mono values discipline.

- [ ] **Step 1:** HealthPanel (add retry test RED → implement) → run its tests.
- [ ] **Step 2:** CleanupPanel + ActivityPanel (extend each with an Empty-state test) → run their tests.
- [ ] **Step 3: Green + commit**

```bash
pnpm test && pnpm check
git add -A && git commit -m "feat(console): crisp station panels — health tiles, cleanup list, activity rows"
```

---

### Task 6: Plan C gate

**Files:** none new.

- [ ] **Step 1: Full gate**

```bash
pnpm exec svelte-kit sync && pnpm check && pnpm test && pnpm build
```

- [ ] **Step 2: Cyber-consumer audit for the station surface**

```bash
grep -rn "cyber-card" src/lib/components/stations src/routes/nodes | grep -v app.css
```

Expected: zero hits. (Other surfaces still use cyber classes — their plans delete them.)

- [ ] **Step 3: Push**

```bash
git push origin ui-revamp
```
