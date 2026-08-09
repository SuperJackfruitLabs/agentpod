<script lang="ts">
  import { onMount, tick } from "svelte";
  import { listFiles, writeFile, mkdir, move, del } from "$lib/api/client";
  import { toast } from "svelte-sonner";
  import type { FsEntry } from "@agentpod/contract";
  import { ChevronRight, ChevronDown, Loader2, Trash2, FilePlus, FolderPlus, Pencil } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import TypeToConfirmDialog from "$lib/components/ui/TypeToConfirmDialog.svelte";
  import { autofocus } from "$lib/actions/autofocus";
  import FileIcon from "$lib/components/file-icon.svelte";

  interface Props {
    stationId: string;
    /** Show write actions when the station advertises fs.write capability. */
    canWrite?: boolean;
    /** Path of the file currently shown in the preview pane, for row highlight. */
    activePath: string | null;
    /** Fires when a file row (not a directory) is clicked. */
    onEntryClick: (entry: FsEntry) => void;
    /** Fires whenever a directory listing resolves (root load or expand), so
     *  the parent can index full FsEntry metadata and seed quick-open. */
    onEntriesLoaded?: (path: string, entries: FsEntry[]) => void;
    /** Fires after a successful delete, so the parent can close any open tabs
     *  under the deleted path. */
    onDeleted?: (path: string) => void;
    /** Fires after a successful rename, so the parent can retarget any open
     *  tab / cached content at the new path. */
    onRenamed?: (oldPath: string, newPath: string, newName: string) => void;
    /** Set by the parent (e.g. from a breadcrumb click) to request the tree
     *  expand-and-scroll to a directory. Cleared back to null once handled. */
    revealRequest?: string | null;
  }

  let {
    stationId,
    canWrite = false,
    activePath,
    onEntryClick,
    onEntriesLoaded,
    onDeleted,
    onRenamed,
    revealRequest = $bindable(null),
  }: Props = $props();

  let rootEntries = $state<FsEntry[]>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);
  let expandedPaths = $state<Set<string>>(new Set());
  let folderContents = $state<Map<string, FsEntry[]>>(new Map());
  let loadingFolders = $state<Set<string>>(new Set());
  let container = $state<HTMLDivElement | undefined>(undefined);

  /** Entry currently targeted for deletion; opens TypeToConfirmDialog. */
  let deleteTarget = $state<FsEntry | null>(null);
  /** null = not creating; "file" = new-file mode; "dir" = new-folder mode. */
  let newItemMode = $state<"file" | "dir" | null>(null);
  let newItemName = $state("");
  /** Inline rename: entry being renamed and the pending new name. */
  let renameTarget = $state<FsEntry | null>(null);
  let renameName = $state("");

  onMount(async () => {
    await refresh();
  });

  $effect(() => {
    if (revealRequest !== null) {
      const path = revealRequest;
      void revealPath(path).then(() => {
        revealRequest = null;
      });
    }
  });

  async function refresh() {
    isLoading = true;
    error = null;
    try {
      rootEntries = await listFiles(stationId, "");
      onEntriesLoaded?.("", rootEntries);
    } catch (err) {
      error = err instanceof Error ? err.message : "Couldn’t load this folder.";
    } finally {
      isLoading = false;
    }
  }

  async function ensureExpanded(path: string) {
    if (!folderContents.has(path)) {
      await loadDirContents(path);
    }
    if (!expandedPaths.has(path)) {
      const next = new Set(expandedPaths);
      next.add(path);
      expandedPaths = next;
    }
  }

  async function revealPath(path: string) {
    const parts = path.split("/");
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      await ensureExpanded(acc);
    }
    await tick();
    container?.querySelector<HTMLElement>(`[data-tree-path="${cssEscapePath(path)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function cssEscapePath(path: string): string {
    return path.replace(/["\\]/g, "\\$&");
  }

  async function toggleDir(path: string) {
    if (expandedPaths.has(path)) {
      const next = new Set(expandedPaths);
      next.delete(path);
      expandedPaths = next;
    } else {
      await ensureExpanded(path);
    }
  }

  async function loadDirContents(path: string) {
    const loading = new Set(loadingFolders);
    loading.add(path);
    loadingFolders = loading;
    try {
      const contents = await listFiles(stationId, path);
      const next = new Map(folderContents);
      next.set(path, contents);
      folderContents = next;
      onEntriesLoaded?.(path, contents);
    } catch {
      const next = new Map(folderContents);
      next.set(path, []);
      folderContents = next;
    } finally {
      const done = new Set(loadingFolders);
      done.delete(path);
      loadingFolders = done;
    }
  }

  function handleEntryClick(entry: FsEntry) {
    if (entry.type === "dir") {
      toggleDir(entry.path);
    } else {
      onEntryClick(entry);
    }
  }

  function getChildren(path: string): FsEntry[] {
    return folderContents.get(path) ?? [];
  }

  function sortEntries(entries: FsEntry[]): FsEntry[] {
    return [...entries].sort((a, b) => {
      if (a.type === "dir" && b.type !== "dir") return -1;
      if (a.type !== "dir" && b.type === "dir") return 1;
      return a.name.localeCompare(b.name);
    });
  }

  // ── Write helpers ────────────────────────────────────────────────────────────
  async function handleDelete() {
    if (!deleteTarget) return;
    const path = deleteTarget.path;
    try {
      await del(stationId, path, { recursive: deleteTarget.type === "dir" });
      onDeleted?.(path);
    } catch (err) {
      toast.error(`Couldn't delete ${deleteTarget.name}`, {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      deleteTarget = null;
    }
    await refresh();
  }

  async function handleNewItemKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      const name = newItemName.trim();
      if (!name) return;
      try {
        if (newItemMode === "dir") {
          await mkdir(stationId, name);
        } else {
          await writeFile(stationId, name, "");
        }
      } catch (err) {
        toast.error(`Couldn't create ${name}`, {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        newItemMode = null;
        newItemName = "";
      }
      await refresh();
    } else if (e.key === "Escape") {
      newItemMode = null;
      newItemName = "";
    }
  }

  async function handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      if (!renameTarget) return;
      const newName = renameName.trim();
      if (!newName || newName === renameTarget.name) {
        renameTarget = null;
        return;
      }
      const dir = renameTarget.path.includes("/")
        ? renameTarget.path.substring(0, renameTarget.path.lastIndexOf("/") + 1)
        : "";
      const newPath = dir + newName;
      try {
        await move(stationId, renameTarget.path, newPath);
        onRenamed?.(renameTarget.path, newPath, newName);
      } catch (err) {
        toast.error(`Couldn't rename ${renameTarget.name}`, {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        renameTarget = null;
        renameName = "";
      }
      await refresh();
    } else if (e.key === "Escape") {
      renameTarget = null;
      renameName = "";
    }
  }
