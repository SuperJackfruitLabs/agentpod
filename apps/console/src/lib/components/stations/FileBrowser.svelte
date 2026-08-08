<script lang="ts">
  import { readFile } from "$lib/api/client";
  import type { FsEntry } from "@agentpod/contract";
  import { X, RefreshCw } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { ResizablePaneGroup, ResizablePane, ResizableHandle } from "$lib/components/ui/resizable";
  import * as Breadcrumb from "$lib/components/ui/breadcrumb";
  import FileIcon from "$lib/components/file-icon.svelte";
  import { Empty } from "$lib/components/ui/empty";
  import FileTree from "./file-tree.svelte";
  import FilePreview from "./file-preview.svelte";
  import FileQuickOpen from "./file-quick-open.svelte";
  import { BINARY_EXTS, extOf } from "$lib/utils/file-ext";

  interface Props {
    stationId: string;
    /** Show write actions when the station advertises fs.write capability. */
    canWrite?: boolean;
    /**
     * Called when the user clicks "Edit (diff)" on a file.
     * The station page uses this to open the ConfigEditor modal.
     * Only invoked when canWrite is true.
     */
    onOpenConfigEditor?: (path: string) => void;
  }

  let { stationId, canWrite = false, onOpenConfigEditor }: Props = $props();

  // ── Tree ↔ preview bridge state ──────────────────────────────────────────────
  /** Every FsEntry the tree (or quick-open) has discovered, keyed by path —
   *  gives the preview/tabs/breadcrumb full metadata regardless of how a
   *  file was opened. */
  let entryIndex = $state<Map<string, FsEntry>>(new Map());
  /** Mirrors the tree's loaded folders (root under key ""), used to seed
   *  quick-open's walk so it doesn't refetch what the tree already has. */
  let loadedFolders = $state<Map<string, FsEntry[]>>(new Map());
  /** Set by a breadcrumb click; FileTree expands+scrolls to it, then clears it. */
  let revealRequest = $state<string | null>(null);

  // ── File tabs / preview state ────────────────────────────────────────────────
  let openFiles = $state<{ path: string; name: string }[]>([]);
  let activePath = $state<string | null>(null);
  let contentCache = $state<Map<string, { content: string; truncated: boolean }>>(new Map());
  let isLoadingFile = $state(false);
  let fileError = $state<string | null>(null);

  // ── Quick-open state ─────────────────────────────────────────────────────────
  let quickOpenOpen = $state(false);

  // ── Derived preview state ────────────────────────────────────────────────────
  const activeEntry = $derived.by((): FsEntry | null => {
    if (!activePath) return null;
    return (
      entryIndex.get(activePath) ?? {
        name: openFiles.find((f) => f.path === activePath)?.name ?? activePath,
        path: activePath,
        type: "file",
        size: null,
        modified: null,
      }
    );
  });
  const activeContentEntry = $derived(activePath ? (contentCache.get(activePath) ?? null) : null);

  type BreadcrumbSegment = { name: string; path: string; isDir: boolean };
  const breadcrumbSegments = $derived.by((): BreadcrumbSegment[] => {
    if (!activePath) return [];
    const parts = activePath.split("/");
    let acc = "";
    return parts.map((name, i) => {
      acc = acc ? `${acc}/${name}` : name;
      return { name, path: acc, isDir: i < parts.length - 1 };
    });
  });

  function handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
      e.preventDefault();
      quickOpenOpen = true;
    }
  }

  // ── Tree callbacks ───────────────────────────────────────────────────────────
  function handleEntriesLoaded(path: string, entries: FsEntry[]) {
    const nextIndex = new Map(entryIndex);
    for (const entry of entries) nextIndex.set(entry.path, entry);
    entryIndex = nextIndex;

    const nextFolders = new Map(loadedFolders);
    nextFolders.set(path, entries);
    loadedFolders = nextFolders;
  }

  function handleDeleted(path: string) {
    for (const f of openFiles.filter((f) => f.path === path || f.path.startsWith(`${path}/`))) {
      closeTab(f.path);
    }
  }

  function handleRenamed(oldPath: string, newPath: string, newName: string) {
    openFiles = openFiles.map((f) => (f.path === oldPath ? { path: newPath, name: newName } : f));
    if (activePath === oldPath) activePath = newPath;
    if (contentCache.has(oldPath)) {
      const next = new Map(contentCache);
      next.set(newPath, next.get(oldPath)!);
      next.delete(oldPath);
      contentCache = next;
    }
    if (entryIndex.has(oldPath)) {
      const next = new Map(entryIndex);
      const val = next.get(oldPath)!;
      next.delete(oldPath);
      next.set(newPath, { ...val, path: newPath, name: newName });
      entryIndex = next;
    }
  }

  function revealDir(path: string) {
    revealRequest = path;
  }

  // ── Preview / tab helpers ────────────────────────────────────────────────────
  function isBinaryPath(path: string): boolean {
    return BINARY_EXTS.has(extOf(path));
  }

  /** Open (or activate) a file as a tab. Cached content is reused — a
   *  network fetch only happens the first time a path is opened. Binary
   *  files are never fetched (the hub has no binary endpoint). */
  async function openFile(entry: FsEntry) {
    const path = entry.path;
    const nextIndex = new Map(entryIndex);
    nextIndex.set(path, entry);
    entryIndex = nextIndex;

    if (!openFiles.some((f) => f.path === path)) {
      openFiles = [...openFiles, { path, name: entry.name }];
    }
    activePath = path;
    fileError = null;

    if (isBinaryPath(path) || contentCache.has(path)) return;

    isLoadingFile = true;
    try {
      const result = await readFile(stationId, path);
      const next = new Map(contentCache);
      next.set(path, result);
      contentCache = next;
    } catch (err) {
      fileError = err instanceof Error ? err.message : "Failed to read file";
    } finally {
      isLoadingFile = false;
    }
  }

  function fallbackEntry(f: { path: string; name: string }): FsEntry {
    return { name: f.name, path: f.path, type: "file", size: null, modified: null };
  }

  async function refreshActiveFile() {
    if (!activePath) return;
    const entry = entryIndex.get(activePath);
    const next = new Map(contentCache);
    next.delete(activePath);
    contentCache = next;
    if (entry) await openFile(entry);
  }

  /** Evict a path's cached content — e.g. after ConfigEditor saves it out of
   *  band, so the preview cache doesn't keep serving pre-edit content. If
   *  the path is the currently active tab, refetch it immediately so the
   *  visible preview updates too. Called by the station page via
   *  `bind:this` after ConfigEditor's onSaved fires. */
  export function invalidate(path: string) {
    if (contentCache.has(path)) {
      const next = new Map(contentCache);
      next.delete(path);
      contentCache = next;
    }
    if (activePath === path) {
      const entry = entryIndex.get(path);
      if (entry) openFile(entry);
    }
  }

  function closeTab(path: string) {
    const idx = openFiles.findIndex((f) => f.path === path);
    if (idx === -1) return;
    openFiles = openFiles.filter((f) => f.path !== path);
    if (activePath === path) {
      activePath = openFiles.length === 0 ? null : openFiles[Math.min(idx, openFiles.length - 1)].path;
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="flex h-full min-h-[300px] border border-border rounded-md overflow-hidden bg-background"
  onkeydown={handleKeydown}
>
  <ResizablePaneGroup direction="horizontal">
    <ResizablePane defaultSize={28} minSize={15} class="flex flex-col overflow-hidden bg-muted/10">
      <FileTree
        {stationId}
        {canWrite}
        {activePath}
        onEntryClick={openFile}
        onEntriesLoaded={handleEntriesLoaded}
        onDeleted={handleDeleted}
        onRenamed={handleRenamed}
        bind:revealRequest
      />
    </ResizablePane>

    <ResizableHandle withHandle />

    <ResizablePane defaultSize={72} class="flex flex-col overflow-hidden">
      <!-- ── Preview pane ── -->
      {#if openFiles.length === 0}
        <div class="flex flex-1 items-center justify-center p-6">
          <Empty
            title="Select a file to preview"
            description="Choose a file from the tree, or press ⌘P to quick-open."
          />
        </div>
      {:else}
        <!-- Tab strip -->
        <div class="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/60 bg-muted/5 px-1" role="tablist">
          {#each openFiles as f (f.path)}
            <div
              role="tab"
              tabindex="0"
              aria-selected={f.path === activePath}
              aria-label={f.name}
              class="group flex shrink-0 items-center gap-1.5 border-b-2 px-2 py-1.5 text-[12px] font-mono cursor-pointer
                {f.path === activePath ? 'border-primary bg-background text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
              onclick={() => openFile(entryIndex.get(f.path) ?? fallbackEntry(f))}
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openFile(entryIndex.get(f.path) ?? fallbackEntry(f));
                }
              }}
            >
              <FileIcon filename={f.name} size="xs" />
              <span class="max-w-[140px] truncate">{f.name}</span>
              <button
                type="button"
                aria-label="Close {f.name}"
                class="rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                onclick={(e: MouseEvent) => {
                  e.stopPropagation();
                  closeTab(f.path);
                }}
              >
                <X class="h-3 w-3" />
              </button>
            </div>
          {/each}
        </div>

        <!-- Breadcrumb + actions -->
        {#if activePath}
          <div class="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
            <Breadcrumb.Root class="min-w-0">
              <Breadcrumb.List class="flex-nowrap">
                {#each breadcrumbSegments as seg, i (seg.path)}
                  <Breadcrumb.Item>
                    {#if i === breadcrumbSegments.length - 1}
                      <Breadcrumb.Page class="truncate">{seg.name}</Breadcrumb.Page>
                    {:else}
                      <Breadcrumb.Link href="#" onclick={(e: MouseEvent) => { e.preventDefault(); revealDir(seg.path); }}>
                        {seg.name}
                      </Breadcrumb.Link>
                    {/if}
                  </Breadcrumb.Item>
                  {#if i < breadcrumbSegments.length - 1}
                    <Breadcrumb.Separator />
                  {/if}
                {/each}
              </Breadcrumb.List>
            </Breadcrumb.Root>

            <div class="flex shrink-0 items-center gap-1.5">
              <Button variant="ghost" size="icon-sm" title="Refresh" onclick={refreshActiveFile}>
                <RefreshCw class="h-3.5 w-3.5" />
              </Button>
              {#if canWrite && activeContentEntry !== null && onOpenConfigEditor}
                <Button
                  variant="outline"
                  size="sm"
                  class="h-7 px-2 text-[11px] font-sans"
                  onclick={() => onOpenConfigEditor!(activePath!)}
                >
                  Edit (diff)
                </Button>
              {/if}
            </div>
          </div>
        {/if}

        {#if activeEntry}
          <FilePreview
            entry={activeEntry}
            content={activeContentEntry?.content ?? null}
            truncated={activeContentEntry?.truncated ?? false}
            loading={isLoadingFile}
            error={fileError}
          />
        {/if}
      {/if}
    </ResizablePane>
  </ResizablePaneGroup>
</div>

<FileQuickOpen
  {stationId}
  seeded={loadedFolders}
  onPick={(entry) => openFile(entry)}
  bind:open={quickOpenOpen}
/>
