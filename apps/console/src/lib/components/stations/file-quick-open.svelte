<script lang="ts">
  import { listFiles } from "$lib/api/client";
  import type { FsEntry } from "@agentpod/contract";
  import * as Command from "$lib/components/ui/command";
  import FileIcon from "$lib/components/file-icon.svelte";

  interface Props {
    stationId: string;
    /** Already-loaded folder contents (root under key ""), seeded so the
     *  walk doesn't refetch what the tree already has. */
    seeded: Map<string, FsEntry[]>;
    onPick: (entry: FsEntry) => void;
    open: boolean;
  }

  let { stationId, seeded, onPick, open = $bindable(false) }: Props = $props();

  const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".svelte-kit", "target"]);
  const MAX_DIRS = 200;

  let files = $state<FsEntry[]>([]);
  let capped = $state(false);
  let walking = $state(false);

  async function walk() {
    walking = true;
    capped = false;
    const collected: FsEntry[] = [];
    const visited = new Set<string>();
    const queue: string[] = [""];
    let dirBudget = MAX_DIRS;

    while (queue.length > 0) {
      if (dirBudget <= 0) {
        capped = true;
        break;
      }
      const dir = queue.shift()!;
      if (visited.has(dir)) continue;
      visited.add(dir);
      dirBudget--;

      let entries: FsEntry[];
      if (seeded.has(dir)) {
        entries = seeded.get(dir)!;
      } else {
        try {
          entries = await listFiles(stationId, dir);
        } catch {
          entries = [];
        }
      }

      for (const entry of entries) {
        if (entry.type === "dir") {
          if (SKIP_DIRS.has(entry.name)) continue;
          queue.push(entry.path);
        } else {
          collected.push(entry);
        }
      }
    }

    files = collected;
    walking = false;
  }

  $effect(() => {
    if (open) {
      void walk();
    } else {
      files = [];
      capped = false;
    }
  });

  function pick(entry: FsEntry) {
    onPick(entry);
    open = false;
  }
</script>

<Command.Dialog bind:open title="Quick open" description="Search files by name or path">
  <Command.Input placeholder="Search files…" />
  <Command.List>
    {#if walking}
      <Command.Loading>Indexing files…</Command.Loading>
    {:else}
      <Command.Empty>No files found.</Command.Empty>
      <Command.Group heading="Files">
        {#each files as entry (entry.path)}
          <Command.Item value={entry.path} onSelect={() => pick(entry)}>
            <FileIcon filename={entry.name} size="sm" class="mr-2" />
            <span class="truncate">{entry.name}</span>
            <span class="ml-2 truncate text-xs text-muted-foreground">{entry.path}</span>
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}
  </Command.List>
  {#if capped}
    <div class="border-t border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
      Search capped — refine your query
    </div>
  {/if}
</Command.Dialog>