</script>

<!-- Write toolbar (always rendered when canWrite so tests can find buttons) -->
{#if canWrite}
  <div class="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5 bg-muted/5">
    <Button
      variant="ghost"
      size="sm"
      class="h-7 gap-1 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
      onclick={() => { newItemMode = "file"; newItemName = ""; }}
      title="New File"
    >
      <FilePlus class="h-3.5 w-3.5" />
      New File
    </Button>
    <Button
      variant="ghost"
      size="sm"
      class="h-7 gap-1 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
      onclick={() => { newItemMode = "dir"; newItemName = ""; }}
      title="New Folder"
    >
      <FolderPlus class="h-3.5 w-3.5" />
      New Folder
    </Button>
  </div>

  <!-- Inline create input -->
  {#if newItemMode !== null}
    <div class="shrink-0 px-2 py-1.5 border-b border-border/60 bg-muted/5">
      <input
        type="text"
        class="h-7 w-full rounded border border-input bg-background px-2 text-sm font-mono outline-none focus:border-ring"
        placeholder={newItemMode === "dir" ? "Folder name" : "File name"}
        bind:value={newItemName}
        onkeydown={handleNewItemKeydown}
        use:autofocus
      />
    </div>
  {/if}
{/if}

<!-- File tree -->
<div class="flex-1 overflow-y-auto" bind:this={container}>
  {#if isLoading}
    <p class="text-sm text-muted-foreground p-3">Loading…</p>
  {:else if error}
    <p class="text-sm text-destructive p-3">{error}</p>
  {:else if rootEntries.length === 0}
    <p class="text-sm text-muted-foreground p-3">No files found.</p>
  {:else}
    <div class="py-1">
      {#snippet renderEntry(entry: FsEntry, depth: number)}
        <!-- Row wrapper: holds the entry button + optional action buttons -->
        <div
          class="group flex items-center w-full rounded-sm
            {entry.path === activePath ? 'bg-primary/10 text-primary' : 'hover:bg-muted/30 text-foreground'}"
          style:padding-left="{depth * 16 + 4}px"
          data-tree-path={entry.path}
        >
          <!-- Main entry button -->
          <button
            type="button"
            class="flex flex-1 items-center gap-1.5 py-1.5 text-sm font-mono text-left pr-1 pl-1 min-w-0"
            onclick={() => handleEntryClick(entry)}
          >
            {#if entry.type === "dir"}
              <span class="flex items-center justify-center w-4 shrink-0 text-muted-foreground">
                {#if loadingFolders.has(entry.path)}
                  <Loader2 class="h-3.5 w-3.5 animate-spin" />
                {:else if expandedPaths.has(entry.path)}
                  <ChevronDown class="h-3.5 w-3.5" />
                {:else}
                  <ChevronRight class="h-3.5 w-3.5" />
                {/if}
              </span>
            {:else}
              <span class="w-4 shrink-0"></span>
            {/if}
            <FileIcon
              filename={entry.name}
              isDirectory={entry.type === "dir"}
              isExpanded={expandedPaths.has(entry.path)}
              size="xs"
            />
            <span class="truncate">{entry.name}</span>
          </button>

          <!-- Write action buttons (visible on hover; always in DOM for testing) -->
          {#if canWrite}
            {#if renameTarget?.path === entry.path}
              <input
                type="text"
                class="h-6 w-24 shrink-0 rounded border border-input bg-background px-1 text-xs font-mono outline-none focus:border-ring focus:ring-2 focus:ring-ring"
                bind:value={renameName}
                onkeydown={handleRenameKeydown}
                use:autofocus
              />
            {:else}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Rename {entry.name}"
                class="mr-0.5 h-6 w-6 shrink-0 text-muted-foreground opacity-0 hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                onclick={(e: MouseEvent) => {
                  e.stopPropagation();
                  renameTarget = entry;
                  renameName = entry.name;
                }}
              >
                <Pencil class="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete {entry.name}"
                class="mr-1 h-6 w-6 shrink-0 text-muted-foreground opacity-0 hover:text-destructive focus:opacity-100 group-hover:opacity-100"
                onclick={(e: MouseEvent) => {
                  e.stopPropagation();
                  deleteTarget = entry;
                }}
              >
                <Trash2 class="h-3 w-3" />
              </Button>
            {/if}
          {/if}
        </div>

        {#if entry.type === "dir" && expandedPaths.has(entry.path)}
          {#each sortEntries(getChildren(entry.path)) as child (child.path)}
            {@render renderEntry(child, depth + 1)}
          {/each}
        {/if}
      {/snippet}

      {#each sortEntries(rootEntries) as entry (entry.path)}
        {@render renderEntry(entry, 0)}
      {/each}
    </div>
  {/if}
</div>

<!-- ── Delete confirm dialog ── -->
<TypeToConfirmDialog
  open={deleteTarget !== null}
  title="Delete {deleteTarget?.name ?? ''}"
  message="This will permanently delete {deleteTarget?.name ?? ''}. This action can’t be undone."
  confirmPhrase={deleteTarget?.name ?? ""}
  confirmLabel={deleteTarget?.type === "dir" ? "Delete folder" : "Delete file"}
  onConfirm={handleDelete}
  onCancel={() => (deleteTarget = null)}
/>
